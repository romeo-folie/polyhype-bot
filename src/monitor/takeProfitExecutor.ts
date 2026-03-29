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
import { submitSell, resolveSimmerMarketId, getSimmerPositions, SimmerError } from '../shared/simmer.js';
import { submitClobSell } from '../shared/clob.js';
import { closePosition } from '../execution/positionLedger.js';
import { notifyTakeProfitExecuted } from '../execution/telegram.js';
import { creditProceeds } from '../shared/bankroll.js';
import { loadConfig } from '../shared/config.js';
import { getHyperliquid, HL_SYMBOL_MAP } from '../shared/hyperliquid.js';
import type { Redis } from 'ioredis';
import type { Position } from '../execution/positionLedger.js';
import type { ExitReason } from './takeProfitEvaluator.js';

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

  // Use tracked shares if available; fall back to estimating from stake/entry price
  const sharesToSell = position.sharesHeld ?? position.stakeUsd / position.entryPrice;

  // Guard against legacy Redis positions with entryPrice=0 or NaN sharesHeld
  if (!isFinite(sharesToSell) || sharesToSell <= 0) {
    const error = `invalid sharesToSell (${String(sharesToSell)}) — entryPrice=${String(position.entryPrice)}, sharesHeld=${String(position.sharesHeld)}. Skipping sell to prevent bad order.`;
    logger.error('[take-profit-executor] aborting sell — invalid share count', {
      marketId: position.marketId,
      sharesToSell,
      entryPrice: position.entryPrice,
      sharesHeld: position.sharesHeld,
    });
    return { marketId: position.marketId, success: false, error, returnPct, reason };
  }

  logger.info('[take-profit-executor] exiting position', {
    marketId: position.marketId,
    direction: position.direction,
    sellSide,
    sharesToSell: sharesToSell.toFixed(4),
    returnPct: returnPct.toFixed(2),
    reason,
    venue: position.executionVenue,
  });

  // Route to the correct venue
  const venue = position.executionVenue;
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

  // Resolve the Simmer-internal UUID for this market.
  // Simmer does NOT accept Polymarket numeric IDs — it requires its own UUID.
  // The buy path does this via resolveSimmerMarketId(signal.question); we must
  // do the same here or the sell will always fail with "Market not found".
  const simmerId = await resolveSimmerMarketId(position.question);
  if (!simmerId) {
    const error = `Simmer market ID not found for question: "${position.question.slice(0, 80)}"`;
    logger.warn('[take-profit-executor] cannot resolve Simmer UUID — sell aborted', {
      marketId: position.marketId,
      question: position.question.slice(0, 80),
    });
    return { marketId: position.marketId, success: false, error, returnPct, reason };
  }

  logger.info('[take-profit-executor] resolved Simmer UUID', {
    marketId: position.marketId,
    simmerId,
  });

  try {
    const tradeResult = await submitSell({
      market_id: simmerId,
      side: sellSide,
      action: 'sell',
      shares: sharesToSell,
      reasoning: `Take-profit exit: ${reason} — return ${returnPct.toFixed(1)}% at price ${currentPrice.toFixed(3)}`,
    });

    if (tradeResult.success) {
      await closePosition(redis, position.marketId, position.direction);
      const proceedsUsd = sharesToSell * currentPrice;
      await creditProceeds(redis, proceedsUsd);
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
    } else {
      const error = tradeResult.error ?? 'unknown error from Simmer';
      
      // FALLBACK: Attempt Synthetic Exit on HL if primary venue fails
      const synthetic = await attemptSyntheticExit({ position, currentPrice, returnPct, reason, redis });
      if (synthetic.success) return synthetic;

      // AUTO-RECOVERY: If shares mismatch, fetch actual balance and retry ONCE
      if (error.toLowerCase().includes('insufficient shares')) {
        logger.warn('[take-profit-executor] share mismatch detected — sync and retry', {
          marketId: position.marketId,
          expected: sharesToSell.toFixed(4),
          error
        });

        const livePositions = await getSimmerPositions({ status: 'active' });
        const liveMatch = livePositions.find(p => p.market_id === simmerId && p.side === sellSide);
        
        if (liveMatch?.shares && liveMatch.shares > 0 && liveMatch.shares < sharesToSell) {
          logger.info('[take-profit-executor] retrying with actual balance', {
            marketId: position.marketId,
            actualShares: liveMatch.shares.toFixed(4)
          });
          
          const retryResult = await submitSell({
            market_id: simmerId,
            side: sellSide,
            action: 'sell',
            shares: liveMatch.shares,
            reasoning: `Recovery exit: ${reason} (Sync from ${sharesToSell.toFixed(4)} to ${liveMatch.shares.toFixed(4)})`,
          });

          if (retryResult.success) {
            await closePosition(redis, position.marketId, position.direction);
            await creditProceeds(redis, liveMatch.shares * currentPrice);
            const freshReturnPct = position.entryPrice > 0 ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100 : 0;
            await notifyTakeProfitExecuted({ position, currentPrice, returnPct: freshReturnPct, reason });
            return { marketId: position.marketId, success: true, returnPct: freshReturnPct, reason, txHash: retryResult.tx_hash };
          }
        }
      }

      logger.warn('[take-profit-executor] sell returned success=false', {
        marketId: position.marketId,
        error,
      });
      return { marketId: position.marketId, success: false, error, returnPct, reason };
    }
  } catch (err) {
    const message =
      err instanceof SimmerError
        ? `HTTP ${err.statusCode.toString()}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);

    logger.error('[take-profit-executor] exit trade failed', {
      marketId: position.marketId,
      error: message,
    });
    return { marketId: position.marketId, success: false, error: message, returnPct, reason };
  }
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

  // Get the correct token ID: index 0 for YES, index 1 for NO
  const tokenId = position.direction === 'YES'
    ? position.clobTokenIds?.[0]
    : position.clobTokenIds?.[1];

  if (position.executionVenue === 'hyperliquid') {
    // TODO: Implement Hyperliquid exit logic in Phase: futures
    return { success: false, marketId: position.marketId, error: 'Hyperliquid exit not yet implemented', returnPct, reason };
  }

  if (!tokenId) {
    const error = 'CLOB exit failed: missing token ID for direction ' + position.direction;
    logger.error('[take-profit-executor] ' + error, { marketId: position.marketId });
    return { marketId: position.marketId, success: false, error, returnPct, reason };
  }

  try {
    const clobResult = await submitClobSell({
      tokenId,
      shares: sharesToSell,
      orderType: loadConfig().CLOB_ORDER_TYPE,
    });

    if (clobResult.success) {
      await closePosition(redis, position.marketId, position.direction);
      const proceedsUsd = sharesToSell * currentPrice;
      await creditProceeds(redis, proceedsUsd);
      await notifyTakeProfitExecuted({ position, currentPrice, returnPct, reason });

      logger.info('[take-profit-executor] exit successful (clob)', {
        marketId: position.marketId,
        txHash: clobResult.tx_hash,
        returnPct: returnPct.toFixed(2),
      });

      const successResult: TakeProfitResult = {
        marketId: position.marketId,
        success: true,
        returnPct,
        reason,
      };
      if (clobResult.tx_hash) successResult.txHash = clobResult.tx_hash;
      return successResult;
    } else {
      const error = clobResult.error ?? 'CLOB sell failed';
      logger.warn('[take-profit-executor] CLOB sell returned success=false', {
        marketId: position.marketId,
        error,
      });
      return { marketId: position.marketId, success: false, error, returnPct, reason };
    }
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

  // 1. Identify correlated asset
  let hlSymbol: string | undefined;
  const lowerQuestion = position.question.toLowerCase();
  for (const [id, symbol] of Object.entries(HL_SYMBOL_MAP)) {
    if (lowerQuestion.includes(id) || lowerQuestion.includes((symbol as string).toLowerCase())) {
      hlSymbol = symbol as string;
      break;
    }
  }

  if (!hlSymbol) return { success: false, marketId: position.marketId, returnPct, reason, error: 'No correlated asset found' };

  // 2. Open Synthetic Exit (Hedge)
  const isBuy = position.direction === 'NO'; // If we were long NO, we buy the asset to hedge. If YES, we short.
  const hl = getHyperliquid();
  const hedgeStakeUsd = position.stakeUsd;

  logger.info('[take-profit-executor] attempting synthetic exit on HL', { symbol: hlSymbol, isBuy, reason });

  const result = await hl.placeMarketOrder({
    symbol: hlSymbol,
    isBuy,
    sizeUsd: hedgeStakeUsd,
    leverage: 1,
  });

  if (result.success) {
    await closePosition(redis, position.marketId, position.direction);
    await notifyTakeProfitExecuted({ position, currentPrice, returnPct, reason: `Synthetic: ${reason}` as ExitReason });
    
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
