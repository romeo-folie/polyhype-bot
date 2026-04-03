/**
 * Take-profit executor.
 *
 * When the evaluator decides to exit a position, this module:
 * 1. Routes to the correct venue (Simmer or CLOB) based on position.executionVenue
 * 2. Removes the position from the Redis ledger
 * 3. Sends a Telegram take-profit notification
 *
 * Sell direction is always the same side as the entry direction:
 *   Entry YES → Sell YES shares
 *   Entry NO  → Sell NO shares
 */

import { logger } from '../shared/logger.js';
import { submitSell, resolveSimmerMarketId } from '../shared/simmer.js';
import { submitClobSell, fetchClobTokenBalance, parseBalanceFromClobError, type ClobBalanceResult, CLOB_MIN_ORDER_USD } from '../shared/clob.js';
import { closePosition, markPositionSynthHedged, markPositionPendingSettlement, updatePositionShares } from '../execution/positionLedger.js';
import { notifyTakeProfitExecuted } from '../execution/telegram.js';
import { creditProceeds } from '../shared/bankroll.js';
import { loadConfig } from '../shared/config.js';
import { recordPositionOutcome } from '../shared/positionOutcomeRecorder.js';
import { recordExecutionEvent } from '../shared/telemetry.js';
import { getHyperliquid, resolveHlSymbol } from '../shared/hyperliquid.js';
import type { Redis } from 'ioredis';
import type { Position } from '../execution/positionLedger.js';

import type { ExitReason } from './takeProfitEvaluator.js';

/**
 * Close a PM position from the ledger and, if a delta-hedge link exists,
 * also close the linked HL position. Called from all take-profit exit paths
 * so hedge positions are never orphaned.
 */
async function closePositionWithHedge(redis: Redis, marketId: string, direction: Position['direction']): Promise<void> {
  await closePosition(redis, marketId, direction);
  // Check for a linked HL hedge and close it if present.
  const hlSymbol = await redis.get(`hedge:link:${marketId}`).catch(() => null);
  if (hlSymbol) {
    try {
      const hl = getHyperliquid();
      const result = await hl.closePosition(hlSymbol);
      if (result.success) {
        logger.info('[take-profit-executor] closed linked HL hedge', { marketId, hlSymbol });
      } else {
        logger.warn('[take-profit-executor] failed to close linked HL hedge', { marketId, hlSymbol, error: result.error });
      }
    } catch (err) {
      logger.warn('[take-profit-executor] error closing linked HL hedge', { marketId, hlSymbol, error: String(err) });
    }
    await redis.del(`hedge:link:${marketId}`).catch((e: unknown) => { logger.debug('[take-profit-executor] hedge:link del failed (non-fatal)', { marketId, error: String(e) }); });
  }
}

function emitExecutionOutcome(redis: Redis, position: Position, returnPct: number, exitPrice: number, reason: ExitReason): void {
  if (!position.executionId) return;
  const realizedPnlUsd = position.stakeUsd * (returnPct / 100);
  void recordExecutionEvent(redis, 'execution_outcome', {
    executionId: position.executionId,
    marketId: position.marketId,
    direction: position.direction,
    finalExecutionPath: 'take_profit',
    entryPrice: position.entryPrice,
    exitPrice: exitPrice,
    entryTimestamp: position.openedAt,
    exitTimestamp: new Date().toISOString(),
    realizedPnlUsd: realizedPnlUsd,
    realizedRoi: returnPct / 100,
    executionVenue: position.executionVenue,
    modeConfigured: position.modeConfigured ?? loadConfig().EXECUTION_MODE,
    entryExecutionPath: position.entryExecutionPath ?? null,
    entryOrderType: position.entryOrderType ?? null,
    fallbackReason: position.fallbackReason ?? null,
    decisionSpreadBps: position.decisionSpreadBps ?? null,
    makerPriceImprovementBps: position.makerPriceImprovementBps ?? null,
    makerPriceImprovementUsd: position.makerPriceImprovementUsd ?? null,
    closedReason: reason,
  }).catch(() => {});
}

export interface TakeProfitResult {
  marketId: string;
  success: boolean;
  txHash?: string | undefined;
  error?: string | undefined;
  returnPct: number;
  reason: ExitReason;
}

