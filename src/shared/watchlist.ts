import { logger } from './logger.js';
import { getActiveMarkets } from '../mapping/gamma.js';
import type { GammaMarket } from '../mapping/gamma.js';
import type { Redis } from 'ioredis';

const WATCHLIST_KEY = 'watchlist:dynamic_keywords';
const MARKET_CACHE_KEY = 'watchlist:market_cache';
// Cache TTL is 3× the 4h cron interval so a single missed refresh run (disk
// hiccup, network blip, etc.) does not blank the cache and take clob-flow /
// entityExtractor / sports-scanner dark. Actively stale data (up to ~10% market
// turnover over 12h) is preferable to no data at all.
const WATCHLIST_TTL_SECONDS = 3600 * 12; // 12 hours

/**
 * Keywords that are too common and should be ignored to avoid noise.
 */
const BLACKLIST = new Set([
  'will',
  'price',
  'market',
  'polymarket',
  'yes',
  'no',
  'above',
  'below',
  'than',
  'between',
  'before',
  'after',
  'during',
  'since',
  'until',
  'which',
]);

/**
 * Normalise a string into individual keywords.
 * Filters out short tokens and common noise.
 */
function toKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !BLACKLIST.has(w));
}

/**
 * Refresh the dynamic watchlist by pulling all active market titles.
 * Extracts unique keywords and stores them in Redis.
 */
export async function refreshDynamicWatchlist(redis: Redis): Promise<number> {
  try {
    logger.info('[watchlist] refreshing dynamic keywords from active markets...');
    const markets = await getActiveMarkets(2000); // Fetch top 2000 markets

    const keywords = new Set<string>();
    for (const m of markets) {
      // Add tokens from the question
      const tokens = toKeywords(m.question);
      for (const t of tokens) keywords.add(t);

      // If description contains specific entities, we could add them too,
      // but title is usually sufficient and less noisy.
    }

    if (keywords.size > 0) {
      const pipeline = redis.pipeline();
      pipeline.del(WATCHLIST_KEY);
      pipeline.sadd(WATCHLIST_KEY, ...Array.from(keywords));
      pipeline.expire(WATCHLIST_KEY, WATCHLIST_TTL_SECONDS);
      await pipeline.exec();
    }

    // Cache full market objects for local keyword matching in entityExtractor.
    // Only store the fields needed for matching to keep the payload small.
    // Filter out expired markets — Gamma returns active=true even past endDate.
    const now = Date.now();
    const liveMarkets = markets.filter((m) => {
      if (!m.endDate) return true;
      const end = new Date(m.endDate).getTime();
      return isNaN(end) || end >= now;
    });

    try {
      const slim = liveMarkets.map((m) => ({
        id: m.id,
        question: m.question,
        description: m.description,
        conditionId: m.conditionId,
        clobTokenIds: m.clobTokenIds,
        outcomePrices: m.outcomePrices,
        liquidity: m.liquidity,
        endDate: m.endDate,
        volume: m.volume,
        feesEnabled: m.feesEnabled,
        feeType: m.feeType,
      }));
      await redis.set(MARKET_CACHE_KEY, JSON.stringify(slim), 'EX', WATCHLIST_TTL_SECONDS);
    } catch (err: unknown) {
      logger.warn('[watchlist] failed to cache market objects (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info('[watchlist] refresh complete', {
      uniqueKeywords: keywords.size,
      cachedMarkets: liveMarkets.length,
      expiredFiltered: markets.length - liveMarkets.length,
    });
    return keywords.size;
  } catch (err: unknown) {
    logger.error('[watchlist] refresh failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Efficiently check if a text string matches any keyword in the dynamic watchlist.
 *
 * Performance: O(N) where N is number of unique words in text.
 */
export async function matchesWatchlist(text: string, redis: Redis): Promise<boolean> {
  const tokens = toKeywords(text);
  if (tokens.length === 0) return false;

  // Fail-open Check: if watchlist key is missing or empty, bypass gating to prevent pipeline stalls.
  const exists = await redis.exists(WATCHLIST_KEY);
  if (!exists) return true;

  // Use Redis SMISMEMBER (or SISMEMBER in loop) to check all tokens at once.
  // SMISMEMBER is supported in Redis 6.2.0+.
  // Fallback to multiple SISMEMBER calls if needed, but modern clusters/insts have it.
  try {
    const results = await redis.smismember(WATCHLIST_KEY, ...tokens);
    return results.some((r) => r === 1);
  } catch (err: unknown) {
    // Fallback for older Redis versions or errors
    for (const token of tokens) {
      if (await redis.sismember(WATCHLIST_KEY, token)) return true;
    }
  }

  return false;
}

/**
 * Read the cached market list from Redis.
 *
 * Returns an empty array if the cache is missing or corrupted.
 */
export async function getCachedMarkets(redis: Redis): Promise<GammaMarket[]> {
  try {
    const raw = await redis.get(MARKET_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as GammaMarket[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
