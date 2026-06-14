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
import { fetchWuHistoricalHigh, fetchWuHistoricalLow } from './wuClient.js';
import { fetchMetarDailyHigh, fetchMetarDailyLow } from './metarClient.js';
import { fetchHkoDailyHigh, fetchHkoDailyLow } from './hkoClient.js';
import { computeCityBias, computeCityBaseRates } from './cityBias.js';
import { runStationAudit } from './stationAudit.js';
import { runWeatherOracleScan } from './weatherOracleScanner.js';

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

/** Injectable resolution fetcher for tests. Returns the daily high (and, when
 *  available, the daily low) from the exact Polymarket resolution source. */
export type ResolutionFetcher = (
  coords: CityCoordinates,
  targetDate: string,
) => Promise<{ high: number; source: string; low: number | null } | null>;

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
       OR gt.resolution_low IS NULL
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
  resolutionFetcher?: ResolutionFetcher,
): Promise<{ resolved: number; unknownCity: number; noData: number }> {
  // No-op default keeps reconcileTargets pure; runWeatherReconcile always
  // passes an explicit makeResolutionFetcher so production is unaffected.
  const resolverFn: ResolutionFetcher = resolutionFetcher ?? (() => Promise.resolve(null));
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
    let archiveLow: number | null | undefined;
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
      archiveLow = result.observedLow;
    }

    // Fetch from the exact Polymarket resolution source (best-effort; never aborts the loop).
    let resolution: { high: number; source: string; low: number | null } | null = null;
    try {
      resolution = await resolverFn(coords, t.targetDate);
    } catch (err) {
      logger.warn('[weather-reconciler] resolution fetch threw, continuing without it', {
        city: canonical, targetDate: t.targetDate,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // For hasArchive rows we only want to backfill resolution_high.
    // If resolution also returned nothing there is nothing new to write.
    if (t.hasArchive && !resolution) {
      logger.debug('[weather-reconciler] archive row exists, resolution unavailable — skipping enqueue', {
        city: canonical, targetDate: t.targetDate,
      });
      noData++;
      continue;
    }

    const observedAt = new Date().toISOString();

    // Low resolution is paired with its source (both-or-neither, per the schema):
    // only attach when the source actually returned a low. `!= null` catches both
    // a null low and an absent field (older fetchers / test doubles).
    const resolutionLowPair = resolution?.low != null
      ? { resolutionLow: resolution.low, resolutionLowSource: resolution.source }
      : {};

    if (t.hasArchive) {
      // Resolution-only backfill: writer issues a bare UPDATE — no INSERT path.
      void enqueueWrite('weather_ground_truth', {
        city: canonical,
        targetDate: t.targetDate,
        unit: coords.unit,
        resolutionHigh: resolution!.high,
        resolutionSource: resolution!.source,
        ...resolutionLowPair,
        observedAt,
        backfillOnly: true,
      });
    } else {
      void enqueueWrite('weather_ground_truth', {
        city: canonical,
        targetDate: t.targetDate,
        unit: coords.unit,
        observedHigh: archiveHigh!,
        ...(archiveLow != null ? { observedLow: archiveLow } : {}),
        source: 'open-meteo-archive',
        resolutionHigh: resolution?.high,
        resolutionSource: resolution?.source,
        ...resolutionLowPair,
        observedAt,
      });
    }

    logger.info('[weather-reconciler] ground truth enqueued', {
      city: canonical,
      targetDate: t.targetDate,
      unit: coords.unit,
      observedHigh: archiveHigh,
      observedLow: archiveLow ?? null,
      resolutionHigh: resolution?.high,
      resolutionLow: resolution?.low ?? null,
      resolutionSource: resolution?.source,
    });
    resolved++;
  }

  return { resolved, unknownCity, noData };
}

/**
 * Build a ResolutionFetcher bound to the given Redis instance and optional fetchFn.
 * The fetchFn is forwarded to all three underlying HTTP clients so tests can inject
 * a mock and production can use the global fetch uniformly.
 */
function makeResolutionFetcher(redis: Redis, fetchFn?: FetchFn): ResolutionFetcher {
  // wu/metar/hkoClient use `typeof fetch` (accepts string | URL | Request); our FetchFn
  // only passes plain strings, so the cast is safe — we just widen the parameter type.
  type WideFetch = typeof fetch;
  const wf = fetchFn as WideFetch | undefined;
  return async (coords, targetDate) => {
    // Fetch both daily extremes from the same source so one reconcile grounds
    // both the highest- and lowest-temperature markets. `low` is best-effort:
    // returning a high with a null low still writes the high row.
    if (coords.resolutionSource === 'hko') {
      const [high, low] = await Promise.all([
        fetchHkoDailyHigh(targetDate, wf),
        fetchHkoDailyLow(targetDate, wf),
      ]);
      return high !== null ? { high, source: 'hko', low } : null;
    }
    if (coords.resolutionSource === 'metar') {
      // Pass the station tz: the market settles on the station's local day,
      // and METAR reportTimes are UTC (3h misaligned for Istanbul).
      const [high, low] = await Promise.all([
        fetchMetarDailyHigh(coords.wuStation, targetDate, wf, coords.tz),
        fetchMetarDailyLow(coords.wuStation, targetDate, wf, coords.tz),
      ]);
      return high !== null ? { high, source: 'metar', low } : null;
    }
    // WU
    if (!coords.isoCountry) {
      logger.warn('[weather-reconciler] wu city missing isoCountry', { wuStation: coords.wuStation });
      return null;
    }
    const [high, low] = await Promise.all([
      fetchWuHistoricalHigh(coords.wuStation, coords.isoCountry, targetDate, coords.unit, redis, wf),
      fetchWuHistoricalLow(coords.wuStation, coords.isoCountry, targetDate, coords.unit, redis, wf),
    ]);
    return high !== null ? { high, source: 'wu', low } : null;
  };
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
    await computeCityBias(sql, redis, cfg.WEATHER_BIAS_MIN_SAMPLES, cfg.WEATHER_BIAS_SAMPLES_SINCE, 'high');
    await computeCityBias(sql, redis, cfg.WEATHER_BIAS_MIN_SAMPLES, cfg.WEATHER_BIAS_SAMPLES_SINCE, 'low');
    await computeCityBaseRates(sql, redis, cfg.WEATHER_BASE_RATE_LOOKBACK_DAYS);
    if (cfg.WEATHER_STATION_AUDIT_ENABLED) await runStationAudit(redis);
    await runWeatherOracleScan(redis).catch((err: unknown) => {
      logger.warn('[weather-reconciler] oracle scan failed — continuing', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return;
  }

  const archiveFetcher: ArchiveFetcher = fetchFn
    ? (lat, lon, date, unit) => fetchHistoricalHigh(lat, lon, date, unit, fetchFn)
    : fetchHistoricalHigh;
  const resolutionFetcher = makeResolutionFetcher(redis, fetchFn);

  const summary = await reconcileTargets(targets, archiveFetcher, resolutionFetcher);
  logger.info('[weather-reconciler] run complete', {
    candidates: targets.length,
    ...summary,
  });

  // After ground-truth upserts, refresh per-city bias caches (high and low) and
  // actuals cache in Redis. Run unconditionally so caches are warm before flags
  // are flipped.
  await computeCityBias(sql, redis, cfg.WEATHER_BIAS_MIN_SAMPLES, cfg.WEATHER_BIAS_SAMPLES_SINCE, 'high');
  await computeCityBias(sql, redis, cfg.WEATHER_BIAS_MIN_SAMPLES, cfg.WEATHER_BIAS_SAMPLES_SINCE, 'low');
  await computeCityBaseRates(sql, redis, cfg.WEATHER_BASE_RATE_LOOKBACK_DAYS);
  if (cfg.WEATHER_STATION_AUDIT_ENABLED) await runStationAudit(redis);
  await runWeatherOracleScan(redis).catch((err: unknown) => {
    logger.warn('[weather-reconciler] oracle scan failed — continuing', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
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
