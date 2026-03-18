/**
 * Simmer SDK execution wrapper.
 *
 * Submits a trade signal to the `polymarket-ai-divergence` Simmer skill.
 * Retries once on timeout (network blip), fails fast on auth/logic errors.
 */

import { submitTrade, SimmerError } from '../shared/simmer.js';
import { logger } from '../shared/logger.js';
import type { TradeSignal } from '../mapping/index.js';

export interface ExecutionResult {
  success: boolean;
  txHash?: string | undefined;
  error?: string | undefined;
  /** Signal that was attempted */
  signal: TradeSignal;
}

/**
 * Execute a single trade signal via the Simmer SDK.
 * Retries once on timeout; does not retry on 4xx (auth/logic errors).
 */
export async function executeSignal(signal: TradeSignal): Promise<ExecutionResult> {
  const input = {
    market_id: signal.marketId,
    direction: signal.direction,
    amount_usdc: signal.stakeUsd,
  } as const;

  logger.info('[executor] submitting trade', {
    marketId: signal.marketId,
    direction: signal.direction,
    stakeUsd: signal.stakeUsd.toFixed(2),
    edgeMagnitude: signal.edgeMagnitude.toFixed(3),
  });

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await submitTrade(input);

      if (result.success) {
        logger.info('[executor] trade submitted', {
          marketId: signal.marketId,
          txHash: result.tx_hash,
          attempt,
        });
        return { success: true, txHash: result.tx_hash, signal };
      }

      // Simmer returned success=false with an error message — not retriable
      logger.warn('[executor] simmer rejected trade', {
        marketId: signal.marketId,
        error: result.error,
      });
      return { success: false, error: result.error ?? 'Simmer rejected trade', signal };
    } catch (err) {
      const isTimeout =
        err instanceof Error &&
        (err.name === 'TimeoutError' || err.message.toLowerCase().includes('timeout'));
      const isSimmerError = err instanceof SimmerError;

      // Don't retry 4xx auth/logic errors
      if (isSimmerError && err.statusCode >= 400 && err.statusCode < 500) {
        logger.warn('[executor] non-retriable error', {
          marketId: signal.marketId,
          status: err.statusCode,
          error: err.message,
        });
        return { success: false, error: err.message, signal };
      }

      if (attempt === 1 && isTimeout) {
        logger.warn('[executor] timeout on attempt 1, retrying', { marketId: signal.marketId });
        continue;
      }

      const message = err instanceof Error ? err.message : String(err);
      logger.error('[executor] trade submission failed', {
        marketId: signal.marketId,
        attempt,
        error: message,
      });
      return { success: false, error: message, signal };
    }
  }

  // Should never reach here — loop always returns or continues
  return { success: false, error: 'unexpected executor state', signal };
}

/**
 * Execute all trade signals sequentially.
 * Returns results for all signals (success and failure).
 */
export async function executeSignals(signals: TradeSignal[]): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];
  for (const signal of signals) {
    const result = await executeSignal(signal);
    results.push(result);
  }
  return results;
}
