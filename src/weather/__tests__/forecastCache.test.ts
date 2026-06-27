/**
 * Tests for the last-good forecast cache (forecastCache.ts).
 *
 * The cache lets the invalidation evaluator survive forecast-provider outages:
 * written on every successful fetch (scanner + invalidation), read only as the
 * invalidation evaluator's last resort.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockLoadConfig = vi.fn(() => ({ WEATHER_FORECAST_CACHE_TTL_S: 10_800 }));
vi.mock('../../shared/config.js', () => ({ loadConfig: mockLoadConfig }));

const {
  cacheForecast, readCachedForecast, forecastCacheKey,
  cacheShadowEnsemble, readCachedShadowEnsemble, shadowEnsembleCacheKey,
} = await import('../forecastCache.js');

function makeRedis(store = new Map<string, string>()) {
  return {
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    _store: store,
  };
}

function makeForecast() {
  return {
    forecastHigh: 17.8,
    stdDev: 1.4,
    source: 'open-meteo' as const,
    ensembleMembers: 31,
    ensembleModel: 'gfs' as const,
    shadowEnsemble: { stdDev: 1.1, ensembleMembers: 51, ensembleModel: 'ecmwf' as const },
  };
}

describe('forecastCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the forecast under weather:forecast_cache:<city>:<date> with the config TTL', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cacheForecast(redis as any, 'amsterdam', '2026-06-04', makeForecast());

    expect(redis.set).toHaveBeenCalledWith(
      'weather:forecast_cache:high:amsterdam:2026-06-04',
      expect.any(String),
      'EX',
      10_800,
    );
  });

  it('strips shadowEnsemble from the payload and stamps fetchedAt', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cacheForecast(redis as any, 'amsterdam', '2026-06-04', makeForecast());

    const raw = redis._store.get(forecastCacheKey('amsterdam', '2026-06-04'))!;
    const payload = JSON.parse(raw) as Record<string, unknown>;
    expect(payload.shadowEnsemble).toBeUndefined();
    expect(typeof payload.fetchedAt).toBe('string');
    expect(payload.forecastHigh).toBe(17.8);
  });

  it('round-trips: readCachedForecast returns the written forecast (shadowEnsemble nulled)', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cacheForecast(redis as any, 'amsterdam', '2026-06-04', makeForecast());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readCachedForecast(redis as any, 'amsterdam', '2026-06-04');

    expect(result).not.toBeNull();
    expect(result!.forecastHigh).toBe(17.8);
    expect(result!.stdDev).toBe(1.4);
    expect(result!.source).toBe('open-meteo');
    expect(result!.ensembleMembers).toBe(31);
    expect(result!.shadowEnsemble).toBeNull();
  });

  it('returns null on a cache miss', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readCachedForecast(redis as any, 'amsterdam', '2026-06-04');
    expect(result).toBeNull();
  });

  it('returns null on corrupt JSON', async () => {
    const redis = makeRedis();
    redis._store.set(forecastCacheKey('amsterdam', '2026-06-04'), '{not json');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readCachedForecast(redis as any, 'amsterdam', '2026-06-04');
    expect(result).toBeNull();
  });

  it('returns null when required numeric fields are missing or non-finite', async () => {
    const redis = makeRedis();
    redis._store.set(
      forecastCacheKey('amsterdam', '2026-06-04'),
      JSON.stringify({ stdDev: 1.2, source: 'open-meteo' }), // no forecastHigh
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await readCachedForecast(redis as any, 'amsterdam', '2026-06-04')).toBeNull();

    redis._store.set(
      forecastCacheKey('amsterdam', '2026-06-04'),
      JSON.stringify({ forecastHigh: Infinity, stdDev: 1.2, source: 'open-meteo' }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await readCachedForecast(redis as any, 'amsterdam', '2026-06-04')).toBeNull();
  });
});

describe('forecastCache — shadow ensemble', () => {
  const shadow = { stdDev: 1.1, ensembleMembers: 51, ensembleModel: 'ecmwf' as const };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the shadow under weather:shadow_ensemble_cache:<metric>:<city>:<date> with the config TTL', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cacheShadowEnsemble(redis as any, 'tokyo', '2026-06-27', 'high', shadow);

    expect(redis.set).toHaveBeenCalledWith(
      'weather:shadow_ensemble_cache:high:tokyo:2026-06-27',
      expect.any(String),
      'EX',
      10_800,
    );
  });

  it('round-trips: readCachedShadowEnsemble returns the written shadow (+ stamps fetchedAt)', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cacheShadowEnsemble(redis as any, 'tokyo', '2026-06-27', 'high', shadow);

    const raw = redis._store.get(shadowEnsembleCacheKey('tokyo', '2026-06-27'))!;
    expect(typeof (JSON.parse(raw) as { fetchedAt?: unknown }).fetchedAt).toBe('string');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readCachedShadowEnsemble(redis as any, 'tokyo', '2026-06-27');
    expect(result).toEqual(shadow);
  });

  it('keeps high and low shadow caches separate (metric in the key)', async () => {
    const redis = makeRedis();
    const lowShadow = { stdDev: 0.9, ensembleMembers: 31, ensembleModel: 'gfs' as const };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cacheShadowEnsemble(redis as any, 'tokyo', '2026-06-27', 'high', shadow);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cacheShadowEnsemble(redis as any, 'tokyo', '2026-06-27', 'low', lowShadow);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await readCachedShadowEnsemble(redis as any, 'tokyo', '2026-06-27', 'high')).toEqual(shadow);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await readCachedShadowEnsemble(redis as any, 'tokyo', '2026-06-27', 'low')).toEqual(lowShadow);
  });

  it('returns null on a cache miss', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await readCachedShadowEnsemble(redis as any, 'tokyo', '2026-06-27')).toBeNull();
  });

  it('returns null on corrupt JSON', async () => {
    const redis = makeRedis();
    redis._store.set(shadowEnsembleCacheKey('tokyo', '2026-06-27'), '{nope');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await readCachedShadowEnsemble(redis as any, 'tokyo', '2026-06-27')).toBeNull();
  });

  it('returns null on invalid stdDev (≤0 / non-finite) or unknown ensemble model', async () => {
    const redis = makeRedis();
    const k = shadowEnsembleCacheKey('tokyo', '2026-06-27');

    redis._store.set(k, JSON.stringify({ stdDev: 0, ensembleMembers: 51, ensembleModel: 'ecmwf' }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await readCachedShadowEnsemble(redis as any, 'tokyo', '2026-06-27')).toBeNull();

    redis._store.set(k, JSON.stringify({ stdDev: 1.1, ensembleMembers: 51, ensembleModel: 'none' }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await readCachedShadowEnsemble(redis as any, 'tokyo', '2026-06-27')).toBeNull();
  });
});
