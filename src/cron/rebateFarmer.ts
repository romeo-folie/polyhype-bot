/**
 * Rebate Farmer — passive maker liquidity provision.
 *
 * Places resting GTC post-only limit orders on high-volume, tight-spread
 * binary markets to earn maker rebates. Polymarket distributes 100% of
 * taker fees to makers, so even random-direction resting orders that get
 * filled are structurally positive (+1.12% per trade on average).
 *
 * Cycle (runs every 5 min via cron or Docker):
 *   1. Reconcile tracked orders — detect fills, cancel stale orders
 *   2. Compute budget from bankroll × fraction, capped by hard limit
 *   3. Select top markets by volume × (1/spread) composite score
 *   4. Place new resting orders inside the spread
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
import { hasOpenPosition } from '../execution/positionLedger.js';
import { checkGlobalGovernor, recordGlobalTrade } from '../shared/governor.js';
import { selectRebateMarkets } from '../rebate/marketSelector.js';
import {
  reconcileOrders,
  getDeployedUsd,
  hasRestingOrderForMarket,
  placeRestingOrder,
} from '../rebate/orderManager.js';

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

    // Phase 2: Compute budget.
    const bankroll = await getBankroll(redis);
    const maxDeploy = Math.min(
      bankroll * cfg.REBATE_MAX_BANKROLL_FRACTION,
      cfg.REBATE_MAX_TOTAL_USD,
    );
    const currentlyDeployed = await getDeployedUsd(redis);
    let remaining = maxDeploy - currentlyDeployed;

    if (remaining < cfg.REBATE_ORDER_SIZE_USD) {
      logger.info('[rebate] budget exhausted', {
        maxDeploy: maxDeploy.toFixed(2),
        currentlyDeployed: currentlyDeployed.toFixed(2),
      });
      return;
    }

    // Phase 3: Select markets.
    const candidates = await selectRebateMarkets(redis, cfg.REBATE_MAX_MARKETS);

    if (candidates.length === 0) {
      logger.info('[rebate] no eligible markets found');
      return;
    }

    // Phase 4: Place new resting orders.
    let placed = 0;
    for (const candidate of candidates) {
      if (remaining < cfg.REBATE_ORDER_SIZE_USD) break;

      // Skip markets where we already have a resting order.
      if (await hasRestingOrderForMarket(redis, candidate.marketId)) continue;

      // Skip markets where we already have an open position.
      if (await hasOpenPosition(redis, candidate.marketId, candidate.direction)) continue;

      // Respect global rate limits.
      const gov = await checkGlobalGovernor(redis, 'polymarket');
      if (!gov.ok) {
        logger.info('[rebate] governor rate limit — pausing placement', {
          elapsedMs: gov.elapsedMs,
          minIntervalMs: gov.minIntervalMs,
        });
        break;
      }

      const sizeUsd = Math.min(cfg.REBATE_ORDER_SIZE_USD, remaining);
      const order = await placeRestingOrder(redis, candidate, sizeUsd);

      if (order) {
        await recordGlobalTrade(redis, 'polymarket');
        remaining -= sizeUsd;
        placed++;
      }
    }

    logger.info('[rebate] cycle complete', {
      filled: reconciled.filled.length,
      partialFills: reconciled.partialFills.length,
      staleCancelled: reconciled.stale.length,
      externalCancelled: reconciled.cancelled.length,
      newOrdersPlaced: placed,
      budgetRemaining: remaining.toFixed(2),
      totalDeployed: (currentlyDeployed + placed * cfg.REBATE_ORDER_SIZE_USD).toFixed(2),
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
