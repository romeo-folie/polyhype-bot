/**
 * Market selector for rebate farming.
 *
 * Scores candidate markets by `volume × (10000 / spreadBps)` — rewards
 * high volume (more taker flow = more rebates) and tight spreads (less
 * adverse selection). Pre-filters on cached data before fetching order
 * books to stay within CLOB API rate limits.
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getCachedMarkets } from '../shared/watchlist.js';
import { getClobOrderBook } from '../shared/clob.js';
import {
  parseOutcomes,
  parseOutcomePrices,
  parseClobTokenIds,
} from '../mapping/gamma.js';
import type { RebateMarketCandidate } from './types.js';

/** Maximum number of order books to fetch per cycle (rate limit guard). */
const MAX_BOOK_FETCHES = 25;

export async function selectRebateMarkets(
  redis: Redis,
  maxMarkets: number,
): Promise<RebateMarketCandidate[]> {
  const cfg = loadConfig();
  const markets = await getCachedMarkets(redis);
  if (markets.length === 0) {
    logger.debug('[rebate] market cache empty — skipping selection');
    return [];
  }

  // Phase 1: Pre-filter on cached data (cheap — no API calls).
  const preFiltered: {
    marketId: string;
    conditionId: string;
    question: string;
    clobTokenIds: string[];
    volume: number;
    liquidity: number;
    yesPrice: number;
    endDate: string | null;
    negRisk: boolean;
  }[] = [];

  for (const market of markets) {
    // Binary-only gate.
    if (market.outcomes) {
      try {
        if (parseOutcomes(market.outcomes).length !== 2) continue;
      } catch {
        continue;
      }
    }

    // Fee market gate.
    if (cfg.REBATE_SKIP_FEE_MARKETS && market.feesEnabled) continue;

    // Expired market gate.
    if (market.endDate) {
      const end = new Date(market.endDate).getTime();
      if (!isNaN(end) && end < Date.now()) continue;
    }

    const volume = parseFloat(market.volume ?? '0');
    if (!isFinite(volume) || volume < cfg.REBATE_MIN_VOLUME) continue;

    const liquidity = parseFloat(market.liquidity ?? '0');
    if (!isFinite(liquidity) || liquidity < cfg.REBATE_MIN_LIQUIDITY) continue;

    // Parse YES price — need it for direction selection.
    let yesPrice: number;
    try {
      const prices = parseOutcomePrices(market.outcomePrices);
      if (prices.length === 0) continue;
      yesPrice = parseFloat(prices[0] ?? '0');
      if (!isFinite(yesPrice) || yesPrice <= 0 || yesPrice >= 1) continue;
    } catch {
      continue;
    }

    // Skip extreme prices — poor spread dynamics at the tails.
    if (yesPrice < 0.10 || yesPrice > 0.90) continue;

    let clobTokenIds: string[];
    try {
      clobTokenIds = parseClobTokenIds(market.clobTokenIds ?? []);
      if (clobTokenIds.length < 2) continue;
    } catch {
      continue;
    }

    preFiltered.push({
      marketId: market.id,
      conditionId: market.conditionId,
      question: market.question,
      clobTokenIds,
      volume,
      liquidity,
      yesPrice,
      endDate: market.endDate ?? null,
      negRisk: false, // fetched from order book later
    });
  }

  // Sort by volume descending and take top MAX_BOOK_FETCHES to limit API calls.
  preFiltered.sort((a, b) => b.volume - a.volume);
  const toFetch = preFiltered.slice(0, MAX_BOOK_FETCHES);

  // Phase 2: Fetch order books and score.
  const candidates: RebateMarketCandidate[] = [];

  for (const m of toFetch) {
    // Choose direction: bid on the side closer to 0.50 — that side has more
    // natural taker flow (buyers pushing toward the consensus center).
    const direction: 'YES' | 'NO' = m.yesPrice >= 0.50 ? 'YES' : 'NO';
    const tokenId = direction === 'YES' ? m.clobTokenIds[0]! : m.clobTokenIds[1]!;

    const book = await getClobOrderBook(tokenId);
    if (!book) continue;

    const bestBid = parseFloat(book.bids[0]?.price ?? '0');
    const bestAsk = parseFloat(book.asks[0]?.price ?? '0');
    if (bestBid <= 0 || bestAsk <= 0 || bestAsk <= bestBid) continue;

    const midPrice = (bestBid + bestAsk) / 2;
    const spreadBps = ((bestAsk - bestBid) / midPrice) * 10_000;
    if (spreadBps < cfg.REBATE_MIN_SPREAD_BPS) continue;

    // Score: volume × inverse spread. Higher is better.
    const score = m.volume * (10_000 / spreadBps);

    candidates.push({
      marketId: m.marketId,
      conditionId: m.conditionId,
      question: m.question,
      clobTokenIds: m.clobTokenIds,
      direction,
      tokenId,
      bestBid,
      bestAsk,
      spreadBps,
      midPrice,
      volume: m.volume,
      liquidity: m.liquidity,
      score,
      tickSize: book.tick_size,
      negRisk: book.neg_risk ?? false,
      endDate: m.endDate,
    });
  }

  // Sort by score descending and take top N.
  candidates.sort((a, b) => b.score - a.score);
  const selected = candidates.slice(0, maxMarkets);

  logger.info('[rebate] market selection complete', {
    cached: markets.length,
    preFiltered: preFiltered.length,
    booksFetched: toFetch.length,
    passedSpread: candidates.length,
    selected: selected.length,
  });

  return selected;
}
