import type { Redis } from 'ioredis';
import { getHyperliquid } from '../shared/hyperliquid.js';
import { logger } from '../shared/logger.js';

/**
 * Hyperliquid settles perp funding hourly at 1/8 of the computed 8-hour rate,
 * so the `funding` field returned by `metaAndAssetCtxs` is the hourly rate.
 * APR = hourly × 24 × 365.
 */
export const HL_FUNDING_SETTLEMENTS_PER_YEAR = 24 * 365;

export interface CachedAssetCtx {
  fundingRate: number;
  openInterest: number;
  markPrice: number;
}

/**
 * Fetch HL asset context (funding, OI, mark) with a Redis cache. Used by the
 * HL-native signal voters (issue #265) so each scanner tick doesn't re-hit
 * the HL info endpoint.
 *
 * Stale-on-error: returns null if the HL fetch fails and nothing is cached.
 * Callers should treat null as "skip this voter" rather than failing the
 * whole signal — the other voters still carry the scoring.
 */
export async function getCachedAssetCtx(
  symbol: string,
  redis: Redis,
  ttlSec: number,
): Promise<CachedAssetCtx | null> {
  const key = `hl:asset-ctx:${symbol}`;
  let cached: string | null = null;
  try {
    cached = await redis.get(key);
  } catch (err) {
    logger.warn('[hl-asset-ctx] redis get failed', {
      symbol,
      err: err instanceof Error ? err.message : String(err),
    });
    // treat as cache miss and fall through to HL fetch
  }
  if (cached) {
    try {
      return JSON.parse(cached) as CachedAssetCtx;
    } catch {
      // Malformed cache entry — delete it so we don't keep reparsing the same
      // garbage on every tick until TTL expires. Best-effort: a delete failure
      // just means we'll retry parsing next tick, which is harmless.
      try {
        await redis.del(key);
      } catch {
        // ignore — non-critical cleanup
      }
    }
  }
  try {
    const ctx = await getHyperliquid().getAssetContext(symbol);
    try {
      await redis.setex(key, ttlSec, JSON.stringify(ctx));
    } catch (err) {
      // Cache write failure is non-fatal — we still return the fresh ctx.
      logger.warn('[hl-asset-ctx] redis setex failed', {
        symbol,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return ctx;
  } catch (err) {
    logger.warn('[hl-asset-ctx] fetch failed', {
      symbol,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Compute annualized APR (as a percent, e.g. 120 = 120%) from the hourly
 * funding rate returned by the HL info endpoint.
 */
export function fundingRateToApr(hourlyFundingRate: number): number {
  return hourlyFundingRate * HL_FUNDING_SETTLEMENTS_PER_YEAR * 100;
}
