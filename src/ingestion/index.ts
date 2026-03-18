/**
 * Phase 3: End-to-end orchestration pipeline.
 *
 * Cron entrypoint for the world-monitor-scraper.
 * Full pipeline: ingest → deduplicate → score → map → execute → notify → persist.
 *
 *   npm run cron:ingest
 *   npx tsx src/ingestion/index.ts
 */

import { getRedis } from '../shared/redis.js';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { fetchRssFeeds } from './rss.js';
import { scrapeHeadlines } from './scraper.js';
import { filterSeen } from './dedup.js';
import { scoreItems } from './scorer.js';
import type { ScoredItem } from './scorer.js';
import { runMapping } from '../mapping/index.js';
import { executeSignals } from '../execution/executor.js';
import { persistPosition } from '../execution/positionLedger.js';
import {
  notifyTradeExecuted,
  notifyExecutionError,
} from '../shared/telegram.js';

/**
 * Run only the ingestion + scoring stage.
 * Used by Phase 1/2 tests and the ingest-only cron path.
 */
export async function runIngestion(): Promise<ScoredItem[]> {
  const cfg = loadConfig();
  const redis = getRedis();
  const [rssItems, scraped] = await Promise.all([fetchRssFeeds(), scrapeHeadlines()]);
  const all = [...rssItems, ...scraped];
  const newItems = await filterSeen(all, redis);
  const scored = await scoreItems(newItems);
  const highUrgency = scored.filter((i) => i.urgencyScore >= cfg.URGENCY_THRESHOLD);
  logger.info('[ingestion] stage complete', {
    total: all.length,
    new: newItems.length,
    highUrgency: highUrgency.length,
    threshold: cfg.URGENCY_THRESHOLD,
  });
  return highUrgency;
}

/**
 * Run the full pipeline: ingest → map → execute → persist → notify.
 * Called by the main cron entry point.
 *
 * @param bankrollUsd Current portfolio value in USD (read from env/config by caller).
 */
export async function runPipeline(bankrollUsd: number): Promise<void> {
  const cfg = loadConfig();
  logger.info('[pipeline] starting cycle', { bankrollUsd });

  // Stage 1: Ingest + score
  const highUrgency = await runIngestion();

  if (highUrgency.length === 0) {
    logger.info('[pipeline] no high-urgency items — cycle complete');
    return;
  }

  // Stage 2: Market mapping
  let signals;
  try {
    signals = await runMapping(highUrgency, bankrollUsd);
  } catch (err) {
    logger.error('[pipeline] market mapping failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  logger.info('[pipeline] mapping complete', {
    highUrgency: highUrgency.length,
    signals: signals.length,
    divergenceThreshold: cfg.DIVERGENCE_THRESHOLD,
  });

  if (signals.length === 0) {
    logger.info('[pipeline] no signals above divergence threshold — cycle complete');
    return;
  }

  // Stage 3: Execute signals
  const results = await executeSignals(signals);

  // Stage 4: Persist positions + notify
  let succeeded = 0;
  for (const result of results) {
    if (result.success) {
      succeeded++;
      if (result.txHash) {
        try {
          await persistPosition(result.signal, result.txHash);
        } catch (err) {
          logger.error('[pipeline] failed to persist position', {
            marketId: result.signal.marketId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        // Simmer returned success=true without a tx_hash — trade may have been
        // submitted but we cannot track it. Log prominently; still notify.
        logger.warn('[pipeline] trade succeeded but no txHash returned — position not persisted', {
          marketId: result.signal.marketId,
        });
      }
      notifyTradeExecuted(result);
    } else {
      notifyExecutionError(result);
    }
  }
  logger.info('[pipeline] cycle complete', {
    signalsExecuted: results.length,
    succeeded,
    failed: results.length - succeeded,
  });
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

import { fileURLToPath } from 'node:url';
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  // Load config eagerly — fail fast if env is misconfigured
  const cfg = loadConfig();

  // Bankroll: read from env or default to $100 as per PRD
  const bankrollUsd = Number(process.env['BANKROLL_USD'] ?? 100);

  logger.info('[pipeline] cron triggered', {
    bankrollUsd,
    urgencyThreshold: cfg.URGENCY_THRESHOLD,
    divergenceThreshold: cfg.DIVERGENCE_THRESHOLD,
    maxBetFraction: cfg.MAX_BET_FRACTION,
  });

  runPipeline(bankrollUsd)
    .then(() => {
      logger.info('[pipeline] exit clean');
      process.exit(0);
    })
    .catch((err: unknown) => {
      logger.error('[pipeline] fatal error', { error: String(err) });
      process.exit(1);
    });
}
