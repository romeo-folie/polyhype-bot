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
import { canonicalCityKey } from './noaaClient.js';

const REDIS_TTL_S = 7 * 24 * 60 * 60; // 7 days
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
  /** Number of paired samples used. */
  sampleSize: number;
  updatedAt: string;
}

function redisKey(city: string): string {
  const canonical = canonicalCityKey(city) ?? city.toLowerCase().trim();
  return `weather:city_bias:${canonical}`;
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
): Promise<void> {
  try {
    const rows = await sql<{
      city: string;
      sample_size: number;
      mean_bias: number;
      empirical_stddev: number;
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
          AND so.observed_at >= NOW() - ${EWMA_LOOKBACK_DAYS} * INTERVAL '1 day'
          AND (so.payload->>'forecastHigh') IS NOT NULL
      )
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
    `;

    if (rows.length === 0) {
      logger.info('[weather-bias] no cities with enough paired samples yet', { minSamples });
      return;
    }

    const now = new Date().toISOString();
    for (const row of rows) {
      const bias: CityBias = {
        meanBias: Math.round(row.mean_bias * 1000) / 1000,
        empiricalStddev: Math.round((row.empirical_stddev ?? 0) * 1000) / 1000,
        sampleSize: row.sample_size,
        updatedAt: now,
      };
      await redis.set(redisKey(row.city), JSON.stringify(bias), 'EX', REDIS_TTL_S);
      logger.info('[weather-bias] city bias updated', {
        city: row.city,
        meanBias: bias.meanBias,
        empiricalStddev: bias.empiricalStddev,
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
    return parsed;
  } catch {
    return null;
  }
}
