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
import { isMarketRelevant } from './relevanceGate.js';
import { estimateConsensusProbability, estimateSentiment } from './consensusCalculator.js';
import { computeDivergence } from './divergenceCalculator.js';
import { resolveYesPrice } from '../shared/priceCache.js';
import { resolveHlSymbol } from '../shared/hyperliquid.js';
import { getRedis } from '../shared/redis.js';
import { scoreConfluence } from '../arb/confluenceScorer.js';
import type { ScoredItem } from '../ingestion/scorer.js';
import type { Redis } from 'ioredis';
import type { ClobPriceFeed } from '../shared/clobWebSocket.js';

export interface TradeSignal {
  /** Gamma market ID or Hyperliquid symbol */
  marketId: string;
  conditionId?: string;
  clobTokenIds?: string[];
  executionId?: string;
  question: string;
  direction: 'YES' | 'NO' | 'UP' | 'DOWN' | 'LONG' | 'SHORT';
  stakeUsd: number;
  edgeMagnitude: number;
  consensusProbability?: number;
  /** Standard deviation of consensus probability across N LLM samples */
  consensusStddev?: number;
  outcomePrice: number;
  halfKellyFraction?: number;
  /** The OSINT headline that triggered this signal */
  sourcedFrom: string;
  /** LLM reasoning for the probability estimate */
  reasoning: string;
  /** Futures-specific */
  isFutures?: boolean;
  leverage?: number;
  symbol?: string;
  /** True when the Gamma market has fees enabled — executor skips CLOB for these */
  feesEnabled?: boolean;
  /** Origin of the signal, used for execution routing (e.g. bypassing Simmer for arb) */
  source?: 'osint' | 'crypto-arb' | 'futures' | 'copytrade';
  /** Operational metadata for alerts/telemetry */
  latencyMs?: number | undefined;
  volatility?: number | undefined;
  spreadBps?: number | undefined;
  assetId?: string | undefined;
  endDate?: string | undefined;
}

/**
 * Run the market mapping pipeline on a set of high-urgency items.
 *
 * @param items      High-urgency scored items from Phase 1.
 * @param bankrollUsd Current portfolio value in USD (passed in from caller for testability).
 * @param opts       Optional WebSocket feed + Redis for real-time price resolution.
 */
