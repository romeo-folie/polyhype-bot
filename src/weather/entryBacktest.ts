/**
 * Pure analytics for the weather entry backtest (scripts/weather-entry-backtest.ts).
 *
 * Everything here is side-effect free and DB-free so it can be unit-tested and
 * reused. The script wrapper does the SQL I/O and printing; the scoring,
 * family re-derivation, bucketing, aggregation, and the executed→family
 * attribution join all live here.
 *
 * Win/EV convention: buy 1 share of the traded side at entry price P; pays $1 if
 * the side wins else $0. Realized edge per share = winRate − P; break-even win
 * rate = P. See docs/plans/weather-entry-strategy-refinement-2026-06-29.md.
 */
import { parseBracketLabel } from './weatherScanner.js';
import { classifyBracketShape, horizonBucket, normalizeSource, type BracketShape } from './bracketCalibration.js';
import { canonicalCityKey } from './noaaClient.js';
import {
  classifyWeatherStrategyFamily,
  weatherSelectedBy,
  type WeatherStrategyFamily,
  type WeatherSelectedBy,
} from './strategyFamily.js';

export interface Candidate {
  marketId: string;
  city: string;
  targetDate: string;
  metric: 'high' | 'low';
  bracket: string;
  shape: BracketShape;
  source: string;
  daysOut: number;
  horizon: string;
  side: 'YES' | 'NO';
  family: WeatherStrategyFamily;
  selectedBy: WeatherSelectedBy;
  modalDisagreement: boolean;
  /** Price paid for the traded side (ladder bid for ladder NOs); the break-even win rate. */
  entryPrice: number;
  /** Raw model edge on the traded side at scan time (envelope metric_value). */
  edge: number;
  /** Distance (°) from corrected forecast to the bracket interval. */
  distance: number;
  /** Did the configured gates admit it for a live trade at scan time. */
  wouldTrade: boolean;
  /** Did the traded side win, recomputed from ground truth. */
  win: boolean;
  observedAt: string;
}

export interface GroundTruth {
  high: Map<string, number>;
  low: Map<string, number>;
}

export interface ExecutedRow {
  market_id: string;
  question: string;
  opened_at: string;
  result: string;
  return_pct: number;
  stake_usd: number;
  direction: string;
}

// ── Scoring helpers (mirror the resolver — keep in sync) ──────────────────────

/** YES iff the resolved value rounds into the bracket (half-degree boundaries). */
export function isYes(actual: number, low: number | null, high: number | null): boolean {
  const lo = low === null ? -Infinity : low - 0.5;
  const hi = high === null ? Infinity : high + 0.5;
  return actual >= lo && actual < hi;
}

/**
 * Distance (°) from a forecast point to the bracket interval; 0 inside or on the
 * open side of a tail. Uses the resolver's ±0.5° rounding boundaries so this
 * matches the scanner's `forecastDistanceToBracket` (which produced the stored
 * `farNoDistance` for ladder rows) — ladder and non-ladder candidates must be
 * measured on the same scale or the distance cohorts mix two definitions.
 */
export function distanceToBracket(forecast: number, low: number | null, high: number | null): number {
  const lo = low === null ? -Infinity : low - 0.5;
  const hi = high === null ? Infinity : high + 0.5;
  if (forecast >= lo && forecast < hi) return 0;
  if (forecast < lo) return lo - forecast;
  return forecast - hi;
}

export function priceBucket(p: number): string {
  if (!Number.isFinite(p)) return 'na';
  if (p < 0.10) return '0.00-0.10';
  if (p < 0.25) return '0.10-0.25';
  if (p < 0.40) return '0.25-0.40';
  if (p < 0.55) return '0.40-0.55';
  if (p < 0.70) return '0.55-0.70';
  if (p < 0.85) return '0.70-0.85';
  return '0.85-1.00';
}

