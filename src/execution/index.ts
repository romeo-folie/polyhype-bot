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
  const bankrollUsd = await getBankroll(redis);
  logger.info('[execution] pipeline starting', { bankrollUsd });

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

      // Record in ledger
      await recordPosition(redis, {
        marketId: result.signal.marketId,
        conditionId: result.signal.conditionId,
        clobTokenIds: result.signal.clobTokenIds,
        question: result.signal.question,
        direction: result.signal.direction,
        entryPrice: result.signal.outcomePrice,
        stakeUsd: result.signal.stakeUsd,
        consensusProbability: result.signal.consensusProbability ?? 0.5,
        consensusStddev: result.signal.consensusStddev,
        edgeMagnitude: result.signal.edgeMagnitude,
        sourcedFrom: result.signal.sourcedFrom,
        openedAt: new Date().toISOString(),
        txHash: result.tradeResult.tx_hash,
        sharesHeld: result.tradeResult.shares_bought,
        executionVenue: result.executionVenue || 'simmer',
        isFutures: result.signal.isFutures,
        leverage: result.signal.leverage,
        symbol: result.signal.symbol || (result.signal.isFutures ? result.signal.marketId : undefined),
      });

      // Track HL margin consumed for accurate margin cap checks in subsequent signals.
      if (result.executionVenue === 'hyperliquid') {
        sessionExposureUsd += signal.stakeUsd;
      } else if (result.hedgeAttempted) {
        sessionExposureUsd += signal.stakeUsd;
      }

      await notifyTradeExecuted(result.signal, result.tradeResult.tx_hash);
    } else if (result.tradeResult && !result.tradeResult.success) {
      failed++;
      await notifyTradeError(result.signal, result.tradeResult.error ?? 'unknown error');
    }
  }

  logger.info('[execution] pipeline complete', { executed, failed, skipped });
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
