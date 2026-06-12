/**
 * Per-city forecast bias computation and retrieval.
 *
 * Reads paired (forecast, observed) rows from shadow_observations ⋈
 * weather_ground_truth, computes mean bias and empirical σ per city, and
 * caches the result in Redis for the scanner to apply at probability-compute
 * time.
 *
 * Log marker: [weather-bias]
 */

import type { Sql } from 'postgres';
import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { CITY_COORDINATES, canonicalCityKey } from './noaaClient.js';

const REDIS_TTL_S = 7 * 24 * 60 * 60; // 7 days
const ACTUALS_REDIS_TTL_S = 36 * 60 * 60; // 36 hours — reconciler runs every 24h; extra 12h guards against jitter/delay
// Recency half-life for EWMA weighting: samples N days old receive 2^(-N/7) weight.
// 7 days means last week's data counts 2× more than data from 2 weeks ago, so
// seasonal drift (e.g. spring marine-layer bias for KLAX) shows up in ~5 days
// instead of the ~12 days a simple mean would take with the same sample volume.
const EWMA_HALF_LIFE_DAYS = 7;
// Lookback window: beyond 4 half-lives the weight is < 7% of today's — negligible.
// Bounding the query lets the DB use a (kind, observed_at DESC) index and keeps
// the join size constant as the shadow table grows over time.
const EWMA_LOOKBACK_DAYS = 4 * EWMA_HALF_LIFE_DAYS; // 28 days

export interface CityBias {
  /** Mean of (forecastHigh − observedHigh) across paired samples. Positive → model runs warm. */
  meanBias: number;
  /** Standard deviation of forecast errors across paired samples. */
  empiricalStddev: number;
  /** Weighted MAE before any city-mean correction is applied. */
  rawMae?: number;
  /** Weighted MAE after subtracting meanBias from the forecast. */
  correctedMae?: number;
  /** True when recent out-of-sample error improved after mean shifting. */
  meanShiftHelpful?: boolean;
  /** Number of paired samples used. */
  sampleSize: number;
  updatedAt: string;
}

function redisKey(city: string): string {
  const canonical = canonicalCityKey(city) ?? city.toLowerCase().trim();
  return `weather:city_bias:${canonical}`;
}

function actualsRedisKey(city: string): string {
  const canonical = canonicalCityKey(city) ?? city.toLowerCase().trim();
  return `weather:actuals:${canonical}`;
}

export interface CityActuals {
  /** Recent WU daily high temperatures (COALESCE(resolution_high, observed_high)), sorted newest-first. */
  highs: number[];
  /** Unit of the values ('celsius' | 'fahrenheit'). */
  unit: string;
  /** Number of valid rows used. */
  sampleSize: number;
  updatedAt: string;
}

/**
 * Compute per-city bias from joined shadow + ground-truth data and write to Redis.
 *
 * Pulls `kind='weather_event'` rows from shadow_observations, extracts
 * `payload->>'forecastHigh'` (cast to float), and joins to weather_ground_truth
 * on (city, target_date). For each city with at least `minSamples` paired rows,
 * writes a CityBias JSON blob to Redis with a 7-day TTL.
 *
 * Designed to be called from the reconciler cron after ground-truth upserts so
 * the bias values always reflect the freshest paired data.
 */
