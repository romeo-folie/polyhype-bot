/**
 * Correlation Discovery Cron (every 6h)
 *
 * Discovers cross-market logical relationships and persists them as
 * constraint edges in Redis for the violation scanner to consume.
 *
 * Flow:
 *   1. Load cached markets (top N by liquidity)
 *   2. Find candidate pairs by entity overlap
 *   3. Classify each pair via LLM (implication / mutual-exclusion / none)
 *   4. Persist constraint edges in Redis
 *
 * Log marker: [corr-discovery]
 */

import 'dotenv/config';
import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getCachedMarkets } from '../shared/watchlist.js';
import { parseOutcomePrices, parseClobTokenIds } from '../mapping/gamma.js';
import { findCandidatePairs } from '../correlation/pairFinder.js';
import { classifyRelationship } from '../correlation/relationshipClassifier.js';
import { saveConstraint, evictExpiredConstraints, loadAllConstraints } from '../correlation/constraintGraph.js';
import { pairKey, edgeId } from '../correlation/types.js';
import type { MarketPrice, ConstraintEdge } from '../correlation/types.js';

const PAIR_SEEN_PREFIX = 'correlation:discovery:pair_seen:';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Build a MarketPrice from a cached GammaMarket. Returns null if the market
 * is unparseable, multi-outcome, or has a past endDate.
 */
function toMarketPrice(market: {
  id: string;
  question: string;
  conditionId: string;
  clobTokenIds: string | string[];
  outcomePrices: string | string[];
  outcomes?: string | string[];
  liquidity: string;
  endDate: string | null;
}): MarketPrice | null {
  try {
    // Binary-only gate.
    if (market.outcomes) {
      const outcomes = typeof market.outcomes === 'string'
        ? (JSON.parse(market.outcomes) as unknown[])
        : market.outcomes;
      if (Array.isArray(outcomes) && outcomes.length > 2) return null;
    }

    // Skip markets with past endDate.
    if (market.endDate && new Date(market.endDate).getTime() <= Date.now()) return null;

    const prices = parseOutcomePrices(market.outcomePrices);
    const yesPrice = parseFloat(prices[0] ?? '0');
    if (!isFinite(yesPrice)) return null;

    const noPrice = parseFloat(prices[1] ?? '0');

    const clobTokenIds = parseClobTokenIds(market.clobTokenIds);
    if (clobTokenIds.length < 2) return null;

    const liquidity = parseFloat(market.liquidity ?? '0');
    if (!isFinite(liquidity)) return null;

    return {
      marketId: market.id,
      yesPrice,
      noPrice: isFinite(noPrice) ? noPrice : 1 - yesPrice,
      clobTokenIds,
      conditionId: market.conditionId,
      question: market.question,
      endDate: market.endDate,
      liquidity,
    };
  } catch {
    return null;
  }
}

/**
 * Run the correlation discovery process.
 */
