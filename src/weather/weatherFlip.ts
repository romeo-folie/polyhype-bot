/**
 * Weather drift flip strategy (Phase 6).
 *
 * Classifies open weather positions as flip candidates based on the Phase 3-5
 * state machine, then optionally executes a taker flip (exit held side + buy
 * opposite at ask) when all gates clear.
 *
 * Flip candidate classes:
 *   confirmed_flip     - live oracle proves opposite is winner / our side impossible
 *   market_oracle_flip - market AND oracle explain the reprice; both agree against us
 *   forecast_flip      - modal/forecast persisted against us; no oracle confirmation
 *   audit_only         - market dead; forecast/oracle don't explain → do not auto-flip
 *
 * Only confirmed_flip and (when WEATHER_DRIFT_FLIP_CONFIRMED_ONLY=false)
 * market_oracle_flip are eligible for live execution.
 *
 * Log marker: [weather-flip]
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { getClobOrderBook } from '../shared/clob.js';
import { getBookTouchLevels } from '../shared/bookTouch.js';
import { submitClobBuy, CLOB_MIN_ORDER_USD } from '../shared/clob.js';
import type { OpenWeatherPosition } from './weatherThesis.js';
import type { WeatherDriftState } from './weatherDriftStrategy.js';
import type { ContradictionClass } from './liveObservation.js';
import { tryWeatherExit } from './weatherExit.js';

export type FlipCandidateClass =
  | 'confirmed_flip'      // oracle proves outcome, opposite side is the winner
  | 'market_oracle_flip'  // market + oracle both explain the adverse move
  | 'forecast_flip'       // persistent modal/forecast against us; oracle not yet confirmed
  | 'audit_only';         // market dead; no oracle or forecast explanation → do not auto-flip

// Minimum bump ratio relative to CLOB_MIN_ORDER_USD, same as hedge/lock-in helpers.
const FLIP_BUY_MIN_ORDER_BUMP_RATIO = 0.6;

// Idempotency key prefix — prevents double-flip within the same scan cycle.
export const FLIP_EXECUTED_KEY_PREFIX = 'weather:drift_flip_executed:';
const FLIP_EXECUTED_TTL_S = 14 * 24 * 3600;
// Cooldown after a failed flip buy — avoids rapid retry on transient errors.
export const FLIP_COOLDOWN_KEY_PREFIX = 'weather:drift_flip_cooldown:';

/**
 * Classify whether and how a position is a flip candidate.
 * Returns null when the position is not a flip candidate.
 */
export function classifyFlipCandidate(params: {
  state: WeatherDriftState;
  oracleState: 'oracle_impossible' | 'oracle_confirmed' | null;
  oracleConfidence: 'settlement_aligned' | 'proxy' | 'none';
  contradictionClass: ContradictionClass | null;
  marketAgainstTier: 1 | 2 | null;
  currentHeldBid: number | null;
  marketDeadBid: number;
  currentHeldProb: number;
  modalStreak: number;
  modalMinRunsForFlip: number;
}): FlipCandidateClass | null {
  const {
    state,
    oracleState,
    oracleConfidence,
    contradictionClass,
    marketAgainstTier,
    currentHeldBid,
    marketDeadBid,
    currentHeldProb,
    modalStreak,
    modalMinRunsForFlip,
  } = params;

  // oracle_confirmed means OUR held side is the winner — do NOT flip.
  // Only oracle_impossible (our side cannot win) warrants a confirmed flip.
  const oracleSettlementClear =
    oracleState === 'oracle_impossible' &&
    oracleConfidence === 'settlement_aligned';

  // confirmed_flip: live oracle has made the outcome settlement-clear.
  if (oracleSettlementClear) {
    return 'confirmed_flip';
  }

  // audit_only: market is dead (bid near zero) but forecast/oracle don't explain it.
  // The correct response may be an oracle-mapping fix, not a trade.
  const marketIsDead = currentHeldBid != null && currentHeldBid <= marketDeadBid;
  if (marketIsDead && contradictionClass === 'market_contradicts_model') {
    return 'audit_only';
  }

  // market_oracle_flip: both market repricing and oracle confirm our side is impaired.
  if (
    contradictionClass === 'market_confirms_oracle' &&
    marketAgainstTier === 1
  ) {
    return 'market_oracle_flip';
  }

  // forecast_flip: persistent modal/forecast state; no live oracle confirmation.
  if (
    (state === 'modal_against' || state === 'thesis_weakened') &&
    modalStreak >= modalMinRunsForFlip &&
    currentHeldProb < 0.5
  ) {
    return 'forecast_flip';
  }

  return null;
}

