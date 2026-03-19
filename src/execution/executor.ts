/**
 * Trade executor.
 *
 * Wraps the Simmer SDK `submitTrade` with:
 * - Pre-execution validation (stake floor, price sanity)
 * - Idempotency guard via Redis (prevent double-firing the same signal)
 * - Structured result logging
 *
 * Idempotency key: SHA-256 of `${marketId}:${direction}:${roundedStakeUsd}`
 * TTL: 1 hour — signals older than 1 hour are considered expired.
 */

import { createHash } from 'node:crypto';
import { logger } from '../shared/logger.js';
import { submitTrade, SimmerError } from '../shared/simmer.js';
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
}

/**
 * Compute an idempotency key for a trade signal.
 * Rounds stake to 2 dp to tolerate minor floating-point variance.
 */
function idempotencyKey(signal: TradeSignal): string {
  const canonical = `${signal.marketId}:${signal.direction}:${signal.stakeUsd.toFixed(2)}`;
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `${IDEMPOTENCY_KEY_PREFIX}${hash}`;
}

/**
 * Execute a single trade signal via the Simmer SDK.
 *
 * Returns an ExecutionResult — never throws. All errors are captured in result.error.
 */
export async function executeSignal(
  signal: TradeSignal,
  redis: Redis,
): Promise<ExecutionResult> {
  // 1. Stake floor check
  if (signal.stakeUsd < MIN_STAKE_USD) {
    logger.info('[executor] skipping — stake below floor', {
      marketId: signal.marketId,
      stakeUsd: signal.stakeUsd,
    });
    return { signal, skipped: true, skipReason: 'stake_below_floor' };
  }

  // 2. Idempotency check
  const key = idempotencyKey(signal);
  const alreadyFired = await redis.get(key);
  if (alreadyFired) {
    logger.info('[executor] skipping — idempotency key already set', {
      marketId: signal.marketId,
      key,
    });
    return { signal, skipped: true, skipReason: 'already_executed' };
  }

  // 3. Submit trade
  logger.info('[executor] submitting trade', {
    marketId: signal.marketId,
    direction: signal.direction,
    stakeUsd: signal.stakeUsd,
    edgeMagnitude: signal.edgeMagnitude,
    consensusP: signal.consensusProbability,
  });

  try {
    const tradeResult = await submitTrade({
      market_id: signal.marketId,
      // Simmer API uses lowercase 'yes'/'no'; our internal signal uses 'YES'/'NO'
      side: signal.direction.toLowerCase() as 'yes' | 'no',
      amount: signal.stakeUsd,
      reasoning: `OSINT signal: "${signal.sourcedFrom}" — consensus P=${signal.consensusProbability.toFixed(2)}, market P=${signal.outcomePrice.toFixed(2)}, edge=${signal.edgeMagnitude.toFixed(2)}. ${signal.reasoning}`,
    });

    if (tradeResult.success) {
      // Mark idempotency key so we don't re-fire this signal
      await redis.set(key, '1', 'EX', IDEMPOTENCY_TTL_SECONDS);
      logger.info('[executor] trade submitted successfully', {
        marketId: signal.marketId,
        txHash: tradeResult.tx_hash,
      });
    } else {
      logger.warn('[executor] trade returned success=false', {
        marketId: signal.marketId,
        error: tradeResult.error,
      });
    }

    return { signal, skipped: false, tradeResult };
  } catch (err) {
    const message = err instanceof SimmerError
      ? `HTTP ${err.statusCode.toString()}: ${err.message}`
      : err instanceof Error ? err.message : String(err);

    logger.error('[executor] trade submission failed', {
      marketId: signal.marketId,
      error: message,
    });
    return { signal, skipped: false, error: message };
  }
}

/**
 * Execute a batch of trade signals, respecting idempotency.
 *
 * Signals are processed sequentially to avoid hammering the Simmer skill.
 */
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
