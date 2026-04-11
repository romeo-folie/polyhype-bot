import type { Redis } from 'ioredis';

export const UPDOWN_TRADES_KEY = 'updown:trades:recent';
export const UPDOWN_OUTCOMES_KEY = 'updown:outcomes:recent';
export const UPDOWN_PNL_COOLDOWN_KEY = 'updown:pnl_cooldown';
export const UPDOWN_MARKET_LOCK_PREFIX = 'updown:market_locked:';

const WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MARKET_LOCK_TTL_S = 60 * 60; // fallback when endDate missing
const MIN_MARKET_LOCK_TTL_S = 60; // keep lock at least a minute after resolution

export async function countRecentUpDownTrades(redis: Redis): Promise<number> {
  const cutoff = Date.now() - WINDOW_MS;
  await redis.zremrangebyscore(UPDOWN_TRADES_KEY, 0, cutoff);
  return redis.zcard(UPDOWN_TRADES_KEY);
}

export async function recordUpDownTrade(
  redis: Redis,
  marketId: string,
  direction: 'UP' | 'DOWN',
): Promise<void> {
  const now = Date.now();
  const member = `${marketId}:${direction}:${now}`;
  await redis.zadd(UPDOWN_TRADES_KEY, now, member);
  await redis.expire(UPDOWN_TRADES_KEY, Math.ceil((WINDOW_MS * 2) / 1000));
}

export async function isUpDownMarketLocked(
  redis: Redis,
  marketId: string,
): Promise<boolean> {
  const v = await redis.get(`${UPDOWN_MARKET_LOCK_PREFIX}${marketId}`);
  return v !== null;
}

/**
 * Lock a market against further Up/Down entries of *any* direction. Kills
 * whipsaw where confluence flips UP→DOWN (or vice versa) within a 5-min
 * market's lifetime and the scanner happily enters both sides of the same
 * binary outcome.
 *
 * TTL is pinned to the market's own endDate (plus a small pad) when known,
 * so the key evaporates with the market and doesn't linger. Falls back to
 * 1h when endDate is missing.
 */
export async function lockUpDownMarket(
  redis: Redis,
  marketId: string,
  endDate: string | null,
): Promise<void> {
  let ttl = DEFAULT_MARKET_LOCK_TTL_S;
  if (endDate) {
    const endMs = Date.parse(endDate);
    if (Number.isFinite(endMs)) {
      const secsLeft = Math.ceil((endMs - Date.now()) / 1000) + MIN_MARKET_LOCK_TTL_S;
      if (secsLeft > MIN_MARKET_LOCK_TTL_S) {
        ttl = secsLeft;
      } else {
        ttl = MIN_MARKET_LOCK_TTL_S;
      }
    }
  }
  await redis.set(`${UPDOWN_MARKET_LOCK_PREFIX}${marketId}`, '1', 'EX', ttl);
}

export async function recordUpDownOutcome(
  redis: Redis,
  result: 'W' | 'L',
  windowSize: number,
): Promise<void> {
  await redis.lpush(UPDOWN_OUTCOMES_KEY, result);
  await redis.ltrim(UPDOWN_OUTCOMES_KEY, 0, windowSize - 1);
  await redis.expire(UPDOWN_OUTCOMES_KEY, 7 * 24 * 3600);
}

export interface PnlGateResult {
  blocked: boolean;
  reason?: 'cooldown_active' | 'cooldown_triggered';
  winRate?: number;
  samples?: number;
}

export async function evaluateUpDownPnlGate(
  redis: Redis,
  cfg: {
    windowSize: number;
    minWinRate: number;
    minSamples: number;
    cooldownMin: number;
  },
): Promise<PnlGateResult> {
  const cooldownActive = await redis.get(UPDOWN_PNL_COOLDOWN_KEY);
  if (cooldownActive) {
    return { blocked: true, reason: 'cooldown_active' };
  }
  const recentOutcomes = await redis.lrange(UPDOWN_OUTCOMES_KEY, 0, cfg.windowSize - 1);
  if (recentOutcomes.length < cfg.minSamples) {
    return { blocked: false, samples: recentOutcomes.length };
  }
  const wins = recentOutcomes.filter((o) => o === 'W').length;
  const winRate = wins / recentOutcomes.length;
  if (winRate < cfg.minWinRate) {
    await redis.set(UPDOWN_PNL_COOLDOWN_KEY, '1', 'EX', cfg.cooldownMin * 60);
    return {
      blocked: true,
      reason: 'cooldown_triggered',
      winRate,
      samples: recentOutcomes.length,
    };
  }
  return { blocked: false, winRate, samples: recentOutcomes.length };
}
