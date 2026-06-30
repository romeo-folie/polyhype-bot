/**
 * Weather maker-fill lifecycle logging (forward toxicity data collection).
 *
 * The entry backtest showed real maker FILLS lose money while candidate-quote
 * shadow EV looks +EV — i.e. fills cluster on trades that moved against us
 * (adverse selection). Shadow can never measure this; only real fills can. This
 * persists one shadow_observations row (kind='weather_maker_lifecycle') per
 * weather maker order at POST and at FILL so toxicity can be measured forward.
 *
 * Storage is shadow_observations JSONB (same pattern as weather_bracket /
 * weather_bracket_full) rather than a dedicated table — a low-risk first cut;
 * promotable to a typed table later. Rows are linked by (marketId, direction):
 * a 'posted' row carries the cohort context, and a 'filled' row carries the
 * realized fill + detection path; analysis joins them.
 *
 * KEY SIGNAL — fillDetectionPath: the most adversely-selected fills are detected
 * ASYNC by the reconciler (the scanner blocks re-emission after an adverse
 * reprice, so the executor-resume path never runs and fill-time market state is
 * unrecoverable). So 'reconciler' fills are a robust toxicity proxy even when
 * the precise fill-time mid is null.
 */
import { enqueueWrite } from '../db/writeQueue.js';

export type MakerLifecycleEvent = 'posted' | 'filled';
export type MakerFillDetectionPath = 'executor_resume' | 'reconciler';

export interface MakerLifecycleInput {
  eventType: MakerLifecycleEvent;
  /** How a fill was detected. null on 'posted' rows. */
  fillDetectionPath?: MakerFillDetectionPath | null;
  marketId: string;
  direction: 'YES' | 'NO';
  /** Cohort context — populated on 'posted' rows (reconciler 'filled' rows lack the
   *  opp, so these join from the matching posted row by marketId+direction). */
  strategyFamily?: string | null;
  city?: string | null;
  bracket?: string | null;
  targetDate?: string | null;
  metric?: 'high' | 'low' | null;
  daysOut?: number | null;
  isResolutionDay?: boolean | null;
  forecastSource?: string | null;
  /** Posted limit price (the break-even the order rests at). */
  postedPrice?: number | null;
  /** Book mid at this event (post time, or fill-detection time). null when unavailable
   *  (reconciler fills). */
  clobMid?: number | null;
  /** Model probability at this event (post-time, or fill-detection-time on executor_resume). */
  modelProb?: number | null;
  edge?: number | null;
  /** Realized fill VWAP ('filled' rows). */
  fillPrice?: number | null;
  fillShares?: number | null;
  /** Signed toxicity: (clobMid − postedPrice)/postedPrice in bps. Positive = mid above our
   *  entry (favorable); negative = mid below our entry (adverse). null when mid unavailable. */
  toxicityBps?: number | null;
}

/** Compute signed toxicity in bps: where the book mid sits relative to our posted price. */
export function makerToxicityBps(clobMid: number | null | undefined, postedPrice: number | null | undefined): number | null {
  if (clobMid == null || postedPrice == null || !Number.isFinite(clobMid) || !Number.isFinite(postedPrice) || postedPrice <= 0) {
    return null;
  }
  return Math.round(((clobMid - postedPrice) / postedPrice) * 10_000);
}

/** Persist one maker-lifecycle row. Callers gate on WEATHER_MAKER_LIFECYCLE_LOG_ENABLED. */
export function enqueueWeatherMakerLifecycle(input: MakerLifecycleInput): void {
  void enqueueWrite('shadow_observations', {
    kind: 'weather_maker_lifecycle',
    source: 'arb',
    marketId: input.marketId,
    direction: input.direction,
    wouldBlock: false,
    // Envelope metricValue carries the toxicity proxy for cheap top-level filtering.
    metricValue: input.toxicityBps ?? 0,
    threshold: 0,
    payload: { ...input },
  });
}
