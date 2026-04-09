/**
 * Trend-exit for PM positions.
 *
 * Detects a sustained downward price trend using ordinary least-squares
 * regression over the rolling PnL% sample window that stale exit already
 * maintains (stale:samples:<marketId>:<direction> ZSET).  No new Redis keys.
 *
 * Exit fires when ALL of the following hold:
 *   1. Position age  >= TREND_EXIT_MIN_AGE_H          (ignore early noise)
 *   2. Current PnL%  <  TREND_EXIT_MIN_PNL_PCT         (must be underwater)
 *   3. Sample count  >= TREND_EXIT_MIN_SAMPLES         (enough data)
 *   4. R²            >= TREND_EXIT_MIN_R2              (trend, not a V-swing)
 *   5. slope (%/h)   <  category threshold             (declining fast enough)
 *
 * Category thresholds differentiate market volatility regimes:
 *   Sports / Crypto-Regulatory → wider (-0.8 %/h) — these markets swing hard
 *   Macro / Politics / Geo     → narrower (-0.3 %/h) — slow deliberate moves
 *
 * When TREND_EXIT_ENABLED=false, the evaluator still runs and shadow-logs
 * "[monitor] trend_exit shadow" so the caller can review before enabling.
 *
 * Re-entry is blocked via the shared stale:cooldown key (markStaleCooldown)
 * — no separate cooldown key needed.
 *
 * Copytrades and futures are excluded by the caller (index.ts).
 */

import type { Redis } from 'ioredis';
import type { Position } from '../execution/positionLedger.js';
import type { AppConfig } from '../shared/config.js';
import { inferCategory } from '../shared/outcomeRecorder.js';
import { normalizeCategory } from './staleExit.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TrendDecision {
  /** True when all gates pass and the position should be exited. */
  shouldExit: boolean;
  /** Regression slope in %/h (negative = declining). Null if not enough data. */
  slopePerH: number | null;
  /** Goodness-of-fit of the regression. Null if not computed. */
  r2: number | null;
  /** Number of samples used for regression. */
  sampleCount: number;
  /** PnL% at evaluation time. */
  currentPnlPct: number;
  /** Category-specific slope threshold used. */
  thresholdSlopePerH: number;
  /** Normalised market category. */
  category: string;
  /** Position age in hours. */
  ageH: number;
  /** Hours since sample tracker first observed this position. */
  trackedH: number;
  /** Human-readable reason a gate blocked the exit (set when shouldExit=false). */
  blockedReason?: string;
}

// ─── Redis helper ─────────────────────────────────────────────────────────────

/**
 * Read PnL% samples for a position from the stale:samples ZSET within the
 * given window, converting timestamps to hours-since-first-sample so the
 * regression x-axis starts at 0.
 *
 * Returns an empty array when fewer than 2 samples are available — the caller
 * should treat this as insufficient data.
 */
