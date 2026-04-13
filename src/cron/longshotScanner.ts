/**
 * Longshot Bias / NO-Side Scanner
 *
 * Exploits the favorite-longshot bias documented by Whelan's study of 300K
 * Polymarket contracts: YES contracts priced 3-15 cents are systematically overpriced
 * due to retail optimism. The scanner buys NO to bet against the bias.
 *
 * Category-specific optimism gaps (from academic research):
 *   - Entertainment/media: ~5 percentage points overpriced
 *   - Sports: ~2pp
 *   - Political longshots: ~3pp
 *   - Finance/crypto: ~0pp (exempt -- well-calibrated domains)
 *
 * The current near-zero scanner tries to find UNDERPRICED cheap YES outcomes.
 * Research shows this is the LOSING side of the bias. This scanner takes the
 * opposite approach: cheap YES = overpriced by retail optimism -> buy NO.
 *
 * Ships with LONGSHOT_SCANNER_ENABLED=false. Shadow-log first, review
 * `[longshot] opportunity found` logs, then enable.
 *
 * Log marker: [longshot]
 * Dedup key:  longshot:attempted:{marketId}  (TTL: LONGSHOT_DEDUP_TTL_S)
 */

import 'dotenv/config';
import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getBankroll } from '../shared/bankroll.js';
import { getCachedMarkets } from '../shared/watchlist.js';
import { parseOutcomePrices, parseClobTokenIds, parseOutcomes } from '../mapping/gamma.js';
import { executeSignal } from '../execution/executor.js';
import { priceZoneOf } from '../shared/zones.js';
import type { TradeSignal } from '../mapping/index.js';

const DEDUP_KEY_PREFIX = 'longshot:attempted:';

// ── Category-specific optimism gaps (from Whelan research) ─────────────────
// These represent the average number of percentage points by which YES
// contracts in each domain are overpriced at the 3-15 cent level.
const CATEGORY_OPTIMISM_GAP: Record<string, number> = {
  'entertainment': 0.05,
  'sports': 0.02,
  'us-politics': 0.03,
  'geopolitical': 0.03,
  'ai-tech': 0.03,
  'default': 0.02,
};

// ── Lightweight keyword classifier for market questions ────────────────────
// Mirrors the keyword categories from categoryClassifier.ts but avoids LLM
// calls since we process many markets per scan. Returns the category ID.
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  'crypto-regulatory': [
    'bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'token', 'stablecoin',
    'defi', 'nft', 'blockchain', 'solana', 'ripple', 'xrp', 'binance',
    'coinbase',
  ],
  'macro': [
    'fed', 'federal reserve', 'rate cut', 'rate hike', 'inflation', 'cpi',
    'gdp', 'central bank', 'treasury', 'yield', 'recession', 'ecb',
    'interest rate', 'monetary policy', 'tariff',
  ],
  'ai-tech': [
    'ai', 'artificial intelligence', 'gpt', 'openai', 'deepmind',
    'frontier model', 'agi', 'llm', 'nvidia', 'semiconductor',
  ],
  'us-politics': [
    'congress', 'senate', 'president', 'biden', 'trump', 'supreme court',
    'executive order', 'governor', 'democrat', 'republican',
  ],
  'sports': [
    'nba', 'nhl', 'playoff', 'championship', 'game 7', 'stanley cup',
    'super bowl', 'world series', 'lakers', 'warriors', 'celtics',
    'yankees', 'dodgers', 'mvp',
  ],
  'entertainment': [
    'oscar', 'emmy', 'grammy', 'netflix', 'movie', 'film', 'album',
    'box office', 'award', 'celebrity', 'reality tv', 'bachelor',
    'bachelorette', 'survivor', 'american idol',
  ],
  'geopolitical': [
    'war', 'nato', 'ukraine', 'russia', 'china', 'taiwan', 'iran',
    'sanctions', 'ceasefire', 'military', 'invasion',
  ],
};

/**
 * Classify a market question into a category using keyword matching.
 * Returns the category ID with the most keyword hits, or 'default'.
 */
