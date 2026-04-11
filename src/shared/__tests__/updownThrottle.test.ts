import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import {
  countRecentUpDownTrades,
  recordUpDownTrade,
  recordUpDownOutcome,
  evaluateUpDownPnlGate,
  isUpDownMarketLocked,
  lockUpDownMarket,
  UPDOWN_TRADES_KEY,
  UPDOWN_OUTCOMES_KEY,
  UPDOWN_PNL_COOLDOWN_KEY,
  UPDOWN_MARKET_LOCK_PREFIX,
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

describe('isUpDownMarketLocked / lockUpDownMarket', () => {
  it('returns false when the lock key is missing', async () => {
    const redis = makeRedis();
    const locked = await isUpDownMarketLocked(redis, 'mkt-42');
    expect(locked).toBe(false);
    expect(redis.get).toHaveBeenCalledWith(`${UPDOWN_MARKET_LOCK_PREFIX}mkt-42`);
  });

  it('returns true when a lock exists', async () => {
    const redis = makeRedis();
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce('1');
    const locked = await isUpDownMarketLocked(redis, 'mkt-42');
    expect(locked).toBe(true);
  });

  it('locks with endDate-derived TTL when endDate is provided', async () => {
    const redis = makeRedis();
    const endDate = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min out
    await lockUpDownMarket(redis, 'mkt-42', endDate);
    const call = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe(`${UPDOWN_MARKET_LOCK_PREFIX}mkt-42`);
    expect(call[1]).toBe('1');
    expect(call[2]).toBe('EX');
    // ~10min + 60s pad = ~660s, allow small drift from Date.now()
    const ttl = call[3] as number;
    expect(ttl).toBeGreaterThan(600);
    expect(ttl).toBeLessThan(700);
  });

  it('falls back to 1h TTL when endDate is null', async () => {
    const redis = makeRedis();
    await lockUpDownMarket(redis, 'mkt-42', null);
    const call = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[3]).toBe(3600);
  });

  it('clamps to 60s minimum when endDate is already in the past', async () => {
    const redis = makeRedis();
    const endDate = new Date(Date.now() - 60_000).toISOString();
    await lockUpDownMarket(redis, 'mkt-42', endDate);
    const call = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[3]).toBe(60);
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
