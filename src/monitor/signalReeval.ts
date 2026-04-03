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

// Stop-words filtered from market question before keyword matching.
// Without this filter, common English words ("will", "from", "before", etc.)
// cause nearly every headline to match every position, burning LLM tokens
// on irrelevant re-evaluations.
const STOP_WORDS = new Set([
  'will',
  'does',
  'have',
  'been',
  'this',
  'that',
  'what',
  'when',
  'where',
  'which',
  'with',
  'from',
  'into',
  'more',
  'than',
  'them',
  'they',
  'their',
  'there',
  'then',
  'each',
  'also',
  'most',
  'some',
  'over',
  'only',
  'very',
  'just',
  'about',
  'after',
  'again',
  'before',
  'being',
  'below',
  'between',
  'both',
  'could',
  'during',
  'further',
  'here',
  'other',
  'same',
  'should',
  'such',
  'under',
  'until',
  'while',
  'would',
  'your',
]);

/** Extract meaningful keywords from a market question, filtering stop-words. */
export function extractKeywords(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

/** Visible for testing */
export { STOP_WORDS };

/**
 * Re-evaluate open positions against fresh OSINT items.
 *
 * For each position, if any high-urgency item is topically relevant (keyword
 * overlap after stop-word filtering), re-estimate consensus probability.
 * If the edge has evaporated below REEVAL_EDGE_FLOOR or direction has flipped, exit.
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
    // Uses extractKeywords to filter stop-words and short tokens.
    const questionWords = extractKeywords(position.question);

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

      // description is null because the position ledger does not store the original
      // Gamma market description (it was available during Phase 2 mapping but not
      // persisted). Trade-off: re-eval consensus may be slightly less informed than
      // the original estimate, but the question text + headline + current price
      // provide sufficient context for the LLM to produce a useful probability.
      // To improve: persist description in the position ledger in a future iteration.
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
    const freshEdge = position.direction === 'YES' ? freshP - marketP : 1 - freshP - (1 - marketP);

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
      // Note on exit + re-entry race: the ingestion pipeline's idempotency guard
      // (SHA-256 dedup key with 1h TTL in Redis) prevents the same headline from
      // opening a new position in the same cycle where we just exited one. A re-entry
      // can only happen on a genuinely new signal in a subsequent cycle.
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
