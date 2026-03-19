/**
 * Trade executor.
 *
 * Execution flow:
 * 1) Try Simmer first (primary venue)
 * 2) If market is unavailable in Simmer, fall back to direct Polymarket CLOB
 *
 * Shared controls:
 * - Stake floor check
 * - Idempotency guard via Redis (prevent double-firing same signal)
 * - Structured result logging
 */

import { createHash } from 'node:crypto';
import { logger } from '../shared/logger.js';
import { submitTrade, resolveSimmerMarketId, SimmerError } from '../shared/simmer.js';
import { submitClobBuy } from '../shared/clob.js';
import { hasOpenPosition } from './positionLedger.js';
import type { SimmerTradeResult } from '../shared/simmer.js';
import type { Redis } from 'ioredis';
import type { TradeSignal } from '../mapping/index.js';

const IDEMPOTENCY_TTL_SECONDS = 3600; // 1 hour
const MIN_STAKE_USD = 0.01; // below this: skip (rounding noise)
const IDEMPOTENCY_KEY_PREFIX = 'trade:executed:';

export interface ExecutionResult {
  signal: TradeSignal;
  skipped: boolean;
  skipReason?: string;
  tradeResult?: SimmerTradeResult;
  error?: string;
  executionVenue?: 'simmer' | 'clob';
}

function idempotencyKey(signal: TradeSignal): string {
  const canonical = `${signal.marketId}:${signal.direction}:${signal.stakeUsd.toFixed(2)}`;
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `${IDEMPOTENCY_KEY_PREFIX}${hash}`;
}

function clobTokenForSignal(signal: TradeSignal): string | null {
  if (signal.direction === 'YES') return signal.clobTokenIds[0] ?? null;
  return signal.clobTokenIds[1] ?? null;
}

function isMarketNotFoundMessage(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return /market\s+not\s+found/i.test(msg);
}

async function tryExecuteViaClob(signal: TradeSignal): Promise<{
  ok: boolean;
  tradeResult?: SimmerTradeResult;
  error?: string;
}> {
  const tokenId = clobTokenForSignal(signal);
  if (!tokenId) {
    return { ok: false, error: 'CLOB fallback unavailable: missing clobTokenIds' };
  }

  logger.info('[executor] attempting CLOB fallback', {
    marketId: signal.marketId,
    tokenId,
    direction: signal.direction,
    stakeUsd: signal.stakeUsd,
  });

  const clobResult = await submitClobBuy({
    tokenId,
    amountUsd: signal.stakeUsd,
  });

  const tradeResult: SimmerTradeResult = {
    success: clobResult.success,
    tx_hash: clobResult.tx_hash,
    shares_bought: clobResult.shares_bought,
    error: clobResult.error,
    raw: clobResult.raw,
  };

  if (clobResult.success) return { ok: true, tradeResult };
  return { ok: false, tradeResult, error: clobResult.error ?? 'CLOB trade failed' };
}

