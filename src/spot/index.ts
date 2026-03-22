/**
 * Phase 5: Spot Price Monitor — Pipeline Orchestration.
 *
 * poll() → detect() → correlate() → estimate() → diverge() → execute()
 *
 * Runs as `cron:spot` (1-min interval). Independent from the news pipeline.
 * Emits standard TradeSignal[] and shares the same executor, position ledger,
 * idempotency layer, and Telegram notifications.
 */

import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getRedis, closeRedis } from '../shared/redis.js';
import { getBankroll, deductStake } from '../shared/bankroll.js';
import { getPriceFeed } from '../shared/feedSingleton.js';
import { resolveYesPrice } from '../shared/priceCache.js';
import { pollSpotPrices } from './poller.js';
import { detectMoves } from './thresholdDetector.js';
import { findCorrelatedMarkets } from './marketCorrelator.js';
import { estimateFastConsensus } from './fastPathConsensus.js';
import { computeDivergence } from '../mapping/divergenceCalculator.js';
import { executeSignals } from '../execution/executor.js';
import { recordPosition, hasOpenPosition } from '../execution/positionLedger.js';
import { notifyTradeExecuted, notifyTradeError } from '../execution/telegram.js';
import type { TradeSignal } from '../mapping/index.js';

/**
 * Run a single spot monitor cycle.
 */
export async function runSpotMonitor(): Promise<void> {
  const cfg = loadConfig();

  if (!cfg.SPOT_MONITOR_ENABLED) {
    logger.info('[spot] spot monitor disabled, skipping');
    return;
  }

  // Prevent overlapping runs — LLM calls can exceed the 1-min cron interval
  const redis = getRedis();
  const lockAcquired = await redis.set('spot:lock', '1', 'EX', 120, 'NX');
  if (!lockAcquired) {
    logger.info('[spot] previous cycle still running, skipping');
    return;
  }

  try {
    await runSpotMonitorInner(cfg, redis);
  } finally {
    // Release lock explicitly so the next cron run isn't blocked for the full 120s TTL
    await redis.del('spot:lock').catch(() => { /* best effort */ });
  }
}

