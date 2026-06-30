/**
 * Weather entry strategy-family classification.
 *
 * Every weather bracket candidate belongs to exactly one mutually-exclusive
 * "strategy family" — a distinct trading strategy with its own edge profile,
 * admission rules, and failure modes. The scanner historically blended these
 * under one generic edge threshold; classifying them is the foundation for
 * per-family thresholds, cohort admission, and the entry backtest
 * (docs/plans/weather-entry-strategy-refinement-2026-06-29.md, Phase 2).
 *
 * This module is PURE and side-effect free: the live scanner classifies
 * in-memory opportunities, and the offline backtest classifies historical
 * shadow rows by constructing the same {@link StrategyFamilyInput} shape. Keep
 * it dependency-light so both callers can share one source of truth.
 */

/** The mutually-exclusive strategy a weather candidate belongs to. */
export type WeatherStrategyFamily =
  /** YES on an unbounded tail bracket ("X or higher" / "X or below"). */
  | 'tail_yes'
  /** YES on a bounded interior bracket. */
  | 'interior_yes'
  /** NO chosen directly because NO edge dominates (the model's own preferred side). */
  | 'native_no'
  /** NO that exists only because the model preferred YES but a YES gate blocked it. */
  | 'yes_gated_fallback_no'
  /** Maker-only NO far from the forecast/modal region (far ladder bid). */
  | 'far_no_ladder'
  /** Maker-only NO near but outside the forecast/modal region (adjacent ladder bid). */
  | 'adjacent_no_ladder'
  /** Resolution-day NO confirmed by settlement-aligned live-observation physics. */
  | 'resday_lockin_no'
  /** NO that fades the market's own favorite (highest-priced) bracket. */
  | 'market_favorite_fade'
  /** No tradeable side (defensive; candidates normally always carry a side). */
  | 'none';

/** How the candidate's decision price/side was selected. */
export type WeatherSelectedBy =
  /** Live observation locked the outcome in; price crosses to the ask. */
  | 'lockin'
  /** A far/adjacent ladder bid ceiling, not the live market quote. */
  | 'ladder_bid'
  /** The calibrated reliability-map probability drove the live side/edge. */
  | 'calibrated_edge'
  /** The raw (uncalibrated) Gaussian probability drove the side/edge. */
  | 'raw_edge';

/**
 * Minimal structural input the classifier reads. {@link WeatherBracketOpportunity}
 * satisfies this directly; the backtest builds it from persisted shadow rows
 * (deriving `isTailBracket` from the bracket label via `classifyBracketShape`).
 */
export interface StrategyFamilyInput {
  tradeSide: 'YES' | 'NO';
  /** True for an unbounded bracket (low === null || high === null). */
  isTailBracket: boolean;
  /** Which NO ladder produced this candidate, or null for a non-ladder NO. */
  noLadderKind?: 'far' | 'adjacent' | null;
  /** Model preferred YES (edgeYes ≥ edgeNo > 0) but a YES gate blocked it. */
  wouldHaveFallenBackToNo?: boolean;
  /** Bracket/side confirmed by settlement-aligned live observations (lock-in physics). */
  liveObservationConfirmed?: boolean;
  /** Scan ran on the market's resolution day (city-local timezone). */
  isResolutionDay?: boolean;
  /** This candidate's bracket label. */
  bracketLabel?: string | null;
  /** Label of the market-favorite (max YES price) bracket for the event. */
  marketFavoriteBracket?: string | null;
  /** Label of the model-modal (max model prob) bracket for the event. */
  modelModalBracket?: string | null;
  /** The calibrated probability drove the LIVE decision for this cohort. */
  calibrationLive?: boolean;
}

/**
 * Classify a candidate into exactly one strategy family.
 *
 * Precedence on the NO side (strongest signal first): live-observation lock-in
 * dominates because physics has already settled the outcome regardless of how
 * the candidate was originally generated; then the explicit ladder kinds; then
 * the YES-gate fallback provenance; then a fade of the market's own favorite;
 * else a native NO.
 */
export function classifyWeatherStrategyFamily(o: StrategyFamilyInput): WeatherStrategyFamily {
  if (o.tradeSide === 'YES') {
    return o.isTailBracket ? 'tail_yes' : 'interior_yes';
  }
  if (o.tradeSide === 'NO') {
    // Live-observation confirmation is set only on the resolution day; treat it
    // as the dominant signal — a NO on a bracket the observed extreme already
    // cleared is a lock-in even if it also looks like a ladder or fallback.
    if (o.liveObservationConfirmed === true) return 'resday_lockin_no';
    if (o.noLadderKind === 'far') return 'far_no_ladder';
    if (o.noLadderKind === 'adjacent') return 'adjacent_no_ladder';
    if (o.wouldHaveFallenBackToNo === true) return 'yes_gated_fallback_no';
    if (
      o.bracketLabel != null &&
      o.marketFavoriteBracket != null &&
      o.bracketLabel === o.marketFavoriteBracket
    ) {
      return 'market_favorite_fade';
    }
    return 'native_no';
  }
  return 'none';
}

/**
 * How the decision price/side was chosen. Mirrors the classifier's NO-side
 * precedence for the price-bearing mechanisms (lock-in ask cross → ladder bid
 * ceiling), then falls back to whether the calibrated or raw probability drove
 * the side.
 */
export function weatherSelectedBy(o: StrategyFamilyInput): WeatherSelectedBy {
  if (o.tradeSide === 'NO' && o.liveObservationConfirmed === true) return 'lockin';
  if (o.noLadderKind === 'far' || o.noLadderKind === 'adjacent') return 'ladder_bid';
  if (o.calibrationLive === true) return 'calibrated_edge';
  return 'raw_edge';
}

/**
 * Orthogonal event-level tag: the model-modal bracket and the market-favorite
 * bracket disagree. Kept as a boolean rather than a mutually-exclusive family
 * because it cross-cuts the others (a native NO, a fade, or a YES can all occur
 * inside a disagreement event). The backtest can promote it to a family later
 * if it proves to carry independent signal.
 */
export function isWeatherModalDisagreement(o: StrategyFamilyInput): boolean {
  return (
    o.modelModalBracket != null &&
    o.marketFavoriteBracket != null &&
    o.modelModalBracket !== o.marketFavoriteBracket
  );
}