export async function runCorrelationDiscovery(redis: Redis): Promise<void> {
  const cfg = loadConfig();

  // 1. Load and filter markets.
  const rawMarkets = await getCachedMarkets(redis);
  if (rawMarkets.length === 0) {
    logger.warn('[corr-discovery] market cache empty — ensure refreshWatchlist runs first');
    return;
  }

  const markets: MarketPrice[] = [];
  for (const raw of rawMarkets) {
    const mp = toMarketPrice(raw);
    if (mp && mp.liquidity >= cfg.CORRELATION_MIN_LIQUIDITY) {
      markets.push(mp);
    }
  }

  // Sort by liquidity descending, cap to discovery budget.
  markets.sort((a, b) => b.liquidity - a.liquidity);
  const capped = markets.slice(0, cfg.CORRELATION_MAX_MARKETS_FOR_DISCOVERY);

  // 2. Evict expired constraints before adding new ones.
  await evictExpiredConstraints(redis);

  // 3. Find candidate pairs by entity overlap.
  const pairs = findCandidatePairs(
    capped,
    cfg.CORRELATION_MIN_SHARED_ENTITIES,
    cfg.CORRELATION_MAX_PAIRS_PER_DISCOVERY,
  );

  if (pairs.length === 0) {
    logger.info('[corr-discovery] no candidate pairs found', {
      marketsConsidered: capped.length,
    });
    return;
  }

  // 4. Classify each pair via LLM.
  let newEdges = 0;
  let skippedSeen = 0;
  let classifiedNone = 0;
  let llmErrors = 0;

  for (const pair of pairs) {
    // Pair-seen dedup: don't re-classify within the dedup window.
    const pk = pairKey(pair.a.marketId, pair.b.marketId);
    const seenKey = `${PAIR_SEEN_PREFIX}${pk}`;
    const claimed = await redis.set(seenKey, '1', 'EX', cfg.CORRELATION_PAIR_DEDUP_TTL_S, 'NX');
    if (!claimed) {
      skippedSeen++;
      continue;
    }

    try {
      const result = await classifyRelationship(
        pair.a.question,
        pair.b.question,
        redis,
        cfg.CORRELATION_CLASSIFY_CACHE_TTL_S,
      );

      if (result.type === 'none') {
        classifiedNone++;
        continue;
      }

      // Normalize implication direction so the stored edge always reads A→B.
      let marketIdA = pair.a.marketId;
      let marketIdB = pair.b.marketId;
      let questionA = pair.a.question;
      let questionB = pair.b.question;
      let endDateA = pair.a.endDate;
      let endDateB = pair.b.endDate;

      if (result.type === 'implication' && result.direction === 'B_implies_A') {
        // Swap so stored edge is A→B.
        [marketIdA, marketIdB] = [marketIdB, marketIdA];
        [questionA, questionB] = [questionB, questionA];
        [endDateA, endDateB] = [endDateB, endDateA];
      }

      const edge: ConstraintEdge = {
        id: edgeId(marketIdA, marketIdB, result.type),
        type: result.type,
        marketIdA,
        marketIdB,
        questionA,
        questionB,
        reasoning: result.reasoning,
        discoveredAt: Math.floor(Date.now() / 1000),
        endDateA,
        endDateB,
      };

      await saveConstraint(redis, edge, cfg.CORRELATION_GRAPH_TTL_S);
      newEdges++;

      logger.info('[corr-discovery] constraint discovered', {
        type: edge.type,
        marketIdA,
        marketIdB,
        questionA: questionA.slice(0, 80),
        questionB: questionB.slice(0, 80),
        reasoning: result.reasoning.slice(0, 120),
      });
    } catch (err) {
      llmErrors++;
      logger.warn('[corr-discovery] pair classification failed', {
        error: err instanceof Error ? err.message : String(err),
        marketIdA: pair.a.marketId,
        marketIdB: pair.b.marketId,
      });
    }

    // Rate-limit LLM calls.
    if (cfg.CORRELATION_CLASSIFY_DELAY_MS > 0) {
      await delay(cfg.CORRELATION_CLASSIFY_DELAY_MS);
    }
  }

  // Load total for summary.
  const totalEdges = (await loadAllConstraints(redis)).length;

  logger.info('[corr-discovery] discovery complete', {
    marketsConsidered: capped.length,
    pairsFound: pairs.length,
    skippedSeen,
    classifiedNone,
    llmErrors,
    newEdges,
    totalEdges,
  });
}

// ── Standalone entrypoint (cron) ──────────────────────────────────────────

async function main() {
  const { getRedis, closeRedis } = await import('../shared/redis.js');
  const redis = getRedis();
  try {
    await runCorrelationDiscovery(redis);
  } finally {
    await closeRedis();
  }
}

const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/correlationDiscovery.js') === true;

if (isMainModule) {
  void main().catch((err: unknown) => {
    logger.error('[corr-discovery] fatal error', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