export async function fetchTrendSamples(
  redis: Redis,
  position: Position,
  windowMs: number,
  nowMs: number = Date.now(),
): Promise<{ tH: number; pct: number }[]> {
  const sKey = `stale:samples:${position.marketId}:${position.direction}`;
  const sinceMs = nowMs - windowMs;

  const members = await redis.zrangebyscore(sKey, sinceMs, '+inf');
  if (members.length < 2) return [];

  const parsed: { tsMs: number; pct: number }[] = [];
  for (const m of members) {
    const colonIdx = m.indexOf(':');
    if (colonIdx === -1) continue;
    const tsMs = parseInt(m.slice(0, colonIdx), 10);
    const pct = parseFloat(m.slice(colonIdx + 1));
    if (!Number.isFinite(tsMs) || !Number.isFinite(pct)) continue;
    parsed.push({ tsMs, pct });
  }

  if (parsed.length < 2) return [];

  // Normalise x-axis: first sample in window = t=0 h
  const t0 = parsed[0]!.tsMs;
  return parsed.map(({ tsMs, pct }) => ({
    tH: (tsMs - t0) / (1_000 * 60 * 60),
    pct,
  }));
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Single-pass OLS linear regression: y = slope·t + intercept.
 * Returns slope (y-units / t-units), R², and sample count.
 * Returns null when the x-values are degenerate (all the same timestamp).
 */
function computeLinearRegression(
  points: { tH: number; pct: number }[],
): { slope: number; r2: number } | null {
  const n = points.length;
  if (n < 2) return null;

  let sumT = 0,
    sumY = 0,
    sumTT = 0,
    sumTY = 0;
  for (const p of points) {
    sumT += p.tH;
    sumY += p.pct;
    sumTT += p.tH * p.tH;
    sumTY += p.tH * p.pct;
  }

  const denom = n * sumTT - sumT * sumT;
  if (Math.abs(denom) < 1e-12) return null; // all at same timestamp

  const slope = (n * sumTY - sumT * sumY) / denom;
  const intercept = (sumY - slope * sumT) / n;

  // R² — proportion of variance explained by the linear model
  const meanY = sumY / n;
  let ssTot = 0,
    ssRes = 0;
  for (const p of points) {
    ssTot += (p.pct - meanY) ** 2;
    ssRes += (p.pct - (slope * p.tH + intercept)) ** 2;
  }

  // If all y-values are identical, ssTot=0 → define R²=1 (perfect flat line fits trivially)
  const r2 = ssTot < 1e-12 ? 1 : 1 - ssRes / ssTot;

  return { slope, r2 };
}

/**
 * Look up the per-category slope threshold (in %/h) from config.
 * Thresholds are negative; more negative = steeper decline required to exit.
 */
function getCategorySlope(category: string, cfg: AppConfig): number {
  switch (category) {
    case 'sports':
      return cfg.TREND_EXIT_SLOPE_SPORTS;
    case 'crypto-regulatory':
      return cfg.TREND_EXIT_SLOPE_CRYPTO_REGULATORY;
    case 'ai-tech':
      return cfg.TREND_EXIT_SLOPE_AI_TECH;
    case 'macro':
      return cfg.TREND_EXIT_SLOPE_MACRO;
    case 'us-politics':
      return cfg.TREND_EXIT_SLOPE_US_POLITICS;
    case 'geopolitical':
      return cfg.TREND_EXIT_SLOPE_GEOPOLITICAL;
    default:
      return cfg.TREND_EXIT_SLOPE_DEFAULT;
  }
}

// ─── Main evaluator ───────────────────────────────────────────────────────────

/**
 * Pure function — all async Redis work (fetchTrendSamples, recordStaleSample)
 * is done by the caller before invoking this.
 *
 * Returns a TrendDecision; the caller decides whether to act (ENABLED=true)
 * or shadow-log (ENABLED=false) based on `shouldExit`.
 */
export function evaluateTrend(opts: {
  position: Position;
  currentPnlPct: number;
  firstSeenMs: number;
  samples: { tH: number; pct: number }[];
  cfg: AppConfig;
  nowMs?: number;
}): TrendDecision {
  const { position, currentPnlPct, firstSeenMs, samples, cfg } = opts;
  const nowMs = opts.nowMs ?? Date.now();

  const openedMs = new Date(position.openedAt).getTime();
  const ageH = (nowMs - openedMs) / (1_000 * 60 * 60);
  const trackedH = (nowMs - firstSeenMs) / (1_000 * 60 * 60);

  const category = normalizeCategory(inferCategory(position.question));
  const thresholdSlopePerH = getCategorySlope(category, cfg);

  const base: TrendDecision = {
    shouldExit: false,
    slopePerH: null,
    r2: null,
    sampleCount: samples.length,
    currentPnlPct,
    thresholdSlopePerH,
    category,
    ageH,
    trackedH,
  };

  // Gate 1: minimum position age — ignore early price discovery noise
  if (ageH < cfg.TREND_EXIT_MIN_AGE_H) {
    return { ...base, blockedReason: 'min_age' };
  }

  // Gate 2: must be underwater by at least MIN_PNL_PCT (a negative number)
  // cfg value is negative, e.g. -5 means "must be at -5% or worse"
  if (currentPnlPct > cfg.TREND_EXIT_MIN_PNL_PCT) {
    return { ...base, blockedReason: 'pnl_not_deep_enough' };
  }

  // Gate 3: enough samples for a meaningful regression
  if (samples.length < cfg.TREND_EXIT_MIN_SAMPLES) {
    return { ...base, blockedReason: 'insufficient_samples' };
  }

  const reg = computeLinearRegression(samples);
  if (!reg) {
    return { ...base, blockedReason: 'regression_failed' };
  }

  const { slope, r2 } = reg;

  // Gate 4: R² quality — low R² means data is noisy/V-shaped, not a clean trend
  if (r2 < cfg.TREND_EXIT_MIN_R2) {
    return { ...base, slopePerH: slope, r2, blockedReason: 'low_r2' };
  }

  // Gate 5: slope must be more negative than the category threshold
  // e.g. slope=-0.7 < threshold=-0.5 → exit; slope=-0.3 >= threshold=-0.5 → hold
  if (slope >= thresholdSlopePerH) {
    return { ...base, slopePerH: slope, r2, blockedReason: 'slope_above_threshold' };
  }

  return {
    ...base,
    shouldExit: true,
    slopePerH: slope,
    r2,
  };
}
