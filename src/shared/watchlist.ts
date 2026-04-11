import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { getActiveMarkets, parseOutcomes, parseOutcomePrices } from '../mapping/gamma.js';
import { enqueueWrite } from '../db/writeQueue.js';
import type { GammaMarket } from '../mapping/gamma.js';
import type { Redis } from 'ioredis';

const WATCHLIST_KEY = 'watchlist:dynamic_keywords';
const MARKET_CACHE_KEY = 'watchlist:market_cache';

// Price history for near-zero scanner reprice filter. Each refresh writes the
// cheaper side (YES or NO) of every market that sits below PRICE_HIST_TRACK_MAX
// to a per-market-per-direction ZSET, keyed `near_zero:price_hist:{id}:{dir}`.
// Score = wall-clock ms; member = "{ms}:{price}" (unique even when the same
// price appears twice). TTL refreshed on every write — stale markets drop out
// after 14 days naturally.
const PRICE_HIST_KEY_PREFIX = 'near_zero:price_hist:';
const PRICE_HIST_TTL_SECONDS = 14 * 24 * 3600;
// Only track markets whose cheaper side is below this threshold. Catches
// candidates currently in the near-zero zone plus markets close enough to drop
// into it within one lookback window. Above this, tracking is wasted writes.
const PRICE_HIST_TRACK_MAX = 0.35;
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

    if (liveMarkets.length === 0) {
      // Do NOT overwrite the existing cache with an empty array. This happens
      // when Gamma returns stale data or all fetched markets have past endDates.
      // Preserving the existing cache (even if slightly stale) is far better
      // than blanking it and taking the CLOB flow dark.
      logger.error('[watchlist] all fetched markets filtered as expired — preserving existing cache', {
        totalFetched: markets.length,
      });
    } else {
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
    }

    // Emit market_catalog snapshot to PG analytics layer.
    const snapshotId = randomUUID();
    const capturedAt = new Date().toISOString();
    for (const m of liveMarkets) {
      void enqueueWrite('market_catalog', {
        snapshotId,
        capturedAt,
        marketId: m.id,
        conditionId: m.conditionId,
        question: m.question,
        endDate: m.endDate ?? undefined,
        outcomes: (() => { try { return parseOutcomes(m.outcomes); } catch { return undefined; } })(),
        liquidity: m.liquidity != null ? Number(m.liquidity) : undefined,
        active: m.active,
        raw: { volume: m.volume, feesEnabled: m.feesEnabled },
      });
    }

    // Capture a snapshot of current prices for markets near either extreme,
    // so the near-zero scanner can later distinguish recently-repriced markets
    // from perennial dead horses. Fire-and-forget — never fail the refresh on
    // price history write errors.
    const tracked = await recordNearZeroPriceHistory(redis, liveMarkets);

    logger.info('[watchlist] refresh complete', {
      uniqueKeywords: keywords.size,
      cachedMarkets: liveMarkets.length,
      expiredFiltered: markets.length - liveMarkets.length,
      priceHistoryTracked: tracked,
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

/**
 * Append one price sample per market to the near-zero price-history ZSETs.
 * Tracks only the cheaper side (YES or NO) and only when it's below
 * PRICE_HIST_TRACK_MAX — a market 90¢-YES has no chance of appearing in the
 * 3–10¢ scan zone from either direction, so tracking it is wasted writes.
 *
 * Writes are pipelined. Called from `refreshDynamicWatchlist` after the market
 * cache is updated, so we reuse the same Gamma fetch.
 */
export async function recordNearZeroPriceHistory(
  redis: Redis,
  markets: GammaMarket[],
  nowMs: number = Date.now(),
): Promise<number> {
  const pipeline = redis.pipeline();
  let tracked = 0;
  for (const m of markets) {
    try {
      const prices = parseOutcomePrices(m.outcomePrices);
      const yes = parseFloat(prices[0] ?? '');
      const no = parseFloat(prices[1] ?? '');
      if (!Number.isFinite(yes) || !Number.isFinite(no)) continue;

      // Track the cheaper side only — that's the one the near-zero scanner evaluates.
      const yesCheaper = yes <= no;
      const side: 'YES' | 'NO' = yesCheaper ? 'YES' : 'NO';
      const price = yesCheaper ? yes : no;
      if (price >= PRICE_HIST_TRACK_MAX) continue;

      const key = `${PRICE_HIST_KEY_PREFIX}${m.id}:${side}`;
      const member = `${nowMs}:${price}`;
      pipeline.zadd(key, nowMs, member);
      pipeline.expire(key, PRICE_HIST_TTL_SECONDS);
      tracked++;
    } catch {
      // malformed prices → skip
    }
  }
  if (tracked > 0) {
    try {
      await pipeline.exec();
    } catch (err: unknown) {
      logger.warn('[watchlist] price history write failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return tracked;
}

/**
 * Read the peak price observed for a market+direction over the last N days.
 * Used by the near-zero scanner's dead-horse filter: markets that have always
 * been cheap are efficient, real mispricings drop INTO the zone from higher.
 *
 * Returns null when no history exists (first sighting — caller should grandfather
 * in rather than block).
 */
export async function getNearZeroPeakPrice(
  redis: Redis,
  marketId: string,
  direction: 'YES' | 'NO',
  lookbackDays: number,
  nowMs: number = Date.now(),
): Promise<number | null> {
  const key = `${PRICE_HIST_KEY_PREFIX}${marketId}:${direction}`;
  const cutoffMs = nowMs - lookbackDays * 24 * 3600 * 1000;
  const members = await redis.zrangebyscore(key, cutoffMs, '+inf');
  if (members.length === 0) return null;
  let max = 0;
  for (const m of members) {
    const colonIdx = m.indexOf(':');
    if (colonIdx === -1) continue;
    const p = parseFloat(m.slice(colonIdx + 1));
    if (Number.isFinite(p) && p > max) max = p;
  }
  return max > 0 ? max : null;
}
