/**
 * Weather ground-truth reconciler.
 *
 * For every city in `CITY_COORDINATES` and every past target_date in the
 * lookback window, fetches two ground-truth readings and writes them to
 * `weather_ground_truth`:
 *
 *   observed_high     — Open-Meteo archive at forecast coordinates (existing)
 *   resolution_high   — exact Polymarket resolution source: WU, METAR, or HKO
 *
 * Running both side-by-side lets the bias system compare forecast vs resolution
 * source (eliminating basis risk) while retaining the Open-Meteo delta for
 * diagnosing coordinate vs model error separately.
 *
 * Discovery covers:
 *   (a) (city, date) pairs with no ground-truth row yet
 *   (b) existing rows where resolution_high IS NULL (backfill)
 *
 * Read-only with respect to trading: no signals, no positions. Safe to run
 * unconditionally; no *_ENABLED flag.
 *
 * Log marker: [weather-reconciler]
 */
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { getSql } from '../db/client.js';
import { getRedis } from '../shared/redis.js';
import type { Redis } from 'ioredis';
import { CITY_COORDINATES, canonicalCityKey, lookupCity, type CityCoordinates } from './noaaClient.js';
import {
  fetchHistoricalHigh,
  type FetchFn,
  type HistoricalHigh,
} from './openMeteoClient.js';
import { fetchWuHistoricalHigh } from './wuClient.js';
import { fetchMetarDailyHigh } from './metarClient.js';
import { fetchHkoDailyHigh } from './hkoClient.js';
import { computeCityBias } from './cityBias.js';

/** One unresolved (city, target_date) tuple to reconcile. */
export interface UnresolvedTarget {
  /** City name; may be aliased (e.g. "nyc") — canonicalized at reconcile time. */
  city: string;
  targetDate: string; // YYYY-MM-DD
  /** True if an Open-Meteo archive row already exists; only resolution_high needs populating. */
  hasArchive: boolean;
}

type ArchiveFetcher = (
  lat: number,
  lon: number,
  targetDate: string,
  unit: 'fahrenheit' | 'celsius',
) => Promise<HistoricalHigh | null>;

/** Injectable resolution fetcher for tests. */
export type ResolutionFetcher = (
  coords: CityCoordinates,
  targetDate: string,
) => Promise<{ high: number; source: string } | null>;

/**
 * Generate (city, target_date) tuples for every canonical city in
 * `CITY_COORDINATES` crossed with every past date in
 * [now - lookbackDays, now - lagDays] that doesn't yet have a ground-truth row.
 *
 * Returns at most `limit` rows, ordered by target_date descending (prefer
 * newest unresolved first — most useful for current scanner validation).
 *
 * Decoupled from `shadow_observations` deliberately: the scanner only emits
 * shadow rows for events 1-2 days in the future, and any writer downtime would
 * leave permanent gaps. Iterating cities × dates costs at most ~30 archive
 * fetches/day after the initial backfill, well under Open-Meteo's quota.
 */
