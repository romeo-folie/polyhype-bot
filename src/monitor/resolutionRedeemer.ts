/**
 * Resolution redeemer.
 *
 * Checks Simmer for any resolved (won) positions and redeems them for USDC.e.
 * Called at the start of each monitor cycle, before price checks.
 *
 * Flow:
 *   1. GET /api/sdk/positions?status=resolved&venue=polymarket
 *   2. Filter to redeemable=true
 *   3. POST /api/sdk/redeem for each — Simmer signs + broadcasts for managed wallets
 *   4. Remove redeemed positions from Redis ledger
 *   5. Credit proceeds to bankroll and notify Telegram
 *
 * Rate limit: Simmer redeem is 10/minute. We process sequentially to stay within limits.
 */

import { logger } from '../shared/logger.js';
import { getSimmerPositions, submitRedeem, SimmerError } from '../shared/simmer.js';
import { closePosition } from '../execution/positionLedger.js';
import { creditProceeds } from '../shared/bankroll.js';
import { notifyRedemptionExecuted } from '../execution/telegram.js';
import type { Redis } from 'ioredis';

export interface RedemptionResult {
  marketId: string;
  side: 'yes' | 'no';
  success: boolean;
  txHash?: string;
  valueUsdc?: number;
  error?: string;
}

/**
 * Find and redeem all resolved winning positions on Simmer.
 *
 * Never throws — errors are logged and captured per-position.
 * Returns an array of results (one per redeemable position attempted).
 */
export async function redeemResolvedPositions(redis: Redis): Promise<RedemptionResult[]> {
  const results: RedemptionResult[] = [];

  let resolvedPositions;
  try {
    resolvedPositions = await getSimmerPositions({
      status: 'resolved',
      venue: 'polymarket',
      source: 'sdk:polymarket-geopolitical-agent',
    });
  } catch (err) {
    logger.warn('[redeemer] failed to fetch resolved positions — skipping redemption cycle', {
      error: err instanceof Error ? err.message : String(err),
    });
    return results;
  }

  const redeemable = resolvedPositions.filter((p) => p.redeemable === true);

  if (redeemable.length === 0) {
    logger.debug('[redeemer] no redeemable positions found');
    return results;
  }

  logger.info('[redeemer] found redeemable positions', { count: redeemable.length });

  for (const pos of redeemable) {
    const side = pos.side as 'yes' | 'no';
    try {
      const redeemResult = await submitRedeem({ market_id: pos.market_id, side });

      if (redeemResult.success) {
        // Remove from Redis ledger — treat direction as uppercase to match ledger keys
        const direction = side.toUpperCase() as 'YES' | 'NO';
        await closePosition(redis, pos.market_id, direction);

        // Credit face value (resolved = $1/share) to bankroll
        const proceedsUsdc = pos.value_usdc ?? pos.shares ?? 0;
        if (proceedsUsdc > 0) {
          await creditProceeds(redis, proceedsUsdc);
        }

        // Notify
        const notifyOpts: Parameters<typeof notifyRedemptionExecuted>[0] = {
          marketId: pos.market_id,
          question: pos.question ?? pos.market_id,
          side,
          valueUsdc: proceedsUsdc,
        };
        if (redeemResult.tx_hash) notifyOpts.txHash = redeemResult.tx_hash;
        await notifyRedemptionExecuted(notifyOpts);

        logger.info('[redeemer] redemption successful', {
          marketId: pos.market_id,
          side,
          txHash: redeemResult.tx_hash,
          valueUsdc: proceedsUsdc,
        });

        const r: RedemptionResult = {
          marketId: pos.market_id,
          side,
          success: true,
          valueUsdc: proceedsUsdc,
        };
        if (redeemResult.tx_hash) r.txHash = redeemResult.tx_hash;
        results.push(r);
      } else {
        const error = redeemResult.error ?? 'unknown error from Simmer';
        logger.warn('[redeemer] redemption returned success=false', {
          marketId: pos.market_id,
          error,
        });
        results.push({ marketId: pos.market_id, side, success: false, error });
      }
    } catch (err) {
      const message =
        err instanceof SimmerError
          ? `HTTP ${err.statusCode.toString()}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);

      logger.error('[redeemer] redemption failed', { marketId: pos.market_id, side, error: message });
      results.push({ marketId: pos.market_id, side, success: false, error: message });
    }
  }

  return results;
}
