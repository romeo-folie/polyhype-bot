/**
 * Weather ground-truth reconciler.
 *
 * Scans `shadow_observations` for past weather bracket events that have resolved
 * (target_date has passed), looks up the observed daily high via the Open-Meteo
 * archive API, and writes a row to `weather_ground_truth`. This gives us a
 * persistent oracle to validate whatever the weather scanner predicted — the
 * scanner currently produces 18-27% edges that we cannot tell apart from bugs
 * until we can see whether the winning bracket actually won in reality.
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
import { lookupCity } from './noaaClient.js';
import {
  fetchHistoricalHigh,
  type FetchFn,
  type HistoricalHigh,
} from './openMeteoClient.js';

/** One unresolved (city, target_date) tuple from shadow_observations. */
export interface UnresolvedTarget {
  city: string;
  targetDate: string; // YYYY-MM-DD
  unit: 'fahrenheit' | 'celsius';
}

type ArchiveFetcher = (
  lat: number,
  lon: number,
  targetDate: string,
  unit: 'fahrenheit' | 'celsius',
) => Promise<HistoricalHigh | null>;

/**
 * Find (city, target_date) tuples with weather_event shadow rows whose
 * target_date falls in [now - lookbackDays, now - lagDays], AND for which no
 * row yet exists in weather_ground_truth.
 *
 * Returns at most `limit` rows, ordered by target_date descending (prefer
 * newest unresolved first — the scanner is actively producing data there).
 */
export async function fetchUnresolvedTargets(
  lagDays: number,
  lookbackDays: number,
  limit: number,
): Promise<UnresolvedTarget[]> {
  const sql = getSql();
  const rows = await sql<{ city: string; target_date: string; unit: string }[]>`
    SELECT DISTINCT
      so.payload->>'city'        AS city,
      so.payload->>'targetDate'  AS target_date,
      COALESCE(so.payload->>'unit', 'fahrenheit') AS unit
    FROM shadow_observations so
    LEFT JOIN weather_ground_truth gt
      ON gt.city = so.payload->>'city'
     AND gt.target_date = (so.payload->>'targetDate')::date
    WHERE so.kind = 'weather_event'
      AND so.payload ? 'city'
      AND so.payload ? 'targetDate'
      AND (so.payload->>'targetDate')::date <= (CURRENT_DATE - ${lagDays}::int)
      AND (so.payload->>'targetDate')::date >= (CURRENT_DATE - ${lookbackDays}::int)
      AND gt.id IS NULL
    ORDER BY target_date DESC
    LIMIT ${limit}
  `;

  const out: UnresolvedTarget[] = [];
  for (const r of rows) {
    if (r.unit !== 'fahrenheit' && r.unit !== 'celsius') continue;
    out.push({
      city: r.city,
      targetDate: r.target_date.slice(0, 10),
      unit: r.unit,
    });
  }
  return out;
}

/**
 * Reconcile the given list of (city, target_date, unit) tuples by fetching
 * historical highs and enqueueing `weather_ground_truth` rows. Returns a
 * summary for logging.
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
    if (!coords) {
      logger.warn('[weather-reconciler] unknown city, skipping', { city: t.city });
      unknownCity++;
      continue;
    }

    const result = await fetcher(coords.lat, coords.lon, t.targetDate, t.unit);
    if (!result) {
      noData++;
      continue;
    }

    void enqueueWrite('weather_ground_truth', {
      city: t.city,
      targetDate: t.targetDate,
      unit: t.unit,
      observedHigh: result.observedHigh,
      source: 'open-meteo-archive',
    });
    logger.info('[weather-reconciler] ground truth enqueued', {
      city: t.city,
      targetDate: t.targetDate,
      unit: t.unit,
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
  const targets = await fetchUnresolvedTargets(
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
