import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock noaaClient so canonicalCityKey works without the real module resolving ESM
vi.mock('../noaaClient.js', async () => {
  const actual = await vi.importActual<typeof import('../noaaClient.js')>('../noaaClient.js');
  return { ...actual };
});

const { computeCityBias, getCityBias } = await import('../cityBias.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSql(rows: Record<string, unknown>[]) {
  // postgres tagged-template mock — returns the fixture rows for any query
  const fn = vi.fn().mockResolvedValue(rows);
  // tagged template call: sql`...` → fn()
  return Object.assign(fn, { [Symbol.iterator]: undefined });
}

function makeRedis() {
  const store = new Map<string, { value: string; ttl: number }>();
  return {
    set: vi.fn(async (key: string, value: string, _ex: string, ttl: number) => {
      store.set(key, { value, ttl });
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    _store: store,
  };
}

// ---------------------------------------------------------------------------
// computeCityBias
// ---------------------------------------------------------------------------

describe('computeCityBias', () => {
  it('writes bias to Redis for cities with enough samples', async () => {
    const sql = makeSql([
      { city: 'chicago', sample_size: 20, mean_bias: 1.5, empirical_stddev: 2.3 },
      { city: 'miami',   sample_size: 16, mean_bias: -0.8, empirical_stddev: 1.7 },
    ]);
    const redis = makeRedis();

    await computeCityBias(sql as never, redis as never, 14);

    expect(redis.set).toHaveBeenCalledTimes(2);
    const chicagoCall = redis.set.mock.calls.find((c) => (c[0] as string).includes('chicago'));
    expect(chicagoCall).toBeDefined();
    const payload = JSON.parse(chicagoCall![1] as string) as {
      meanBias: number; empiricalStddev: number; sampleSize: number;
    };
    expect(payload.meanBias).toBeCloseTo(1.5, 2);
    expect(payload.empiricalStddev).toBeCloseTo(2.3, 2);
    expect(payload.sampleSize).toBe(20);
  });

  it('applies 7-day TTL when writing to Redis', async () => {
    const sql = makeSql([
      { city: 'nyc', sample_size: 15, mean_bias: 0.5, empirical_stddev: 1.1 },
    ]);
    const redis = makeRedis();

    await computeCityBias(sql as never, redis as never, 14);

    const call = redis.set.mock.calls[0];
    expect(call).toBeDefined();
    // 4th arg is the TTL in seconds: 7 * 24 * 60 * 60 = 604800
    expect(call![3]).toBe(604800);
  });

  it('does not write when SQL returns no rows (all cities below minSamples)', async () => {
    const sql = makeSql([]);
    const redis = makeRedis();

    await computeCityBias(sql as never, redis as never, 14);

    expect(redis.set).not.toHaveBeenCalled();
  });

  it('handles SQL error gracefully — does not throw', async () => {
    const sql = vi.fn().mockRejectedValue(new Error('DB connection lost'));
    const redis = makeRedis();

    await expect(computeCityBias(sql as never, redis as never)).resolves.not.toThrow();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('uses canonical city key in Redis key', async () => {
    const sql = makeSql([
      { city: 'new york', sample_size: 20, mean_bias: 1.0, empirical_stddev: 1.5 },
    ]);
    const redis = makeRedis();

    await computeCityBias(sql as never, redis as never, 14);

    const calls = redis.set.mock.calls;
    expect(calls.length).toBe(1);
    const key = calls[0]![0] as string;
    // Key must use the namespace prefix
    expect(key).toMatch(/^weather:city_bias:/);
    // Key must reference the city identity — canonicalized form of "new york"
    expect(key.toLowerCase()).toContain('new york');
  });
});

// ---------------------------------------------------------------------------
// getCityBias
// ---------------------------------------------------------------------------

describe('getCityBias', () => {
  let redis: ReturnType<typeof makeRedis>;

  beforeEach(() => {
    redis = makeRedis();
  });

  it('returns null when key is absent', async () => {
    const result = await getCityBias(redis as never, 'chicago');
    expect(result).toBeNull();
  });

  it('returns parsed CityBias when key exists', async () => {
    const bias = {
      meanBias: 1.5,
      empiricalStddev: 2.3,
      sampleSize: 20,
      updatedAt: '2026-04-19T00:00:00Z',
    };
    redis._store.set('weather:city_bias:chicago', { value: JSON.stringify(bias), ttl: 604800 });

    const result = await getCityBias(redis as never, 'chicago');
    expect(result).not.toBeNull();
    expect(result!.meanBias).toBeCloseTo(1.5, 2);
    expect(result!.empiricalStddev).toBeCloseTo(2.3, 2);
    expect(result!.sampleSize).toBe(20);
  });

  it('returns null when stored JSON is malformed', async () => {
    redis._store.set('weather:city_bias:chicago', { value: 'not-json', ttl: 604800 });
    const result = await getCityBias(redis as never, 'chicago');
    expect(result).toBeNull();
  });

  it('returns null when meanBias field is missing', async () => {
    redis._store.set(
      'weather:city_bias:miami',
      { value: JSON.stringify({ empiricalStddev: 1.5, sampleSize: 10, updatedAt: '2026-04-19T00:00:00Z' }), ttl: 604800 },
    );
    const result = await getCityBias(redis as never, 'miami');
    expect(result).toBeNull();
  });
});