export interface TryWeatherFlipOpts {
  redis: Redis;
  pos: OpenWeatherPosition;
  city: string;
  targetDate: string;
  bracketLabel: string;
  heldTokenId: string;
  oppositeTokenId: string;
  oppositeDirection: 'YES' | 'NO';
  currentHeldProb: number;
  /** The opposite side's model fair value used to compute edge. */
  oppositeModelFairValue: number;
  flipCandidateClass: FlipCandidateClass;
  isResolutionDay: boolean;
  confirmedOnly: boolean;
  minEdgeBps: number;
  maxOppositePrice: number;
  /** Maximum total notional (USD) remaining in this scan cycle. */
  remainingScanNotional: number;
  /** Maximum total notional (USD) remaining for this city in this cycle. */
  remainingCityNotional: number;
  exitCooldownKey: string;
  exitCooldownS: number;
  exitedKey: string;
  exitedTtlS: number;
  flipCooldownS: number;
  extraContext?: Record<string, unknown>;
}

export interface TryWeatherFlipResult {
  executed: boolean;
  amountUsd: number;
  reason: string;
}

/**
 * Attempt a flip: exit the held side (if bid/depth clear) then buy the opposite
 * side as a taker (FAK at current ask).
 *
 * Returns { executed: false } when any gate blocks. Returns { executed: true }
 * only after both the exit sell succeeds and the opposite-side buy succeeds.
 */
