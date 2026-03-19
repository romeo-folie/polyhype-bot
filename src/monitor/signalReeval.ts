/**
 * Signal-driven position re-evaluation.
 *
 * For each open position, re-run consensus estimation against the current
 * market question. If the fresh consensus no longer supports the held direction
 * (edge has evaporated or flipped), recommend exit.
 *
 * This runs inside the trade cycle (cron:trade) after ingestion, before new
 * signal execution — so it can use fresh OSINT context.
 */

import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { estimateConsensusProbability } from '../mapping/consensusCalculator.js';
import { fetchCurrentPrice } from './priceFetcher.js';
import { executeTakeProfit } from './takeProfitExecutor.js';
import { getOpenPositions } from '../execution/positionLedger.js';
import type { Redis } from 'ioredis';
import type { ScoredItem } from '../ingestion/scorer.js';

/**
 * Re-evaluate open positions against fresh OSINT items.
 *
 * For each position, if any high-urgency item is topically relevant (simple
 * keyword overlap), re-estimate consensus probability. If the edge has
 * evaporated below REEVAL_EDGE_FLOOR or direction has flipped, exit.
 */
export async function reEvaluatePositions(
  highUrgencyItems: ScoredItem[],
  redis: Redis,
): Promise<{ exited: number; held: number; errors: number }> {
  const cfg = loadConfig();

  if (!cfg.REEVAL_ENABLED) {
    return { exited: 0, held: 0, errors: 0 };
  }

  const edgeFloor = cfg.REEVAL_EDGE_FLOOR;
  const positions = await getOpenPositions(redis);

  if (positions.length === 0 || highUrgencyItems.length === 0) {
    return { exited: 0, held: 0, errors: 0 };
  }

  let exited = 0;
  let held = 0;
  let errors = 0;

  for (const position of positions) {
    // Check if any high-urgency item is relevant to this position's market.
    // Simple heuristic: check if any keyword from the market question appears
    // in the headline (case-insensitive, 4+ char words only).
    const questionWords = position.question
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 4);

    const hasRelevantNews = highUrgencyItems.some((item) => {
      const headline = item.title.toLowerCase();
      return questionWords.some((word) => headline.includes(word));
    });

    if (!hasRelevantNews) {
      held++;
      continue;
    }

    // Fetch current price first — needed for both LLM prompt and edge calculation
    const currentPrice = await fetchCurrentPrice(position);
    if (!currentPrice) {
      errors++;
      continue;
    }

    // Re-estimate consensus probability using live market price
    let freshConsensus: { probability: number; reasoning: string };
    try {
      const relevantHeadline = highUrgencyItems.find((item) => {
        const headline = item.title.toLowerCase();
        return questionWords.some((word) => headline.includes(word));
      });

      freshConsensus = await estimateConsensusProbability({
        question: position.question,
        description: null,
        headline: relevantHeadline?.title ?? highUrgencyItems[0]?.title ?? '',
        currentYesPrice: currentPrice.currentYesPrice,
      });
    } catch (err) {
      logger.warn('[reeval] consensus re-estimation failed', {
        marketId: position.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
      errors++;
      continue;
    }

    // Compute fresh edge
    const freshP = freshConsensus.probability;
    const marketP = currentPrice.currentYesPrice;
    const freshEdge =
      position.direction === 'YES' ? freshP - marketP : (1 - freshP) - (1 - marketP);

    logger.info('[reeval] position re-evaluated', {
      marketId: position.marketId,
      direction: position.direction,
      freshConsensusP: freshP.toFixed(3),
      marketP: marketP.toFixed(3),
      freshEdge: freshEdge.toFixed(3),
      edgeFloor,
    });

    // Exit conditions:
    // 1. Edge has flipped (negative = wrong direction)
    // 2. Edge has evaporated below floor
    const shouldExit = freshEdge < edgeFloor;

    if (shouldExit) {
      const returnPct =
        position.entryPrice > 0
          ? ((currentPrice.currentOutcomePrice - position.entryPrice) / position.entryPrice) * 100
          : 0;

      logger.info('[reeval] exiting position — edge evaporated', {
        marketId: position.marketId,
        freshEdge: freshEdge.toFixed(3),
        returnPct: returnPct.toFixed(2),
      });

      const result = await executeTakeProfit({
        position,
        currentPrice: currentPrice.currentOutcomePrice,
        returnPct,
        reason: 'signal_reeval',
        redis,
      });

      if (result.success) {
        exited++;
      } else {
        logger.warn('[reeval] exit failed — will retry next cycle', {
          marketId: position.marketId,
          error: result.error,
        });
        errors++;
      }
    } else {
      held++;
    }
  }

  logger.info('[reeval] cycle complete', { exited, held, errors });
  return { exited, held, errors };
}