/**
 * Execute a take-profit exit for a single position.
 *
 * Routes to Simmer or CLOB based on position.executionVenue.
 * Never throws — all errors are captured in result.error.
 */
export async function executeTakeProfit(opts: {
  position: Position;
  currentPrice: number;
  returnPct: number;
  reason: ExitReason;
  redis: Redis;
}): Promise<TakeProfitResult> {
  const { position, currentPrice, returnPct, reason, redis } = opts;
  // Sell the same side we bought (sell YES shares to exit a YES position)
  const sellSide = position.direction.toLowerCase() as 'yes' | 'no';

  // Use tracked shares if available; fall back to estimating from stake/entry price.
  // Truncate to 6 decimal places to avoid rounding overshoot vs actual CLOB balance.
  // Use truncation (floor toward zero), not rounding — rounding up could exceed fill size.
  // Avoid truncating values smaller than 1e-6 to zero (which would trip the <= 0 guard below).
  const rawShares = position.sharesHeld ?? position.stakeUsd / position.entryPrice;
  const sharesToSell = rawShares >= 1e-6
    ? Math.floor(rawShares * 1_000_000) / 1_000_000
    : rawShares; // sub-micro values: keep as-is; the <= 0 / NaN guard handles truly invalid values

  // Guard against legacy Redis positions with entryPrice=0 or NaN sharesHeld
  if (!isFinite(sharesToSell) || sharesToSell <= 0) {
    const error = `terminal_no_balance: invalid sharesToSell (${String(sharesToSell)}) — entryPrice=${String(position.entryPrice)}, sharesHeld=${String(position.sharesHeld)}`;
    logger.error('[take-profit-executor] aborting sell — invalid share count', {
      marketId: position.marketId,
      sharesToSell,
      entryPrice: position.entryPrice,
      sharesHeld: position.sharesHeld,
    });
    // Durable-flag position so monitor loop does not retry
    await updatePositionShares(redis, position.marketId, position.direction, 0, 'terminal_no_balance').catch(() => {});
    return { marketId: position.marketId, success: false, error, returnPct, reason };
  }

  logger.info('[take-profit-executor] exiting position', {
    marketId: position.marketId,
    direction: position.direction,
    sellSide,
    sharesToSell: sharesToSell.toFixed(4),
    returnPct: returnPct.toFixed(2),
    reason,
    venue: position.executionVenue ?? 'simmer',
  });

  // Route to the correct venue
  const venue = position.executionVenue ?? 'simmer';
  if (venue === 'clob') {
    return executeClobExit({ position, currentPrice, returnPct, reason, redis, sharesToSell });
  }
  return executeSimmerExit({ position, currentPrice, returnPct, reason, redis, sellSide, sharesToSell });
}

