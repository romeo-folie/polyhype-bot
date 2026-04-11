/**
 * Take-profit evaluator.
 *
 * Given an open position and its current market price, decides whether to exit.
 *
 * Two exit conditions (either triggers):
 *
 * 1. TAKE_PROFIT_THRESHOLD: position return ≥ TAKE_PROFIT_THRESHOLD (default 25%)
 *    return = (currentPrice - entryPrice) / entryPrice
 *
 * 2. DIVERGENCE_CLOSED: the original edge has reversed — market has moved past
 *    our consensus probability, meaning the opportunity is gone.
 *    Condition: for YES positions, currentYesPrice >= consensusProbability
 *               for NO positions,  currentYesPrice <= consensusProbability
 */

import type { Position } from '../execution/positionLedger.js';
import type { CurrentPrice } from './priceFetcher.js';

export type ExitReason =
  | 'take_profit_threshold'
  | 'divergence_closed'
  | 'stop_loss'
  | 'signal_reeval'
  | 'copytrade_mirror'
  | 'synthetic'
  | 'futures_sl'
  | 'futures_tp'
  | 'stale_exit'
  | 'trailing_stop'
  | 'trend_exit';

export interface ExitDecision {
  shouldExit: boolean;
  reason?: ExitReason;
  /** Return as a decimal (0.25 = 25%) */
  returnDecimal: number;
  /** Return as a percentage */
  returnPct: number;
}

/**
 * Evaluate whether a position should be exited.
 */
export interface ZoneAwareStopLossConfig {
  enabled: boolean;
  extremeLow: number;
  extremeHigh: number;
  minAbsoluteMove: number;
}

export function evaluateTakeProfit(
  position: Position,
  currentPrice: CurrentPrice,
  takeProfitThreshold: number,
  stopLossThreshold = 0.3,
  zoneAwareSl?: ZoneAwareStopLossConfig,
): ExitDecision {
  const { entryPrice, consensusProbability, direction } = position;
  const { currentOutcomePrice, currentYesPrice } = currentPrice;

  // Compute return on the outcome we hold
  const returnDecimal = entryPrice > 0 ? (currentOutcomePrice - entryPrice) / entryPrice : 0;
  const returnPct = returnDecimal * 100;

  // Condition 1: stop-loss — exit immediately if loss exceeds threshold.
  // Zone-aware override: for positions entered in the price tails, also require
  // an absolute price move to avoid spread-noise stop-outs on tiny-priced outcomes.
  if (returnDecimal <= -stopLossThreshold) {
    const inExtremeZone =
      zoneAwareSl?.enabled &&
      (entryPrice <= zoneAwareSl.extremeLow || entryPrice >= zoneAwareSl.extremeHigh);
    const absMove = Math.abs(entryPrice - currentOutcomePrice);
    if (!inExtremeZone || absMove >= (zoneAwareSl?.minAbsoluteMove ?? 0)) {
      return { shouldExit: true, reason: 'stop_loss', returnDecimal, returnPct };
    }
  }

  // Condition 2: take-profit threshold reached
  if (returnDecimal >= takeProfitThreshold) {
    return { shouldExit: true, reason: 'take_profit_threshold', returnDecimal, returnPct };
  }

  // Condition 2: divergence has closed (market price reached our consensus estimate)
  // Skip this for copytrades — their consensus probability is the entry price,
  // making divergence closure effectively a tiny-profit exit which we don't want.
  // Skip for reconciled positions — they have no consensus estimate, so the 0.5
  // default causes either premature exits or stuck positions.
  if (
    !position.sourcedFrom.startsWith('copytrade:') &&
    !position.sourcedFrom.startsWith('reconciled:')
  ) {
    // UP (BTC Up/Down) is a YES-side direction — its token IS the YES-token.
    // Must be treated as 'YES' here or the else branch inverts the check.
    const isYesSide = direction === 'YES' || direction === 'UP';
    const divergenceClosed = isYesSide
      ? currentYesPrice >= (consensusProbability ?? 0.5)
      : currentYesPrice <= (consensusProbability ?? 0.5);

    if (divergenceClosed) {
      return { shouldExit: true, reason: 'divergence_closed', returnDecimal, returnPct };
    }
  }

  return { shouldExit: false, returnDecimal, returnPct };
}
