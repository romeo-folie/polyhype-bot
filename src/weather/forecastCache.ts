/**
 * Last-good forecast cache.
 *
 * Every successful ForecastResult from the scanner and the invalidation
 * evaluator is written here with a TTL; the invalidation evaluator reads it as
 * a LAST RESORT when live fetches fail. On a 30-minute monitoring cadence a
 * ≤3h-stale forecast beats a blind skip — the 2026-06-04 Open-Meteo outage
 * made the entire invalidation sweep skip every position for multiple scans.
 *
 * Fresh ENTRIES never read this cache: a scan miss stays a miss.
 *
 * Key: weather:forecast_cache:<metric>:<city>:<YYYY-MM-DD>
 * Payload: JSON ForecastResult (shadowEnsemble stripped — calibration-only
 * data, not needed for invalidation decisions) + fetchedAt for observability.
 *
 * The metric segment keeps a city's highest- and lowest-temperature forecasts
 * (which differ) in separate cache entries for the same city/date.
 */

import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import type { ForecastResult } from './weatherScanner.js';

const CACHE_KEY_PREFIX = 'weather:forecast_cache:';

export function forecastCacheKey(
  city: string,
  targetDate: string,
  metric: 'high' | 'low' = 'high',
): string {
  return `${CACHE_KEY_PREFIX}${metric}:${city}:${targetDate}`;
}

/** Cached payload = ForecastResult minus shadowEnsemble, plus fetchedAt. */
export interface CachedForecast extends Omit<ForecastResult, 'shadowEnsemble'> {
  fetchedAt: string;
}

/**
 * Persist a successful forecast (best-effort — callers fire-and-forget).
 * Cache-sourced results must NOT be re-written; callers only write forecasts
 * obtained from a live fetch so the TTL reflects true data age.
 */
export async function cacheForecast(
  redis: Redis,
  city: string,
  targetDate: string,
  forecast: ForecastResult,
): Promise<void> {
  const cfg = loadConfig();
  const { shadowEnsemble: _shadow, ...rest } = forecast;
  const payload: CachedForecast = { ...rest, fetchedAt: new Date().toISOString() };
  await redis.set(
    forecastCacheKey(city, targetDate, forecast.metric ?? 'high'),
    JSON.stringify(payload),
    'EX',
    cfg.WEATHER_FORECAST_CACHE_TTL_S,
  );
}

/**
 * Read the last-good forecast for (city, targetDate), or null when absent,
 * corrupt, or missing required fields.
 */
export async function readCachedForecast(
  redis: Redis,
  city: string,
  targetDate: string,
  metric: 'high' | 'low' = 'high',
): Promise<ForecastResult | null> {
  const raw = await redis.get(forecastCacheKey(city, targetDate, metric));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedForecast>;
    if (
      typeof parsed.forecastHigh !== 'number' ||
      !Number.isFinite(parsed.forecastHigh) ||
      typeof parsed.stdDev !== 'number' ||
      !Number.isFinite(parsed.stdDev) ||
      typeof parsed.source !== 'string'
    ) {
      return null;
    }
    logger.debug('[weather] forecast cache hit', {
      city,
      targetDate,
      metric,
      source: parsed.source,
      fetchedAt: parsed.fetchedAt,
    });
    return {
      forecastHigh: parsed.forecastHigh,
      // Fall back to the requested metric when older cache entries predate the field.
      metric: parsed.metric ?? metric,
      stdDev: parsed.stdDev,
      source: parsed.source,
      ensembleMembers: typeof parsed.ensembleMembers === 'number' ? parsed.ensembleMembers : 0,
      ensembleModel: parsed.ensembleModel ?? 'none',
      shadowEnsemble: null,
    };
  } catch {
    return null;
  }
}

// ── Shadow-ensemble last-good cache ─────────────────────────────────────────
//
// The dual-ensemble shadow (the alternate model — ECMWF when GFS is primary)
// is fetched on a SECOND Open-Meteo ensemble call per event, so it is the first
// to be 429-rate-limited even when the primary forecast succeeds. A null shadow
// hard-blocks every resolution-day fresh entry (the early-entry veto fails closed
// on null shadowEdge), so we cache the last-good shadow spread separately and let
// the scanner fall back to it when a fresh shadow fetch returns null. Only the
// stdDev/members/model are needed: shadowEdge reuses the PRIMARY (fresh) forecast
// centre and only swaps in the shadow's spread.

const SHADOW_ENSEMBLE_CACHE_PREFIX = 'weather:shadow_ensemble_cache:';

/** The non-null shape of ForecastResult.shadowEnsemble. */
export type ShadowEnsemble = NonNullable<ForecastResult['shadowEnsemble']>;

export function shadowEnsembleCacheKey(
  city: string,
  targetDate: string,
  metric: 'high' | 'low' = 'high',
): string {
  return `${SHADOW_ENSEMBLE_CACHE_PREFIX}${metric}:${city}:${targetDate}`;
}

interface CachedShadowEnsemble extends ShadowEnsemble {
  fetchedAt: string;
}

/**
 * Persist a freshly-fetched shadow ensemble (best-effort, fire-and-forget).
 * Callers must only pass a shadow obtained from a live fetch — never a
 * cache-sourced one — so the TTL reflects true data age.
 */
export async function cacheShadowEnsemble(
  redis: Redis,
  city: string,
  targetDate: string,
  metric: 'high' | 'low',
  shadow: ShadowEnsemble,
): Promise<void> {
  const cfg = loadConfig();
  const payload: CachedShadowEnsemble = { ...shadow, fetchedAt: new Date().toISOString() };
  await redis.set(
    shadowEnsembleCacheKey(city, targetDate, metric),
    JSON.stringify(payload),
    'EX',
    // Longer than the primary forecast cache: the shadow spread is stable intraday and
    // must survive the sustained daily ensemble-endpoint outage.
    cfg.WEATHER_SHADOW_ENSEMBLE_CACHE_TTL_S,
  );
}

/**
 * Read the last-good shadow ensemble for (city, targetDate, metric), or null
 * when absent, corrupt, or missing required fields. stdDev must be finite and
 * positive (it enters a normal CDF) and the model must be a known ensemble.
 */
export async function readCachedShadowEnsemble(
  redis: Redis,
  city: string,
  targetDate: string,
  metric: 'high' | 'low' = 'high',
): Promise<ShadowEnsemble | null> {
  const raw = await redis.get(shadowEnsembleCacheKey(city, targetDate, metric));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedShadowEnsemble>;
    if (
      typeof parsed.stdDev !== 'number' ||
      !Number.isFinite(parsed.stdDev) ||
      parsed.stdDev <= 0 ||
      (parsed.ensembleModel !== 'gfs' && parsed.ensembleModel !== 'ecmwf')
    ) {
      return null;
    }
    logger.debug('[weather] shadow ensemble cache hit', {
      city,
      targetDate,
      metric,
      ensembleModel: parsed.ensembleModel,
      fetchedAt: parsed.fetchedAt,
    });
    return {
      stdDev: parsed.stdDev,
      ensembleMembers: typeof parsed.ensembleMembers === 'number' ? parsed.ensembleMembers : 0,
      ensembleModel: parsed.ensembleModel,
    };
  } catch {
    return null;
  }
}
