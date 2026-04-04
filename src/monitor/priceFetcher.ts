/**
 * Polymarket current price fetcher.
 *
 * Fetches the current best-bid/ask prices for open positions directly from
 * the Gamma API. Used by the monitor to compute P&L and decide exits.
 *
 * For a YES position: current price = current YES bid
 * For a NO position:  current price = current NO bid = 1 - YES ask
 *
 * We use the simpler midpoint approximation: currentYesPrice from outcomePrices[0].
 * This is the same field ingested at entry time — consistent comparison.
 */

import { getMarket, parseOutcomePrices, parseOutcomes } from '../mapping/gamma.js';
import { logger } from '../shared/logger.js';
import { getRedis } from '../shared/redis.js';
import { getPriceFeed } from '../shared/feedSingleton.js';
import type { Position } from '../execution/positionLedger.js';

export interface CurrentPrice {
  marketId: string;
  direction: 'YES' | 'NO';
  /** Current price of the outcome we hold (0–1) */
  currentOutcomePrice: number;
  /** Raw YES price from Gamma */
  currentYesPrice: number;
}

/**
 * Fetch the current price for a single open position.
 *
 * Returns null if the market is closed, not found, or the fetch fails.
 */
export async function fetchCurrentPrice(position: Position): Promise<CurrentPrice | null> {
  try {
    // NOTE: feed.watch() is intentionally NOT called here. The read path must
    // remain side-effect-free — watch registration belongs in the monitor setup
    // (fetchAllCurrentPrices callers should call feed.watch() before the read loop).
    // Calling watch() on every fetch invocation caused repeated subscription attempts
    // and obscured WS connection logic.
    // priceFetcher only handles Polymarket positions (YES/NO).
    // Futures positions (LONG/SHORT) are managed by futuresMonitor — skip them here
    // rather than silently casting an invalid direction.
    if (position.direction !== 'YES' && position.direction !== 'NO') {
      logger.debug('[price-fetcher] skipping non-PM position', {
        marketId: position.marketId,
        direction: position.direction,
      });
      return null;
    }
    const pmDirection: 'YES' | 'NO' = position.direction;

    // Skip UUID marketIds (legacy Simmer imports) — Gamma returns 422 for UUIDs.
    // Reconciliation will upgrade these to numeric IDs; no point hitting the API.
    if (/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(position.marketId)) {
      logger.debug('[price-fetcher] skipping UUID marketId (pending upgrade)', {
        marketId: position.marketId,
      });
      return null;
    }

    const redis = getRedis();
    const feed = getPriceFeed(redis);

    // Try WS cache first for sub-second freshness
    const cachedPrice = await feed.getCachedPrice(position.marketId);
    if (cachedPrice !== null) {
      logger.debug('[price-fetcher] WS cache hit', {
        marketId: position.marketId,
        price: cachedPrice,
      });
      const currentOutcomePrice = pmDirection === 'YES' ? cachedPrice : 1 - cachedPrice;
      return {
        marketId: position.marketId,
        direction: pmDirection,
        currentOutcomePrice,
        currentYesPrice: cachedPrice,
      };
    }

    // Fall back to Gamma REST
    const market = await getMarket(position.marketId);

    if (!market.active || market.closed) {
      logger.info('[price-fetcher] market is closed', { marketId: position.marketId });
      return null;
    }

    const prices = parseOutcomePrices(market.outcomePrices);
    if (prices.length === 0) {
      logger.warn('[price-fetcher] empty outcomePrices', { marketId: position.marketId });
      return null;
    }

    // Determine correct indices for YES and NO outcomes.
    // Gamma usually returns ["Yes", "No"] but order is not strictly guaranteed.
    const outcomes = parseOutcomes(market.outcomes).map((o) => o.toLowerCase());
    const yesIndex = outcomes.indexOf('yes');
    const noIndex = outcomes.indexOf('no');

    // Default to index 0 for YES and index 1 for NO if not found or if this is a binary market
    // without standard labels (PGA only supports binary YES/NO for now).
    const resolvedYesIndex = yesIndex !== -1 ? yesIndex : 0;
    const resolvedNoIndex = noIndex !== -1 ? noIndex : (prices.length > 1 ? 1 : 0);

    const currentYesPrice = parseFloat(prices[resolvedYesIndex] ?? '0');
    const currentNoPrice = parseFloat(prices[resolvedNoIndex] ?? '0');

    if (!isFinite(currentYesPrice)) {
      logger.warn('[price-fetcher] non-finite YES price', { marketId: position.marketId });
      return null;
    }

    // currentOutcomePrice is the price of the side we hold.
    // If the market is healthy, YES + NO prices should sum to approx 1.0.
    // We prefer the direct price of the held outcome if available.
    // Validate NO price as well if direction is NO
    if (pmDirection === 'NO' && !Number.isFinite(currentNoPrice)) {
      logger.warn('[price-fetcher] invalid NO price for outcome', { marketId: position.marketId, outcome: outcomes[resolvedNoIndex] });
      return null;
    }

    const currentOutcomePrice = pmDirection === 'YES' ? currentYesPrice : currentNoPrice;

    return {
      marketId: position.marketId,
      direction: pmDirection,
      currentOutcomePrice,
      currentYesPrice,
    };
  } catch (err) {
    logger.warn('[price-fetcher] failed to fetch market price', {
      marketId: position.marketId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Fetch current prices for all open positions.
 *
 * Returns a map keyed by `${marketId}:${direction}` → CurrentPrice.
 * Keying by both marketId and direction prevents a YES and NO position on the
 * same market from overwriting each other's price (second write would silently
 * replace the first with the wrong outcome price).
 */
export async function fetchAllCurrentPrices(
  positions: Position[],
): Promise<Map<string, CurrentPrice>> {
  const results = new Map<string, CurrentPrice>();

  for (const position of positions) {
    const price = await fetchCurrentPrice(position);
    if (price) {
      results.set(`${position.marketId}:${position.direction}`, price);
    }
  }

  return results;
}
