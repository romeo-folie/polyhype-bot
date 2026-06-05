/**
 * Rebate Farmer — passive maker liquidity provision.
 *
 * Places resting GTC post-only limit orders on fee-enabled markets with real
 * recent taker flow. Maker rebates are paid ONLY on filled maker liquidity,
 * daily, from each market's taker-fee pool: crypto 20%, most other fee
 * categories 25%, geopolitics fee-free → no rebate. Resting orders that never
 * fill earn nothing — selection optimizes for fill probability
 * (docs/issues/maker-rebates-not-earning-2026-06-05.md).
 *
 * Cycle (runs every 5 min via cron or Docker):
 *   1. Reconcile tracked orders — detect fills, cancel stale orders
 *   2. Compute budget from bankroll × fraction, capped by hard limit
 *   3. Select markets by recent fee-equivalent flow/hour; quote both tokens
 *      at effective YES-mid ∓ edge (two-sided, no inventory needed)
 *   4. Place/reprice resting orders — one per market+direction
 *   5. Once per UTC day: summary comparing fill-time rebate estimates with
 *      the public rebates API (log + Telegram)
 *
 * Filled orders enter the position ledger with sourcedFrom='rebate-farming'
 * and are managed by the monitor with tight TP/SL thresholds.
 *
 * Ships with REBATE_FARMING_ENABLED=false. Shadow-log first, then enable.
 *
 * Log marker: [rebate]
 */

import 'dotenv/config';
import { getRedis, closeRedis } from '../shared/redis.js';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getBankroll } from '../shared/bankroll.js';
import { hasOpenPosition, getPosition } from '../execution/positionLedger.js';
import { checkGlobalGovernor, recordGlobalTrade } from '../shared/governor.js';
import { selectRebateMarkets } from '../rebate/marketSelector.js';
import {
  reconcileOrders,
  loadRestingOrders,
  findRestingOrder,
  deployedUsd,
  deployedUsdForMarket,
  placeRestingOrder,
  cancelForReprice,
  resolveMatchShares,
} from '../rebate/orderManager.js';
import { maybeSendDailySummary } from '../rebate/rebateChecker.js';

async function main(): Promise<void> {
  const redis = getRedis();
  try {
    const cfg = loadConfig();

    if (!cfg.REBATE_FARMING_ENABLED) {
      logger.info('[rebate] rebate farming disabled');
      return;
    }

    // Phase 1: Reconcile existing resting orders.
    const reconciled = await reconcileOrders(redis);

    // Phase 2: Compute budget. Reload after reconcile — fills/cancels free budget.
    const orders = await loadRestingOrders(redis);
    const bankroll = await getBankroll(redis);
    const maxDeploy = Math.min(
      bankroll * cfg.REBATE_MAX_BANKROLL_FRACTION,
      cfg.REBATE_MAX_TOTAL_USD,
    );
    const currentlyDeployed = deployedUsd(orders);
    let remaining = maxDeploy - currentlyDeployed;

    let placed = 0;
    let repriced = 0;

    if (remaining < cfg.REBATE_ORDER_SIZE_USD) {
      logger.info('[rebate] budget exhausted', {
        maxDeploy: maxDeploy.toFixed(2),
        currentlyDeployed: currentlyDeployed.toFixed(2),
      });
    } else {
      // Phase 3: Select markets by recent fee-equivalent taker flow.
      const candidates = await selectRebateMarkets(redis, cfg.REBATE_MAX_MARKETS);

      if (candidates.length === 0) {
        logger.info('[rebate] no eligible markets found');
      }

      // Phase 4: Place / reprice resting orders — one per market+direction.
      // Two-sided legs are SHARE-matched: a YES+NO pair is riskless only for
      // min(sharesYes, sharesNo), so the second leg (or a leg pairing against
      // held inventory / a resting opposite order) matches the existing share
      // count instead of sizing a fresh $ORDER_SIZE (which leaves the excess
      // shares directional — the weather-bracket oversizing shape, PR #442).
      outer: for (const candidate of candidates) {
        // Shares of the first leg placed for this candidate THIS cycle.
        let cycleLegShares: number | null = null;
        for (const quote of candidate.quotes) {
          const existing = findRestingOrder(orders, candidate.marketId, quote.direction);
          if (existing) {
            // Reprice: the market re-selected with a target that drifted away
            // from the resting price — cancel and re-post at the fresh target.
            // Within threshold → leave it resting (keeps queue priority).
            if (Math.abs(existing.price - quote.price) <= cfg.REBATE_REPRICE_THRESHOLD) continue;
            const cancelledOk = await cancelForReprice(redis, existing);
            if (!cancelledOk) continue;
            orders.delete(existing.orderId);
            remaining += existing.sizeUsd;
            repriced++;
            logger.info('[rebate] repricing drifted order', {
              marketId: candidate.marketId,
              direction: quote.direction,
              oldPrice: existing.price,
              newPrice: quote.price,
            });
          }

          // Skip directions where we already hold a position (inventory-aware:
          // don't accumulate more of a side the monitor is already managing).
          if (await hasOpenPosition(redis, candidate.marketId, quote.direction)) continue;

          // Pair-matching target: held opposite inventory beats a resting
          // opposite order beats this cycle's first leg.
          const oppositeDirection = quote.direction === 'YES' ? 'NO' : 'YES';
          const heldOpposite = await getPosition(redis, candidate.marketId, oppositeDirection);
          const restingOpposite = findRestingOrder(orders, candidate.marketId, oppositeDirection);
          const matchShares = resolveMatchShares(
            heldOpposite?.sharesHeld,
            restingOpposite?.size,
            cycleLegShares,
          );

          // Fresh legs need a full order's budget; pairing legs only their
          // matched cost (placeRestingOrder enforces the CLOB minimum).
          if (matchShares == null && remaining < cfg.REBATE_ORDER_SIZE_USD) continue;

          // Enforce per-market exposure cap across both directions.
          if (deployedUsdForMarket(orders, candidate.marketId) >= cfg.REBATE_MAX_PER_MARKET_USD) {
            continue;
          }

          // Respect global rate limits.
          const gov = await checkGlobalGovernor(redis, 'polymarket');
          if (!gov.ok) {
            logger.info('[rebate] governor rate limit — pausing placement', {
              elapsedMs: gov.elapsedMs,
              minIntervalMs: gov.minIntervalMs,
            });
            break outer;
          }

          const maxUsd = Math.min(cfg.REBATE_ORDER_SIZE_USD, remaining);
          const order = await placeRestingOrder(redis, candidate, quote, { maxUsd, matchShares });

          if (order) {
            await recordGlobalTrade(redis, 'polymarket');
            orders.set(order.orderId, order);
            remaining -= order.sizeUsd;
            placed++;
            if (cycleLegShares === null) cycleLegShares = order.size;
          }
        }
      }
    }

    logger.info('[rebate] cycle complete', {
      filled: reconciled.filled.length,
      partialFills: reconciled.partialFills.length,
      staleCancelled: reconciled.stale.length,
      externalCancelled: reconciled.cancelled.length,
      repriced,
      newOrdersPlaced: placed,
      budgetRemaining: remaining.toFixed(2),
      totalDeployed: (maxDeploy - remaining).toFixed(2),
    });

    // Phase 5: Daily est-vs-API rebate summary (best-effort, never fails the cycle).
    await maybeSendDailySummary(redis).catch((err: unknown) => {
      logger.warn('[rebate] daily summary failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  } finally {
    await closeRedis();
  }
}

void main().catch((err: unknown) => {
  logger.error('[rebate] fatal error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
