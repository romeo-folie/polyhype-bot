import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../config.js', () => ({
  loadConfig: jest.fn(() => ({
    BANKROLL_USD: 100,
  })),
}));

// Suppress logger output in tests
jest.unstable_mockModule('../logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { getBankroll, setBankroll, deductStake, creditProceeds } = await import('../bankroll.js');

function makeRedis() {
  const store = new Map<string, string>();
  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, ...args: unknown[]) => {
      // Support NX flag — return null if key exists and NX is passed
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    incrbyfloat: jest.fn(async (key: string, increment: number) => {
      const current = parseFloat(store.get(key) ?? '0');
      const updated = current + increment;
      store.set(key, updated.toFixed(6));
      return updated.toFixed(6);
    }),
    _store: store,
  };
}

describe('bankroll', () => {
  let redis: ReturnType<typeof makeRedis>;

  beforeEach(() => {
    redis = makeRedis();
  });

  it('cold start returns config value and seeds Redis with NX', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getBankroll(redis as any);
    expect(result).toBe(100);
    expect(redis._store.get('bankroll:current')).toBe('100.000000');
  });

  it('returns existing value from Redis on warm start', async () => {
    redis._store.set('bankroll:current', '85.500000');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getBankroll(redis as any);
    expect(result).toBeCloseTo(85.5);
  });

  it('setBankroll writes absolute value', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await setBankroll(redis as any, 42.123);
    expect(redis._store.get('bankroll:current')).toBe('42.123000');
  });

  it('deductStake reduces correctly via INCRBYFLOAT', async () => {
    redis._store.set('bankroll:current', '100.000000');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = await deductStake(redis as any, 25);
    expect(updated).toBeCloseTo(75);
    expect(redis.incrbyfloat).toHaveBeenCalledWith('bankroll:current', -25);
  });

  it('deductStake clamps at 0 when overdrawing', async () => {
    redis._store.set('bankroll:current', '10.000000');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = await deductStake(redis as any, 50);
    expect(updated).toBe(0);
    // After clamping, key should be '0.000000'
    expect(redis._store.get('bankroll:current')).toBe('0.000000');
  });

  it('creditProceeds increases correctly via INCRBYFLOAT', async () => {
    redis._store.set('bankroll:current', '75.000000');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = await creditProceeds(redis as any, 30);
    expect(updated).toBeCloseTo(105);
    expect(redis.incrbyfloat).toHaveBeenCalledWith('bankroll:current', 30);
  });

  it('getBankroll returns updated value after mutations', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getBankroll(redis as any); // cold start → 100
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deductStake(redis as any, 20); // → 80
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await creditProceeds(redis as any, 10); // → 90
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getBankroll(redis as any);
    expect(result).toBeCloseTo(90);
  });

  it('cold-start NX does not overwrite concurrent seed', async () => {
    // Simulate another process already seeding
    redis._store.set('bankroll:current', '200.000000');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getBankroll(redis as any);
    // Should return the existing 200, not overwrite with config's 100
    expect(result).toBe(200);
  });
});