export async function computeCityBias(
  sql: Sql,
  redis: Redis,
  minSamples = 14,
  /**
   * ISO timestamp; samples observed before this are excluded. Set when the
   * forecast coordinates / resolution stations change so pre-cutover pairs
   * (measured against a different thermometer) don't poison the EWMA.
   */
  samplesSince = '',
): Promise<void> {
  try {
    // Effective floor of the sample window: the EWMA lookback, raised to the
    // cutover date when one is configured. Folding it into one bound keeps the
    // query shape (and its index use) identical with or without a cutover.
    const lookbackFloor = new Date(Date.now() - EWMA_LOOKBACK_DAYS * 86_400_000);
    const sinceDate = samplesSince ? new Date(samplesSince) : null;
    if (sinceDate && Number.isNaN(sinceDate.getTime())) {
      logger.warn('[weather-bias] unparseable WEATHER_BIAS_SAMPLES_SINCE — ignoring cutover', {
        samplesSince,
      });
    }
    const windowStart =
      sinceDate && !Number.isNaN(sinceDate.getTime()) && sinceDate > lookbackFloor
        ? sinceDate
        : lookbackFloor;
    const rows = await sql<{
      city: string;
      sample_size: number;
      mean_bias: number;
      empirical_stddev: number;
      raw_mae: number;
      corrected_mae: number;
    }[]>`
      WITH weighted AS (
        SELECT
          gt.city,
          -- Prefer resolution_high (exact Polymarket source) over observed_high (Open-Meteo archive).
          (so.payload->>'forecastHigh')::float
            - COALESCE(gt.resolution_high, gt.observed_high)        AS error,
          -- Exponential decay: samples N days old get weight 2^(-N / half_life).
          -- Newer observations dominate so seasonal drift surfaces in ~5 days
          -- rather than the ~12 days an equal-weight mean would take.
          EXP(
            -EXTRACT(EPOCH FROM (NOW() - so.observed_at)) / 86400.0
            * LN(2) / ${EWMA_HALF_LIFE_DAYS}
          )                                                          AS w
        FROM shadow_observations so
        JOIN weather_ground_truth gt
          ON gt.city       = so.payload->>'city'
         AND gt.target_date = (so.payload->>'targetDate')::date
        WHERE so.kind = 'weather_event'
          AND so.observed_at >= ${windowStart}
          AND (so.payload->>'forecastHigh') IS NOT NULL
      ),
      stats AS (
      SELECT
        city,
        COUNT(*)::int                                                AS sample_size,
        SUM(error * w) / NULLIF(SUM(w), 0)                         AS mean_bias,
        -- Weighted population stddev: sqrt(E[w·x²]/E[w] − (E[w·x]/E[w])²).
        -- GREATEST(..., 0) guards against sub-zero results from float rounding.
        SQRT(GREATEST(
          SUM(w * error * error) / NULLIF(SUM(w), 0)
          - POWER(SUM(w * error) / NULLIF(SUM(w), 0), 2),
          0
        ))                                                          AS empirical_stddev
      FROM weighted
      GROUP BY city
      HAVING COUNT(*) >= ${minSamples}
      )
      SELECT
        s.city,
        s.sample_size,
        s.mean_bias,
        s.empirical_stddev,
        SUM(ABS(w.error) * w.w) / NULLIF(SUM(w.w), 0)               AS raw_mae,
        SUM(ABS(w.error - s.mean_bias) * w.w) / NULLIF(SUM(w.w), 0) AS corrected_mae
      FROM stats s
      JOIN weighted w
        ON w.city = s.city
      GROUP BY s.city, s.sample_size, s.mean_bias, s.empirical_stddev
    `;

    // The refresh is authoritative: cities that no longer qualify (below
    // minSamples in the window) get their cached bias DELETED, not merely
    // left to expire. Otherwise a WEATHER_BIAS_SAMPLES_SINCE cutover — set
    // precisely because old samples were measured against a different
    // station/coords — would leave every city applying its stale,
    // wrong-thermometer correction for up to the 7-day TTL. Falling back to
    // "no correction" is the designed below-minSamples behaviour.
    const qualified = new Set(rows.map((r) => canonicalCityKey(r.city) ?? r.city.toLowerCase().trim()));
    for (const city of Object.keys(CITY_COORDINATES)) {
      if (!qualified.has(city)) {
        await redis.del(redisKey(city));
      }
    }

    if (rows.length === 0) {
      logger.info('[weather-bias] no cities with enough paired samples yet', { minSamples });
      return;
    }

    const now = new Date().toISOString();
    for (const row of rows) {
      const bias: CityBias = {
        meanBias: Math.round(row.mean_bias * 1000) / 1000,
        empiricalStddev: Math.round((row.empirical_stddev ?? 0) * 1000) / 1000,
        rawMae: Math.round((row.raw_mae ?? 0) * 1000) / 1000,
        correctedMae: Math.round((row.corrected_mae ?? 0) * 1000) / 1000,
        meanShiftHelpful: (row.corrected_mae ?? Number.POSITIVE_INFINITY) < (row.raw_mae ?? 0) * 0.98,
        sampleSize: row.sample_size,
        updatedAt: now,
      };
      await redis.set(redisKey(row.city), JSON.stringify(bias), 'EX', REDIS_TTL_S);
      logger.info('[weather-bias] city bias updated', {
        city: row.city,
        meanBias: bias.meanBias,
        empiricalStddev: bias.empiricalStddev,
        rawMae: bias.rawMae,
        correctedMae: bias.correctedMae,
        meanShiftHelpful: bias.meanShiftHelpful,
        sampleSize: bias.sampleSize,
      });
    }
  } catch (err) {
    logger.warn('[weather-bias] computeCityBias failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Compute per-city recent WU actuals and write sorted highs arrays to Redis.
 *
 * Queries weather_ground_truth for COALESCE(resolution_high, observed_high) per
 * city over the last lookbackDays days, then caches the sorted array in Redis so
 * the scanner can compute tail-bracket YES base rates without DB access.
 *
 * Log marker: [weather-bias]
 */
export async function computeCityBaseRates(
  sql: Sql,
  redis: Redis,
  lookbackDays = 14,
): Promise<void> {
  try {
    const rows = await sql<{
      city: string;
      unit: string;
      highs: number[];
      sample_size: number;
    }[]>`
      SELECT
        city,
        unit,
        ARRAY_AGG(
          COALESCE(resolution_high, observed_high)
          ORDER BY target_date DESC
        ) AS highs,
        COUNT(*)::int AS sample_size
      FROM weather_ground_truth
      WHERE target_date >= (CURRENT_DATE - ${lookbackDays}::int)::date
        AND COALESCE(resolution_high, observed_high) IS NOT NULL
      GROUP BY city, unit
    `;

    if (rows.length === 0) {
      logger.info('[weather-bias] no city actuals to cache', { lookbackDays });
      return;
    }

    const now = new Date().toISOString();
    for (const row of rows) {
      const actuals: CityActuals = {
        highs: row.highs,
        unit: row.unit,
        sampleSize: row.sample_size,
        updatedAt: now,
      };
      await redis.set(actualsRedisKey(row.city), JSON.stringify(actuals), 'EX', ACTUALS_REDIS_TTL_S);
      logger.info('[weather-bias] city actuals updated', {
        city: row.city,
        unit: row.unit,
        sampleSize: row.sample_size,
      });
    }
  } catch (err) {
    logger.warn('[weather-bias] computeCityBaseRates failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Read a city's cached bias from Redis. Returns null if absent or unparseable.
 */
export async function getCityBias(redis: Redis, city: string): Promise<CityBias | null> {
  try {
    const raw = await redis.get(redisKey(city));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CityBias;
    if (typeof parsed.meanBias !== 'number' || typeof parsed.empiricalStddev !== 'number') {
      return null;
    }
    return {
      ...parsed,
      meanShiftHelpful: parsed.meanShiftHelpful === true,
    };
  } catch {
    return null;
  }
}

/**
 * Read a city's cached actuals from Redis. Returns null if absent or unparseable.
 */
export async function getCityActuals(redis: Redis, city: string): Promise<CityActuals | null> {
  try {
    const raw = await redis.get(actualsRedisKey(city));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CityActuals;
    if (!Array.isArray(parsed.highs) || parsed.highs.length === 0 || typeof parsed.unit !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