export async function runMapping(
  items: ScoredItem[],
  bankrollUsd: number,
  opts?: { redis?: Redis; feed?: ClobPriceFeed },
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
      // 1. Hard Relevance Gate: Skip expensive operations if headline is irrelevant
      const isRelevant = await isMarketRelevant({
        headline: item.title,
        question: candidate.question,
        description: candidate.description,
      });
      if (!isRelevant) continue;

      // 2. Subscribe to WS updates for high-urgency items
      if (opts?.feed && item.urgencyScore >= cfg.URGENCY_THRESHOLD) {
        await opts.feed.watch(candidate.marketId, candidate.clobTokenIds);
      }

      // 3. Resolve price: WS cache first, then fall back to Gamma snapshot
      let currentYesPrice = candidate.currentYesPrice;
      if (opts?.redis && opts.feed) {
        const wsPrice = await resolveYesPrice(candidate.marketId, opts.redis, opts.feed);
        if (wsPrice !== null) currentYesPrice = wsPrice;
      }

      let consensus;
      try {
        consensus = await estimateConsensusProbability({
          question: candidate.question,
          description: candidate.description,
          headline: item.title,
          ...(opts?.redis ? { redis: opts.redis } : {}),
        });
      } catch (err) {
        logger.warn('[mapping] consensus estimation failed', {
          marketId: candidate.marketId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // Require at least 2 LLM samples for a trade — a single provider
      // returning 0.50 ("unrelated") creates phantom edge on extreme-priced
      // markets when stddev=0 looks artificially confident.
      if (consensus.sampleCount < 2) {
        logger.info('[mapping] skipping — insufficient consensus samples', {
          marketId: candidate.marketId,
          question: candidate.question.substring(0, 80),
          sampleCount: consensus.sampleCount,
          consensusP: consensus.probability.toFixed(3),
        });
        continue;
      }

      const { hasTrade, decision, skipReason } = computeDivergence({
        consensusProbability: consensus.probability,
        consensusStddev: consensus.stddev,
        currentYesPrice,
        bankrollUsd,
        divergenceThreshold,
        maxBetFraction,
        bookDepthUsd: candidate.liquidity,
      });

      logger.info('[mapping] divergence result', {
        marketId: candidate.marketId,
        question: candidate.question.substring(0, 80),
        consensusP: consensus.probability.toFixed(3),
        consensusStddev: consensus.stddev.toFixed(3),
        marketP: currentYesPrice.toFixed(3),
        hasTrade,
        skipReason,
        direction: decision?.direction,
        stakeUsd: decision?.stakeUsd.toFixed(2),
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
          source: 'osint',
          latencyMs: item.latencyMs,
          endDate: candidate.endDate ?? undefined,
          // assetId is not directly known from entity extraction, but usually 
          // inferred by the monitor or stored if known from spot move.
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

/**
 * High-speed mapping for News -> Futures.
 */
export async function mapNewsToFutures(
  items: ScoredItem[],
  bankrollUsd: number,
): Promise<TradeSignal[]> {
  const cfg = loadConfig();
  if (!cfg.FUTURES_ENABLED) return [];

  const signals: TradeSignal[] = [];

  for (const item of items) {
    if (item.urgencyScore < cfg.FUTURES_URGENCY_THRESHOLD) continue;

    // 1. Identify asset using shared symbol resolution logic
    const symbol = resolveHlSymbol(item.title);
    if (!symbol) continue;

    // 2. Perform zero-shot LLM sentiment analysis
    const direction = await estimateSentiment(item.title);
    if (direction === 'NEUTRAL') {
      logger.info('[mapping] skipping HL signal — neutral sentiment', {
        symbol,
        title: item.title,
      });
      continue;
    }

    // TA confluence gate — block if indicators disagree with LLM sentiment
    if (cfg.FUTURES_CONFLUENCE_GATE_ENABLED) {
      const redis = getRedis();
      const confluence = await scoreConfluence(symbol, redis);
      const expectedDir = direction === 'LONG' ? 'UP' : 'DOWN';

      if (confluence.score < cfg.FUTURES_MIN_CONFLUENCE_SCORE) {
        logger.info('[mapping] futures confluence_block — score too low', {
          symbol, direction, score: confluence.score,
          signals: confluence.signals, title: item.title,
        });
        continue;
      }
      if (confluence.direction !== expectedDir) {
        logger.info('[mapping] futures confluence_block — direction mismatch', {
          symbol, direction,
          confluenceDirection: confluence.direction, score: confluence.score,
          signals: confluence.signals, title: item.title,
        });
        continue;
      }

      logger.info('[mapping] futures confluence_pass', {
        symbol, direction, score: confluence.score,
        signals: confluence.signals,
      });
    }

    // Scale stakeUsd based on urgency (e.g. 6/10 urgency = 60% of max allowed stake).
    const maxStake = Math.min(cfg.FUTURES_MAX_PER_TRADE_USD, bankrollUsd * cfg.MAX_BET_FRACTION);
    const stakeUsd = maxStake * (item.urgencyScore / 10);

    signals.push({
      marketId: symbol,
      question: `News Futures: ${symbol} ${direction}`,
      direction,
      stakeUsd,
      edgeMagnitude: item.urgencyScore / 10,
      outcomePrice: 0, // Market order
      isFutures: true,
      leverage: cfg.FUTURES_DEFAULT_LEVERAGE,
      sourcedFrom: `News: ${item.title}`,
      reasoning: `High-urgency news detected for ${symbol} with ${direction} sentiment. Urgency: ${item.urgencyScore}. Executing single-signal HL Perp via rapid LLM classification.`,
      source: 'futures',
      latencyMs: item.latencyMs,
      assetId: symbol,
    });

    // Only one futures signal per news item to prevent over-trading
  }

  return signals;
}
