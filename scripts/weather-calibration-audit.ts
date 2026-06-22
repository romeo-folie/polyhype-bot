#!/usr/bin/env tsx
/**
 * Weather bracket-probability calibration audit + fitter.
 *
 * Reads shadow predictions (shadow_observations, kind='weather_bracket') and
 * scores the raw model YES probability against realized outcomes from
 * weather_ground_truth — using COALESCE(resolution_*, observed_*), the source
 * that actually settles markets (WU/METAR), NOT observed_high alone.
 *
 * Prints:
 *   - reliability (raw vs calibrated) by predicted-prob bin
 *   - Brier / log-loss, raw vs calibrated, on a CHRONOLOGICAL hold-out
 *   - per-shape / per-source / per-horizon calibration error
 *   - acceptance-gate summary
 *
 * With --fit, writes the fitted reliability map to
 * src/weather/data/calibrationParams.json (loaded at runtime by
 * src/weather/bracketCalibration.ts). The committed artifact is fit on ALL
 * data; the reported metrics use an 80/20 chronological hold-out so they are
 * out-of-sample and honest.
 *
 * Read-only unless --fit is passed. Safe to run anytime.
 *
 * Usage:
 *   npx tsx scripts/weather-calibration-audit.ts            # audit only
 *   npx tsx scripts/weather-calibration-audit.ts --fit      # audit + write artifact
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSql, closeSql } from '../src/db/client.js';
import { logger } from '../src/shared/logger.js';
import { canonicalCityKey } from '../src/weather/noaaClient.js';
import { parseBracketLabel } from '../src/weather/weatherScanner.js';
import {
  classifyBracketShape,
  horizonBucket,
  normalizeSource,
  cellKey,
  interpolateCell,
  calibrateWeatherBracketProbability,
  type BracketShape,
  type CalibrationCell,
  type CalibrationTable,
} from '../src/weather/bracketCalibration.js';

const BIN_COUNT = 10;
const PRIOR_STRENGTH = 20; // pseudo-counts shrinking each cell toward its parent
const MIN_CELL_SAMPLES = 80; // runtime trust threshold for a specific cell
// A cell's learned curve must beat raw (identity) by at least this much Brier on
// the recent hold-out to be kept; otherwise the cell ships as identity (raw
// passthrough). Guards against over-fit/drifting corrections on already-well-
// calibrated cohorts (e.g. the US `combined` source).
const GUARDRAIL_MIN_BRIER_GAIN = 0.003;
const VERSION = 1;

// eslint-disable-next-line no-console
const log = (s = ''): void => console.log(s);

interface Pair {
  city: string;
  targetDate: string;
  daysOut: number;
  shape: BracketShape;
  source: string;
  metric: 'high' | 'low';
  pRaw: number;
  yes: boolean;
  /** Reconstructed market YES price (single-bracket binary): tradeSide YES → outcomePrice; else 1−outcomePrice. */
  yesPrice: number;
  observedAt: string;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** YES iff the resolved value rounds into the bracket (half-degree boundaries). */
function isYes(actual: number, low: number | null, high: number | null): boolean {
  const lo = low === null ? -Infinity : low - 0.5;
  const hi = high === null ? Infinity : high + 0.5;
  return actual >= lo && actual < hi;
}

/** Pool-adjacent-violators: nearest weighted-monotone (non-decreasing) fit. */
function pav(values: number[], weights: number[]): number[] {
  const n = values.length;
  const val = values.slice();
  const wt = weights.slice();
  // blocks of [start,end] with pooled mean
  const blkVal: number[] = [];
  const blkWt: number[] = [];
  const blkLen: number[] = [];
  for (let i = 0; i < n; i++) {
    let v = val[i]!;
    let w = wt[i]!;
    let len = 1;
    while (blkVal.length > 0 && blkVal[blkVal.length - 1]! > v) {
      const pv = blkVal.pop()!;
      const pw = blkWt.pop()!;
      const pl = blkLen.pop()!;
      v = (pv * pw + v * w) / (pw + w);
      w = pw + w;
      len += pl;
    }
    blkVal.push(v);
    blkWt.push(w);
    blkLen.push(len);
  }
  const out: number[] = [];
  for (let b = 0; b < blkVal.length; b++) {
    for (let k = 0; k < blkLen[b]!; k++) out.push(clamp01(blkVal[b]!));
  }
  return out;
}