export async function fetchTargetsToReconcile(
  lagDays: number,
  lookbackDays: number,
  limit: number,
): Promise<UnresolvedTarget[]> {
  const sql = getSql();
  const cities = Object.keys(CITY_COORDINATES);
  const rows = await sql<{ city: string; target_date: string; has_archive: boolean }[]>`
    WITH date_range AS (
      SELECT generate_series(
        (CURRENT_DATE - ${lookbackDays}::int)::date,
        (CURRENT_DATE - ${lagDays}::int)::date,
        '1 day'::interval
      )::date AS target_date
    ),
    city_list AS (
      SELECT unnest(${cities}::text[]) AS city
    )
    SELECT cl.city AS city,
           dr.target_date::text AS target_date,
           (gt.id IS NOT NULL) AS has_archive
    FROM city_list cl
    CROSS JOIN date_range dr
    LEFT JOIN weather_ground_truth gt
      ON gt.city = cl.city
     AND gt.target_date = dr.target_date
    WHERE gt.id IS NULL
       OR gt.resolution_high IS NULL
    ORDER BY dr.target_date DESC, cl.city ASC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    city: r.city,
    targetDate: r.target_date.slice(0, 10),
    hasArchive: Boolean(r.has_archive),
  }));
}

/**
 * Reconcile the given list of (city, target_date) tuples. For each target:
 *   - If no archive row exists: fetch Open-Meteo archive + resolution source, write both.
 *   - If archive row exists but resolution_high is NULL: fetch resolution source only.
 *
 * Both fetchers are injectable for tests.
 */
export async function reconcileTargets(
  targets: UnresolvedTarget[],
  archiveFetcher: ArchiveFetcher = fetchHistoricalHigh,
  resolutionFetcher: ResolutionFetcher = defaultResolutionFetcher,
): Promise<{ resolved: number; unknownCity: number; noData: number }> {
  let resolved = 0;
  let unknownCity = 0;
  let noData = 0;

  for (const t of targets) {
    const coords = lookupCity(t.city);
    const canonical = canonicalCityKey(t.city);
    if (!coords || !canonical) {
      logger.warn('[weather-reconciler] unknown city, skipping', { city: t.city });
      unknownCity++;
      continue;
    }

    // If archive row already exists, skip the Open-Meteo fetch and only populate resolution.
    let archiveHigh: number | undefined;
    if (!t.hasArchive) {
      const result = await archiveFetcher(coords.lat, coords.lon, t.targetDate, coords.unit);
      if (!result) {
        logger.debug('[weather-reconciler] archive returned no data (will retry next run)', {
          city: canonical, targetDate: t.targetDate,
        });
        noData++;
        continue;
      }
      archiveHigh = result.observedHigh;
    }

    // Fetch from the exact Polymarket resolution source (best-effort; doesn't block row write).
    const resolution = await resolutionFetcher(coords, t.targetDate);

    const observedAt = new Date().toISOString();
    void enqueueWrite('weather_ground_truth', {
      city: canonical,
      targetDate: t.targetDate,
      unit: coords.unit,
      // observedHigh is required by the schema; for backfill-only rows set a sentinel
      // that the ON CONFLICT handler will ignore (it only updates resolution columns).
      observedHigh: archiveHigh ?? 0,
      source: archiveHigh !== undefined ? 'open-meteo-archive' : 'backfill-sentinel',
      resolutionHigh: resolution?.high,
      resolutionSource: resolution?.source,
      observedAt,
    });

    logger.info('[weather-reconciler] ground truth enqueued', {
      city: canonical,
      targetDate: t.targetDate,
      unit: coords.unit,
      observedHigh: archiveHigh,
      resolutionHigh: resolution?.high,
      resolutionSource: resolution?.source,
    });
    resolved++;
  }

  return { resolved, unknownCity, noData };
}

/**
 * Default resolution fetcher — dispatches to the appropriate client based on
 * the city's resolutionSource. Requires a live Redis instance for WU key caching.
 */
let _redis: Redis | null = null;
function getResolverRedis(): Redis {
  if (!_redis) _redis = getRedis();
  return _redis;
}

async function defaultResolutionFetcher(
  coords: CityCoordinates,
  targetDate: string,
): Promise<{ high: number; source: string } | null> {
  if (coords.resolutionSource === 'hko') {
    const high = await fetchHkoDailyHigh(targetDate);
    return high !== null ? { high, source: 'hko' } : null;
  }
  if (coords.resolutionSource === 'metar') {
    const high = await fetchMetarDailyHigh(coords.wuStation, targetDate);
    return high !== null ? { high, source: 'metar' } : null;
  }
  // WU
  if (!coords.isoCountry) {
    logger.warn('[weather-reconciler] wu city missing isoCountry', { wuStation: coords.wuStation });
    return null;
  }
  const high = await fetchWuHistoricalHigh(
    coords.wuStation,
    coords.isoCountry,
    targetDate,
    coords.unit,
    getResolverRedis(),
  );
  return high !== null ? { high, source: 'wu' } : null;
}

/**
 * Run one reconciler cycle. Pulls unresolved targets from the DB and reconciles
 * them. Always safe to call — no locks, no cascading effects.
 */
export async function runWeatherReconcile(fetchFn?: FetchFn): Promise<void> {
  const cfg = loadConfig();
  const targets = await fetchTargetsToReconcile(
    cfg.WEATHER_RECONCILER_LAG_DAYS,
    cfg.WEATHER_RECONCILER_LOOKBACK_DAYS,
    cfg.WEATHER_RECONCILER_MAX_PER_RUN,
  );

  const redis = getRedis();
  const sql = getSql();

  if (targets.length === 0) {
    logger.info('[weather-reconciler] no unresolved targets — refreshing bias cache only', {
      lagDays: cfg.WEATHER_RECONCILER_LAG_DAYS,
      lookbackDays: cfg.WEATHER_RECONCILER_LOOKBACK_DAYS,
    });
    await computeCityBias(sql, redis, cfg.WEATHER_BIAS_MIN_SAMPLES);
    return;
  }

  const archiveFetcher: ArchiveFetcher = fetchFn
    ? (lat, lon, date, unit) => fetchHistoricalHigh(lat, lon, date, unit, fetchFn)
    : fetchHistoricalHigh;

  const summary = await reconcileTargets(targets, archiveFetcher);
  logger.info('[weather-reconciler] run complete', {
    candidates: targets.length,
    ...summary,
  });

  // After ground-truth upserts, refresh per-city bias cache in Redis.
  // This runs unconditionally regardless of WEATHER_BIAS_CORRECTION_ENABLED so
  // the cache is warm by the time the flag is flipped.
  await computeCityBias(sql, redis, cfg.WEATHER_BIAS_MIN_SAMPLES);
}

// ── Standalone entrypoint (cron) ──────────────────────────────────────────

async function main() {
  const { closeSql } = await import('../db/client.js');
  const { closeRedis } = await import('../shared/redis.js');
  try {
    await runWeatherReconcile();
  } finally {
    await closeSql();
    await closeRedis();
  }
}

const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/weatherReconciler.js') === true;

if (isMainModule) {
  void main().catch((err: unknown) => {
    logger.error('[weather-reconciler] fatal error', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
