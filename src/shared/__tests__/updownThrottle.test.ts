import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import {
  countRecentUpDownTrades,
  recordUpDownTrade,
  recordUpDownOutcome,
  evaluateUpDownPnlGate,
  UPDOWN_TRADES_KEY,
  UPDOWN_OUTCOMES_KEY,
  UPDOWN_PNL_COOLDOWN_KEY,
} from '../updownThrottle.js';

function makeRedis() {
  return {
    zremrangebyscore: vi.fn().mockResolvedValue(0),
    zcard: vi.fn().mockResolvedValue(0),
    zadd: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    lpush: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue('OK'),
    lrange: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  } as unknown as Redis & Record<string, ReturnType<typeof vi.fn>>;
}

describe('countRecentUpDownTrades', () => {
  it('trims old entries then returns cardinality', async () => {
    const redis = makeRedis();
    (redis.zcard as ReturnType<typeof vi.fn>).mockResolvedValueOnce(2);

    const n = await countRecentUpDownTrades(redis);
    expect(n).toBe(2);
    expect(redis.zremrangebyscore).toHaveBeenCalledWith(
      UPDOWN_TRADES_KEY,
      0,
      expect.any(Number),
    );
    const cutoff = (redis.zremrangebyscore as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(60 * 60 * 1000 - 100);
  });
});

describe('recordUpDownTrade', () => {
  it('zadds with timestamp and sets expiry', async () => {
    const redis = makeRedis();
    await recordUpDownTrade(redis, 'mkt-1', 'DOWN');
    expect(redis.zadd).toHaveBeenCalledWith(
      UPDOWN_TRADES_KEY,
      expect.any(Number),
      expect.stringMatching(/^mkt-1:DOWN:\d+$/),
    );
    expect(redis.expire).toHaveBeenCalledWith(UPDOWN_TRADES_KEY, 7200);
  });
});

describe('recordUpDownOutcome', () => {
  it('lpushes result and trims to window', async () => {
    const redis = makeRedis();
    await recordUpDownOutcome(redis, 'W', 5);
    expect(redis.lpush).toHaveBeenCalledWith(UPDOWN_OUTCOMES_KEY, 'W');
    expect(redis.ltrim).toHaveBeenCalledWith(UPDOWN_OUTCOMES_KEY, 0, 4);
    expect(redis.expire).toHaveBeenCalledWith(UPDOWN_OUTCOMES_KEY, 7 * 24 * 3600);
  });
});

describe('evaluateUpDownPnlGate', () => {
  const baseCfg = { windowSize: 5, minWinRate: 0.4, minSamples: 3, cooldownMin: 30 };

  it('passes when cooldown absent and no outcomes', async () => {
    const redis = makeRedis();
    const r = await evaluateUpDownPnlGate(redis, baseCfg);
    expect(r.blocked).toBe(false);
  });

  it('blocks when cooldown key present', async () => {
    const redis = makeRedis();
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce('1');
    const r = await evaluateUpDownPnlGate(redis, baseCfg);
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('cooldown_active');
  });

  it('does not trigger cooldown below min_samples', async () => {
    const redis = makeRedis();
    (redis.lrange as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['L', 'L']);
    const r = await evaluateUpDownPnlGate(redis, baseCfg);
    expect(r.blocked).toBe(false);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('triggers cooldown when win rate below threshold', async () => {
    const redis = makeRedis();
    (redis.lrange as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['L', 'L', 'L', 'W', 'L']);
    const r = await evaluateUpDownPnlGate(redis, baseCfg);
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('cooldown_triggered');
    expect(r.winRate).toBeCloseTo(0.2, 5);
    expect(redis.set).toHaveBeenCalledWith(
      UPDOWN_PNL_COOLDOWN_KEY,
      '1',
      'EX',
      30 * 60,
    );
  });

  it('passes when win rate meets threshold', async () => {
    const redis = makeRedis();
    (redis.lrange as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['W', 'W', 'L', 'W', 'L']);
    const r = await evaluateUpDownPnlGate(redis, baseCfg);
    expect(r.blocked).toBe(false);
    expect(r.winRate).toBeCloseTo(0.6, 5);
    expect(redis.set).not.toHaveBeenCalled();
  });
});
