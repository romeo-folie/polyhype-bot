import type { Redis } from 'ioredis';
import { loadConfig } from './config.js';

const GOVERNOR_LAST_TRADE_KEY = 'governor:last_trade_at';

/**
 * Global Rate-Limit Governor.
 *
 * Protects Polymarket account rate limits by ensuring a minimum interval
 * between orders, shared across all processes (arb, execution, copytrade).
 *
 * Hyperliquid (Futures) trades are EXEMPT from this rate limit as the
 * exchange handles high-throughput API agents natively.
 */
export async function checkGlobalGovernor(
  redis: Redis,
  platform: 'polymarket' | 'hyperliquid',
): Promise<{ ok: boolean; elapsedMs: number; minIntervalMs: number }> {
  if (platform === 'hyperliquid') {
    return { ok: true, elapsedMs: Infinity, minIntervalMs: 0 };
  }

  const cfg = loadConfig();
  const maxTradesPerMin = cfg.ARB_GLOBAL_MAX_TRADES_PER_MIN;
  const minIntervalMs = 60000 / maxTradesPerMin;

  const lastTradeAt = await redis.get(GOVERNOR_LAST_TRADE_KEY);
  const now = Date.now();
  const elapsedMs = lastTradeAt ? now - parseInt(lastTradeAt) : Infinity;

  if (elapsedMs < minIntervalMs) {
    return { ok: false, elapsedMs, minIntervalMs };
  }

  return { ok: true, elapsedMs, minIntervalMs };
}

/**
 * Records that a trade has been initiated on the specified platform.
 * Updates the shared global cooldown for Polymarket.
 */
export async function recordGlobalTrade(
  redis: Redis,
  platform: 'polymarket' | 'hyperliquid',
): Promise<void> {
  if (platform === 'hyperliquid') return;

  await redis.set(GOVERNOR_LAST_TRADE_KEY, Date.now().toString());
}

/**
 * Atomically reserve `count` consecutive governor slots (Lua check + write).
 *
 * Built for atomic pair placement: a YES+NO pair must never be half-blocked —
 * leg 1 allowed and leg 2 rate-limited leaves naked directional exposure
 * (live failure 2026-06-06: a LoL YES leg rested alone for 5 minutes after
 * the governor blocked its partner). Reserving both slots BEFORE the first
 * order goes out makes that impossible.
 *
 * Semantics: when the minimum interval has elapsed since the last recorded
 * trade, the key is pre-stamped to `now + (count − 1) × minIntervalMs` — the
 * timestamp of the LAST reserved slot — so every other process checking
 * checkGlobalGovernor backs off for the whole reservation window. The caller
 * must NOT also call recordGlobalTrade for the reserved placements (the
 * reservation already stamped them; a record would double-charge).
 *
 * Failed placements after a reservation still consume the slots —
 * conservative by design (the API calls were budgeted even if rejected).
 */
export async function reserveGovernorSlots(
  redis: Redis,
  platform: 'polymarket' | 'hyperliquid',
  count: number,
): Promise<{ ok: boolean; elapsedMs: number; minIntervalMs: number }> {
  if (platform === 'hyperliquid' || count <= 0) {
    return { ok: true, elapsedMs: Infinity, minIntervalMs: 0 };
  }

  const cfg = loadConfig();
  const minIntervalMs = 60000 / cfg.ARB_GLOBAL_MAX_TRADES_PER_MIN;
  const now = Date.now();

  // Atomic check-and-stamp: GET + compare + SET in one Lua execution so a
  // concurrent checker can never slip between the read and the write.
  const result = (await redis.eval(
    `local last = redis.call("get", KEYS[1])
     local now = tonumber(ARGV[1])
     local minInt = tonumber(ARGV[2])
     local count = tonumber(ARGV[3])
     local elapsed = -1
     if last then elapsed = now - tonumber(last) end
     if last and elapsed < minInt then
       return {0, tostring(elapsed)}
     end
     redis.call("set", KEYS[1], tostring(now + (count - 1) * minInt))
     return {1, tostring(elapsed)}`,
    1,
    GOVERNOR_LAST_TRADE_KEY,
    String(now),
    String(minIntervalMs),
    String(count),
  )) as [number, string];

  const elapsedRaw = parseFloat(result[1]);
  const elapsedMs = elapsedRaw < 0 ? Infinity : elapsedRaw;
  return { ok: result[0] === 1, elapsedMs, minIntervalMs };
}