export function distanceBucket(d: number): string {
  if (d <= 0) return 'inside';
  if (d < 0.5) return '0.0-0.5'; // "rounds into bracket" danger zone
  if (d < 1.0) return '0.5-1.0';
  if (d < 2.0) return '1.0-2.0';
  if (d < 3.0) return '2.0-3.0';
  return '3.0+';
}

export function edgeBucket(e: number): string {
  if (!Number.isFinite(e)) return 'na';
  if (e < 0) return 'edge<0';
  if (e < 0.05) return 'edge 0.00-0.05';
  if (e < 0.10) return 'edge 0.05-0.10';
  if (e < 0.20) return 'edge 0.10-0.20';
  return 'edge 0.20+';
}

function num(v: unknown): number { return typeof v === 'number' ? v : Number(v); }

/**
 * Build a scored {@link Candidate} from a single weather_bracket shadow row, or
 * null when it cannot be scored (missing city/date/bracket, unparseable label,
 * or no resolved ground truth for its city-day). The strategy family is
 * RE-DERIVED from the payload with the single PR1 definition so historical rows
 * (which predate the stored strategyFamily field) score identically to new ones.
 */
export function candidateFromShadowPayload(
  marketId: string,
  payload: Record<string, unknown>,
  metricValue: number | null,
  observedAt: string,
  gt: GroundTruth,
): Candidate | null {
  const p = payload;
  const city = typeof p.city === 'string' ? canonicalCityKey(p.city) : null;
  if (!city) return null;
  const targetDate = typeof p.targetDate === 'string' ? p.targetDate.slice(0, 10) : '';
  const bracket = typeof p.bracket === 'string' ? p.bracket : '';
  if (!targetDate || !bracket) return null;
  const parsed = parseBracketLabel(bracket);
  if (!parsed) return null;
  const side: 'YES' | 'NO' = p.tradeSide === 'NO' ? 'NO' : 'YES';
  // Rows predating the lowest-temp feature carry no metric and are all highs.
  const metric: 'high' | 'low' = p.metric === 'low' ? 'low' : 'high';
  const actual = (metric === 'low' ? gt.low : gt.high).get(`${city}|${targetDate}`);
  if (actual === undefined) return null; // unresolved — cannot score

  const shape = classifyBracketShape(parsed.low, parsed.high);
  const isTailBracket = shape === 'high_tail' || shape === 'low_tail';
  const noLadderKind: 'far' | 'adjacent' | null =
    p.noLadderKind === 'far' ? 'far' : p.noLadderKind === 'adjacent' ? 'adjacent' : null;
  const familyInput = {
    tradeSide: side,
    isTailBracket,
    noLadderKind,
    wouldHaveFallenBackToNo: p.wouldHaveFallenBackToNo === true,
    liveObservationConfirmed: p.liveObservationConfirmed === true,
    bracketLabel: bracket,
    marketFavoriteBracket: typeof p.marketFavoriteBracket === 'string' ? p.marketFavoriteBracket : null,
    modelModalBracket: typeof p.modelModalBracket === 'string' ? p.modelModalBracket : null,
    calibrationLive: p.calibrationLive === true,
  };
  const family = classifyWeatherStrategyFamily(familyInput);
  const selectedBy = weatherSelectedBy(familyInput);
  const modalDisagreement =
    familyInput.modelModalBracket != null &&
    familyInput.marketFavoriteBracket != null &&
    familyInput.modelModalBracket !== familyInput.marketFavoriteBracket;

  const yes = isYes(actual, parsed.low, parsed.high);
  const win = side === 'YES' ? yes : !yes;
  const entryPrice = num(p.outcomePrice);
  const edge = metricValue != null ? num(metricValue) : NaN;
  const daysOut = Number.isFinite(num(p.daysOut)) ? num(p.daysOut) : 2;
  const forecast = Number.isFinite(num(p.correctedForecastHigh)) ? num(p.correctedForecastHigh)
    : Number.isFinite(num(p.forecastHigh)) ? num(p.forecastHigh) : NaN;
  const distance = Number.isFinite(num(p.farNoDistance)) ? num(p.farNoDistance)
    : Number.isFinite(forecast) ? distanceToBracket(forecast, parsed.low, parsed.high) : 0;

  return {
    marketId,
    city, targetDate, metric, bracket, shape,
    source: normalizeSource(typeof p.forecastSource === 'string' ? p.forecastSource : undefined),
    daysOut, horizon: horizonBucket(daysOut), side, family, selectedBy, modalDisagreement,
    entryPrice, edge, distance, wouldTrade: p.wouldTrade === true, win, observedAt,
  };
}