export async function tryWeatherFlip(opts: TryWeatherFlipOpts): Promise<TryWeatherFlipResult> {
  const {
    redis, pos, city, targetDate, bracketLabel,
    heldTokenId, oppositeTokenId, oppositeDirection,
    currentHeldProb, oppositeModelFairValue,
    flipCandidateClass, isResolutionDay, confirmedOnly,
    minEdgeBps, maxOppositePrice,
    remainingScanNotional, remainingCityNotional,
    exitCooldownKey, exitCooldownS, exitedKey, exitedTtlS,
    flipCooldownS, extraContext = {},
  } = opts;

  // Only confirmed_flip is eligible by default; market_oracle_flip when confirmedOnly=false.
  if (flipCandidateClass === 'forecast_flip' || flipCandidateClass === 'audit_only') {
    return { executed: false, amountUsd: 0, reason: 'flip_class_not_eligible' };
  }
  if (confirmedOnly && flipCandidateClass !== 'confirmed_flip') {
    return { executed: false, amountUsd: 0, reason: 'confirmed_only_gate' };
  }

  // Idempotency and cooldown.
  const flipExecutedKey = `${FLIP_EXECUTED_KEY_PREFIX}${pos.id}`;
  const flipCooldownKey = `${FLIP_COOLDOWN_KEY_PREFIX}${pos.id}`;
  if (await redis.get(flipExecutedKey).catch(() => null)) {
    return { executed: false, amountUsd: 0, reason: 'already_flipped' };
  }
  if (await redis.get(flipCooldownKey).catch(() => null)) {
    return { executed: false, amountUsd: 0, reason: 'flip_on_cooldown' };
  }

  // Fetch opposite-side book to check ask price and edge.
  const oppBook = await getClobOrderBook(oppositeTokenId);
  const oppAsk = oppBook ? (getBookTouchLevels(oppBook).bestAsk?.price ?? null) : null;
  if (oppAsk == null || oppAsk <= 0) {
    logger.info('[weather-flip] no opposite-side ask — skipping', {
      positionId: pos.id,
      marketId: pos.marketId,
      oppositeDirection,
      ...extraContext,
    });
    return { executed: false, amountUsd: 0, reason: 'no_opposite_ask' };
  }

  if (oppAsk > maxOppositePrice) {
    logger.info('[weather-flip] opposite ask exceeds max price — skipping', {
      positionId: pos.id,
      oppAsk,
      maxOppositePrice,
      ...extraContext,
    });
    return { executed: false, amountUsd: 0, reason: 'opposite_ask_too_high' };
  }

  const edgeBps = Math.round((oppositeModelFairValue - oppAsk) * 10_000);
  if (edgeBps < minEdgeBps) {
    logger.info('[weather-flip] insufficient edge on opposite side — skipping', {
      positionId: pos.id,
      edgeBps,
      minEdgeBps,
      oppositeModelFairValue: +oppositeModelFairValue.toFixed(4),
      oppAsk: +oppAsk.toFixed(4),
      ...extraContext,
    });
    return { executed: false, amountUsd: 0, reason: 'edge_below_min' };
  }

  // Notional check against scan and city caps.
  const intendedUsd = pos.sharesHeld * oppAsk;
  const effectiveUsd = Math.max(intendedUsd, CLOB_MIN_ORDER_USD);
  if (effectiveUsd > remainingScanNotional) {
    return { executed: false, amountUsd: 0, reason: 'scan_notional_cap' };
  }
  if (effectiveUsd > remainingCityNotional) {
    return { executed: false, amountUsd: 0, reason: 'city_notional_cap' };
  }

  // Gate: too small to bump to CLOB minimum 1:1.
  if (intendedUsd < CLOB_MIN_ORDER_USD * FLIP_BUY_MIN_ORDER_BUMP_RATIO) {
    logger.info('[weather-flip] flip notional too far below CLOB minimum — skipping', {
      positionId: pos.id,
      intendedUsd: +intendedUsd.toFixed(4),
      minOrderUsd: CLOB_MIN_ORDER_USD,
      ...extraContext,
    });
    return { executed: false, amountUsd: 0, reason: 'notional_below_clob_min' };
  }

  // Step 1: exit the held side. Only fires on resolution day (same gate as drift exits).
  const exited = await tryWeatherExit({
    redis,
    pos,
    city,
    targetDate,
    bracketLabel,
    heldTokenId,
    currentHeldProb,
    invalidationReason: `weather_drift_flip:${flipCandidateClass}`,
    enabled: true,
    isResolutionDay,
    minExitPrice: 0.05,
    maxExitSlippage: 0.20,
    useMarketFloor: true,
    exitCooldownKey,
    exitCooldownS,
    exitedKey,
    exitedTtlS,
    exitReason: 'weather_drift',
    shadowKind: 'weather_drift_flip_exit',
    logMarker: '[weather-flip]',
    minDepthRatio: 0.90,
    extraContext: { flipCandidateClass, oppositeDirection, ...extraContext },
  });

  // If exit failed, do not proceed to the opposite-side buy.
  if (!exited) {
    await redis.set(flipCooldownKey, '1', 'EX', flipCooldownS).catch(() => {});
    return { executed: false, amountUsd: 0, reason: 'exit_failed' };
  }

  // Step 2: buy the opposite side as a taker (FAK).
  const amountUsd = Math.max(intendedUsd, CLOB_MIN_ORDER_USD);
  logger.info('[weather-flip] buying opposite side', {
    positionId: pos.id,
    marketId: pos.marketId,
    oppositeDirection,
    oppAsk: +oppAsk.toFixed(4),
    amountUsd: +amountUsd.toFixed(4),
    edgeBps,
    flipCandidateClass,
    ...extraContext,
  });

  const buyResult = await submitClobBuy({
    tokenId: oppositeTokenId,
    amountUsd,
    orderType: 'FAK',
  });

  if (!buyResult.success) {
    logger.warn('[weather-flip] opposite-side buy failed — cooling down', {
      positionId: pos.id,
      marketId: pos.marketId,
      oppositeDirection,
      error: buyResult.error,
    });
    await redis.set(flipCooldownKey, '1', 'EX', flipCooldownS).catch(() => {});
    return { executed: false, amountUsd: 0, reason: 'buy_failed' };
  }

  const sharesBought = buyResult.shares_bought ?? 0;
  logger.info('[weather-flip] flip executed', {
    positionId: pos.id,
    marketId: pos.marketId,
    city,
    targetDate,
    bracketLabel,
    oppositeDirection,
    flipCandidateClass,
    sharesBought,
    amountUsd: +amountUsd.toFixed(4),
    oppAsk: +oppAsk.toFixed(4),
    edgeBps,
    ...extraContext,
  });

  await redis.set(flipExecutedKey, '1', 'EX', FLIP_EXECUTED_TTL_S).catch(() => {});

  void enqueueWrite('shadow_observations', {
    kind: 'weather_drift_flip',
    source: 'arb',
    marketId: pos.marketId,
    direction: oppositeDirection,
    wouldBlock: false,
    metricValue: amountUsd,
    threshold: CLOB_MIN_ORDER_USD,
    payload: {
      positionId: pos.id,
      city,
      targetDate,
      bracketLabel,
      heldDirection: pos.direction,
      oppositeDirection,
      flipCandidateClass,
      oppAsk,
      amountUsd,
      sharesBought,
      edgeBps,
      minEdgeBps,
      entryPrice: pos.entryPrice,
      sharesHeld: pos.sharesHeld,
      ...extraContext,
    },
  });

  return { executed: true, amountUsd, reason: 'flip_executed' };
}
