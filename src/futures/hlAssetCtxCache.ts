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
    } catch (err) {
      // Malformed cache entry — delete it so we don't keep reparsing the same
      // garbage on every tick until TTL expires. Log so a poison pattern
      // (e.g. a deploy that changed the struct shape) is visible in ops.
      logger.warn('[hl-asset-ctx] malformed cache entry, invalidating', {
        symbol,
        err: err instanceof Error ? err.message : String(err),
      });
      try {
        await redis.del(key);
      } catch (deleteErr) {
        logger.warn('[hl-asset-ctx] failed to delete malformed cache entry', {
          symbol,
          err: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
        });
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

// ── OI divergence baseline (issue #265 Sub-PR 2) ────────────────────────────

/** Snapshot of OI + mark price at a fixed point in time for divergence comparison. */
export interface OiBaseline {
  oi: number;
  markPrice: number;
  ts: number;
}

/**
 * Read the existing OI baseline for `symbol` and, if none exists (first call
 * or TTL expired), atomically write the current values as the new baseline.
 *
 * The baseline key `hl:oi-baseline:<symbol>` is written with SET NX EX so
 * only the first caller per TTL window wins — subsequent callers within the
 * same window all read the same frozen snapshot, giving a consistent lookback.
 *
 * Returns:
 * - The existing baseline (non-null) when one is already stored — caller can
 *   compute oiPctChange and pricePctChange vs this.
 * - null on the first call of each TTL cycle (no prior baseline to compare
 *   against) — caller should treat the OI voter as neutral for this tick.
 */
export async function getOrSetOiBaseline(
  symbol: string,
  redis: Redis,
  currentOi: number,
  currentMarkPrice: number,
  ttlSec: number,
): Promise<OiBaseline | null> {
  const key = `hl:oi-baseline:${symbol}`;

  // 1. Try to read an existing baseline.
  let existing: string | null = null;
  try {
    existing = await redis.get(key);
  } catch (err) {
    logger.warn('[hl-asset-ctx] oi baseline get failed', {
      symbol,
      err: err instanceof Error ? err.message : String(err),
    });
    // Treat as cache miss — fall through to write attempt.
  }

  if (existing) {
    try {
      return JSON.parse(existing) as OiBaseline;
    } catch (err) {
      logger.warn('[hl-asset-ctx] malformed oi baseline, invalidating', {
        symbol,
        err: err instanceof Error ? err.message : String(err),
      });
      try { await redis.del(key); } catch { /* non-critical */ }
      // Fall through to write a fresh baseline.
    }
  }

  // 2. No usable baseline — write current as the new baseline (NX = only if
  //    not exists, so a parallel scanner tick can't stomp a just-written key).
  const newBaseline: OiBaseline = { oi: currentOi, markPrice: currentMarkPrice, ts: Date.now() };
  try {
    const setResult = await redis.set(key, JSON.stringify(newBaseline), 'EX', ttlSec, 'NX');
    if (setResult === null) {
      // NX race lost — another process wrote the key between our GET and SET.
      // Read what they wrote so this tick can participate in divergence scoring.
      try {
        const raced = await redis.get(key);
        if (raced) return JSON.parse(raced) as OiBaseline;
      } catch {
        // Ignore — treat as neutral tick if second read also fails.
      }
    }
  } catch (err) {
    logger.warn('[hl-asset-ctx] oi baseline write failed', {
      symbol,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return null; // No prior baseline this tick — voter is neutral.
}