async function executeSimmerExit(opts: {
  position: Position;
  currentPrice: number;
  returnPct: number;
  reason: ExitReason;
  redis: Redis;
  sellSide: 'yes' | 'no';
  sharesToSell: number;
}): Promise<TakeProfitResult> {
  const { position, currentPrice, returnPct, reason, redis, sellSide, sharesToSell } = opts;

  const question = position.question ?? '';
  let simmerIdResult: string | null = null;
  let simmerError: string | null = null;

  // STEP 1: Always attempt resolution by question first for precision and UUID consistency.
  simmerIdResult = await resolveSimmerMarketId(question);
  
  if (simmerIdResult) {
    try {
      const tradeResult = await submitSell({
        market_id: simmerIdResult,
        side: sellSide,
        action: 'sell',
        shares: sharesToSell,
        reasoning: `Resolved sell: ${reason} — return ${returnPct.toFixed(1)}%`,
      });

      if (tradeResult.success) {
        return await finalizeSimmerExit(redis, position, sharesToSell, tradeResult, currentPrice, returnPct, reason);
      }
      simmerError = tradeResult.error ?? null;
    } catch (err) {
      simmerError = err instanceof Error ? err.message : String(err);
    }
  }

  // STEP 2: Fall back to direct numeric ID if resolution failed or resolution result failed with "Market not found"
  const isResolutionFailure = !simmerIdResult || (simmerError && (simmerError.toLowerCase().includes('not found') || simmerError.toLowerCase().includes('invalid market')));

  if (isResolutionFailure) {
    logger.info('[take-profit-executor] Simmer resolution failed or returned market_not_found — trying direct numeric ID', {
      marketId: position.marketId,
      simmerError,
    });

    try {
      const directResult = await submitSell({
        market_id: position.marketId,
        side: sellSide,
        action: 'sell',
        shares: sharesToSell,
        reasoning: `Direct numeric sell: ${reason} — return ${returnPct.toFixed(1)}%`,
      });

      if (directResult.success) {
        return await finalizeSimmerExit(redis, position, sharesToSell, directResult, currentPrice, returnPct, reason);
      }
      simmerError = directResult.error ?? null;
    } catch (err) {
      simmerError = err instanceof Error ? err.message : String(err);
    }
  }

  // STEP 3: Fallback to CLOB exit if Simmer resolution failed and we have CLOB enabled/token IDs.
  // We ONLY fall back if the failure was a mapping/resolution error (Market not found).
  // If Simmer gave a real execution error (slippage, balance, etc.), we do NOT fall back to CLOB
  // to avoid double-charging or out-of-sync state if Simmer's fill was partial.
  const isAbortedResolution = !simmerIdResult && (!simmerError || simmerError.toLowerCase().includes('resolution failed'));
  const isMarketNotFoundError = simmerError && (
    simmerError.toLowerCase().includes('not found') || 
    simmerError.toLowerCase().includes('invalid market')
  );

  if ((isAbortedResolution || isMarketNotFoundError) && position.clobTokenIds && position.clobTokenIds.length > 0) {
    logger.info('[take-profit-executor] Simmer resolution/lookup failed — falling back to CLOB', {
      marketId: position.marketId,
      simmerError,
    });
    return executeClobExit({ position, currentPrice, returnPct, reason, redis, sharesToSell });
  }

  // STEP 4: Attempt Synthetic Exit on HL if all else fails
  const synthetic = await attemptSyntheticExit({ position, currentPrice, returnPct, reason, redis });
  if (synthetic.success) return synthetic;

  const finalError = simmerError ?? 'Simmer resolution failed';
  return { marketId: position.marketId, success: false, error: finalError, returnPct, reason };
}

/** Post-sell cleanup for Simmer: close position, credit proceeds, record outcome, notify. */
async function finalizeSimmerExit(
  redis: Redis,
  position: Position,
  sharesExited: number,
  tradeResult: { tx_hash?: string | null | undefined },
  currentPrice: number,
  returnPct: number,
  reason: ExitReason,
): Promise<TakeProfitResult> {
  await closePositionWithHedge(redis, position.marketId, position.direction);
  const proceedsUsd = sharesExited * currentPrice;
  await creditProceeds(redis, proceedsUsd);
  await recordPositionOutcome(redis, position, {
    result: returnPct >= 0 ? 'won' : 'lost',
    returnPct,
  });
  emitExecutionOutcome(redis, position, returnPct, currentPrice, reason);
  await notifyTakeProfitExecuted({ position, currentPrice, returnPct, reason });

  logger.info('[take-profit-executor] exit successful (simmer)', {
    marketId: position.marketId,
    txHash: tradeResult.tx_hash,
    returnPct: returnPct.toFixed(2),
  });

  const successResult: TakeProfitResult = {
    marketId: position.marketId,
    success: true,
    returnPct,
    reason,
  };
  if (tradeResult.tx_hash) successResult.txHash = tradeResult.tx_hash;
  return successResult;
}

/** Post-sell cleanup: close position, credit proceeds, record outcome, notify. */
async function finalizeClobExit(
  redis: Redis,
  position: Position,
  sharesExited: number,
  currentPrice: number,
  returnPct: number,
  reason: ExitReason,
  txHash?: string | null | undefined,
): Promise<TakeProfitResult> {
  await closePositionWithHedge(redis, position.marketId, position.direction);
  const proceedsUsd = sharesExited * currentPrice;
  await creditProceeds(redis, proceedsUsd);
  await recordPositionOutcome(redis, position, {
    result: returnPct >= 0 ? 'won' : 'lost',
    returnPct,
    executionVenueOverride: 'clob',
  });
  await notifyTakeProfitExecuted({ position, currentPrice, returnPct, reason });

  const result: TakeProfitResult = { marketId: position.marketId, success: true, returnPct, reason };
  if (txHash) result.txHash = txHash;
  return result;
}

