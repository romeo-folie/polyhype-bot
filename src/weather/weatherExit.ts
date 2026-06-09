/**
 * Shared weather position exit helper.
 *
 * Extracted so the forecast-invalidation scanner and the drift scanner execute
 * a resolution-day position sell through identical logic without duplication.
 *
 * No Redis key constants live here — callers supply all key strings so each
 * scanner owns its own key namespace.
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { getClobOrderBook } from '../shared/clob.js';
import { getBookTouchLevels } from '../shared/bookTouch.js';
import { getPosition } from '../execution/positionLedger.js';
import { executeTakeProfit } from '../monitor/takeProfitExecutor.js';
import type { OpenWeatherPosition } from './weatherThesis.js';

export interface TryWeatherExitOpts {
  redis: Redis;
  pos: OpenWeatherPosition;
  city: string;
  targetDate: string;
  bracketLabel: string;
  heldTokenId: string;
  currentHeldProb: number;
  invalidationReason: string;
  enabled: boolean;
  isResolutionDay: boolean;
  minExitPrice: number;
  maxExitSlippage: number;
  /**
   * When true the floor is minExitPrice only (market-anchored sell-at-best-bid).
   * When false the floor is max(minExitPrice, currentHeldProb − maxExitSlippage).
   * Drift exits always use market floor; invalidation exits choose per-reason.
   */
  useMarketFloor: boolean;
  exitCooldownKey: string;
  exitCooldownS: number;
  /** Idempotency key — checked on entry and set on success. Shared across scanners so only one exit fires. */
  exitedKey: string;
  exitedTtlS: number;
  exitReason: 'weather_invalidation' | 'weather_drift';
  shadowKind: string;
  logMarker: string;
  /**
   * Fraction of sharesHeld that must be covered by bids at or above exitFloor (0–1).
   * Defaults to 1.0 (full coverage). Drift exits can pass 0.90 to allow partial-depth exits.
   */
  minDepthRatio?: number;
  /** Optional fields merged into log lines and shadow payload — e.g. hedgeBarrier, driftState. */
  extraContext?: Record<string, unknown>;
}

/**
 * Attempt a resolution-day, price-gated exit of a weather position.
 * Returns true only when executeTakeProfit succeeds; false otherwise (caller falls back to notify).
 */
