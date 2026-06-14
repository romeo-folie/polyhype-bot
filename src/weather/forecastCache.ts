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
      source: parsed.source as ForecastResult['source'],
      ensembleMembers: typeof parsed.ensembleMembers === 'number' ? parsed.ensembleMembers : 0,
      ensembleModel: (parsed.ensembleModel as ForecastResult['ensembleModel']) ?? 'none',
      shadowEnsemble: null,
    };
  } catch {
    return null;
  }
}