async function runSpotMonitorInner(
  cfg: ReturnType<typeof loadConfig>,
  redis: ReturnType<typeof getRedis>,
): Promise<void> {
  logger.info('[spot] starting spot monitor cycle');

  const bankrollUsd = await getBankroll(redis);

  // 1. Poll spot prices
  const prices = await pollSpotPrices();
  if (prices.length === 0) {
    logger.info('[spot] no prices fetched, skipping cycle');
    return;
  }

  // 2. Detect significant moves
  const moves = await detectMoves(prices);
  if (moves.length === 0) {
    logger.info('[spot] no significant moves detected');
    return;
  }

  logger.info('[spot] detected moves', { count: moves.length });

  // 3. For each move, find correlated markets and generate signals
  const signals: TradeSignal[] = [];

  for (const move of moves) {
    let markets;
    try {
      markets = await findCorrelatedMarkets(move);
    } catch (err) {
      logger.error('[spot] failed to find correlated markets', {
        assetId: move.assetId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (markets.length === 0) {
      logger.info('[spot] no correlated markets for move', { assetId: move.assetId });
      continue;
    }

    const feed = getPriceFeed(redis);

    for (const market of markets) {
      // Subscribe to WS price updates for this correlated market
      await feed.watch(market.marketId, market.clobTokenIds);

      // Resolve price: WS cache first, Gamma snapshot fallback
      let currentYesPrice = market.currentYesPrice;
      const wsPrice = await resolveYesPrice(market.marketId, redis, feed);
      if (wsPrice !== null) currentYesPrice = wsPrice;

      // 4. Estimate consensus probability
      let consensus;
      try {
        consensus = await estimateFastConsensus(move, market);
      } catch (err) {
        logger.warn('[spot] consensus estimation failed', {
          marketId: market.marketId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // Adjust probability based on correlation direction AND actual move direction.
      // correlationDirection answers: "does asset RISING make YES more likely?"
      //   positive + price up   → consensus as-is
      //   positive + price down → invert (asset falling makes YES less likely)
      //   negative + price up   → invert (asset rising makes YES less likely)
      //   negative + price down → as-is  (asset falling makes YES more likely)
      const shouldInvert =
        (market.correlationDirection === 'positive' && move.changePercent < 0) ||
        (market.correlationDirection === 'negative' && move.changePercent > 0);
      const adjustedProbability = shouldInvert
        ? 1 - consensus.probability
        : consensus.probability;

      // 5. Compute divergence
      // Spot fast-path: formula-based estimates are deterministic (stddev=0).
      // LLM fallback goes through estimateConsensusProbability which returns real stddev.
      // Both cases now propagate correctly — EV gate is properly conservative for LLM calls.
      const consensusStddev = consensus.stddev;
      const { hasTrade, decision } = computeDivergence({
        consensusProbability: adjustedProbability,
        consensusStddev,
        currentYesPrice,
        bankrollUsd,
        divergenceThreshold: cfg.SPOT_DIVERGENCE_THRESHOLD,
        maxBetFraction: cfg.MAX_BET_FRACTION,
      });

      if (!hasTrade || !decision) continue;

      const sourcedFrom =
        `Spot: ${move.assetId} ${move.changePercent > 0 ? '+' : ''}${move.changePercent.toFixed(1)}% ` +
        `in ${move.windowMinutes}min`;

      signals.push({
        marketId: market.marketId,
        conditionId: market.conditionId,
        clobTokenIds: market.clobTokenIds,
        question: market.question,
        direction: decision.direction,
        stakeUsd: decision.stakeUsd,
        edgeMagnitude: decision.edgeMagnitude,
        consensusProbability: decision.consensusProbability,
        consensusStddev,
        outcomePrice: decision.outcomePrice,
        halfKellyFraction: decision.halfKellyFraction,
        sourcedFrom,
        reasoning: consensus.reasoning,
      });
    }
  }

  if (signals.length === 0) {
    logger.info('[spot] no trade signals after divergence check');
    return;
  }

  // 6a. Deduplicate signals by marketId:direction — multiple spot moves in one
  // cycle can correlate to the same market. Keep the highest-edge signal only
  // to prevent duplicate execution before position is recorded.
  const bestByKey = new Map<string, TradeSignal>();
  for (const signal of signals) {
    const key = `${signal.marketId}:${signal.direction}`;
    const existing = bestByKey.get(key);
    if (!existing || signal.edgeMagnitude > existing.edgeMagnitude) {
      bestByKey.set(key, signal);
    }
  }
  const dedupedSignals = Array.from(bestByKey.values());

  // 6b. Pre-check: skip signals where a position is already open (guards against
  // the race between executeSignals and recordPosition in the same cycle).
  const filteredSignals: TradeSignal[] = [];
  for (const signal of dedupedSignals) {
    const alreadyOpen = await hasOpenPosition(redis, signal.marketId, signal.direction);
    if (alreadyOpen) {
      logger.info('[spot] skipping signal — position already open', {
        marketId: signal.marketId,
        direction: signal.direction,
      });
      continue;
    }
    filteredSignals.push(signal);
  }

  if (filteredSignals.length === 0) {
    logger.info('[spot] all signals filtered (dedup or existing positions)');
    return;
  }

  logger.info('[spot] executing trade signals', {
    raw: signals.length,
    afterDedup: dedupedSignals.length,
    afterPositionCheck: filteredSignals.length,
  });

  // 6c. Execute signals via shared executor
  const results = await executeSignals(filteredSignals, redis);

  for (const result of results) {
    if (result.skipped) {
      logger.info('[spot] signal skipped', {
        marketId: result.signal.marketId,
        reason: result.skipReason,
      });
      continue;
    }

    if (result.error) {
      logger.error('[spot] trade execution failed', {
        marketId: result.signal.marketId,
        error: result.error,
      });
      await notifyTradeError(result.signal, result.error);
      continue;
    }

    if (!result.tradeResult?.success) {
      await notifyTradeError(result.signal, result.tradeResult?.error ?? 'unknown error');
      continue;
    }

    // Record position
    await recordPosition(redis, {
      marketId: result.signal.marketId,
      conditionId: result.signal.conditionId,
      clobTokenIds: result.signal.clobTokenIds,
      question: result.signal.question,
      direction: result.signal.direction,
      entryPrice: result.signal.outcomePrice,
      stakeUsd: result.signal.stakeUsd,
      openedAt: new Date().toISOString(),
      sourcedFrom: result.signal.sourcedFrom,
      consensusProbability: result.signal.consensusProbability,
      consensusStddev: result.signal.consensusStddev,
      edgeMagnitude: result.signal.edgeMagnitude,
    });

    await deductStake(redis, result.signal.stakeUsd);
    await notifyTradeExecuted(result.signal, result.tradeResult.tx_hash);

    logger.info('[spot] trade executed', {
      marketId: result.signal.marketId,
      direction: result.signal.direction,
      stakeUsd: result.signal.stakeUsd,
      venue: result.executionVenue,
    });
  }

  logger.info('[spot] spot monitor cycle complete', {
    signalsGenerated: signals.length,
    executed: results.filter((r) => !r.skipped && !r.error).length,
    skipped: results.filter((r) => r.skipped).length,
    errors: results.filter((r) => r.error).length,
  });
}

// CLI entrypoint — only runs when executed directly, not when imported
async function main() {
  try {
    await runSpotMonitor();
  } catch (err) {
    logger.error('[spot] fatal error', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  } finally {
    await closeRedis();
  }
}

// Entrypoint when run directly (npx tsx src/spot/index.ts)
const isMain = process.argv[1]?.endsWith('spot/index.ts') ?? false;
if (isMain) {
  main();
}
