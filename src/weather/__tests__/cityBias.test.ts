import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock noaaClient so canonicalCityKey works without the real module resolving ESM
vi.mock('../noaaClient.js', async () => {
  const actual = await vi.importActual<typeof import('../noaaClient.js')>('../noaaClient.js');
  return { ...actual };
});

const { computeCityBias, getCityBias, computeCityBaseRates, getCityActuals } = await import('../cityBias.js');

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
      { city: 'chicago', sample_size: 20, mean_bias: 1.5, empirical_stddev: 2.3, raw_mae: 2.0, corrected_mae: 1.4 },
      { city: 'miami',   sample_size: 16, mean_bias: -0.8, empirical_stddev: 1.7, raw_mae: 1.2, corrected_mae: 1.25 },
    ]);
    const redis = makeRedis();

    await computeCityBias(sql as never, redis as never, 14);

    expect(redis.set).toHaveBeenCalledTimes(2);
    const chicagoCall = redis.set.mock.calls.find((c) => (c[0]).includes('chicago'));
    expect(chicagoCall).toBeDefined();
    const payload = JSON.parse(chicagoCall![1]) as {
      meanBias: number; empiricalStddev: number; rawMae: number; correctedMae: number; meanShiftHelpful: boolean; sampleSize: number;
    };
    expect(payload.meanBias).toBeCloseTo(1.5, 2);
    expect(payload.empiricalStddev).toBeCloseTo(2.3, 2);
    expect(payload.rawMae).toBeCloseTo(2.0, 2);
    expect(payload.correctedMae).toBeCloseTo(1.4, 2);
    expect(payload.meanShiftHelpful).toBe(true);
    expect(payload.sampleSize).toBe(20);
  });

  it('applies 7-day TTL when writing to Redis', async () => {
    const sql = makeSql([
      { city: 'nyc', sample_size: 15, mean_bias: 0.5, empirical_stddev: 1.1, raw_mae: 1.0, corrected_mae: 0.7 },
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

  it('clamps the sample window to WEATHER_BIAS_SAMPLES_SINCE when later than the EWMA lookback', async () => {
    // After a station/coords change, pre-cutover samples were measured against
    // a different thermometer — they must not enter the EWMA.
    const sql = makeSql([]);
    const redis = makeRedis();
    const since = new Date(Date.now() - 2 * 86_400_000).toISOString(); // 2 days ago, inside 28d lookback

    await computeCityBias(sql as never, redis as never, 14, since);

    const dateParam = (sql.mock.calls[0] as unknown[]).find((v) => v instanceof Date)!;
    expect(dateParam).toBeDefined();
    expect(dateParam.getTime()).toBe(new Date(since).getTime());
  });

  it('falls back to the EWMA lookback when the cutover is older or absent', async () => {
    const sql = makeSql([]);
    const redis = makeRedis();
    const ancient = new Date(Date.now() - 365 * 86_400_000).toISOString();

    await computeCityBias(sql as never, redis as never, 14, ancient);

    const dateParam = (sql.mock.calls[0] as unknown[]).find((v) => v instanceof Date)!;
    const expectedFloor = Date.now() - 28 * 86_400_000;
    expect(Math.abs(dateParam.getTime() - expectedFloor)).toBeLessThan(60_000);
  });

  it('ignores an unparseable cutover instead of breaking the bias refresh', async () => {
    const sql = makeSql([]);
    const redis = makeRedis();

    await expect(
      computeCityBias(sql as never, redis as never, 14, 'not-a-date'),
    ).resolves.not.toThrow();

    const dateParam = (sql.mock.calls[0] as unknown[]).find((v) => v instanceof Date)!;
    const expectedFloor = Date.now() - 28 * 86_400_000;
    expect(Math.abs(dateParam.getTime() - expectedFloor)).toBeLessThan(60_000);
  });

  it('uses canonical city key in Redis key', async () => {
    const sql = makeSql([
      { city: 'new york', sample_size: 20, mean_bias: 1.0, empirical_stddev: 1.5, raw_mae: 1.5, corrected_mae: 1.0 },
    ]);
    const redis = makeRedis();

    await computeCityBias(sql as never, redis as never, 14);

    const calls = redis.set.mock.calls;
    expect(calls.length).toBe(1);
    const key = calls[0]![0];
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
      rawMae: 2.0,
      correctedMae: 1.4,
      meanShiftHelpful: true,
      sampleSize: 20,
      updatedAt: '2026-04-19T00:00:00Z',
    };
    redis._store.set('weather:city_bias:chicago', { value: JSON.stringify(bias), ttl: 604800 });

    const result = await getCityBias(redis as never, 'chicago');
    expect(result).not.toBeNull();
    expect(result!.meanBias).toBeCloseTo(1.5, 2);
    expect(result!.empiricalStddev).toBeCloseTo(2.3, 2);
    expect(result!.meanShiftHelpful).toBe(true);
    expect(result!.sampleSize).toBe(20);
  });

  it('treats legacy cached payloads without meanShiftHelpful as non-helpful', async () => {
    const bias = {
      meanBias: 1.5,
      empiricalStddev: 2.3,
      sampleSize: 20,
      updatedAt: '2026-04-19T00:00:00Z',
    };
    redis._store.set('weather:city_bias:chicago', { value: JSON.stringify(bias), ttl: 604800 });

    const result = await getCityBias(redis as never, 'chicago');
    expect(result).not.toBeNull();
    expect(result!.meanShiftHelpful).toBe(false);
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

// ---------------------------------------------------------------------------
// computeCityBaseRates
// ---------------------------------------------------------------------------

describe('computeCityBaseRates', () => {
  it('writes actuals to Redis for cities with rows', async () => {
    const sql = makeSql([
      { city: 'chicago', unit: 'fahrenheit', highs: [72, 68, 75, 70, 71], sample_size: 5 },
      { city: 'paris',   unit: 'celsius',    highs: [28, 30, 29, 27, 31], sample_size: 5 },
    ]);
    const redis = makeRedis();

    await computeCityBaseRates(sql as never, redis as never, 14);

    expect(redis.set).toHaveBeenCalledTimes(2);
    const chicagoCall = redis.set.mock.calls.find((c) => (c[0]).includes('chicago'));
    expect(chicagoCall).toBeDefined();
    const payload = JSON.parse(chicagoCall![1]) as { highs: number[]; unit: string; sampleSize: number };
    expect(payload.highs).toEqual([72, 68, 75, 70, 71]);
    expect(payload.unit).toBe('fahrenheit');
    expect(payload.sampleSize).toBe(5);
  });

  it('applies 36h TTL when writing to Redis', async () => {
    const sql = makeSql([
      { city: 'nyc', unit: 'fahrenheit', highs: [68, 72], sample_size: 2 },
    ]);
    const redis = makeRedis();

    await computeCityBaseRates(sql as never, redis as never, 14);

    const call = redis.set.mock.calls[0];
    expect(call).toBeDefined();
    expect(call![3]).toBe(36 * 60 * 60);
  });

  it('does not write when SQL returns no rows', async () => {
    const sql = makeSql([]);
    const redis = makeRedis();

    await computeCityBaseRates(sql as never, redis as never, 14);

    expect(redis.set).not.toHaveBeenCalled();
  });

  it('handles SQL error gracefully — does not throw', async () => {
    const sql = vi.fn().mockRejectedValue(new Error('DB down'));
    const redis = makeRedis();

    await expect(computeCityBaseRates(sql as never, redis as never)).resolves.not.toThrow();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('uses weather:actuals: key prefix', async () => {
    const sql = makeSql([
      { city: 'chicago', unit: 'fahrenheit', highs: [70], sample_size: 1 },
    ]);
    const redis = makeRedis();

    await computeCityBaseRates(sql as never, redis as never, 14);

    const key = redis.set.mock.calls[0]![0];
    expect(key).toMatch(/^weather:actuals:/);
  });

  it('uses postgres cast (CURRENT_DATE - $n::int)::date in the actuals query', async () => {
    // Regression guard: the query previously used `CURRENT_DATE - ${lookbackDays}` without
    // an explicit cast, which caused a type error on some postgres versions.
    // Verify the template strings surrounding the interpolated lookbackDays contain the cast.
    const sql = makeSql([]);
    await computeCityBaseRates(sql as never, makeRedis() as never, 14);

    const [strings, lookbackArg] = sql.mock.calls[0] as [TemplateStringsArray, number];
    expect(strings[0]).toContain('(CURRENT_DATE - ');
    expect(strings[1]).toContain('::int)::date');
    expect(lookbackArg).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// getCityActuals
// ---------------------------------------------------------------------------

describe('getCityActuals', () => {
  let redis: ReturnType<typeof makeRedis>;

  beforeEach(() => {
    redis = makeRedis();
  });

  it('returns null when key is absent', async () => {
    const result = await getCityActuals(redis as never, 'chicago');
    expect(result).toBeNull();
  });

  it('returns parsed CityActuals when key exists', async () => {
    const actuals = {
      highs: [72, 68, 75],
      unit: 'fahrenheit',
      sampleSize: 3,
      updatedAt: '2026-05-26T00:00:00Z',
    };
    redis._store.set('weather:actuals:chicago', { value: JSON.stringify(actuals), ttl: 86400 });

    const result = await getCityActuals(redis as never, 'chicago');
    expect(result).not.toBeNull();
    expect(result!.highs).toEqual([72, 68, 75]);
    expect(result!.unit).toBe('fahrenheit');
    expect(result!.sampleSize).toBe(3);
  });

  it('returns null when stored JSON is malformed', async () => {
    redis._store.set('weather:actuals:chicago', { value: 'not-json', ttl: 86400 });
    const result = await getCityActuals(redis as never, 'chicago');
    expect(result).toBeNull();
  });

  it('returns null when highs field is not an array', async () => {
    redis._store.set(
      'weather:actuals:miami',
      { value: JSON.stringify({ highs: 'bad', unit: 'celsius', sampleSize: 5 }), ttl: 86400 },
    );
    const result = await getCityActuals(redis as never, 'miami');
    expect(result).toBeNull();
  });
});
