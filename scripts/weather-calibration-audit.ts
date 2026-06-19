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
const VERSION = 1;

// eslint-disable-next-line no-console
const log = (s = ''): void => console.log(s);

interface Pair {
  city: string;
  targetDate: string;
  daysOut: number;
  shape: BracketShape;
  source: string;
  pRaw: number;
  yes: boolean;
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

/** Build the full lookup table (all tiers) from a set of pairs. */
function buildTable(pairs: Pair[]): CalibrationTable {
  const global = fitCell(pairs, null);

  const byShape: Record<string, CalibrationCell> = {};
  for (const [shape, ps] of groupBy(pairs, (p) => p.shape)) {
    byShape[shape] = fitCell(ps, global.bins);
  }

  const byShapeSource: Record<string, CalibrationCell> = {};
  for (const [key, ps] of groupBy(pairs, (p) => `${p.shape}|${p.source}`)) {
    const shape = key.split('|')[0]!;
    byShapeSource[key] = fitCell(ps, (byShape[shape] ?? global).bins);
  }

  const byShapeSourceHorizon: Record<string, CalibrationCell> = {};
  for (const [key, ps] of groupBy(pairs, (p) => `${p.shape}|${p.source}|${horizonBucket(p.daysOut)}`)) {
    const parts = key.split('|');
    const ss = `${parts[0]}|${parts[1]}`;
    byShapeSourceHorizon[key] = fitCell(ps, (byShapeSource[ss] ?? byShape[parts[0]!] ?? global).bins);
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
    global,
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

  // Dedup to one pair per (city, date, bracket, daysOut) — collapses intra-day
  // rescans (same outcome) while preserving the per-horizon prediction. Last write wins.
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
    const pRaw = Number(p.modelProb);
    if (!Number.isFinite(pRaw)) continue;
    const metric = p.metric === 'low' ? 'low' : 'high';
    const actual = (metric === 'low' ? gtLow : gtHigh).get(`${city}|${targetDate}`);
    if (actual === undefined) continue;
    const daysOut = Number.isFinite(Number(p.daysOut)) ? Number(p.daysOut) : 2;
    const shape = classifyBracketShape(parsed.low, parsed.high);
    const source = normalizeSource(typeof p.forecastSource === 'string' ? p.forecastSource : undefined);
    const yes = isYes(actual, parsed.low, parsed.high);
    const key = `${city}|${targetDate}|${label}|${daysOut}`;
    dedup.set(key, { city, targetDate, daysOut, shape, source, pRaw, yes, observedAt: row.observed_at });
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
    calibrateWeatherBracketProbability(p.pRaw, { shape: p.shape, source: p.source, daysOut: p.daysOut }, table);
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