async function executeClobExit(opts: {
  position: Position;
  currentPrice: number;
  returnPct: number;
  reason: ExitReason;
  redis: Redis;
  sharesToSell: number;
}): Promise<TakeProfitResult> {
  const { position, currentPrice, returnPct, reason, redis, sharesToSell } = opts;

  // 1. Venue Guard: Ensure we don't attempt CLOB token extraction for HL positions
  if (position.executionVenue === 'hyperliquid') {
    return { success: false, marketId: position.marketId, error: 'Hyperliquid exit not yet implemented via CLOB route', returnPct, reason };
  }

  // 2. Extract token ID
  const tokenId = position.direction === 'YES'
    ? position.clobTokenIds?.[0]
    : position.clobTokenIds?.[1];

  if (!tokenId) {
    const error = 'CLOB exit failed: missing token ID for direction ' + position.direction;
    logger.error('[take-profit-executor] ' + error, { marketId: position.marketId });
    return { marketId: position.marketId, success: false, error, returnPct, reason };
  }

  // Polymarket CLOB rejects orders below $1.00 notional (shares × currentPrice).
  // Positions this small are better left for the resolution redeemer (which pays $1/share at settlement).
  const notionalUsd = sharesToSell * currentPrice;
  if (notionalUsd < CLOB_MIN_ORDER_USD) {
    logger.warn('[take-profit-executor] CLOB sell below minimum notional — marking pendingSettlement', {
      marketId: position.marketId,
      shares: sharesToSell,
      currentPrice,
      notionalUsd: notionalUsd.toFixed(4),
      minUsd: CLOB_MIN_ORDER_USD,
    });
    await markPositionPendingSettlement(redis, position.marketId, position.direction);

    return { marketId: position.marketId, success: false, error: `CLOB sell below minimum: $${notionalUsd.toFixed(4)} < $${String(CLOB_MIN_ORDER_USD)}`, returnPct, reason };
  }

  // Fetch actual on-chain balance with one retry to handle transient RPC failures.
  // Uses discriminated result so genuine zero balance is handled differently from fetch errors.
  let balanceResult: ClobBalanceResult = await fetchClobTokenBalance(tokenId);
  if (!balanceResult.ok) {
    // Retry once before falling back.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    balanceResult = await fetchClobTokenBalance(tokenId);
  }

  let actualBalance: number;
  if (!balanceResult.ok) {
    // Both attempts failed — use 98% of Redis value as conservative approximation.
    // (Previously 99.99%, which still overshot due to FAK partial fills.)
    logger.warn('[take-profit-executor] balance fetch failed after retry — using 98% fallback', {
      marketId: position.marketId,
      tokenId,
      sharesToSell,
      error: balanceResult.error,
    });
    actualBalance = sharesToSell * 0.98;
  } else {
    actualBalance = balanceResult.balance;
  }

  // Ghost position cleanup — genuine zero balance (not a fetch error) means stale ledger entry.
  if (balanceResult.ok && actualBalance < 0.001) {
    logger.error('[take-profit-executor] on-chain balance near-zero — closing stale ledger entry', {
      marketId: position.marketId,
      tokenId,
      actualBalance,
      redisShares: sharesToSell,
    });
    await updatePositionShares(redis, position.marketId, position.direction, 0, 'terminal_no_balance').catch(() => {});
    await closePositionWithHedge(redis, position.marketId, position.direction);
    return { marketId: position.marketId, success: false, error: 'terminal_no_balance', returnPct, reason };
  }

  // Use the minimum of (tracked shares, actual balance) to prevent overshoot.
  const safeShares = Math.min(sharesToSell, actualBalance);

  // Re-check notional after balance sync — actual balance may be too small to sell
  const postSyncNotional = safeShares * currentPrice;
  if (postSyncNotional < CLOB_MIN_ORDER_USD) {
    logger.warn('[take-profit-executor] post-sync notional below minimum — marking pendingSettlement', {
      marketId: position.marketId,
      safeShares,
      currentPrice,
      postSyncNotional: postSyncNotional.toFixed(4),
      minUsd: CLOB_MIN_ORDER_USD,
    });
    await markPositionPendingSettlement(redis, position.marketId, position.direction);
    return { marketId: position.marketId, success: false, error: `post-sync below minimum: $${postSyncNotional.toFixed(4)} < $${String(CLOB_MIN_ORDER_USD)}`, returnPct, reason };
  }

  // Log drift when actual balance is less than Redis-tracked shares.
  if (actualBalance < sharesToSell) {
    logger.info('[take-profit-executor] CLOB balance sync: using actual balance', {
      marketId: position.marketId,
      sharesToSell,
      actualBalance,
      diff: sharesToSell - actualBalance,
    });
  }

  if (safeShares <= 0) {
    logger.warn('[take-profit-executor] safe shares <= 0 after balance sync — skipping sell', {
      marketId: position.marketId,
      sharesToSell,
      actualBalance,
      safeShares,
    });
    await updatePositionShares(redis, position.marketId, position.direction, 0, 'terminal_no_balance').catch(() => {});
    await closePositionWithHedge(redis, position.marketId, position.direction);
    return { marketId: position.marketId, success: false, error: 'terminal_no_balance', returnPct, reason };
  }

  try {
    const clobResult = await submitClobSell({
      tokenId,
      shares: safeShares,
      orderType: loadConfig().CLOB_ORDER_TYPE,
    });

    if (clobResult.success) {
      logger.info('[take-profit-executor] exit successful (clob)', {
        marketId: position.marketId,
        txHash: clobResult.tx_hash,
        shares: safeShares,
      });
      return finalizeClobExit(redis, position, safeShares, currentPrice, returnPct, reason, clobResult.tx_hash);
    }

    // ── Auto-retry: parse actual balance from CLOB error and retry once ─────
    const error = clobResult.error ?? 'CLOB sell failed';
    if (error.toLowerCase().includes('not enough balance')) {
      const parsedBalance = parseBalanceFromClobError(error);
      if (parsedBalance !== null && parsedBalance > 0 && parsedBalance < safeShares) {
        logger.info('[take-profit-executor] retrying with CLOB-reported balance', {
          marketId: position.marketId,
          previousShares: safeShares,
          clobBalance: parsedBalance,
        });

        const retryShares = Math.floor(parsedBalance * 1_000_000) / 1_000_000;
        const retryNotional = retryShares * currentPrice;
        if (retryShares > 0 && retryNotional >= CLOB_MIN_ORDER_USD) {
          const retryResult = await submitClobSell({
            tokenId,
            shares: retryShares,
            orderType: loadConfig().CLOB_ORDER_TYPE,
          });

          if (retryResult.success) {
            logger.info('[take-profit-executor] exit successful after balance retry (clob)', {
              marketId: position.marketId,
              txHash: retryResult.tx_hash,
              shares: retryShares,
            });
            return finalizeClobExit(redis, position, retryShares, currentPrice, returnPct, reason, retryResult.tx_hash);
          }
        }
      }
    }

    // Dead market: no buyers at any price — mark pendingSettlement
    if (error.toLowerCase().includes('no match')) {
      logger.warn('[take-profit-executor] CLOB sell has no matching buyers — marking pendingSettlement', {
        marketId: position.marketId,
      });
      await markPositionPendingSettlement(redis, position.marketId, position.direction);
    }

    logger.warn('[take-profit-executor] CLOB sell returned success=false', {
      marketId: position.marketId,
      error,
    });
    return { marketId: position.marketId, success: false, error, returnPct, reason };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[take-profit-executor] CLOB exit trade failed', {
      marketId: position.marketId,
      error: message,
    });
    return { marketId: position.marketId, success: false, error: message, returnPct, reason };
  }
}

