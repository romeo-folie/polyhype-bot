/**
 * Trailing-stop exit for PM positions.
 *
 * Layered on top of the fixed take-profit line: activation = TP line.
 * Floor is clamped to never fall below TP, so the first crossing degenerates
 * to today's fixed-TP behavior on an immediate reversal. Above TP, the floor
 * ratchets up with the peak so we protect real gains instead of round-tripping.
 *
 * The activation threshold is passed in by the caller so trailing always
 * matches the *effective* TP the position would otherwise exit at
 * (e.g. COPYTRADE_TAKE_PROFIT for copytrades, TAKE_PROFIT_THRESHOLD for OSINT).
 *
 * Only evaluated for PM positions (not futures) and only when
 * TRAILING_STOP_ENABLED=true. The monitor loop suppresses the fixed-TP exit
 * when trailing is enabled so trailing takes over. SL is never suppressed.
 *
 * HWM reuses the existing `position.highWaterMarkPct` ledger column already
 * used by futuresMonitor — no schema change.
 */

import type { Position } from '../execution/positionLedger.js';
import type { AppConfig } from '../shared/config.js';

export interface TrailingStopDecision {
  shouldExit: boolean;
  reason?: string;
  newHwmPct: number;
  peakPct: number;
  floorPct: number;
  drawdownPct: number;
}

/**
 * Evaluate trailing-stop for a PM position.
 *
 * Caller is responsible for:
 *   - persisting `newHwmPct` via updateHighWaterMark() every tick
 *   - short-circuiting when the feature flag is off
 *   - excluding futures/pendingSettlement positions
 *
 * Returns `shouldExit=true` with a human-readable `reason` when the current
 * PnL has pulled back past the trailing floor.
 */
export function evaluateTrailingStop(opts: {
  position: Position;
  currentPnlPct: number;
  currentBid: number | null | undefined;
  /**
   * Activation threshold in percent (e.g. 20 for +20%). Must equal the
   * effective fixed-TP line the caller applied, so trailing takes over at
   * exactly the point fixed-TP would have exited.
   */
  activationPct: number;
  cfg: AppConfig;
}): TrailingStopDecision {
  const { position, currentPnlPct, currentBid, activationPct, cfg } = opts;

  // Near-resolution guard (defense-in-depth): when the market price signals
  // imminent settlement (currentBid ≥ threshold, e.g. NO = 0.99 because YES
  // bids collapsed to 0.01), do not update the HWM and do not fire the
  // trailing stop.  The primary gate is in monitor/index.ts (routes the
  // position to pendingSettlement); this guard prevents HWM poisoning if a
  // future refactor ever reaches this function with a near-res price.
  if (
    typeof currentBid === 'number' &&
    Number.isFinite(currentBid) &&
    currentBid >= cfg.MONITOR_NEAR_RES_PRICE_THRESHOLD
  ) {
    const priorHwm = position.highWaterMarkPct;
    const preservedHwm =
      typeof priorHwm === 'number' && Number.isFinite(priorHwm) ? priorHwm : currentPnlPct;
    return {
      shouldExit: false,
      newHwmPct: preservedHwm,
      peakPct: preservedHwm,
      floorPct: Math.max(activationPct, preservedHwm - cfg.TRAILING_GIVEBACK_PCT),
      drawdownPct: preservedHwm - currentPnlPct,
    };
  }

  // HWM is monotonic: max of prior hwm and current PnL.
  const priorHwm = position.highWaterMarkPct;
  const newHwmPct = Math.max(
    typeof priorHwm === 'number' && Number.isFinite(priorHwm) ? priorHwm : currentPnlPct,
    currentPnlPct,
  );

  // Floor is clamped so it never drops below the fixed TP line.
  // First crossing of TP → floor == TP → immediate reversal exits at TP (no regression).
  // Above TP → floor ratchets up with the peak minus giveback.
  const floorPct = Math.max(activationPct, newHwmPct - cfg.TRAILING_GIVEBACK_PCT);
  const drawdownPct = newHwmPct - currentPnlPct;

  const base: TrailingStopDecision = {
    shouldExit: false,
    newHwmPct,
    peakPct: newHwmPct,
    floorPct,
    drawdownPct,
  };

  // Must have armed — peak has to have reached the activation threshold.
  if (newHwmPct < activationPct) return base;

  // Min-bid guard: skip on illiquid markets where even maker exit won't fill.
  if (
    typeof currentBid === 'number' &&
    Number.isFinite(currentBid) &&
    currentBid < cfg.TRAILING_MIN_EXIT_BID
  ) {
    return base;
  }

  if (currentPnlPct <= floorPct) {
    return {
      ...base,
      shouldExit: true,
      reason: `trailing_stop (peak +${newHwmPct.toFixed(2)}%, floor +${floorPct.toFixed(2)}%, now +${currentPnlPct.toFixed(2)}%)`,
    };
  }

  return base;
}
