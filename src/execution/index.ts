/**
 * Phase 3: Trade Execution Orchestration & Notifications
 *
 * End-to-end cron entrypoint:
 *   1. Run ingestion (Phase 1) to get high-urgency OSINT items
 *   2. Run mapping (Phase 2) to produce TradeSignal[]
 *   3. Execute each signal via the Simmer SDK (with idempotency)
 *   4. Record open positions in Redis ledger
 *   5. Send Telegram notifications
 */

import 'dotenv/config';
import process from 'node:process';
import { getRedis, closeRedis, acquireLock, releaseLock } from '../shared/redis.js';
import { logger } from '../shared/logger.js';
import { runIngestion } from '../ingestion/index.js';
import { runMapping, mapNewsToFutures } from '../mapping/index.js';
import { executeSignal } from './executor.js';
import { resolveHlSymbol } from '../shared/hyperliquid.js';
import { recordPosition } from './positionLedger.js';
import { resolveSimmerMarketId, getSimmerPositions } from '../shared/simmer.js';
import { notifyTradeExecuted, notifyTradeError } from './telegram.js';
import { reEvaluatePositions } from '../monitor/signalReeval.js';
import { getBankroll, deductStake } from '../shared/bankroll.js';
import type { ScoredItem } from '../ingestion/scorer.js';
import type { TradeSignal } from '../mapping/index.js';

/**
 * Run the full ingestion → mapping → execution pipeline.
 */
export async function runExecution(): Promise<void> {
  const redis = getRedis();
  const lockToken = await acquireLock('execution:lock', 270);
  if (!lockToken) {
    logger.info('[execution] previous cycle still running, skipping');
    return;
  }

  try {
    await runExecutionInner(redis);
  } finally {
    await releaseLock('execution:lock', lockToken).catch(() => { /* best effort */ });
  }
}

async function runExecutionInner(redis: ReturnType<typeof getRedis>): Promise<void> {
  logger.info('[execution] pipeline starting');

  let highUrgencyItems: ScoredItem[] = [];
  try {
    highUrgencyItems = await runIngestion();
  } catch (err) {
    logger.error('[execution] ingestion failed — continuing', {
      error: err instanceof Error ? err.message : String(err),
    });
    highUrgencyItems = [];
  }

  if (highUrgencyItems.length > 0) {
    await processScoredItemsInner(highUrgencyItems, redis);
  }

  logger.info('[execution] pipeline complete');
}

/**
 * Process a set of scored items through re-evaluation, mapping, and execution.
 * Exposed for low-latency triggers (e.g. Telegram monitor).
 * Acquires the same execution:lock used by runExecution() to prevent concurrent runs.
 */
export async function processScoredItems(
  highUrgencyItems: ScoredItem[],
  redis: ReturnType<typeof getRedis>,
): Promise<void> {
  const lockToken = await acquireLock('execution:lock', 270);
  if (!lockToken) {
    logger.info('[execution] processScoredItems: lock held by another runner, skipping');
    return;
  }
  try {
    await processScoredItemsInner(highUrgencyItems, redis);
  } finally {
    await releaseLock('execution:lock', lockToken).catch(() => { /* best effort */ });
  }
}