/**
 * If the primary venue fails, "close" the risk by opening an offsetting perp on Hyperliquid.
 */
async function attemptSyntheticExit(opts: {
  position: Position;
  currentPrice: number;
  returnPct: number;
  reason: ExitReason;
  redis: Redis;
}): Promise<TakeProfitResult> {
  const { position, currentPrice, returnPct, reason, redis } = opts;
  const cfg = loadConfig();

  if (!cfg.FUTURES_ENABLED) {
    return { success: false, marketId: position.marketId, returnPct, reason, error: 'Futures disabled' };
  }

  // 1. Identify correlated asset — use resolveHlSymbol (word-boundary safe).
  const hlSymbol = resolveHlSymbol(position.question);
  if (!hlSymbol) return { success: false, marketId: position.marketId, returnPct, reason, error: 'No correlated asset found' };

  // 2. Open Synthetic Exit (Hedge)
  const isBuy = position.direction === 'NO'; // If we were long NO, we buy the asset to hedge. If YES, we short.
  const hl = getHyperliquid();
  const hedgeStakeUsd = position.stakeUsd;

  // Margin cap check — synthetic exit opens a new HL position; must respect global cap.
  try {
    const state = await hl.getClearinghouseState();
    const positions = await hl.getOpenPositions(state);
    const totalCurrentMargin = positions.reduce((sum, p) => sum + parseFloat(p.position.marginUsed || '0'), 0);
    if (totalCurrentMargin + hedgeStakeUsd > cfg.FUTURES_GLOBAL_MAX_MARGIN_USD) {
      logger.warn('[take-profit-executor] skipping synthetic exit — global margin cap reached', {
        current: totalCurrentMargin.toFixed(2),
        hedge: hedgeStakeUsd.toFixed(2),
        cap: cfg.FUTURES_GLOBAL_MAX_MARGIN_USD,
      });
      return { success: false, marketId: position.marketId, returnPct, reason, error: 'global_margin_cap' };
    }
  } catch (err) {
    logger.error('[take-profit-executor] margin check failed — aborting synthetic exit', { error: String(err) });
    return { success: false, marketId: position.marketId, returnPct, reason, error: 'margin_check_failed' };
  }

  logger.info('[take-profit-executor] attempting synthetic exit on HL', { symbol: hlSymbol, isBuy, reason });

  const result = await hl.placeMarketOrder({
    symbol: hlSymbol,
    isBuy,
    sizeUsd: hedgeStakeUsd,
    leverage: 1,
  });

  if (result.success) {
    // Persist the hedge link so the redeemer can find and close the HL leg at settlement.
    await redis.set(`hedge:link:${position.marketId}`, hlSymbol, 'EX', 7 * 24 * 3600);
    logger.info('[take-profit-executor] synthetic exit: hedge link persisted', {
      marketId: position.marketId,
      hlSymbol,
    });

    // Mark the PM position as synthetically hedged rather than removing it.
    // The PM shares are still held on-chain — removing the ledger entry would make them
    // invisible to the redeemer and orphan them permanently. The redeemer handles final
    // settlement when the market resolves.
    try {
      await markPositionSynthHedged(redis, position.marketId, position.direction);
    } catch (markErr) {
      logger.error('[take-profit-executor] CRITICAL: failed to mark PM position as synthHedged — rolling back HL', {
        marketId: position.marketId,
        hlSymbol,
        error: markErr instanceof Error ? markErr.message : String(markErr),
      });
      // Attempt to close the HL position to restore a clean state.
      const rollback = await hl.closePosition(hlSymbol).catch((e: unknown) => ({ success: false, error: String(e) }));
      if (!rollback.success) {
        logger.error('[take-profit-executor] HL rollback failed — manual intervention required', {
          marketId: position.marketId,
          hlSymbol,
          rollbackError: rollback.error,
        });
      }
      await redis.del(`hedge:link:${position.marketId}`).catch((e: unknown) => { logger.debug('[take-profit-executor] hedge:link del failed (non-fatal)', { marketId: position.marketId, error: String(e) }); });
      return { success: false, marketId: position.marketId, returnPct, reason, error: 'synth_hedge_mark_failed_rolled_back' };
    }

    await notifyTakeProfitExecuted({ 
       position, 
       currentPrice, 
       returnPct, 
       reason: 'synthetic',
       mechanismDetail: reason,
    });
    
    return {
      marketId: position.marketId,
      success: true,
      returnPct,
      reason,
      txHash: result.txHash,
    };
  }

  return { success: false, marketId: position.marketId, returnPct, reason, error: result.error || 'Synthetic exit failed' };
}
