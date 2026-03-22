/**
 * Phase 2: Market Mapping & Execution Logic
 *
 * Orchestrates the full mapping pipeline:
 *   1. For each high-urgency ingestion item, find candidate Polymarket markets
 *   2. For each candidate, estimate consensus probability via LLM
 *   3. Compute divergence; if edge ≥ threshold, produce a trade signal
 *
 * Returns an array of TradeSignal objects ready for Phase 3 execution.
 */

import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { findCandidateMarkets } from './entityExtractor.js';
import { estimateConsensusProbability } from './consensusCalculator.js';
import { computeDivergence } from './divergenceCalculator.js';
import type { TradeDecision } from './divergenceCalculator.js';
import type { ScoredItem } from '../ingestion/scorer.js';

export interface TradeSignal {
  /** Gamma market ID */
  marketId: string;
  conditionId: string;
  clobTokenIds: string[];
  question: string;
  direction: TradeDecision['direction'];
  stakeUsd: number;
  edgeMagnitude: number;
  consensusProbability: number;
  /** Standard deviation of consensus probability across N LLM samples */
  consensusStddev: number;
  outcomePrice: number;
  halfKellyFraction: number;
  /** The OSINT headline that triggered this signal */
  sourcedFrom: string;
  /** LLM reasoning for the probability estimate */
  reasoning: string;
}

/**
 * Run the market mapping pipeline on a set of high-urgency items.
 *
 * @param items      High-urgency scored items from Phase 1.
 * @param bankrollUsd Current portfolio value in USD (passed in from caller for testability).
 */
export async function runMapping(
  items: ScoredItem[],
  bankrollUsd: number,
): Promise<TradeSignal[]> {
  const cfg = loadConfig();
  const divergenceThreshold = cfg.DIVERGENCE_THRESHOLD;
  const maxBetFraction = cfg.MAX_BET_FRACTION;

  // Per-market deduplication: tracks the highest-edge signal seen for each market.
  // Multiple headlines in one cycle can match the same market; emitting duplicate
  // signals would create over-exposure. We keep only the strongest edge per market.
  const bestByMarket = new Map<string, TradeSignal>();

  for (const item of items) {
    logger.info('[mapping] processing item', { title: item.title, urgency: item.urgencyScore });

    let candidates;
    try {
      candidates = await findCandidateMarkets(item);
    } catch (err) {
      logger.error('[mapping] failed to find candidate markets', {
        title: item.title,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (candidates.length === 0) {
      logger.info('[mapping] no candidate markets found', { title: item.title });
      continue;
    }

    logger.info('[mapping] evaluating candidates', {
      title: item.title,
      count: candidates.length,
    });

    // Evaluate markets in liquidity order (highest first) but cap at 10 per item
    // to avoid runaway LLM calls
    const toEvaluate = candidates.slice(0, 10);

    for (const candidate of toEvaluate) {
      let consensus;
      try {
        consensus = await estimateConsensusProbability({
          question: candidate.question,
          description: candidate.description,
          headline: item.title,
          currentYesPrice: candidate.currentYesPrice,
        });
      } catch (err) {
        logger.warn('[mapping] consensus estimation failed', {
          marketId: candidate.marketId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const { hasTrade, decision, skipReason } = computeDivergence({
        consensusProbability: consensus.probability,
        consensusStddev: consensus.stddev,
        currentYesPrice: candidate.currentYesPrice,
        bankrollUsd,
        divergenceThreshold,
        maxBetFraction,
      });

      logger.info('[mapping] divergence result', {
        marketId: candidate.marketId,
        question: candidate.question.substring(0, 80),
        consensusP: consensus.probability.toFixed(3),
        consensusStddev: consensus.stddev.toFixed(3),
        marketP: candidate.currentYesPrice.toFixed(3),
        hasTrade,
        skipReason,
        direction: decision?.direction,
        stakeUsd: decision?.stakeUsd?.toFixed(2),
      });

      if (hasTrade && decision) {
        const candidate_signal: TradeSignal = {
          marketId: candidate.marketId,
          conditionId: candidate.conditionId,
          clobTokenIds: candidate.clobTokenIds,
          question: candidate.question,
          direction: decision.direction,
          stakeUsd: decision.stakeUsd,
          edgeMagnitude: decision.edgeMagnitude,
          consensusProbability: decision.consensusProbability,
          consensusStddev: consensus.stddev,
          outcomePrice: decision.outcomePrice,
          halfKellyFraction: decision.halfKellyFraction,
          sourcedFrom: item.title,
          reasoning: consensus.reasoning,
        };
        const existing = bestByMarket.get(candidate.marketId);
        if (!existing || decision.edgeMagnitude > existing.edgeMagnitude) {
          bestByMarket.set(candidate.marketId, candidate_signal);
        }
      }
    }
  }

  const signals = Array.from(bestByMarket.values());

  logger.info('[mapping] pipeline complete', {
    itemsProcessed: items.length,
    signalsGenerated: signals.length,
  });

  return signals;
}