async function processScoredItemsInner(
  highUrgencyItems: ScoredItem[],
  redis: ReturnType<typeof getRedis>,
): Promise<void> {
  const bankrollUsd = await getBankroll(redis);
  
  if (highUrgencyItems.length > 0) {
    try {
      // 2. Continuous Monitoring — Re-evaluate open positions against fresh OSINT before opening new ones. 
      // This prevents "doubling down" on trades where our informational edge has already evaporated or flipped.
      const reevalResult = await reEvaluatePositions(highUrgencyItems, redis);
      if (reevalResult.exited > 0 || reevalResult.errors > 0) {
        logger.info('[execution] signal re-evaluation triggered exits', {
          exited: reevalResult.exited,
          held: reevalResult.held,
          errors: reevalResult.errors,
        });
      }
    } catch (err) {
      logger.warn('[execution] signal re-evaluation failed — continuing', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const signals: TradeSignal[] = [];

  if (highUrgencyItems.length > 0) {
    // 3. Phase 2 — map to trade signals
    try {
      // a) High-speed Futures Mapping (breaking news)
      const futuresSignals = await mapNewsToFutures(highUrgencyItems, bankrollUsd);
      if (futuresSignals.length > 0) {
        logger.info('[execution] news-to-futures signals generated', { count: futuresSignals.length });
        signals.push(...futuresSignals);
      }

      // b) Standard Polymarket Mapping (entity extraction + comparison)
      const pmSignals = await runMapping(highUrgencyItems, bankrollUsd);
      signals.push(...pmSignals);
    } catch (err) {
      logger.error('[execution] mapping failed — continuing', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4. Phase 3 — execute mapping signals one at a time
  let executed = 0;
  let failed = 0;
  let skipped = 0;
  let sessionExposureUsd = 0;

  for (const signal of signals) {
    // 4. Execution Loop — Cycle through signals and attempt execution on the primary or fallback venue.
    // This loop is sequential to simplify bankroll management and prevent race conditions on shared account margin.
    //
    // The executor handles Idempotency (Grip-it-and-rip-it): ensures the same signal hash isn't fired twice
    // within the 3600s Redis window, protecting against feed re-ingestion noise or redundant LLM calls
    // during extreme breaking news cycles.
    const result = await executeSignal(signal, redis, sessionExposureUsd);

    if (result.skipped) {
      skipped++;
      logger.info('[execution] signal skipped', {
        marketId: result.signal.marketId,
        executionId: result.signal.executionId,
        reason: result.skipReason,
      });
      continue;
    }

    if (result.error) {
      failed++;
      await notifyTradeError(result.signal, result.error);
      continue;
    }

    if (result.tradeResult?.success) {
      executed++;
      // Immediate bankroll deduction ensures follow-on mapping cycles in this same tick
      // respect the reduced capital, preventing over-allocation or leverage-recursion.
      await deductStake(redis, result.signal.stakeUsd);

      // Compute sharesHeld — prefer actual fill from venue, fall back to estimate.
      let estimatedShares: number | undefined;
      let sharesHeld: number | undefined;
      if (result.sharesFilled != null) {
        sharesHeld = result.sharesFilled;
      } else if (result.tradeResult.shares_bought != null) {
        sharesHeld = result.tradeResult.shares_bought;
      } else {
        // Simmer sometimes omits shares_bought — fall back to estimate from stake/price.
        // This can overstate actual fill on partial fills; log a warning for reconciliation.
        estimatedShares = result.signal.outcomePrice > 0
          ? result.signal.stakeUsd / result.signal.outcomePrice
          : undefined;
        sharesHeld = estimatedShares;
        if (estimatedShares != null) {
          logger.warn('[execution] shares_bought unavailable — using estimated sharesHeld (stakeUsd/outcomePrice)', {
            marketId: result.signal.marketId,
        executionId: result.signal.executionId,
            estimatedShares,
            stakeUsd: result.signal.stakeUsd,
            outcomePrice: result.signal.outcomePrice,
          });
        }
      }


      // Record in ledger
      await recordPosition(redis, {
        marketId: result.signal.marketId,
        executionId: result.signal.executionId,
        conditionId: result.signal.conditionId,
        clobTokenIds: result.signal.clobTokenIds,
        question: result.signal.question,
        direction: result.signal.direction,
        entryPrice: result.entryPrice ?? result.signal.outcomePrice,
        stakeUsd: result.signal.stakeUsd,
        consensusProbability: result.signal.consensusProbability ?? 0.5,
        consensusStddev: result.signal.consensusStddev,
        edgeMagnitude: result.signal.edgeMagnitude,
        sourcedFrom: result.signal.sourcedFrom,
        openedAt: new Date().toISOString(),
        txHash: result.tradeResult.tx_hash,
        sharesHeld,
        executionVenue: result.executionVenue || 'simmer',
        modeConfigured: result.modeConfigured,
        entryExecutionPath: result.entryExecutionPath,
        entryOrderType: result.entryOrderType,
        decisionBestBid: result.decisionBenchmark?.decisionBestBid ?? undefined,
        decisionBestAsk: result.decisionBenchmark?.decisionBestAsk ?? undefined,
        decisionMidPrice: result.decisionBenchmark?.decisionMidPrice ?? undefined,
        decisionSpreadBps: result.decisionBenchmark?.decisionSpreadBps ?? undefined,
        counterfactualImmediateTakerPrice: result.decisionBenchmark?.counterfactualImmediateTakerPrice ?? undefined,
        counterfactualImmediateTakerShares: result.decisionBenchmark?.counterfactualImmediateTakerShares ?? undefined,
        counterfactualImmediateTakerCostUsd: result.decisionBenchmark?.counterfactualImmediateTakerCostUsd ?? undefined,
        makerPriceImprovementBps: result.decisionBenchmark?.makerPriceImprovementBps ?? undefined,
        makerPriceImprovementUsd: result.decisionBenchmark?.makerPriceImprovementUsd ?? undefined,
        fallbackReason: result.fallbackReason,
        isFutures: result.signal.isFutures,
        leverage: result.signal.leverage,
        symbol: result.signal.symbol || (result.signal.isFutures ? result.signal.marketId : undefined),
      });

      // Simmer fill reconciliation: if shares_bought was unavailable and we used an
      // estimate, query Simmer after a short delay to get the confirmed fill amount.
      if (!result.tradeResult.shares_bought && result.executionVenue === 'simmer') {
        setTimeout(async () => {
          try {
            const simmerId = await resolveSimmerMarketId(signal.question);
            if (!simmerId) return;
            const livePositions = await getSimmerPositions({ status: 'active' });
            const side = signal.direction.toLowerCase() as 'yes' | 'no';
            const match = livePositions.find(p => p.market_id === simmerId && p.side === side);
            if (match?.shares && match.shares > 0 && match.shares !== estimatedShares) {
              // Update Redis ledger with actual fill
              await redis.hset(`position:${signal.marketId}:${signal.direction}`, 'sharesHeld', String(match.shares));
              logger.info('[execution] reconciled sharesHeld with Simmer actual fill', {
                marketId: signal.marketId,
                estimated: estimatedShares,
                actual: match.shares,
              });
            }
          } catch (err) {
            logger.warn('[execution] Simmer fill reconciliation failed (non-fatal)', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }, 10000);
      }

      // Track HL margin consumed for accurate margin cap checks in subsequent signals.
      // Only count confirmed HL executions — hedgeDispatched is fire-and-forget and may
      // never actually open a position; counting it would overstate session exposure.
      if (result.executionVenue === 'hyperliquid') {
        sessionExposureUsd += signal.stakeUsd;
      }

      await notifyTradeExecuted(result.signal, result.tradeResult.tx_hash);
    } else if (result.tradeResult && !result.tradeResult.success) {
      failed++;
      await notifyTradeError(result.signal, result.tradeResult.error ?? 'unknown error');
    }
  }

  logger.info('[execution] batch processing complete', { executed, failed, skipped });
}

const isMain = process.argv[1]?.endsWith('execution/index.ts') ?? false;
if (isMain) {
  runExecution()
    .catch((err: unknown) => {
      logger.error('[execution] fatal error', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exitCode = 1;
    })
    .finally(() => {
      closeRedis().catch(() => undefined);
    });
}
