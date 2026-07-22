/**
 * Weather cohort health monitor — alerts when a LIVE calibration cohort stops
 * beating breakeven on recent resolved data.
 *
 * WHY: `WEATHER_CALIBRATION_LIVE_COHORTS` (the `SIDE|metric|shape|source` cohorts allowed
 * to drive live decisions off the calibrated probability) is admitted by a hold-out gate
 * (`shouldAdmitLiveCohort`), but a cohort's real edge can DECAY after admission — exactly
 * how `YES|low|exact|open-meteo` ran 22–25% WR for weeks in July before anyone noticed by
 * hand. This replays the calibrated decision the live scanner would make on each resolved
 * `weather_bracket` shadow row in the most-recent window, scores it vs ground truth, groups
 * by cohort, and Telegram-alerts when a live cohort's WR no longer clears breakeven — so a
 * decayed cohort is caught in days, not weeks. Protects the far-NO bread-and-butter and
 * auto-surfaces future over-promotions.
 *
 * WHERE THIS RUNS: from the always-on `pga-cron` container (needs PG + Redis + Telegram),
 * NOT host-cron — the same rationale as heartbeatWatchdog (host-cron can silently die).
 *
 * Best-effort: any failure is logged, never thrown, so a bad tick can't page-storm.
 */
import 'dotenv/config';
import type { Redis } from 'ioredis';
import { getSql, closeSql } from '../db/client.js';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { notify } from '../execution/telegram.js';
import { canonicalCityKey } from '../weather/noaaClient.js';
import { parseBracketLabel } from '../weather/weatherScanner.js';
import {
  loadCalibrationTable,
  calibrateWeatherBracketProbability,
  classifyBracketShape,
  normalizeSource,
  type BracketShape,
  type CalibrationTable,
} from '../weather/bracketCalibration.js';

/** Redis key recording the last time we ALERTED on cohort health (re-alert cooldown). */
export const COHORT_HEALTH_ALERT_KEY = 'weather:cohort-health:alert';

/** A live cohort's realized performance on the recent resolved window. */
export interface CohortPerf {
  /** `SIDE|metric|shape|source`. */
  cohort: string;
  /** Calibrated picks scored in the window. */
  n: number;
  /** Win rate of the picked side (0–1). */
  wr: number;
  /** Breakeven = avg entry price of the picked side (0–1). */
  be: number;
  /** ROI (fraction). */
  roi: number;
}

export interface CohortHealthResult {
  /** n≥minSamples and WR no longer clears breakeven — the live edge has gone. */
  degrading: CohortPerf[];
  /** n≥minSamples and still beating breakeven. */
  healthy: CohortPerf[];
  /** Too little recent data to judge (n<minSamples). */
  insufficient: CohortPerf[];
}

/**
 * Classify each live cohort's recent performance. A cohort is DEGRADING when it has
 * enough recent samples (`n ≥ minSamples`) yet its win rate no longer clears breakeven
 * (`wr ≤ be`) — the exact inverse of the admission gate. Pure.
 */
export function evaluateCohortHealth(perfs: CohortPerf[], minSamples: number): CohortHealthResult {
  const degrading: CohortPerf[] = [];
  const healthy: CohortPerf[] = [];
  const insufficient: CohortPerf[] = [];
  for (const p of perfs) {
    if (p.n < minSamples) insufficient.push(p);
    else if (p.wr <= p.be) degrading.push(p);
    else healthy.push(p);
  }
  return { degrading, healthy, insufficient };
}

/** A parsed live-cohort spec from `WEATHER_CALIBRATION_LIVE_COHORTS`. */
export interface LiveCohort {
  side: 'YES' | 'NO';
  metric: string;
  shape: string;
  source: string;
  /** Canonical `SIDE|metric|shape|source` key. */
  key: string;
}

/** Parse the side-aware live-cohort allow-list. Legacy 3-part (both-side) entries and
 *  malformed entries are skipped — the health monitor only judges explicit side cohorts. */
