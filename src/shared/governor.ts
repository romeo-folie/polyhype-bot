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