export function classifyMarketCategory(question: string): string {
  const lower = question.toLowerCase();
  let bestCat = 'default';
  let bestHits = 0;

  for (const [catId, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    let hits = 0;
    for (const kw of keywords) {
      if (kw.includes(' ')) {
        if (lower.includes(kw)) hits++;
      } else {
        const re = new RegExp(`\\b${kw}\\b`, 'i');
        if (re.test(lower)) hits++;
      }
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestCat = catId;
    }
  }

  return bestCat;
}

// ── Exported interfaces ────────────────────────────────────────────────────

export interface LongshotOpportunity {
  marketId: string;
  question: string;
  yesPrice: number;
  noPrice: number;
  noClobTokenId: string;
  /** All CLOB token IDs [YES, NO] for signal construction */
  clobTokenIds: string[];
  conditionId: string;
  category: string;
  optimismGap: number;
  edge: number;
  liquidity: number;
  endDate: string | null;
}

/**
 * Scan cached markets for longshot bias opportunities.
 *
 * Returns qualifying markets where the YES price is in the 3-15 cent range
 * (indicating the longshot bias zone) and the estimated optimism gap exceeds
 * the minimum edge threshold. Markets in exempt categories (crypto, macro)
 * are excluded as they are well-calibrated.
 */
export async function scanForLongshotBias(redis: Redis): Promise<LongshotOpportunity[]> {
  const cfg = loadConfig();
  const exemptCategories = new Set(
    cfg.LONGSHOT_EXEMPT_CATEGORIES
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );

  // Load markets from local cache (populated by the every-4h watchlist refresh).
  const allMarkets = await getCachedMarkets(redis);
  if (allMarkets.length === 0) {
    logger.warn('[longshot] market cache empty -- ensure refreshWatchlist runs first');
    return [];
  }

  const opportunities: LongshotOpportunity[] = [];
  let multiOutcomeFiltered = 0;
  let exemptFiltered = 0;
  let priceFiltered = 0;
  let edgeFiltered = 0;
  let liquidityFiltered = 0;

  for (const market of allMarkets) {
    try {
      // Gate 1: Binary markets only -- multi-outcome markets are structurally
      // cheap per-slice and the bias does not apply the same way.
      if (market.outcomes) {
        try {
          const outcomeList = parseOutcomes(market.outcomes);
          if (outcomeList.length > 2) {
            multiOutcomeFiltered++;
            continue;
          }
        } catch {
          // Can't parse outcomes -- skip gate, don't block
        }
      }

      // Gate 2: Parse prices and check YES price range.
      const prices = parseOutcomePrices(market.outcomePrices);
      const yesPrice = parseFloat(prices[0] ?? '0');
      const noPrice = parseFloat(prices[1] ?? '0');

      if (!isFinite(yesPrice) || !isFinite(noPrice)) continue;

      if (yesPrice < cfg.LONGSHOT_YES_PRICE_MIN || yesPrice > cfg.LONGSHOT_YES_PRICE_MAX) {
        priceFiltered++;
        continue;
      }

      // Gate 3: Category classification + exemption check.
      const category = classifyMarketCategory(market.question);
      if (exemptCategories.has(category)) {
        exemptFiltered++;
        continue;
      }

      // Gate 4: Validate NO price is in expected range (complement of YES price).
      // outcomePrices are best-bid snapshots and may not sum to 1; if the observed
      // NO price is far from expected, skip — the book is too wide for edge.
      const expectedNoPrice = 1 - yesPrice;
      if (noPrice < expectedNoPrice - 0.05 || noPrice > expectedNoPrice + 0.05) {
        priceFiltered++;
        continue;
      }

      // Gate 5: Compute optimism gap and edge against observed NO price.
      const optimismGap = CATEGORY_OPTIMISM_GAP[category] ?? CATEGORY_OPTIMISM_GAP.default!;
      // The true probability of NO is approximately (1 - yesPrice + optimismGap),
      // so edge = trueNoProb - noPrice = (1 - yesPrice + optimismGap) - noPrice.
      // When noPrice ≈ 1 - yesPrice this simplifies to ~optimismGap, but using
      // the observed quote accounts for bid/ask spread drift.
      const trueNoProb = 1 - yesPrice + optimismGap;
      const edge = trueNoProb - noPrice;
      if (edge < cfg.LONGSHOT_MIN_EDGE) {
        edgeFiltered++;
        continue;
      }

      // Gate 6: Minimum liquidity.
      const liquidity = parseFloat(market.liquidity ?? '0');
      if (!isFinite(liquidity) || liquidity < cfg.LONGSHOT_MIN_LIQUIDITY) {
        liquidityFiltered++;
        continue;
      }

      // Parse CLOB token IDs -- NO token is at index [1].
      let clobTokenIds: string[];
      try {
        clobTokenIds = parseClobTokenIds(market.clobTokenIds);
      } catch {
        continue;
      }
      if (clobTokenIds.length < 2) continue;

      const noClobTokenId = clobTokenIds[1]!;

      opportunities.push({
        marketId: market.id,
        question: market.question,
        yesPrice,
        noPrice,
        noClobTokenId,
        clobTokenIds,
        conditionId: market.conditionId,
        category,
        optimismGap,
        edge,
        liquidity,
        endDate: market.endDate,
      });
    } catch {
      // Skip malformed market entries
    }
  }

  // Sort by edge descending (higher edge = better opportunity).
  // When edges are equal (same category), sort by YES price ascending
  // (cheaper YES = more overpriced = stronger bias signal).
  opportunities.sort((a, b) => {
    if (b.edge !== a.edge) return b.edge - a.edge;
    return a.yesPrice - b.yesPrice;
  });

  // Cap to max markets per run.
  const capped = opportunities.slice(0, cfg.LONGSHOT_MAX_MARKETS);

  logger.info('[longshot] scan summary', {
    totalMarkets: allMarkets.length,
    multiOutcomeFiltered,
    exemptFiltered,
    priceFiltered,
    edgeFiltered,
    liquidityFiltered,
    qualified: opportunities.length,
    capped: capped.length,
    enabled: cfg.LONGSHOT_SCANNER_ENABLED,
  });

  return capped;
}

/**
 * Run the longshot bias scanner. Always shadow-logs found opportunities.
 * Only executes trades when LONGSHOT_SCANNER_ENABLED=true.
 */
export async function runLongshotScan(redis: Redis): Promise<void> {
  const cfg = loadConfig();

  const opportunities = await scanForLongshotBias(redis);
  if (opportunities.length === 0) return;

  const bankrollUsd = await getBankroll(redis);

  for (const opp of opportunities) {
    const dedupKey = `${DEDUP_KEY_PREFIX}${opp.marketId}`;

    // Claim dedup key before potential execution to prevent concurrent runs
    // re-evaluating the same market.
    const claimed = await redis.set(dedupKey, '1', 'EX', cfg.LONGSHOT_DEDUP_TTL_S, 'NX');
    if (!claimed) {
      logger.debug('[longshot] dedup race -- skipping', { marketId: opp.marketId });
      continue;
    }

    const stakeUsd = Math.min(
      bankrollUsd * cfg.LONGSHOT_MAX_STAKE_FRACTION,
      opp.liquidity * 0.01, // never take more than 1% of actual market liquidity
    );

    const wouldExecute = cfg.LONGSHOT_SCANNER_ENABLED && stakeUsd > 0;

    logger.info('[longshot] opportunity found', {
      marketId: opp.marketId,
      question: opp.question.slice(0, 120),
      yesPrice: opp.yesPrice.toFixed(4),
      noPrice: opp.noPrice.toFixed(4),
      category: opp.category,
      optimismGap: opp.optimismGap.toFixed(3),
      edge: opp.edge.toFixed(3),
      liquidity: opp.liquidity.toFixed(0),
      stakeUsd: stakeUsd.toFixed(2),
      wouldExecute,
      shadow: !cfg.LONGSHOT_SCANNER_ENABLED,
    });

    if (!wouldExecute) continue;

    const signal: TradeSignal = {
      marketId: opp.marketId,
      conditionId: opp.conditionId,
      clobTokenIds: opp.clobTokenIds,
      question: opp.question,
      direction: 'NO',
      stakeUsd,
      edgeMagnitude: opp.edge,
      outcomePrice: opp.noPrice,
      priceZone: priceZoneOf(opp.noPrice),
      sourcedFrom: 'longshot-bias',
      reasoning:
        `Longshot bias scanner: YES=${opp.yesPrice.toFixed(3)}, ` +
        `NO=${opp.noPrice.toFixed(3)}, ` +
        `category=${opp.category}, ` +
        `optimismGap=${opp.optimismGap.toFixed(3)}, ` +
        `edge=${opp.edge.toFixed(3)}. ` +
        `Retail optimism overprices YES at this level (Whelan 300K study).`,
      source: 'longshot-bias',
      endDate: opp.endDate ?? undefined,
    };

    const result = await executeSignal(signal, redis, stakeUsd);
    if (!result.skipped) {
      logger.info('[longshot] trade executed', {
        marketId: opp.marketId,
        direction: 'NO',
        stakeUsd,
        venue: result.executionVenue,
        entryPrice: result.entryPrice,
      });
    } else {
      logger.info('[longshot] trade skipped by executor', {
        marketId: opp.marketId,
        skipReason: result.skipReason,
      });
    }
  }
}

// ── Standalone entrypoint (cron) ──────────────────────────────────────────

async function main() {
  const { getRedis, closeRedis } = await import('../shared/redis.js');
  const redis = getRedis();
  try {
    await runLongshotScan(redis);
  } finally {
    await closeRedis();
  }
}

void main().catch((err: unknown) => {
  logger.error('[longshot] fatal error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