export async function executeSignal(
  signal: TradeSignal,
  redis: Redis,
): Promise<ExecutionResult> {
  // 1) Stake floor check
  if (signal.stakeUsd < MIN_STAKE_USD) {
    logger.info('[executor] skipping — stake below floor', {
      marketId: signal.marketId,
      stakeUsd: signal.stakeUsd,
    });
    return { signal, skipped: true, skipReason: 'stake_below_floor' };
  }

  // 2) Open position check — don't stack into a market we already hold
  const alreadyHolding = await hasOpenPosition(redis, signal.marketId, signal.direction);
  if (alreadyHolding) {
    logger.info('[executor] skipping — already holding position in this market', {
      marketId: signal.marketId,
      direction: signal.direction,
    });
    return { signal, skipped: true, skipReason: 'position_already_open' };
  }

  // 3) Idempotency check
  const key = idempotencyKey(signal);
  const alreadyFired = await redis.get(key);
  if (alreadyFired) {
    logger.info('[executor] skipping — idempotency key already set', {
      marketId: signal.marketId,
      key,
    });
    return { signal, skipped: true, skipReason: 'already_executed' };
  }

  // 3) Try Simmer first
  const simmerId = await resolveSimmerMarketId(signal.question);

  if (simmerId) {
    logger.info('[executor] submitting trade via Simmer', {
      marketId: signal.marketId,
      simmerId,
      direction: signal.direction,
      stakeUsd: signal.stakeUsd,
      edgeMagnitude: signal.edgeMagnitude,
      consensusP: signal.consensusProbability,
    });

    try {
      const tradeResult = await submitTrade({
        market_id: simmerId,
        side: signal.direction.toLowerCase() as 'yes' | 'no',
        amount: signal.stakeUsd,
        reasoning: `OSINT signal: "${signal.sourcedFrom}" — consensus P=${signal.consensusProbability.toFixed(2)}, market P=${signal.outcomePrice.toFixed(2)}, edge=${signal.edgeMagnitude.toFixed(2)}. ${signal.reasoning}`,
      });

      if (tradeResult.success) {
        await redis.set(key, '1', 'EX', IDEMPOTENCY_TTL_SECONDS);
        logger.info('[executor] trade submitted successfully via Simmer', {
          marketId: signal.marketId,
          txHash: tradeResult.tx_hash,
        });
        return { signal, skipped: false, tradeResult, executionVenue: 'simmer' };
      }

      // Simmer returned success=false — only fall back for market-unavailable cases
      if (!isMarketNotFoundMessage(tradeResult.error)) {
        logger.warn('[executor] Simmer trade returned success=false', {
          marketId: signal.marketId,
          error: tradeResult.error,
        });
        return { signal, skipped: false, tradeResult, executionVenue: 'simmer' };
      }

      logger.warn('[executor] Simmer market unavailable; attempting CLOB fallback', {
        marketId: signal.marketId,
        error: tradeResult.error,
      });
    } catch (err) {
      const message = err instanceof SimmerError
        ? `HTTP ${err.statusCode.toString()}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);

      // Only fall back on market-not-found style failures
      if (!isMarketNotFoundMessage(message)) {
        logger.error('[executor] Simmer submission failed', {
          marketId: signal.marketId,
          error: message,
        });
        return { signal, skipped: false, error: message, executionVenue: 'simmer' };
      }

      logger.warn('[executor] Simmer market unavailable (exception); attempting CLOB fallback', {
        marketId: signal.marketId,
        error: message,
      });
    }
  } else {
    logger.info('[executor] market not in Simmer catalogue; attempting CLOB fallback', {
      marketId: signal.marketId,
      question: signal.question,
    });
  }

  // 4) CLOB fallback
  const clob = await tryExecuteViaClob(signal);
  if (clob.ok && clob.tradeResult?.success) {
    const tradeResult = clob.tradeResult;
    await redis.set(key, '1', 'EX', IDEMPOTENCY_TTL_SECONDS);
    logger.info('[executor] trade submitted successfully via CLOB fallback', {
      marketId: signal.marketId,
      txHash: tradeResult.tx_hash,
    });
    return {
      signal,
      skipped: false,
      tradeResult,
      executionVenue: 'clob',
    };
  }

  const fallbackError = clob.error ?? 'CLOB fallback failed';
  logger.error('[executor] CLOB fallback failed', {
    marketId: signal.marketId,
    error: fallbackError,
  });

  return {
    signal,
    skipped: false,
    ...(clob.tradeResult ? { tradeResult: clob.tradeResult } : {}),
    error: fallbackError,
    executionVenue: 'clob',
  };
}

export async function executeSignals(
  signals: TradeSignal[],
  redis: Redis,
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];
  for (const signal of signals) {
    const result = await executeSignal(signal, redis);
    results.push(result);
  }
  return results;
}