export async function tryWeatherExit(opts: TryWeatherExitOpts): Promise<boolean> {
  const {
    redis, pos, heldTokenId, isResolutionDay, currentHeldProb,
    invalidationReason, enabled, minExitPrice, maxExitSlippage,
    useMarketFloor, exitCooldownKey, exitCooldownS, exitedKey, exitedTtlS,
    exitReason, shadowKind, logMarker, minDepthRatio = 1, extraContext = {},
  } = opts;

  if (!enabled) return false;
  if (!isResolutionDay) return false;

  // Idempotency: a prior scan of either scanner already sold this position.
  if (await redis.get(exitedKey).catch(() => null)) return false;

  // Exit cooldown after a prior failed sell — avoids re-submitting every scan
  // on a transient CLOB/RPC error.
  if (await redis.get(exitCooldownKey).catch(() => null)) {
    logger.debug(`${logMarker} exit on cooldown after a prior failed sell — deferring`, {
      positionId: pos.id,
      marketId: pos.marketId,
    });
    return false;
  }

  // Held-side bid book: the side we SELL.
  // REST books are best-at-END, so getBookTouchLevels gives us the true best bid.
  const heldBook = await getClobOrderBook(heldTokenId);
  const bestBid = heldBook ? (getBookTouchLevels(heldBook).bestBid?.price ?? 0) : 0;
  if (!isFinite(bestBid) || bestBid <= 0) {
    logger.info(`${logMarker} exit declined — no held-side bid`, {
      positionId: pos.id,
      marketId: pos.marketId,
      ...extraContext,
    });
    return false;
  }

  const slippageFloor = currentHeldProb - maxExitSlippage;
  const exitFloor = useMarketFloor ? minExitPrice : Math.max(minExitPrice, slippageFloor);
  if (bestBid < exitFloor) {
    logger.info(`${logMarker} exit declined — bid below floor`, {
      positionId: pos.id,
      marketId: pos.marketId,
      ...extraContext,
      invalidationReason,
      floorMode: useMarketFloor ? 'market' : 'slippage',
      bestBid: +bestBid.toFixed(4),
      minExitPrice,
      slippageFloor: +slippageFloor.toFixed(4),
      exitFloor: +exitFloor.toFixed(4),
      currentHeldProb: +currentHeldProb.toFixed(4),
    });
    return false;
  }

  // Depth gate: require cumulative bid size at or above the floor to absorb the
  // whole position so a market sell cannot sweep far below exitFloor.
  let depthAtOrAboveFloor = 0;
  for (const level of heldBook?.bids ?? []) {
    const price = parseFloat(String(level?.price ?? '0'));
    const size = parseFloat(String(level?.size ?? '0'));
    if (isFinite(price) && isFinite(size) && price >= exitFloor) depthAtOrAboveFloor += size;
  }
  if (depthAtOrAboveFloor < pos.sharesHeld * minDepthRatio) {
    logger.info(`${logMarker} exit declined — insufficient bid depth above floor`, {
      positionId: pos.id,
      marketId: pos.marketId,
      ...extraContext,
      sharesHeld: pos.sharesHeld,
      minDepthRatio,
      depthRequired: +(pos.sharesHeld * minDepthRatio).toFixed(2),
      depthAtOrAboveFloor: +depthAtOrAboveFloor.toFixed(2),
      exitFloor: +exitFloor.toFixed(4),
      bestBid: +bestBid.toFixed(4),
    });
    return false;
  }

  const ledgerPos = await getPosition(redis, pos.marketId, pos.direction);
  if (!ledgerPos) {
    logger.warn(`${logMarker} exit declined — no ledger position`, {
      positionId: pos.id,
      marketId: pos.marketId,
      direction: pos.direction,
    });
    return false;
  }

  const returnPct = pos.entryPrice > 0 ? ((bestBid - pos.entryPrice) / pos.entryPrice) * 100 : 0;
  logger.info(`${logMarker} exiting position`, {
    positionId: pos.id,
    marketId: pos.marketId,
    direction: pos.direction,
    ...extraContext,
    bestBid: +bestBid.toFixed(4),
    entryPrice: pos.entryPrice,
    returnPct: +returnPct.toFixed(2),
  });

  const result = await executeTakeProfit({
    position: ledgerPos,
    currentPrice: bestBid,
    returnPct,
    reason: exitReason,
    redis,
  });

  if (!result.success) {
    logger.warn(`${logMarker} exit sell failed — cooling down, falling back to notify`, {
      positionId: pos.id,
      marketId: pos.marketId,
      error: result.error,
    });
    await redis.set(exitCooldownKey, '1', 'EX', exitCooldownS).catch(() => {});
    return false;
  }

  await redis.set(exitedKey, '1', 'EX', exitedTtlS).catch(() => {});

  void enqueueWrite('shadow_observations', {
    kind: shadowKind,
    source: 'arb',
    marketId: pos.marketId,
    direction: pos.direction,
    wouldBlock: false,
    metricValue: bestBid,
    threshold: minExitPrice,
    payload: {
      positionId: pos.id,
      city: opts.city,
      targetDate: opts.targetDate,
      bracketLabel: opts.bracketLabel,
      bestBid,
      entryPrice: pos.entryPrice,
      sharesHeld: pos.sharesHeld,
      currentHeldProb,
      returnPct,
      realizedReturnPct: result.returnPct,
      minExitPrice,
      maxExitSlippage,
      invalidationReason,
      ...extraContext,
    },
  });

  logger.info(`${logMarker} exit executed`, {
    positionId: pos.id,
    marketId: pos.marketId,
    direction: pos.direction,
    ...extraContext,
    bestBid: +bestBid.toFixed(4),
    realizedReturnPct: +result.returnPct.toFixed(2),
  });
  return true;
}
