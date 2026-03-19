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
import { getRedis, closeRedis } from '../shared/redis.js';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { runIngestion } from '../ingestion/index.js';
import { runMapping } from '../mapping/index.js';
import { executeSignals } from './executor.js';
import { recordPosition } from './positionLedger.js';
import { notifyTradeExecuted, notifyTradeError } from './telegram.js';

/**
 * Run the full ingestion → mapping → execution pipeline.
 *
 * This is the cron entrypoint for the main trading loop.
 */
export async function runExecution(): Promise<void> {
  const redis = getRedis();
  const bankrollUsd = loadConfig().BANKROLL_USD;

  logger.info('[execution] pipeline starting', { bankrollUsd });

  // Phase 1 — ingest OSINT
  let highUrgencyItems;
  try {
    highUrgencyItems = await runIngestion();
  } catch (err) {
    logger.error('[execution] ingestion failed — aborting', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (highUrgencyItems.length === 0) {
    logger.info('[execution] no high-urgency items — nothing to do');
    return;
  }

  // Phase 2 — map to trade signals
  let signals;
  try {
    signals = await runMapping(highUrgencyItems, bankrollUsd);
  } catch (err) {
    logger.error('[execution] mapping failed — aborting', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (signals.length === 0) {
    logger.info('[execution] no trade signals generated');
    return;
  }

  logger.info('[execution] signals to execute', { count: signals.length });

  // Phase 3 — execute signals
  const results = await executeSignals(signals, redis);

  // Phase 3 — record positions & notify
  for (const result of results) {
    if (result.skipped) {
      logger.info('[execution] signal skipped', {
        marketId: result.signal.marketId,
        reason: result.skipReason,
      });
      continue;
    }

    if (result.error) {
      await notifyTradeError(result.signal, result.error);
      continue;
    }

    if (result.tradeResult?.success) {
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
        edgeMagnitude: result.signal.edgeMagnitude,
        sourcedFrom: result.signal.sourcedFrom,
        openedAt: new Date().toISOString(),
        txHash: result.tradeResult.tx_hash,
        sharesHeld: result.tradeResult.shares_bought,
      });

      await notifyTradeExecuted(result.signal, result.tradeResult.tx_hash);
    } else if (result.tradeResult && !result.tradeResult.success) {
      await notifyTradeError(result.signal, result.tradeResult.error ?? 'unknown error');
    }
  }

  const executed = results.filter((r) => !r.skipped && !r.error && r.tradeResult?.success).length;
  const failed = results.filter((r) => r.error || (r.tradeResult && !r.tradeResult.success)).length;
  const skipped = results.filter((r) => r.skipped).length;

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
      process.exit(1);
    })
    .finally(() => {
      closeRedis().catch(() => undefined);
    });
}