/** Dedup key — one row per forecast horizon per bracket per city-day. */
export function candidateKey(c: Candidate): string {
  return `${c.metric}|${c.city}|${c.targetDate}|${c.bracket}|${c.daysOut}`;
}

// ── Aggregation ───────────────────────────────────────────────────────────────

export interface Stat { n: number; wins: number; priceSum: number; edgeSum: number }
export function emptyStat(): Stat { return { n: 0, wins: 0, priceSum: 0, edgeSum: 0 }; }
export function addToStat(s: Stat, c: Candidate): void {
  s.n++;
  s.wins += c.win ? 1 : 0;
  if (Number.isFinite(c.entryPrice)) {
    s.priceSum += c.entryPrice;
    s.edgeSum += (c.win ? 1 : 0) - c.entryPrice;
  }
}
export function winRate(s: Stat): number { return s.n ? s.wins / s.n : NaN; }
export function avgPrice(s: Stat): number { return s.n ? s.priceSum / s.n : NaN; }
/** Mean realized edge per share = winRate − avgEntryPrice (>0 ⇒ +EV before fees). */
export function realizedEdge(s: Stat): number { return s.n ? s.edgeSum / s.n : NaN; }

export function groupBy(cands: Candidate[], keyOf: (c: Candidate) => string): Map<string, Stat> {
  const m = new Map<string, Stat>();
  for (const c of cands) {
    const k = keyOf(c);
    let s = m.get(k);
    if (!s) { s = emptyStat(); m.set(k, s); }
    addToStat(s, c);
  }
  return m;
}

// ── Executed → family attribution ─────────────────────────────────────────────

export interface FamilyPnl { n: number; won: number; lost: number; pushed: number; pnl: number; stake: number }

/**
 * Attribute each REAL executed trade to a strategy family by matching it to the
 * nearest shadow candidate for the same market+side at/before entry, then
 * aggregate realized dollar PnL by family. Trades with no matching shadow row
 * (e.g. entry outside the analysis window) bucket under 'unmatched'.
 */
export function attributeExecutedByFamily(executed: ExecutedRow[], cands: Candidate[]): Map<string, FamilyPnl> {
  const byMarket = new Map<string, Candidate[]>();
  for (const c of cands) {
    if (!c.marketId) continue;
    const k = `${c.marketId}|${c.side}`;
    const arr = byMarket.get(k) ?? [];
    arr.push(c);
    byMarket.set(k, arr);
  }
  for (const arr of byMarket.values()) arr.sort((a, b) => a.observedAt.localeCompare(b.observedAt));

  const out = new Map<string, FamilyPnl>();
  const bump = (fam: string, e: ExecutedRow): void => {
    let s = out.get(fam);
    if (!s) { s = { n: 0, won: 0, lost: 0, pushed: 0, pnl: 0, stake: 0 }; out.set(fam, s); }
    s.n++;
    if (e.result === 'won') s.won++; else if (e.result === 'lost') s.lost++; else s.pushed++;
    s.pnl += e.stake_usd * e.return_pct / 100;
    s.stake += e.stake_usd;
  };
  for (const e of executed) {
    const arr = byMarket.get(`${e.market_id}|${e.direction}`);
    let fam = 'unmatched';
    if (arr && arr.length > 0) {
      // Latest candidate observed at/before entry; fall back to the earliest.
      let pick = arr[0]!;
      for (const c of arr) { if (c.observedAt <= e.opened_at) pick = c; else break; }
      fam = pick.family;
    }
    bump(fam, e);
  }
  return out;
}
