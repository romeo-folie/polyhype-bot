/**
 * Take-profit executor.
 *
 * When the evaluator decides to exit a position, this module:
 * 1. Calls the Simmer SDK to sell the position (inverted direction at current price)
 * 2. Removes the position from the Redis ledger
 * 3. Sends a Telegram take-profit notification
 *
 * Sell direction is always the inverse of the entry direction:
 *   Entry YES → Sell NO (exit long YES position)
 *   Entry NO  → Sell YES (exit long NO position)
 */

import { logger } from '../shared/logger.js';
import { submitTrade, SimmerError } from '../shared/simmer.js';
import { closePosition } from '../execution/positionLedger.js';
import { notifyTakeProfitExecuted } from '../execution/telegram.js';
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
  const sellDirection = position.direction === 'YES' ? 'NO' : 'YES';

  logger.info('[take-profit-executor] exiting position', {
    marketId: position.marketId,
    direction: position.direction,
    sellDirection,
    returnPct: returnPct.toFixed(2),
    reason,
  });

  try {
    const tradeResult = await submitTrade({
      market_id: position.marketId,
      direction: sellDirection,
      amount_usdc: position.stakeUsd,
    });

    if (tradeResult.success) {
      // Remove from ledger — position is closed
      await closePosition(redis, position.marketId, position.direction);

      // Notify
      await notifyTakeProfitExecuted({
        position,
        currentPrice,
        returnPct,
        reason,
      });

      logger.info('[take-profit-executor] exit successful', {
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