export function parseLiveCohorts(csv: string): LiveCohort[] {
  const out: LiveCohort[] = [];
  for (const raw of csv.split(',')) {
    const parts = raw.split('|').map((s) => s.trim());
    if (parts.length !== 4) continue;
    const side = (parts[0] ?? '').toUpperCase();
    if (side !== 'YES' && side !== 'NO') continue;
    const metric = normalizeSource(parts[1]);
    const shape = parts[2] ?? '';
    const source = normalizeSource(parts[3]);
    if (!shape) continue;
    out.push({ side, metric, shape, source, key: `${side}|${metric}|${shape}|${source}` });
  }
  return out;
}

/** One resolved bracket prediction, reduced to what cohort scoring needs. */
export interface ScoredBracket {
  metric: string;
  shape: string;
  source: string;
  daysOut: number;
  /** Calibration input probability (pre-σ-inflation Gaussian, the scale the map trains on). */
  pRaw: number;
  /** Market YES price of the single-bracket binary. */
  yesPrice: number;
  /** True iff the resolved value landed in the bracket. */
  yes: boolean;
}

/**
 * Score one live cohort by replaying the calibrated decision on the resolved rows that
 * belong to its metric|shape|source, keeping only the rows the calibrated logic would
 * pick for the cohort's side (NO: calProb < yesPrice; YES: calProb > yesPrice) — the same
 * rule the live scanner and the admission audit use. Pure.
 */
export function scoreCohortFromRows(
  cohort: LiveCohort,
  rows: ScoredBracket[],
  table: CalibrationTable | null,
): CohortPerf {
  const picks: { price: number; won: boolean }[] = [];
  for (const r of rows) {
    if (r.metric !== cohort.metric || r.shape !== cohort.shape || normalizeSource(r.source) !== cohort.source) continue;
    if (!Number.isFinite(r.yesPrice)) continue;
    const calProb = calibrateWeatherBracketProbability(
      r.pRaw,
      { shape: r.shape as BracketShape, source: r.source, daysOut: r.daysOut, metric: r.metric as 'high' | 'low' },
      table,
    );
    const isPick = cohort.side === 'NO' ? calProb < r.yesPrice : calProb > r.yesPrice;
    if (!isPick) continue;
    const price = cohort.side === 'YES' ? r.yesPrice : 1 - r.yesPrice;
    const won = cohort.side === 'YES' ? r.yes : !r.yes;
    picks.push({ price, won });
  }
  const n = picks.length;
  const wr = n > 0 ? picks.filter((p) => p.won).length / n : 0;
  const be = n > 0 ? picks.reduce((s, p) => s + p.price, 0) / n : 0;
  const roi = n > 0 ? picks.reduce((s, p) => s + (p.won ? 1 / Math.max(0.01, p.price) - 1 : -1), 0) / n : 0;
  return { cohort: cohort.key, n, wr, be, roi };
}

