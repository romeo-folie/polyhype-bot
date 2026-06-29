/**
 * Weather bracket-probability calibration (reliability map).
 *
 * The Gaussian bracket model (`estimateBracketProbability`) is systematically
 * mis-calibrated: across the full shadow history every predicted-probability
 * bucket realizes a lower win rate than predicted (overconfident). See
 * docs/issues/weather-bracket-model-overconfidence-2026-06-19.md.
 *
 * This module applies a fitted, monotone reliability map that converts the raw
 * model YES probability `p_raw = P(YES bracket)` into a calibrated `p_cal`
 * grounded in realized outcomes, keyed by (shape, source, horizon). The map is
 * fitted offline by `scripts/weather-calibration-audit.ts --fit`, committed as
 * `data/calibrationParams.json`, and loaded here at module init (same pattern as
 * the climatology table). When the artifact is missing/empty, calibration is the
 * identity — safe no-op.
 *
 * RUNTIME IS PURE + SHADOW-FIRST: the scanner logs p_cal alongside the live
 * (raw) decision; acting on p_cal is gated separately (PR2b).
 */
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

/** Coarse bracket shape — the dominant driver of calibration error. */
export type BracketShape = 'exact' | 'range' | 'high_tail' | 'low_tail';

/** Per-cell reliability curve: `bins[i]` = calibrated P(YES) for a raw prob in
 *  the i-th equal-width bin of [0,1]. Monotone non-decreasing. */
export interface CalibrationCell {
  /** Scored sample count behind this cell (post-shrinkage cells still report raw n). */
  n: number;
  /** Calibrated value per raw-probability bin (length = _meta.binCount). */
  bins: number[];
  /** True when this cell's learned curve did NOT beat raw on the guardrail hold-out,
   *  so it ships as a no-op: calibration returns the raw probability EXACTLY (incl.
   *  the outer 5% tails, which the bin-center interpolation would otherwise clamp).
   *  bins are still populated (identity centers) for the integrity test. */
  identity?: boolean;
}

export interface CalibrationTable {
  _meta: {
    generatedAt: string;
    scoredPairs: number;
    binCount: number;
    /** Bayesian pseudo-count strength used when shrinking a cell toward its parent. */
    priorStrength: number;
    /** Minimum scored n for a specific cell to be trusted at runtime. */
    minCellSamples: number;
    version: number;
  };
  /** Most-specific → least-specific lookup tiers. Keys: see cellKey(). Every key
   *  is prefixed by metric so high- and low-temperature markets never share a
   *  curve — the root tier is per-metric (byMetric['high'|'low']). */
  byShapeSourceHorizon: Record<string, CalibrationCell>;
  byShapeSource: Record<string, CalibrationCell>;
  byShape: Record<string, CalibrationCell>;
  byMetric: Record<string, CalibrationCell>;
}

export interface CalibrationFeatures {
  shape: BracketShape;
  /** Forecast source as stored on the opportunity (`open-meteo`, `hrrr-combined`, …). */
  source: string;
  daysOut: number;
  /** Which daily extreme the market resolves on. High and low calibrate separately. */
  metric: 'high' | 'low';
}

/**
 * Classify a bracket into a calibration shape from its parsed bounds.
 *   - low tail  ("X or below"): low === null
 *   - high tail ("X or higher"): high === null
 *   - exact (single degree, e.g. "27°C"): low === high
 *   - range (multi-degree, e.g. "70-71°F"): low < high
 */
export function classifyBracketShape(low: number | null, high: number | null): BracketShape {
  if (low === null) return 'low_tail';
  if (high === null) return 'high_tail';
  return low === high ? 'exact' : 'range';
}

/** Horizon bucket — forecast skill (and thus calibration) degrades with lead time. */
export function horizonBucket(daysOut: number): string {
  if (daysOut <= 1) return '0-1';
  if (daysOut <= 3) return '2-3';
  return '4+';
}

/** Normalize a forecast-source string to a stable, lowercased key. */
export function normalizeSource(source: string | null | undefined): string {
  return (source ?? 'unknown').trim().toLowerCase() || 'unknown';
}

/**
 * Is this bracket's side-specific (side, metric, shape, source) in the comma-separated
 * live calibration allow-list? New entries use `SIDE|metric|shape|source`, e.g.
 * `NO|high|exact|open-meteo`. Legacy `metric|shape|source` entries are still accepted
 * as both-side cohorts for backward compatibility.
 *
 * Side matters because the hold-out audit can validate calibrated NO while calibrated
 * YES in the same metric/shape/source bucket is a loser, or vice versa. Metric also
 * stays in the key because high/low markets validate independently.
 */
export type CalibrationTradeSide = 'YES' | 'NO';

