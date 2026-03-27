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
import { getRedis, closeRedis, acquireLock, releaseLock } from '../shared/redis.js';
import { logger } from '../shared/logger.js';
import { runIngestion } from '../ingestion/index.js';
import { runMapping } from '../mapping/index.js';
import { runCopytrade } from '../copytrade/index.js';
import { executeSignal } from './executor.js';
import { recordPosition } from './positionLedger.js';
import { notifyTradeExecuted, notifyTradeError } from './telegram.js';
import { reEvaluatePositions } from '../monitor/signalReeval.js';
import { getBankroll, deductStake } from '../shared/bankroll.js';
import type { ScoredItem } from '../ingestion/scorer.js';
import type { TradeSignal } from '../mapping/index.js';

/**
 * Run the full ingestion → mapping → execution pipeline.
 *
 * This is the cron entrypoint for the main trading loop.
 */
export async function runExecution(): Promise<void> {
  const redis = getRedis();

  // Prevent overlapping runs — ingestion + LLM mapping can exceed the 5-min cron
  // interval on slow networks / cold LLM responses. Without a lock, a second cron
  // tick spawns a second process that races for the same signals and double-executes.
  // Token-based: only the acquiring run can release the lock (safe if TTL expires
  // and a newer run reacquires before the older run finishes).
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

  // Copytrade signals (wallet mirroring)
  let copytradeSignals: TradeSignal[] = [];
  try {
    const copytradeResult = await runCopytrade(redis, bankrollUsd);
    copytradeSignals = copytradeResult.signals;
    if (copytradeResult.exits > 0) {
      logger.info('[execution] copytrade mirror exits executed', {
        exits: copytradeResult.exits,
      });
    }
  } catch (err) {
    logger.warn('[execution] copytrade failed — continuing', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Phase 1 — ingest OSINT
  let highUrgencyItems: ScoredItem[] = [];
  try {
    highUrgencyItems = await runIngestion();
  } catch (err) {
    logger.error('[execution] ingestion failed — continuing with copytrade only', {
      error: err instanceof Error ? err.message : String(err),
    });
    highUrgencyItems = [] as never;
  }

  // Re-evaluate existing positions against fresh OSINT before executing new signals.
  // NOTE: re-eval runs BEFORE new signal execution intentionally. If re-eval exits
  // a position and the same cycle's mapping produces a new entry signal for that
  // market, the idempotency key (1h TTL in Redis) prevents re-entry within the
  // same window. This is the desired behavior — an exited position should not be
  // immediately re-entered on the same cycle's OSINT.
  if (highUrgencyItems.length > 0) {
    try {
      const reevalResult = await reEvaluatePositions(highUrgencyItems, redis);
      if (reevalResult.exited > 0) {
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

  let signals: TradeSignal[] = [];

  if (highUrgencyItems.length > 0) {
    // Phase 2 — map to trade signals
    try {
      signals = await runMapping(highUrgencyItems, bankrollUsd);
    } catch (err) {
      logger.error('[execution] mapping failed — continuing with copytrade only', {
        error: err instanceof Error ? err.message : String(err),
      });
      signals = [];
    }
  }

  signals = [...signals, ...copytradeSignals];

  if (signals.length === 0) {
    logger.info('[execution] no trade signals generated');
    return;
  }

  logger.info('[execution] signals to execute', { count: signals.length });

  // Phase 3 — execute signals one at a time, deducting the bankroll cache
  // immediately after each successful trade so that subsequent signals in the
  // same cycle are sized against the remaining balance rather than the full
  // opening snapshot. Without this, Simmer rejects signals 2+ for insufficient
  // funds because the in-process cache still shows the pre-trade balance.
  const results = [];
  let executed = 0;
  let failed = 0;
  let skipped = 0;

  for (const signal of signals) {
    const result = await executeSignal(signal, redis);
    results.push(result);

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

      // Deduct immediately — keeps the bankroll cache accurate for the next
      // signal in this cycle (prevents over-allocation and Simmer rejections).
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
        consensusProbability: result.signal.consensusProbability,
        consensusStddev: result.signal.consensusStddev,
        edgeMagnitude: result.signal.edgeMagnitude,
        sourcedFrom: result.signal.sourcedFrom,
        openedAt: new Date().toISOString(),
        txHash: result.tradeResult.tx_hash,
        sharesHeld: result.tradeResult.shares_bought,
        executionVenue: result.executionVenue ?? 'simmer',
      });

      await notifyTradeExecuted(result.signal, result.tradeResult.tx_hash);
    } else if (result.tradeResult && !result.tradeResult.success) {
      failed++;
      await notifyTradeError(result.signal, result.tradeResult.error ?? 'unknown error');
    }
  }

  logger.info('[execution] pipeline complete', { executed, failed, skipped });
}

// Entrypoint when run directly (npx tsx src/execution/index.ts)
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
