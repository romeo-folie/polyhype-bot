/**
 * Weather ground-truth reconciler.
 *
 * For every city in `CITY_COORDINATES` and every past target_date in the
 * lookback window, look up the observed daily high via the Open-Meteo archive
 * API and write a row to `weather_ground_truth`. This gives us a persistent
 * oracle to validate whatever the weather scanner predicted — the scanner
 * currently produces 18-27% edges that we cannot tell apart from bugs until we
 * can see whether the winning bracket actually won in reality.
 *
 * Discovery is intentionally NOT driven from `shadow_observations`: that path
 * left us empty when the writer wasn't wired yet (2026-04-13/14) and would
 * silently miss any future writer downtime. Iterating cities × dates makes the
 * reconciler self-healing regardless of upstream emit gaps. Already-reconciled
 * (city, target_date) pairs are filtered via LEFT JOIN against
 * `weather_ground_truth` so each pair is fetched at most once ever.
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
import { CITY_COORDINATES, canonicalCityKey, lookupCity } from './noaaClient.js';
import {
  fetchHistoricalHigh,
  type FetchFn,
  type HistoricalHigh,
} from './openMeteoClient.js';
import { computeCityBias } from './cityBias.js';

/** One unresolved (city, target_date) tuple to reconcile. */
export interface UnresolvedTarget {
  /** City name; may be aliased (e.g. "nyc") — canonicalized at reconcile time. */
  city: string;
  targetDate: string; // YYYY-MM-DD
}

type ArchiveFetcher = (
  lat: number,
  lon: number,
  targetDate: string,
  unit: 'fahrenheit' | 'celsius',
) => Promise<HistoricalHigh | null>;

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
  const rows = await sql<{ city: string; target_date: string }[]>`
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
    SELECT cl.city AS city, dr.target_date::text AS target_date
    FROM city_list cl
    CROSS JOIN date_range dr
    LEFT JOIN weather_ground_truth gt
      ON gt.city = cl.city
     AND gt.target_date = dr.target_date
    WHERE gt.id IS NULL
    ORDER BY dr.target_date DESC, cl.city ASC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    city: r.city,
    targetDate: r.target_date.slice(0, 10),
  }));
}

/**
 * Reconcile the given list of (city, target_date) tuples by fetching
 * historical highs and enqueueing `weather_ground_truth` rows. Returns a
 * summary for logging.
 *
 * City keys are canonicalized against CITY_COORDINATES before persistence so
 * aliases ("nyc", "new york city") collapse to the same row, and unit is
 * derived from the city's coords — never from the shadow payload — because
 * unit is a property of the location (US=°F, international=°C).
 *
 * `fetcher` is injectable for tests — defaults to the real Open-Meteo archive
 * client. Unknown cities (missing from CITY_COORDINATES) are skipped with a
 * warning; archive misses (stale data, network errors) are counted but not
 * thrown so a partial failure doesn't fail the whole run.
 */
export async function reconcileTargets(
  targets: UnresolvedTarget[],
  fetcher: ArchiveFetcher = fetchHistoricalHigh,
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

    const result = await fetcher(coords.lat, coords.lon, t.targetDate, coords.unit);
    if (!result) {
      logger.debug('[weather-reconciler] archive returned no data (will retry next run)', {
        city: canonical,
        targetDate: t.targetDate,
      });
      noData++;
      continue;
    }

    // Stamp observedAt at fetch time so the column's documented meaning
    // ("when we fetched it") survives writer lag/replays.
    const observedAt = new Date().toISOString();
    void enqueueWrite('weather_ground_truth', {
      city: canonical,
      targetDate: t.targetDate,
      unit: coords.unit,
      observedHigh: result.observedHigh,
      source: 'open-meteo-archive',
      observedAt,
    });
    logger.info('[weather-reconciler] ground truth enqueued', {
      city: canonical,
      rawCity: t.city,
      targetDate: t.targetDate,
      unit: coords.unit,
      observedHigh: result.observedHigh,
    });
    resolved++;
  }

  return { resolved, unknownCity, noData };
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

  if (targets.length === 0) {
    logger.info('[weather-reconciler] no unresolved targets', {
      lagDays: cfg.WEATHER_RECONCILER_LAG_DAYS,
      lookbackDays: cfg.WEATHER_RECONCILER_LOOKBACK_DAYS,
    });
    return;
  }

  const fetcher: ArchiveFetcher = fetchFn
    ? (lat, lon, date, unit) => fetchHistoricalHigh(lat, lon, date, unit, fetchFn)
    : fetchHistoricalHigh;

  const summary = await reconcileTargets(targets, fetcher);
  logger.info('[weather-reconciler] run complete', {
    candidates: targets.length,
    ...summary,
  });

  // After ground-truth upserts, refresh per-city bias cache in Redis.
  // This runs unconditionally regardless of WEATHER_BIAS_CORRECTION_ENABLED so
  // the cache is warm by the time the flag is flipped.
  const redis = getRedis();
  const sql = getSql();
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
