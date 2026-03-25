/**
 * Phase 4: Position Monitor & Take-Profit
 *
 * Cron entrypoint — runs every 5 minutes.
 *
 * For each open position in the Redis ledger:
 *   1. Fetch current Polymarket price via Gamma API
 *   2. Evaluate take-profit conditions (threshold + divergence closed)
 *   3. If exit triggered: execute sell via Simmer, remove from ledger, notify Telegram
 */

import 'dotenv/config';
import { getRedis, closeRedis } from '../shared/redis.js';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getOpenPositions } from '../execution/positionLedger.js';
import { fetchAllCurrentPrices } from './priceFetcher.js';
import { getPriceFeed } from '../shared/feedSingleton.js';
import { evaluateTakeProfit } from './takeProfitEvaluator.js';
import { executeTakeProfit } from './takeProfitExecutor.js';
import { redeemResolvedPositions } from './resolutionRedeemer.js';

export async function runMonitor(): Promise<void> {
  const redis = getRedis();
  const cfg = loadConfig();
  const takeProfitThreshold = cfg.TAKE_PROFIT_THRESHOLD;
  const stopLossThreshold = cfg.STOP_LOSS_THRESHOLD;

  logger.info('[monitor] starting position check', { takeProfitThreshold, stopLossThreshold });

  // 0. Redeem any resolved winning positions first
  const redemptions = await redeemResolvedPositions(redis);
  if (redemptions.length > 0) {
    const succeeded = redemptions.filter((r) => r.success).length;
    const failed = redemptions.length - succeeded;
    logger.info('[monitor] redemption cycle complete', { succeeded, failed });
  }

  // 1. Load all open positions
  const positions = await getOpenPositions(redis);

  if (positions.length === 0) {
    logger.info('[monitor] no open positions — nothing to do');
    return;
  }

  logger.info('[monitor] checking positions', { count: positions.length });

  // 2a. Register watches for all positions before reading prices.
  // feed.watch() is idempotent and CONNECTING-safe — safe to call in bulk here.
  const feed = getPriceFeed(redis);
  await Promise.all(
    positions.map((p) => feed.watch(p.marketId, p.clobTokenIds).catch(() => undefined)),
  );

  // 2b. Fetch current prices for all positions
  const priceMap = await fetchAllCurrentPrices(positions);

  // 3. Evaluate and act on each position
  let exited = 0;
  let held = 0;
  let priceError = 0;

  for (const position of positions) {
    const currentPrice = priceMap.get(`${position.marketId}:${position.direction}`);

    if (!currentPrice) {
      // Price unavailable — skip, monitor will retry next cycle
      logger.warn('[monitor] price unavailable — skipping', {
        marketId: position.marketId,
      });
      priceError++;
      continue;
    }

    const decision = evaluateTakeProfit(position, currentPrice, takeProfitThreshold, stopLossThreshold);

    logger.info('[monitor] position evaluated', {
      marketId: position.marketId,
      direction: position.direction,
      entryPrice: position.entryPrice.toFixed(3),
      currentPrice: currentPrice.currentOutcomePrice.toFixed(3),
      returnPct: decision.returnPct.toFixed(2),
      shouldExit: decision.shouldExit,
      reason: decision.reason,
    });

    if (decision.shouldExit && decision.reason) {
      const result = await executeTakeProfit({
        position,
        currentPrice: currentPrice.currentOutcomePrice,
        returnPct: decision.returnPct,
        reason: decision.reason,
        redis,
      });

      if (result.success) {
        exited++;
      } else {
        // Failed to exit — position stays in ledger, will retry next cycle
        logger.warn('[monitor] exit failed — will retry next cycle', {
          marketId: position.marketId,
          error: result.error,
        });
      }
    } else {
      held++;
    }
  }

  logger.info('[monitor] cycle complete', { exited, held, priceError });
}

// Entrypoint when run directly (npx tsx src/monitor/index.ts)
const isMain = process.argv[1]?.endsWith('monitor/index.ts') ?? false;
if (isMain) {
  runMonitor()
    .catch((err: unknown) => {
      logger.error('[monitor] fatal error', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    })
    .finally(() => {
      closeRedis().catch(() => undefined);
    });
}
