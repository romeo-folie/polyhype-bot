/**
 * Market price resolver — WebSocket cache first, Gamma REST fallback.
 *
 * Call resolveYesPrice() instead of getMarket() when you need a fast current price.
 */

import type { Redis } from 'ioredis';
import type { ClobPriceFeed } from './clobWebSocket.js';
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