/** Fit a cell's reliability curve from pairs, shrinking toward parentBins
 *  (identity when parentBins is null). */
function fitCell(pairs: Pair[], parentBins: number[] | null): CalibrationCell {
  const wins = new Array<number>(BIN_COUNT).fill(0);
  const cnt = new Array<number>(BIN_COUNT).fill(0);
  for (const p of pairs) {
    let b = Math.floor(clamp01(p.pRaw) * BIN_COUNT);
    if (b >= BIN_COUNT) b = BIN_COUNT - 1;
    if (b < 0) b = 0;
    cnt[b]!++;
    if (p.yes) wins[b]!++;
  }
  const cal = new Array<number>(BIN_COUNT);
  for (let i = 0; i < BIN_COUNT; i++) {
    const center = (i + 0.5) / BIN_COUNT;
    const prior = parentBins ? parentBins[i]! : center; // root shrinks to identity
    cal[i] = (wins[i]! + PRIOR_STRENGTH * prior) / (cnt[i]! + PRIOR_STRENGTH);
  }
  const weights = cnt.map((c) => c + PRIOR_STRENGTH);
  return { n: pairs.length, bins: pav(cal, weights) };
}

/** Identity reliability curve (bin centers) — interpolates back to ~pRaw, i.e. a no-op. */
const IDENTITY_BINS = Array.from({ length: BIN_COUNT }, (_, i) => (i + 0.5) / BIN_COUNT);

function brierOf(pairs: Pair[], pred: (p: Pair) => number): number {
  if (pairs.length === 0) return Infinity;
  let s = 0;
  for (const p of pairs) s += (clamp01(pred(p)) - (p.yes ? 1 : 0)) ** 2;
  return s / pairs.length;
}

/**
 * Fit a cell, but GUARD against a learned curve that doesn't actually help.
 * For cells large enough to be used at runtime (n ≥ MIN_CELL_SAMPLES), validate the
 * fitted curve against identity (raw) on a held-out time-slice (last 25%). Keep the
 * learned curve only if it beats identity out-of-sample; otherwise store identity bins
 * so the cell is a no-op and raw passes through. This stops already-well-calibrated
 * cohorts (e.g. the US `combined` source, and currently `low`) from being made WORSE
 * by an over-fit correction — a calibration cell can now only help or do nothing.
 */