/** Load + dedup + ground-truth-join the resolved weather_bracket rows in the window. */
async function loadResolvedBrackets(
  sql: ReturnType<typeof getSql>,
  windowDays: number,
  nowMs: number,
): Promise<ScoredBracket[]> {
  const cutoffIso = new Date(nowMs - windowDays * 86_400_000).toISOString();
  const rows = await sql<{ payload: Record<string, unknown>; observed_at: string }[]>`
    SELECT payload, observed_at::text AS observed_at
    FROM shadow_observations
    WHERE kind = 'weather_bracket' AND observed_at >= ${cutoffIso}
    ORDER BY observed_at ASC`;
  const gtRows = await sql<{
    city: string; target_date: string;
    resolution_high: number | null; observed_high: number | null;
    resolution_low: number | null; observed_low: number | null;
  }[]>`
    SELECT city, target_date::text AS target_date, resolution_high, observed_high, resolution_low, observed_low
    FROM weather_ground_truth`;
  const gtHigh = new Map<string, number>();
  const gtLow = new Map<string, number>();
  for (const r of gtRows) {
    const k = `${canonicalCityKey(r.city) ?? ''}|${r.target_date}`;
    const hi = r.resolution_high ?? r.observed_high;
    const lo = r.resolution_low ?? r.observed_low;
    if (hi != null) gtHigh.set(k, hi);
    if (lo != null) gtLow.set(k, lo);
  }
  // Dedup to one row per (metric,city,date,bracket), keeping the most-recent observation.
  const dedup = new Map<string, ScoredBracket>();
  for (const row of rows) {
    const p = row.payload;
    const city = typeof p.city === 'string' ? canonicalCityKey(p.city) : null;
    const date = typeof p.targetDate === 'string' ? p.targetDate.slice(0, 10) : '';
    const label = typeof p.bracket === 'string' ? p.bracket : '';
    if (!city || !date || !label) continue;
    const parsed = parseBracketLabel(label);
    if (!parsed) continue;
    const metric: 'high' | 'low' = p.metric === 'low' ? 'low' : 'high';
    const actual = (metric === 'low' ? gtLow : gtHigh).get(`${city}|${date}`);
    if (actual === undefined) continue; // unresolved → skip
    // Drop transitional σ-inflated rows lacking the clean calibration input (same rule
    // as the audit fitter) so we score on the scale the calibrator actually maps.
    const sourceMult = Number(p.sourceStddevMultiplier);
    const inflated = Number.isFinite(sourceMult) && sourceMult !== 1;
    const hasCalInput = p.modelProbCalInput != null && Number.isFinite(Number(p.modelProbCalInput));
    if (inflated && !hasCalInput) continue;
    const pRaw = hasCalInput ? Number(p.modelProbCalInput) : Number(p.modelProb);
    if (!Number.isFinite(pRaw)) continue;
    const op = Number(p.outcomePrice);
    const yesPrice = Number.isFinite(op) ? (p.tradeSide === 'YES' ? op : 1 - op) : NaN;
    const daysOut = Number.isFinite(Number(p.daysOut)) ? Number(p.daysOut) : 2;
    const shape = classifyBracketShape(parsed.low, parsed.high);
    const source = normalizeSource(typeof p.forecastSource === 'string' ? p.forecastSource : undefined);
    const loBound = parsed.low == null ? -Infinity : parsed.low - 0.5;
    const hiBound = parsed.high == null ? Infinity : parsed.high + 0.5;
    const yes = actual >= loBound && actual < hiBound;
    // Key includes daysOut so one row per (bracket, HORIZON) survives — mirrors the
    // admission audit's dedup (weather-calibration-audit.ts) so this monitor scores the
    // same population the gate admitted, and doesn't collapse to only the last scan.
    dedup.set(`${metric}|${city}|${date}|${label}|${daysOut}`, { metric, shape, source, daysOut, pRaw, yesPrice, yes });
  }
  return Array.from(dedup.values());
}

/** Format one cohort line for the Telegram alert. */
function fmtCohort(p: CohortPerf): string {
  return `• <code>${p.cohort}</code> — n=${String(p.n)}, WR ${(100 * p.wr).toFixed(0)}% vs BE ${(100 * p.be).toFixed(0)}%, ROI ${(100 * p.roi).toFixed(0)}%`;
}

/**
 * Score every live cohort on the recent window and alert/recover via Telegram.
 * Returns the classification (or null when disabled / no live cohorts). Best-effort.
 */
