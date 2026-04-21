import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../db/writeQueue.js', () => ({
  enqueueWrite: vi.fn(),
}));

import { getConvictionMultiplier } from '../executor.js';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    CONVICTION_MULTIPLIER_ENABLED: false,
    CONVICTION_BONUS_PER_SOURCE: 0.25,
    CONVICTION_MAX_MULTIPLIER: 1.5,
    CONVICTION_SIGNAL_TTL_S: 1800,
    ...overrides,
  } as ReturnType<typeof import('../../shared/config.js').loadConfig>;
}

function makeRedis() {
  const store = new Map<string, Map<string, number>>();

  const getSet = (key: string): Map<string, number> => {
    if (!store.has(key)) store.set(key, new Map());
    return store.get(key)!;
  };

  return {
    zremrangebyscore: vi.fn(async (key: string, _min: string, max: number) => {
      const s = getSet(key);
      let removed = 0;
      for (const [member, score] of s) {
        if (score <= max) { s.delete(member); removed++; }
      }
      return removed;
    }),
    zadd: vi.fn(async (key: string, score: number, member: string) => {
      const s = getSet(key);
      const isNew = !s.has(member);
      s.set(member, score);
      return isNew ? 1 : 0;
    }),
    expire: vi.fn().mockResolvedValue(1),
    zrangebyscore: vi.fn(async (key: string, min: number, _max: string) => {
      const s = getSet(key);
      return Array.from(s.entries())
        .filter(([, score]) => score >= min)
        .map(([member]) => member);
    }),
    // Helper to pre-seed the store for a given key
    _seed(key: string, entries: { member: string; score: number }[]) {
      const s = getSet(key);
      for (const { member, score } of entries) s.set(member, score);
    },
  };
}

describe('getConvictionMultiplier', () => {
  const MARKET = 'market1';
  const DIR = 'YES';
  const KEY = `signal:recent:${MARKET}:${DIR}`;
  const TTL = 1800;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 1 when no other sources are present', async () => {
    const redis = makeRedis();
    const cfg = makeConfig();
    const result = await getConvictionMultiplier(redis as never, MARKET, DIR, 'osint', cfg);
    expect(result).toBe(1);
  });

  it('returns 1.25x when one other source agrees', async () => {
    const redis = makeRedis();
    const nowS = Math.floor(Date.now() / 1000);
    redis._seed(KEY, [{ member: 'copytrade', score: nowS - 60 }]);
    const cfg = makeConfig();
    const result = await getConvictionMultiplier(redis as never, MARKET, DIR, 'osint', cfg);
    expect(result).toBeCloseTo(1.25);
  });

  it('returns 1.5x when two other sources agree', async () => {
    const redis = makeRedis();
    const nowS = Math.floor(Date.now() / 1000);
    redis._seed(KEY, [
      { member: 'copytrade', score: nowS - 60 },
      { member: 'spot', score: nowS - 30 },
    ]);
    const cfg = makeConfig();
    const result = await getConvictionMultiplier(redis as never, MARKET, DIR, 'osint', cfg);
    expect(result).toBeCloseTo(1.5);
  });

  it('caps at CONVICTION_MAX_MULTIPLIER with many sources', async () => {
    const redis = makeRedis();
    const nowS = Math.floor(Date.now() / 1000);
    redis._seed(KEY, [
      { member: 'copytrade', score: nowS - 10 },
      { member: 'spot', score: nowS - 20 },
      { member: 'oracle-lag', score: nowS - 30 },
      { member: 'arb', score: nowS - 40 },
    ]);
    const cfg = makeConfig({ CONVICTION_MAX_MULTIPLIER: 1.5 });
    const result = await getConvictionMultiplier(redis as never, MARKET, DIR, 'osint', cfg);
    expect(result).toBe(1.5);
  });

  it('excludes current source from the count', async () => {
    const redis = makeRedis();
    const nowS = Math.floor(Date.now() / 1000);
    // Only the current source 'osint' is in the store — no OTHER sources
    redis._seed(KEY, [{ member: 'osint', score: nowS - 10 }]);
    const cfg = makeConfig();
    const result = await getConvictionMultiplier(redis as never, MARKET, DIR, 'osint', cfg);
    expect(result).toBe(1);
  });

  it('prunes stale entries before counting via zremrangebyscore', async () => {
    const redis = makeRedis();
    const nowS = Math.floor(Date.now() / 1000);
    // Seed a stale entry (older than TTL) and a fresh one
    redis._seed(KEY, [
      { member: 'copytrade', score: nowS - TTL - 100 }, // stale
      { member: 'spot', score: nowS - 60 },              // fresh
    ]);
    const cfg = makeConfig();
    const result = await getConvictionMultiplier(redis as never, MARKET, DIR, 'osint', cfg);
    // copytrade is pruned; only spot remains → 1.25x
    expect(result).toBeCloseTo(1.25);
    expect(redis.zremrangebyscore).toHaveBeenCalledWith(KEY, '-inf', expect.any(Number));
  });

  it('calls zadd with correct key format signal:recent:{marketId}:{direction}', async () => {
    const redis = makeRedis();
    const cfg = makeConfig();
    await getConvictionMultiplier(redis as never, MARKET, DIR, 'osint', cfg);
    expect(redis.zadd).toHaveBeenCalledWith(KEY, expect.any(Number), 'osint');
  });

  it('calls expire with TTL * 2 to outlive the window', async () => {
    const redis = makeRedis();
    const cfg = makeConfig();
    await getConvictionMultiplier(redis as never, MARKET, DIR, 'osint', cfg);
    expect(redis.expire).toHaveBeenCalledWith(KEY, TTL * 2);
  });

  it('does not double-count the same source added twice', async () => {
    const redis = makeRedis();
    const nowS = Math.floor(Date.now() / 1000);
    // Pre-seed 'osint' as if it fired before — zadd will update score, not add a new entry
    redis._seed(KEY, [{ member: 'osint', score: nowS - 100 }]);
    const cfg = makeConfig();
    const result = await getConvictionMultiplier(redis as never, MARKET, DIR, 'osint', cfg);
    // Only 'osint' in set; it's the current source → 0 others
    expect(result).toBe(1);
  });
});
