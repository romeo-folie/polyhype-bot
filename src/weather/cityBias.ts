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
      SELECT
        gt.city,
        COUNT(*)::int                                                  AS sample_size,
        AVG((so.payload->>'forecastHigh')::float - gt.observed_high)  AS mean_bias,
        STDDEV((so.payload->>'forecastHigh')::float - gt.observed_high) AS empirical_stddev
      FROM shadow_observations so
      JOIN weather_ground_truth gt
        ON gt.city       = so.payload->>'city'
       AND gt.target_date = (so.payload->>'targetDate')::date
      WHERE so.kind = 'weather_event'
        AND (so.payload->>'forecastHigh') IS NOT NULL
      GROUP BY gt.city
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