export async function runWeatherCohortHealth(
  sql: ReturnType<typeof getSql>,
  redis: Redis,
  deps?: { notify?: (text: string) => Promise<void>; now?: number; table?: CalibrationTable | null },
): Promise<CohortHealthResult | null> {
  const cfg = loadConfig();
  if (!cfg.WEATHER_COHORT_HEALTH_ENABLED) {
    logger.info('[cohort-health] disabled — skipping');
    return null;
  }
  const notifyFn = deps?.notify ?? notify;
  const nowMs = deps?.now ?? Date.now();
  const liveCohorts = parseLiveCohorts(cfg.WEATHER_CALIBRATION_LIVE_COHORTS ?? '');
  if (liveCohorts.length === 0) {
    logger.info('[cohort-health] no side-aware live cohorts configured — skipping');
    return null;
  }
  const table = deps?.table !== undefined ? deps.table : loadCalibrationTable();
  const rows = await loadResolvedBrackets(sql, cfg.WEATHER_COHORT_HEALTH_WINDOW_DAYS, nowMs);
  const perfs = liveCohorts.map((c) => scoreCohortFromRows(c, rows, table));
  const result = evaluateCohortHealth(perfs, cfg.WEATHER_COHORT_HEALTH_MIN_SAMPLES);

  logger.info('[cohort-health] evaluated', {
    windowDays: cfg.WEATHER_COHORT_HEALTH_WINDOW_DAYS,
    resolvedRows: rows.length,
    degrading: result.degrading.map((p) => p.cohort),
    healthy: result.healthy.map((p) => p.cohort),
    insufficient: result.insufficient.map((p) => p.cohort),
  });

  const reAlertMs = cfg.WEATHER_COHORT_HEALTH_REALERT_MIN * 60_000;
  const alertRaw = await redis.get(COHORT_HEALTH_ALERT_KEY);
  const lastAlertMs = alertRaw != null && alertRaw !== '' && Number.isFinite(Number(alertRaw))
    ? Number(alertRaw) * 1000 : null;

  if (result.degrading.length > 0) {
    const cooldownElapsed = lastAlertMs == null || nowMs - lastAlertMs >= reAlertMs;
    if (cooldownElapsed) {
      try {
        await notifyFn(
          `⚠️ <b>Weather cohort(s) degraded</b> — live calibration cohort no longer beats breakeven ` +
          `on the last ${cfg.WEATHER_COHORT_HEALTH_WINDOW_DAYS}d:\n${result.degrading.map(fmtCohort).join('\n')}\n` +
          `Consider re-running <code>weather-calibration-audit --write-live-cohorts</code> to demote it.`,
        );
        await redis.setex(COHORT_HEALTH_ALERT_KEY, 30 * 24 * 60 * 60, String(Math.floor(nowMs / 1000)));
      } catch (err) {
        logger.warn('[cohort-health] alert send failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  } else if (lastAlertMs != null && result.insufficient.length === 0) {
    // Recover only when we previously alerted AND every live cohort is now AFFIRMATIVELY
    // healthy (none degrading, none merely insufficient). A cohort that goes quiet on
    // resolved data is NOT "recovered" — asserting it beat breakeven would be false, so we
    // hold the alert state until there's enough data to say so.
    try {
      await notifyFn(`✅ <b>Weather cohorts recovered</b> — all live cohorts beat breakeven again.`);
      await redis.del(COHORT_HEALTH_ALERT_KEY);
    } catch (err) {
      logger.warn('[cohort-health] recovery notice failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

async function main(): Promise<void> {
  const { getRedis, closeRedis } = await import('../shared/redis.js');
  const redis = getRedis();
  const sql = getSql();
  try {
    await runWeatherCohortHealth(sql, redis);
  } catch (err: unknown) {
    logger.error('[cohort-health] failed', { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  } finally {
    await closeSql();
    await closeRedis();
  }
}

// Only run when invoked directly — importing the pure helpers must NOT trigger a run.
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/weatherCohortHealth.js') === true ||
  process.argv[1]?.endsWith('/weatherCohortHealth.ts') === true;

if (isMainModule) {
  void main().catch((err: unknown) => {
    logger.error('[cohort-health] fatal', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
