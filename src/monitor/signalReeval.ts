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
import { inferCategory } from '../shared/outcomeRecorder.js';
import type { Redis } from 'ioredis';
import type { ScoredItem } from '../ingestion/scorer.js';

// Stop-words filtered from market question before keyword matching.
// Without this filter, common English words ("will", "from", "before", etc.)
// cause nearly every headline to match every position, burning LLM tokens
// on irrelevant re-evaluations.
const STOP_WORDS = new Set([
  'will', 'does', 'have', 'been', 'this', 'that', 'what', 'when', 'where', 'which', 'with', 'from', 'into', 'more', 'than', 'them', 'they', 'their', 'there', 'then', 'each', 'also', 'most', 'some', 'over', 'only', 'very', 'just', 'about', 'after', 'again', 'before', 'being', 'below', 'between', 'both', 'could', 'during', 'further', 'here', 'other', 'same', 'should', 'such', 'under', 'until', 'while', 'would', 'your',
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
    // 1. Category Guard: Only re-evaluate positions that belong to the same domain 
    // as the news items being processed. This prevents Geopolitical news from
    // accidentally triggering exits on Sports or Entertainment trades (e.g. via copytrading).
    const positionCategory = inferCategory(position.question);
    
    const hasCategoryMatch = highUrgencyItems.some(item => 
      item.categoryId === positionCategory || 
      (item.categoryId === 'geopolitical' && positionCategory === 'politics')
    );

    if (!hasCategoryMatch) {
      held++;
      continue;
    }

    // 2. Keyword Match Relevance
    const questionWords = extractKeywords(position.question);
    const relevantHeadline = highUrgencyItems.find((item) => {
      // Must be same category to be relevant
      const categoryMatch = 
        item.categoryId === positionCategory || 
        (item.categoryId === 'geopolitical' && positionCategory === 'politics');
      if (!categoryMatch) return false;

      // Domain Guard: If the item is geopolitical, block common sports keywords 
      // in the position question to doubly-ensure we aren't re-evaluating sports by accident.
      if (item.categoryId === 'geopolitical') {
        const blocklist = ['win', 'match', 'game', 'team', 'playoffs', 'tournament', 'championship', 'nba', 'nfl', 'mlb', 'nhl', 'fifa', 'premier league', 'laliga', 'oscar', 'grammy', 'emmy', 'tony', 'super bowl', 'world cup', 'athlete', 'player', 'scored'];
        const questionLower = position.question.toLowerCase();
        if (blocklist.some(word => questionLower.includes(word))) return false;
      }

      const headline = item.title.toLowerCase();
      return questionWords.some((word) => headline.includes(word));
    });

    if (!relevantHeadline) {
      held++;
      continue;
    }

    // 3. Re-evaluate edge
    const currentPrice = await fetchCurrentPrice(position);
    if (!currentPrice) {
      errors++;
      continue;
    }

    let freshConsensus: { probability: number, reasoning: string };
    try {
      freshConsensus = await estimateConsensusProbability({
        question: position.question,
        description: null,
        headline: relevantHeadline.title,
        currentYesPrice: currentPrice.currentYesPrice,
        redis,
      });
    } catch (err) {
      logger.warn('[reeval] consensus re-estimation failed', {
        marketId: position.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
      errors++;
      continue;
    }

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

    if (freshEdge < edgeFloor) {
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
