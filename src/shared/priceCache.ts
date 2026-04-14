/**
 * Market price resolver — WebSocket cache first, Gamma REST fallback.
 *
 * Call resolveYesPrice() instead of getMarket() when you need a fast current price.
 */

import type { Redis } from 'ioredis';
import type { ClobPriceFeed } from './clobWebSocket.js';
import { WS_NO_PRICE_KEY } from './clobWebSocket.js';
import { getMarket, parseOutcomePrices } from '../mapping/gamma.js';
import { logger } from './logger.js';

export async function resolveYesPrice(
  marketId: string,
  redis: Redis,
  feed: ClobPriceFeed,
): Promise<number | null> {
  // 1. WebSocket cache (sub-second freshness)
  const cached = await feed.getCachedPrice(marketId);
  if (cached !== null) {
    logger.debug('[price-cache] WS hit', { marketId, price: cached });
    return cached;
  }

  // 2. Gamma REST fallback
  try {
    const market = await getMarket(marketId);
    const prices = parseOutcomePrices(market.outcomePrices);
    if (prices.length === 0) {
      // Empty outcomes array — cannot determine a valid price.
      // Returning null (not 0) to avoid triggering false divergence signals.
      logger.warn('[price-cache] empty outcomePrices from Gamma REST', { marketId });
      return null;
    }
    const price = parseFloat(prices[0] ?? '0');
    if (!isFinite(price) || price < 0 || price > 1) return null;
    logger.debug('[price-cache] REST fallback', { marketId, price });
    return price;
  } catch (err) {
    logger.warn('[price-cache] REST fallback failed', { marketId, error: String(err) });
    return null;
  }
}

/**
 * Resolve the current NO-side price for a binary market.
 *
 * Binary Polymarket books have two resting prices (YES and NO) which need not
 * sum to 1 — the spread/overround means `1 - yes` can misrepresent NO by a
 * few cents. For narrow checks like the near-zero band (1–5¢) we must read NO
 * explicitly rather than deriving it from YES.
 */
export async function resolveNoPrice(
  marketId: string,
  redis: Redis,
): Promise<number | null> {
  // 1. WebSocket cache — NO is cached independently under WS_NO_PRICE_KEY.
  try {
    const raw = await redis.get(WS_NO_PRICE_KEY(marketId));
    if (raw !== null) {
      const p = parseFloat(raw);
      if (isFinite(p) && p >= 0 && p <= 1) return p;
    }
  } catch {
    // fall through to REST
  }

  // 2. Gamma REST fallback — outcomePrices[1] is NO for binary markets.
  try {
    const market = await getMarket(marketId);
    const prices = parseOutcomePrices(market.outcomePrices);
    if (prices.length < 2) return null;
    const price = parseFloat(prices[1] ?? '0');
    if (!isFinite(price) || price < 0 || price > 1) return null;
    return price;
  } catch (err) {
    logger.warn('[price-cache] NO REST fallback failed', { marketId, error: String(err) });
    return null;
  }
}
