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
import { submitSell, resolveSimmerMarketId, SimmerError } from '../shared/simmer.js';
import { submitClobSell, fetchClobTokenBalance, parseBalanceFromClobError, CLOB_MIN_ORDER_USD, type ClobBalanceResult } from '../shared/clob.js';
import { closePosition } from '../execution/positionLedger.js';
import { notifyTakeProfitExecuted } from '../execution/telegram.js';
import { creditProceeds } from '../shared/bankroll.js';
import { loadConfig } from '../shared/config.js';
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
    ? position.clobTokenIds[0]
    : position.clobTokenIds[1];

  if (!tokenId) {
    const error = 'CLOB exit failed: missing token ID for direction ' + position.direction;
    logger.error('[take-profit-executor] ' + error, { marketId: position.marketId });
    return { marketId: position.marketId, success: false, error, returnPct, reason };
  }

  // ── Pre-flight: check notional minimum ────────────────────────────────────
  const notionalUsd = sharesToSell * currentPrice;
  if (notionalUsd < CLOB_MIN_ORDER_USD) {
    logger.warn('[take-profit-executor] CLOB sell below minimum notional — skipping, will resolve at settlement', {
      marketId: position.marketId,
      shares: sharesToSell,
      currentPrice,
      notionalUsd: notionalUsd.toFixed(4),
      minUsd: CLOB_MIN_ORDER_USD,
    });
    return { marketId: position.marketId, success: false, error: `CLOB sell below minimum: $${notionalUsd.toFixed(4)} < $${String(CLOB_MIN_ORDER_USD)}`, returnPct, reason };
  }

  // ── Pre-flight: fetch actual on-chain balance with RPC failover ───────────
  let balanceResult: ClobBalanceResult = await fetchClobTokenBalance(tokenId);
  if (!balanceResult.ok) {
    // Retry once after a short delay
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    balanceResult = await fetchClobTokenBalance(tokenId);
  }

  let safeShares: number;
  if (!balanceResult.ok) {
    // Both attempts failed — use 98% of Redis value as conservative approximation.
    // (Previously 99.99%, which still overshot due to FAK partial fills.)
    logger.warn('[take-profit-executor] balance fetch failed after retry — using 98% fallback', {
      marketId: position.marketId,
      tokenId,
      sharesToSell,
      error: balanceResult.error,
    });
    safeShares = sharesToSell * 0.98;
  } else {
    // Ghost position cleanup — genuine zero balance means stale ledger entry.
    if (balanceResult.balance < 0.001) {
      logger.error('[take-profit-executor] on-chain balance near-zero — closing stale ledger entry', {
        marketId: position.marketId,
        tokenId,
        actualBalance: balanceResult.balance,
        redisShares: sharesToSell,
      });
      await closePosition(redis, position.marketId, position.direction);
      return { marketId: position.marketId, success: false, error: 'stale_position_cleared', returnPct, reason };
    }

    safeShares = Math.min(sharesToSell, balanceResult.balance);
    if (balanceResult.balance < sharesToSell) {
      logger.info('[take-profit-executor] CLOB balance sync: using actual balance', {
        marketId: position.marketId,
        sharesToSell,
        actualBalance: balanceResult.balance,
        diff: sharesToSell - balanceResult.balance,
      });
    }
  }

  // Truncate to 6 decimal places (CLOB precision) — floor to avoid overshoot.
  safeShares = Math.floor(safeShares * 1_000_000) / 1_000_000;
  if (safeShares <= 0) {
    return { marketId: position.marketId, success: false, error: 'safe_shares_zero', returnPct, reason };
  }

  // Re-check notional after balance adjustment
  const adjNotional = safeShares * currentPrice;
  if (adjNotional < CLOB_MIN_ORDER_USD) {
    logger.warn('[take-profit-executor] CLOB sell below minimum after balance sync — skipping', {
      marketId: position.marketId,
      safeShares,
      currentPrice,
      adjNotional: adjNotional.toFixed(4),
    });
    return { marketId: position.marketId, success: false, error: `CLOB sell below minimum after sync: $${adjNotional.toFixed(4)}`, returnPct, reason };
  }

  // ── Submit sell order ─────────────────────────────────────────────────────
  try {
    const clobResult = await submitClobSell({
      tokenId,
      shares: safeShares,
      orderType: loadConfig().CLOB_ORDER_TYPE,
    });

    if (clobResult.success) {
      await closePosition(redis, position.marketId, position.direction);
      const proceedsUsd = safeShares * currentPrice;
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

        // Truncate parsed balance to 6 decimals and floor
        const retryShares = Math.floor(parsedBalance * 1_000_000) / 1_000_000;
        const retryNotional = retryShares * currentPrice;
        if (retryShares > 0 && retryNotional >= CLOB_MIN_ORDER_USD) {
          const retryResult = await submitClobSell({
            tokenId,
            shares: retryShares,
            orderType: loadConfig().CLOB_ORDER_TYPE,
          });

          if (retryResult.success) {
            await closePosition(redis, position.marketId, position.direction);
            const proceedsUsd = retryShares * currentPrice;
            await creditProceeds(redis, proceedsUsd);
            await notifyTakeProfitExecuted({ position, currentPrice, returnPct, reason });

            logger.info('[take-profit-executor] exit successful after retry (clob)', {
              marketId: position.marketId,
              txHash: retryResult.tx_hash,
              shares: retryShares,
            });

            return {
              marketId: position.marketId,
              success: true,
              returnPct,
              reason,
              ...(retryResult.tx_hash ? { txHash: retryResult.tx_hash } : {}),
            };
          }
        }
      }
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
