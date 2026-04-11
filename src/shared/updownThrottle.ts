import type { Redis } from 'ioredis';

export const UPDOWN_TRADES_KEY = 'updown:trades:recent';
export const UPDOWN_OUTCOMES_KEY = 'updown:outcomes:recent';
export const UPDOWN_PNL_COOLDOWN_KEY = 'updown:pnl_cooldown';

const WINDOW_MS = 60 * 60 * 1000;

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