function parseLiveCohortEntry(entry: string): {
  side: CalibrationTradeSide | null;
  metric: string;
  shape: string;
  source: string;
} | null {
  const parts = entry.split('|').map((p) => p.trim());
  if (parts.length === 3) {
    const [metric, shape, source] = parts;
    return {
      side: null,
      metric: normalizeSource(metric),
      shape: shape ?? '',
      source: normalizeSource(source),
    };
  }
  if (parts.length === 4) {
    const [sideRaw, metric, shape, source] = parts;
    const side = sideRaw?.toUpperCase();
    if (side !== 'YES' && side !== 'NO') return null;
    return {
      side,
      metric: normalizeSource(metric),
      shape: shape ?? '',
      source: normalizeSource(source),
    };
  }
  return null;
}

export function isCalibrationLiveCohortForSide(
  side: CalibrationTradeSide,
  metric: string,
  shape: BracketShape,
  source: string,
  cohortsCsv: string,
): boolean {
  const wantMetric = normalizeSource(metric);
  const wantSource = normalizeSource(source);
  return cohortsCsv
    .split(',')
    .map(parseLiveCohortEntry)
    .some((c) => c !== null
      && (c.side === null || c.side === side)
      && c.metric === wantMetric
      && c.shape === shape
      && c.source === wantSource);
}

/** @deprecated Runtime callers should use side-aware isCalibrationLiveCohortForSide. */
export function isCalibrationLiveCohort(
  metric: string,
  shape: BracketShape,
  source: string,
  cohortsCsv: string,
): boolean {
  return cohortsCsv
    .split(',')
    .map(parseLiveCohortEntry)
    .some((c) => c !== null
      && c.metric === normalizeSource(metric)
      && c.shape === shape
      && c.source === normalizeSource(source));
}

export function cellKey(features: CalibrationFeatures): {
  shapeSourceHorizon: string;
  shapeSource: string;
  shape: string;
  metric: string;
} {
  const source = normalizeSource(features.source);
  const m = features.metric;
  return {
    shapeSourceHorizon: `${m}|${features.shape}|${source}|${horizonBucket(features.daysOut)}`,
    shapeSource: `${m}|${features.shape}|${source}`,
    shape: `${m}|${features.shape}`,
    metric: m,
  };
}

/**
 * Interpolate a calibrated probability from a cell's per-bin curve at `pRaw`.
 * Bins are equal-width over [0,1]; we linearly interpolate between adjacent bin
 * CENTERS so the mapping is continuous (avoids step discontinuities at edges).
 */
export function interpolateCell(bins: number[], pRaw: number): number {
  const k = bins.length;
  if (k === 0) return pRaw;
  if (k === 1) return clamp01(bins[0]!);
  const x = clamp01(pRaw);
  const pos = x * k - 0.5; // position in "bin center" coordinates (center of bin i is at i)
  if (pos <= 0) return clamp01(bins[0]!);
  if (pos >= k - 1) return clamp01(bins[k - 1]!);
  const lo = Math.floor(pos);
  const frac = pos - lo;
  return clamp01(bins[lo]! + (bins[lo + 1]! - bins[lo]!) * frac);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

let _cachedTable: CalibrationTable | null | undefined;

/** Load the committed calibration artifact (cached). Returns null if absent. */
export function loadCalibrationTable(): CalibrationTable | null {
  if (_cachedTable !== undefined) return _cachedTable;
  try {
    _cachedTable = _require('./data/calibrationParams.json') as CalibrationTable;
  } catch {
    _cachedTable = null;
  }
  return _cachedTable;
}

/** Test-only: inject a table, or pass undefined to reset (reload from disk next call). */
export function _setCalibrationTableForTest(table: CalibrationTable | null | undefined): void {
  _cachedTable = table;
}

/**
 * Calibrate a raw model YES probability. Picks the most-specific cell with
 * enough samples (shape+source+horizon → shape+source → shape → global), then
 * interpolates its reliability curve. Identity when no table/cell is available.
 *
 * `p_raw` is P(YES for the bracket), side-agnostic — callers convert to the
 * traded side afterward exactly as they do with the raw probability.
 */
export function calibrateWeatherBracketProbability(
  pRaw: number,
  features: CalibrationFeatures,
  table: CalibrationTable | null = loadCalibrationTable(),
): number {
  if (!table) return clamp01(pRaw);
  const minN = table._meta.minCellSamples;
  const keys = cellKey(features);
  const cell =
    pickCell(table.byShapeSourceHorizon[keys.shapeSourceHorizon], minN) ??
    pickCell(table.byShapeSource[keys.shapeSource], minN) ??
    pickCell(table.byShape[keys.shape], minN) ??
    pickCell(table.byMetric[keys.metric], minN);
  if (!cell) return clamp01(pRaw);
  // Identity cells are an exact no-op — return raw without interpolation so the
  // outer 5% tails aren't clamped (matters for high-tail YES where pRaw > 0.95).
  if (cell.identity) return clamp01(pRaw);
  return interpolateCell(cell.bins, pRaw);
}

function pickCell(cell: CalibrationCell | null | undefined, minN: number): CalibrationCell | null {
  return cell && cell.n >= minN && cell.bins.length > 0 ? cell : null;
}