function fitCellGuarded(pairs: Pair[], parentBins: number[] | null): CalibrationCell {
  const n = pairs.length;
  if (n < MIN_CELL_SAMPLES) return fitCell(pairs, parentBins); // not used at runtime; harmless
  const cut = Math.floor(n * 0.75);
  const val = pairs.slice(cut);
  if (val.length < 15) return fitCell(pairs, parentBins); // too few to validate → trust the fit
  const trial = fitCell(pairs.slice(0, cut), parentBins).bins;
  const bFitted = brierOf(val, (p) => interpolateCell(trial, p.pRaw));
  const bIdentity = brierOf(val, (p) => p.pRaw);
  // Require a MEANINGFUL Brier improvement on the recent hold-out, not just any
  // edge — a marginal win is usually noise/drift (e.g. the US `combined` source,
  // whose raw is already well-calibrated). Borderline cells default to raw, so
  // calibration only fires where it clearly helps.
  if (bFitted <= bIdentity - GUARDRAIL_MIN_BRIER_GAIN) return fitCell(pairs, parentBins);
  return { n, bins: [...IDENTITY_BINS], identity: true }; // not a clear win → identity (raw passes through exactly)
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

/** Build the full lookup table (all tiers) from a set of pairs. Every key is
 *  prefixed by metric so high/low never blend; the per-metric cell is the root
 *  (parent of that metric's shape tier), and metrics shrink toward each metric's
 *  own root, never across metrics. */
function buildTable(pairs: Pair[]): CalibrationTable {
  const byMetric: Record<string, CalibrationCell> = {};
  for (const [metric, ps] of groupBy(pairs, (p) => p.metric)) {
    byMetric[metric] = fitCellGuarded(ps, null); // root shrinks to identity
  }

  const byShape: Record<string, CalibrationCell> = {};
  for (const [key, ps] of groupBy(pairs, (p) => `${p.metric}|${p.shape}`)) {
    const metric = key.split('|')[0]!;
    byShape[key] = fitCellGuarded(ps, byMetric[metric]!.bins);
  }

  const byShapeSource: Record<string, CalibrationCell> = {};
  for (const [key, ps] of groupBy(pairs, (p) => `${p.metric}|${p.shape}|${p.source}`)) {
    const parts = key.split('|');
    const shape = `${parts[0]}|${parts[1]}`;
    byShapeSource[key] = fitCellGuarded(ps, (byShape[shape] ?? byMetric[parts[0]!]!).bins);
  }

  const byShapeSourceHorizon: Record<string, CalibrationCell> = {};
  for (const [key, ps] of groupBy(pairs, (p) => `${p.metric}|${p.shape}|${p.source}|${horizonBucket(p.daysOut)}`)) {
    const parts = key.split('|');
    const ss = `${parts[0]}|${parts[1]}|${parts[2]}`;
    const shape = `${parts[0]}|${parts[1]}`;
    byShapeSourceHorizon[key] = fitCellGuarded(ps, (byShapeSource[ss] ?? byShape[shape] ?? byMetric[parts[0]!]!).bins);
  }

  return {
    _meta: {
      generatedAt: new Date().toISOString(),
      scoredPairs: pairs.length,
      binCount: BIN_COUNT,
      priorStrength: PRIOR_STRENGTH,
      minCellSamples: MIN_CELL_SAMPLES,
      version: VERSION,
    },
    byShapeSourceHorizon,
    byShapeSource,
    byShape,
    byMetric,
  };
}

async function loadPairs(): Promise<Pair[]> {
  const sql = getSql();
  // ORDER BY observed_at so the per-key dedup below is deterministic and keeps
  // the most-recent intra-day prediction (last write wins).
  const rows = await sql<{ payload: Record<string, unknown>; observed_at: string }[]>`
    SELECT payload, observed_at::text AS observed_at
    FROM shadow_observations
    WHERE kind = 'weather_bracket'
    ORDER BY observed_at ASC
  `;
  const gtRows = await sql<{
    city: string; target_date: string;
    resolution_high: number | null; observed_high: number | null;
    resolution_low: number | null; observed_low: number | null;
  }[]>`
    SELECT city, target_date::text AS target_date,
           resolution_high, observed_high, resolution_low, observed_low
    FROM weather_ground_truth
  `;
  const gtHigh = new Map<string, number>();
  const gtLow = new Map<string, number>();
  for (const r of gtRows) {
    const k = `${r.city}|${r.target_date}`;
    const high = r.resolution_high ?? r.observed_high;
    const low = r.resolution_low ?? r.observed_low;
    if (high != null) gtHigh.set(k, high);
    if (low != null) gtLow.set(k, low);
  }

  // Dedup to one pair per (metric, city, date, bracket, daysOut) — collapses
  // intra-day rescans (same outcome) while preserving the per-horizon prediction.
  // ORDER BY observed_at (above) makes "last write wins" = most-recent prediction.
  const dedup = new Map<string, Pair>();
  for (const row of rows) {
    const p = row.payload;
    const city = typeof p.city === 'string' ? canonicalCityKey(p.city) : null;
    if (!city) continue;
    const targetDate = typeof p.targetDate === 'string' ? p.targetDate.slice(0, 10) : '';
    const label = typeof p.bracket === 'string' ? p.bracket : '';
    if (!targetDate || !label) continue;
    const parsed = parseBracketLabel(label);
    if (!parsed) continue;
    // CALIBRATION INPUT = the bias-corrected, pre-PR1-σ-inflation Gaussian, the
    // scale runtime calibrates (modelProbCalInput). Legacy rows predate that
    // field but predate σ inflation too, so their modelProb IS that same scale.
    // Drop the transitional rows that were σ-inflated yet lack the clean input
    // (sourceStddevMultiplier ≠ 1 and no modelProbCalInput) — they're on the
    // post-inflation scale and would contaminate training.
    const sourceMult = Number(p.sourceStddevMultiplier);
    const inflated = Number.isFinite(sourceMult) && sourceMult !== 1;
    const hasCalInput = p.modelProbCalInput != null && Number.isFinite(Number(p.modelProbCalInput));
    if (inflated && !hasCalInput) continue;
    const pRaw = hasCalInput ? Number(p.modelProbCalInput) : Number(p.modelProb);
    if (!Number.isFinite(pRaw)) continue;
    // Rows predating the lowest-temp feature have no `metric` and are all highs.
    const metric: 'high' | 'low' = p.metric === 'low' ? 'low' : 'high';
    const actual = (metric === 'low' ? gtLow : gtHigh).get(`${city}|${targetDate}`);
    if (actual === undefined) continue;
    const daysOut = Number.isFinite(Number(p.daysOut)) ? Number(p.daysOut) : 2;
    const shape = classifyBracketShape(parsed.low, parsed.high);
    const source = normalizeSource(typeof p.forecastSource === 'string' ? p.forecastSource : undefined);
    const yes = isYes(actual, parsed.low, parsed.high);
    const op = Number(p.outcomePrice);
    const yesPrice = Number.isFinite(op) ? (p.tradeSide === 'YES' ? op : 1 - op) : NaN;
    const key = `${metric}|${city}|${targetDate}|${label}|${daysOut}`;
    dedup.set(key, { city, targetDate, daysOut, shape, source, metric, pRaw, yes, yesPrice, observedAt: row.observed_at });
  }
  return Array.from(dedup.values());
}

interface Bin { n: number; predSum: number; wins: number }

function reliability(pairs: Pair[], predOf: (p: Pair) => number): Bin[] {
  const bins: Bin[] = Array.from({ length: BIN_COUNT }, () => ({ n: 0, predSum: 0, wins: 0 }));
  for (const p of pairs) {
    const pred = predOf(p);
    let i = Math.floor(clamp01(pred) * BIN_COUNT);
    if (i >= BIN_COUNT) i = BIN_COUNT - 1;
    if (i < 0) i = 0;
    bins[i]!.n++;
    bins[i]!.predSum += pred;
    bins[i]!.wins += p.yes ? 1 : 0;
  }
  return bins;
}

function brier(pairs: Pair[], predOf: (p: Pair) => number): number {
  if (pairs.length === 0) return NaN;
  let s = 0;
  for (const p of pairs) {
    const pred = predOf(p);
    s += (pred - (p.yes ? 1 : 0)) ** 2;
  }
  return s / pairs.length;
}

function logLoss(pairs: Pair[], predOf: (p: Pair) => number): number {
  if (pairs.length === 0) return NaN;
  let s = 0;
  const eps = 1e-6;
  for (const p of pairs) {
    const pr = Math.min(1 - eps, Math.max(eps, predOf(p)));
    s += p.yes ? -Math.log(pr) : -Math.log(1 - pr);
  }
  return s / pairs.length;
}

function meanAbsGap(bins: Bin[], minN = 5): number {
  let gapSum = 0;
  let k = 0;
  for (const b of bins) {
    if (b.n < minN) continue;
    gapSum += Math.abs(b.wins / b.n - b.predSum / b.n);
    k++;
  }
  return k > 0 ? gapSum / k : NaN;
}

async function main(): Promise<void> {
  const doFit = process.argv.includes('--fit');
  const pairs = await loadPairs();
  log(`Loaded ${pairs.length} scored (city,date,bracket,daysOut) pairs from shadow_observations ⋈ ground truth`);
  if (pairs.length < 200) {
    log('\nToo few pairs to fit a calibration map — re-run after more shadow data accrues.');
    await closeSql();
    return;
  }

  // Chronological 80/20 split for OUT-OF-SAMPLE reporting.
  const sorted = pairs.slice().sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const cut = Math.floor(sorted.length * 0.8);
  const train = sorted.slice(0, cut);
  const test = sorted.slice(cut);
  const holdoutTable = buildTable(train);
  const calOf = (table: CalibrationTable) => (p: Pair): number =>
    calibrateWeatherBracketProbability(p.pRaw, { shape: p.shape, source: p.source, daysOut: p.daysOut, metric: p.metric }, table);
  const rawOf = (p: Pair): number => p.pRaw;

  log(`\nChronological hold-out: train=${train.length} (≤ ${train[train.length - 1]?.observedAt.slice(0, 10)}), test=${test.length}`);

  // ── Reliability (hold-out) ────────────────────────────────────────────────
  log('\nRELIABILITY on hold-out (predicted P(YES) vs actual YES freq):');
  log('  bin       n_raw  avg_raw  act    |  n_cal  avg_cal  act');
  const rawBins = reliability(test, rawOf);
  const calBins = reliability(test, calOf(holdoutTable));
  for (let i = 0; i < BIN_COUNT; i++) {
    const r = rawBins[i]!;
    const c = calBins[i]!;
    if (r.n === 0 && c.n === 0) continue;
    const rl = r.n ? `${String(r.n).padStart(4)}   ${(r.predSum / r.n).toFixed(3)}   ${(r.wins / r.n).toFixed(3)}` : '   0     -       -  ';
    const cl = c.n ? `${String(c.n).padStart(4)}   ${(c.predSum / c.n).toFixed(3)}   ${(c.wins / c.n).toFixed(3)}` : '   0     -       -  ';
    log(`  ${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}   ${rl}  |  ${cl}`);
  }

  // ── Scores (hold-out) ─────────────────────────────────────────────────────
  const brRaw = brier(test, rawOf);
  const brCal = brier(test, calOf(holdoutTable));
  const llRaw = logLoss(test, rawOf);
  const llCal = logLoss(test, calOf(holdoutTable));
  const gapRaw = meanAbsGap(rawBins);
  const gapCal = meanAbsGap(calBins);
  log('\nHOLD-OUT SCORES:        raw      calibrated   Δ');
  log(`  Brier            ${brRaw.toFixed(4)}   ${brCal.toFixed(4)}    ${(brCal - brRaw >= 0 ? '+' : '') + (brCal - brRaw).toFixed(4)}`);
  log(`  Log-loss         ${llRaw.toFixed(4)}   ${llCal.toFixed(4)}    ${(llCal - llRaw >= 0 ? '+' : '') + (llCal - llRaw).toFixed(4)}`);
  log(`  Mean |calib gap| ${gapRaw.toFixed(4)}   ${gapCal.toFixed(4)}    ${(gapCal - gapRaw >= 0 ? '+' : '') + (gapCal - gapRaw).toFixed(4)}`);

  // ── Per-shape / source / horizon (hold-out gap, raw vs cal) ───────────────
  const segs: { title: string; key: (p: Pair) => string }[] = [
    { title: 'METRIC', key: (p) => p.metric },
    { title: 'SHAPE', key: (p) => p.shape },
    { title: 'SOURCE', key: (p) => p.source },
    { title: 'HORIZON', key: (p) => horizonBucket(p.daysOut) },
  ];
  for (const seg of segs) {
    log(`\nBY ${seg.title} (hold-out): segment  n   rawGap  calGap`);
    for (const [k, ps] of Array.from(groupBy(test, seg.key)).sort((a, b) => b[1].length - a[1].length)) {
      if (ps.length < 10) continue;
      const rg = meanAbsGap(reliability(ps, rawOf), 3);
      const cg = meanAbsGap(reliability(ps, calOf(holdoutTable)), 3);
      log(`  ${k.padEnd(16)} ${String(ps.length).padStart(4)}  ${rg.toFixed(3)}   ${cg.toFixed(3)}`);
    }
  }

  // ── Acceptance gate ───────────────────────────────────────────────────────
  log('\nACCEPTANCE (hold-out):');
  log(`  Brier improves:        ${brCal < brRaw ? 'PASS' : 'FAIL'} (${brCal.toFixed(4)} < ${brRaw.toFixed(4)})`);
  log(`  Calib gap improves:    ${gapCal < gapRaw ? 'PASS' : 'FAIL'} (${gapCal.toFixed(4)} < ${gapRaw.toFixed(4)})`);

  // ── PR2b readiness: calibrated-YES / -NO cohort performance (hold-out) ────────
  // Per (metric|shape|source) cohort, the realized win rate of the bets the CALIBRATED
  // logic would take, vs breakeven (avg price). This is the gate for enabling YES
  // (and act-on-calibration NO) live per cohort: WR must clear breakeven with N.
  // Metric is part of the cohort key because the live allow-list (WEATHER_CALIBRATION_
  // LIVE_COHORTS) is metric-aware — high/low must never blend in the go/no-go read.
  const calFn = calOf(holdoutTable);
  const cohortReport = (side: 'YES' | 'NO'): void => {
    log(`\nCALIBRATED-${side} by cohort (hold-out): cohort  n  WR  breakeven  ROI`);
    const picks = test.filter((p) => {
      const c = calFn(p);
      return side === 'YES' ? c > p.yesPrice && Number.isFinite(p.yesPrice)
                            : c < p.yesPrice && Number.isFinite(p.yesPrice);
    });
    for (const [cohort, ps] of Array.from(groupBy(picks, (p) => `${p.metric}|${p.shape}|${p.source}`)).sort((a, b) => b[1].length - a[1].length)) {
      if (ps.length < 5) continue;
      const price = (p: Pair): number => (side === 'YES' ? p.yesPrice : 1 - p.yesPrice);
      const wonF = (p: Pair): boolean => (side === 'YES' ? p.yes : !p.yes);
      const n = ps.length;
      const wr = ps.filter(wonF).length / n;
      const be = ps.reduce((s, p) => s + price(p), 0) / n;
      const roi = ps.reduce((s, p) => s + (wonF(p) ? 1 / Math.max(0.01, price(p)) - 1 : -1), 0) / n;
      const gate = wr > be ? 'PASS' : 'fail';
      log(`  ${cohort.padEnd(28)} ${String(n).padStart(3)}  ${(100 * wr).toFixed(0)}%  ${(100 * be).toFixed(0)}%  ${(100 * roi).toFixed(0)}%  ${gate}`);
    }
  };
  cohortReport('YES');
  cohortReport('NO');

  if (doFit) {
    // Commit a table fit on ALL data (max signal); reported metrics above are the
    // honest out-of-sample read.
    const full = buildTable(sorted);
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const outPath = join(__dirname, '..', 'src', 'weather', 'data', 'calibrationParams.json');
    writeFileSync(outPath, JSON.stringify(full, null, 2) + '\n');
    log(`\n--fit: wrote ${outPath} (${full._meta.scoredPairs} pairs, ${Object.keys(full.byShapeSourceHorizon).length} cells)`);
    void interpolateCell; // re-exported helper kept available for ad-hoc checks
    void cellKey;
  } else {
    log('\n(audit only — pass --fit to write src/weather/data/calibrationParams.json)');
  }

  await closeSql();
}

void main().catch((err: unknown) => {
  logger.error('[calib-audit] fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
