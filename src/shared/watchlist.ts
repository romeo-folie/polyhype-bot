import { logger } from './logger.js';
import { getActiveMarkets } from '../mapping/gamma.js';
import type { Redis } from 'ioredis';

const WATCHLIST_KEY = 'watchlist:dynamic_keywords';
const WATCHLIST_TTL_SECONDS = 3600 * 6; // 6 hours

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

    logger.info('[watchlist] refresh complete', { uniqueKeywords: keywords.size });
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
