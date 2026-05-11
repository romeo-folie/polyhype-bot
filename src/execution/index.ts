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
import { executeAndRecordSignal } from './executor.js';
import { resolveSimmerMarketId, getSimmerPositions } from '../shared/simmer.js';
import { notifyTradeError } from './telegram.js';
import { reEvaluatePositions } from '../monitor/signalReeval.js';
import { getBankroll } from '../shared/bankroll.js';
import { persistOsintItems } from '../ingestion/osintStore.js';
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
    await releaseLock('execution:lock', lockToken).catch(() => {
      /* best effort */
    });
  }
}

async function runExecutionInner(redis: ReturnType<typeof getRedis>): Promise<void> {
  logger.info('[execution] pipeline starting');

  // Read directly from process.env to avoid triggering loadConfig() validation
  // (which requires LLM keys + SIMMER_API_KEY) on a path that may be a no-op.
  const rssEnabled = process.env.OSINT_RSS_INGESTION_ENABLED === 'true';

  let highUrgencyItems: ScoredItem[] = [];
  if (rssEnabled) {
    try {
      highUrgencyItems = await runIngestion();
    } catch (err) {
      logger.error('[execution] ingestion failed — continuing', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (highUrgencyItems.length > 0) {
    // Persist snapshot so the near-zero NO-side injector cron can read
    // recent OSINT items in a separate process.
    void persistOsintItems(highUrgencyItems, redis).catch((err: unknown) => {
      logger.warn('[execution] osint item persistence failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
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
  options: { wait?: boolean } = {},
): Promise<void> {
  const waitMs = options.wait ? 500 : 0;
  const maxRetries = options.wait ? 20 : 0; // up to 10s wait
  let retries = 0;
  let lockToken: string | null = null;

  while (retries <= maxRetries) {
    lockToken = await acquireLock('execution:lock', 270);
    if (lockToken) break;
    if (maxRetries === 0) break;

    retries++;
    if (retries <= maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  if (!lockToken) {
    logger.info('[execution] processScoredItems: lock held by another runner, skipping after retries', {
      retries,
    });
    return;
  }
  try {
    await processScoredItemsInner(highUrgencyItems, redis);
  } finally {
    await releaseLock('execution:lock', lockToken).catch(() => {
      /* best effort */
    });
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
        logger.info('[execution] news-to-futures signals generated', {
          count: futuresSignals.length,
        });
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
    // executeAndRecordSignal handles deductStake + recordPosition on success.
    const result = await executeAndRecordSignal(signal, redis, sessionExposureUsd);

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

      // sharesHeld was recorded by the executor; derive the same value here for
      // the Simmer reconciliation setTimeout below (uses estimate only if venue
      // omitted shares_bought).
      let estimatedShares: number | undefined;
      if (
        result.sharesFilled == null &&
        result.tradeResult.shares_bought == null &&
        result.signal.outcomePrice > 0
      ) {
        estimatedShares = result.signal.stakeUsd / result.signal.outcomePrice;
      }

      // Simmer fill reconciliation: if shares_bought was unavailable and we used an
      // estimate, query Simmer after a short delay to get the confirmed fill amount.
      // Capture result.signal.stakeUsd BEFORE the setTimeout — the executor may have
      // bumped the stake internally (floor bump, calibration scaling), so the loop
      // variable `signal.stakeUsd` is stale. Use the executed stake when falling
      // back to `stakeUsd / shares` for entry price.
      const executedStakeUsd = result.signal.stakeUsd;
      if (!result.tradeResult.shares_bought && result.executionVenue === 'simmer') {
        setTimeout(async () => {
          try {
            const simmerId = await resolveSimmerMarketId(signal.question);
            if (!simmerId) return;
            const livePositions = await getSimmerPositions({ status: 'active' });
            const side = signal.direction.toLowerCase() as 'yes' | 'no';
            const match = livePositions.find((p) => p.market_id === simmerId && p.side === side);
            if (match?.shares && match.shares > 0 && match.shares !== estimatedShares) {
              // Prefer Simmer's reported average_price (actual fill price) over
              // computing stakeUsd / shares, which assumes the fill matched the
              // requested stake ratio and can be wrong when Simmer fills at a
              // different price due to slippage or partial fills.
              const actualEntryPrice = (match.average_price && match.average_price > 0)
                ? match.average_price
                : executedStakeUsd / match.shares;
              // Update Redis ledger with actual fill and actual entry price
              await redis.hset(`position:${signal.marketId}:${signal.direction}`,
                'sharesHeld', String(match.shares),
                'entryPrice', String(Number(actualEntryPrice).toFixed(6))
              );
              logger.info('[execution] reconciled sharesHeld and entryPrice with Simmer actual fill', {
                marketId: signal.marketId,
                estimated: estimatedShares,
                actual: match.shares,
                oldPrice: result.signal.outcomePrice,
                newPrice: actualEntryPrice,
                source: (match.average_price && match.average_price > 0) ? 'simmer_avg_price' : 'computed',
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
      // Use result.signal.stakeUsd (executed stake after executor bumps/calibration)
      // rather than the loop variable, which can undercount margin and let
      // follow-on signals bypass the margin cap.
      if (result.executionVenue === 'hyperliquid') {
        sessionExposureUsd += result.signal.stakeUsd;
      }
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
