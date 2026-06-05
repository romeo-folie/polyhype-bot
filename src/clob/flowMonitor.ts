/**
 * CLOB flow monitor.
 *
 * Long-running worker that subscribes to the Polymarket CLOB market WS for
 * every token ID in the local watchlist cache and persists:
 *
 *   clob:book_state:{tokenId}  Redis Hash {bestBid, bestAsk, bidSize, askSize, ts}
 *   clob:tape:{marketId}       Sorted set of trade prints (capped at 1000)
 *
 * It also pubs trades and book deltas on Redis Pub/Sub channels for
 * downstream consumers (confluence voter, tape shortlist).
 *
 * Reconnect / shutdown semantics follow the Binance feed pattern.
 */

import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getRedis, closeRedis, acquireLock, releaseLock } from '../shared/redis.js';
import { getCachedMarkets } from '../shared/watchlist.js';
import { getBookTouchLevels } from '../shared/bookTouch.js';
import { parseClobTokenIds, getActiveMarkets } from '../mapping/gamma.js';
import {
  ClobPriceFeed,
  CLOB_BOOK_STATE_KEY,
  CLOB_TAPE_KEY,
  CLOB_TAPE_MAX_LEN,
  CLOB_TRADE_CHANNEL,
  CLOB_BOOK_DELTA_CHANNEL,
} from '../shared/clobWebSocket.js';
import type { Redis } from 'ioredis';

const LOCK_KEY = 'lock:clob:flow_monitor';
const LOCK_TTL_S = 90;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export interface BookSnapshot {
  bestBid: number | null;
  bestAsk: number | null;
  bidSize: number | null;
  askSize: number | null;
  ts: number;
}

/**
 * Pure helper: parse a CLOB `book` message into a snapshot. Exposed for tests.
 *
 * The touch is extracted with an order-agnostic scan (getBookTouchLevels):
 * WS book messages document bids-descending/asks-ascending (best-first), but
 * the REST endpoint ships the OPPOSITE ordering — trusting neither costs
 * nothing and survives either convention changing.
 */
export function parseBookMessage(msg: Record<string, unknown>): {
  tokenId: string;
  marketId: string;
  snapshot: BookSnapshot;
} | null {
  const tokenId = typeof msg.asset_id === 'string' ? msg.asset_id : null;
  if (!tokenId) return null;
  const marketIdRaw = typeof msg.market === 'string' ? msg.market : tokenId;

  const toLevels = (side: unknown): { price?: string | number; size?: string | number }[] =>
    Array.isArray(side) ? (side as { price?: string | number; size?: string | number }[]) : [];
  const { bestBid, bestAsk } = getBookTouchLevels({
    bids: toLevels(msg.bids),
    asks: toLevels(msg.asks),
  });

  return {
    tokenId,
    marketId: marketIdRaw,
    snapshot: {
      bestBid: bestBid?.price ?? null,
      bestAsk: bestAsk?.price ?? null,
      bidSize: bestBid ? (bestBid.size > 0 ? bestBid.size : null) : null,
      askSize: bestAsk ? (bestAsk.size > 0 ? bestAsk.size : null) : null,
      ts: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
    },
  };
}

export interface TradePrint {
  price: number;
  size: number;
  side: 'BUY' | 'SELL' | 'UNKNOWN';
  maker?: string | undefined;
  taker?: string | undefined;
  ts: number;
}

export function parseTradeMessage(msg: Record<string, unknown>): {
  tokenId: string;
  marketId: string;
  trade: TradePrint;
} | null {
  const tokenId = typeof msg.asset_id === 'string' ? msg.asset_id : null;
  if (!tokenId) return null;
  const price = typeof msg.price === 'string' ? parseFloat(msg.price)
    : typeof msg.price === 'number' ? msg.price : NaN;
  if (!Number.isFinite(price)) return null;
  const size = typeof msg.size === 'string' ? parseFloat(msg.size)
    : typeof msg.size === 'number' ? msg.size : NaN;
  const sideRaw = typeof msg.side === 'string' ? msg.side.toUpperCase() : '';
  const side: TradePrint['side'] = sideRaw === 'BUY' || sideRaw === 'SELL' ? sideRaw : 'UNKNOWN';
  return {
    tokenId,
    marketId: typeof msg.market === 'string' ? msg.market : tokenId,
    trade: {
      price,
      size: Number.isFinite(size) ? size : 0,
      side,
      maker: typeof msg.maker === 'string' ? msg.maker : undefined,
      taker: typeof msg.taker === 'string' ? msg.taker : undefined,
      ts: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
    },
  };
}

/** Apply a parsed book delta to Redis and publish on Pub/Sub. */
export async function persistBookDelta(redis: Redis, msg: Record<string, unknown>): Promise<void> {
  const parsed = parseBookMessage(msg);
  if (!parsed) return;
  const key = CLOB_BOOK_STATE_KEY(parsed.tokenId);
  const fields: Record<string, string> = { ts: String(parsed.snapshot.ts) };
  if (parsed.snapshot.bestBid !== null) fields.bestBid = String(parsed.snapshot.bestBid);
  if (parsed.snapshot.bestAsk !== null) fields.bestAsk = String(parsed.snapshot.bestAsk);
  if (parsed.snapshot.bidSize !== null) fields.bidSize = String(parsed.snapshot.bidSize);
  if (parsed.snapshot.askSize !== null) fields.askSize = String(parsed.snapshot.askSize);
  await redis.hset(key, fields);
  await redis.expire(key, 3600);
  await redis.publish(
    CLOB_BOOK_DELTA_CHANNEL,
    JSON.stringify({ tokenId: parsed.tokenId, marketId: parsed.marketId, ...parsed.snapshot }),
  );
}

/** Append a parsed trade print to Redis tape and publish on Pub/Sub. */
export async function persistTradePrint(redis: Redis, msg: Record<string, unknown>): Promise<void> {
  const parsed = parseTradeMessage(msg);
  if (!parsed) return;
  const key = CLOB_TAPE_KEY(parsed.marketId);
  const member = JSON.stringify({ ...parsed.trade, tokenId: parsed.tokenId });
  await redis.zadd(key, parsed.trade.ts, member);
  // Cap at CLOB_TAPE_MAX_LEN by removing the oldest entries.
  await redis.zremrangebyrank(key, 0, -CLOB_TAPE_MAX_LEN - 1);
  await redis.expire(key, 7 * 24 * 3600);
  await redis.publish(
    CLOB_TRADE_CHANNEL,
    JSON.stringify({ marketId: parsed.marketId, ...parsed.trade }),
  );
}

async function loadAllTokenIds(redis: Redis): Promise<{ tokenIds: string[]; markets: number }> {
  let markets = await getCachedMarkets(redis);
  if (markets.length === 0) {
    // Cache is empty — fall back to Gamma API directly so the CLOB feed stays
    // live even during a cron outage or after a Redis restart wipes the cache.
    logger.warn('[clob-flow] market cache empty — falling back to Gamma API');
    try {
      markets = await getActiveMarkets(2000);
    } catch (err: unknown) {
      logger.warn('[clob-flow] Gamma API fallback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const ids = new Set<string>();
  for (const m of markets) {
    if (!m.clobTokenIds) continue;
    try {
      for (const t of parseClobTokenIds(m.clobTokenIds)) ids.add(t);
    } catch {
      // ignore malformed
    }
  }
  return { tokenIds: [...ids], markets: markets.length };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.CLOB_FLOW_ENABLED) {
    logger.info('[clob-flow] CLOB_FLOW_ENABLED=false; exiting');
    return;
  }

  const redis = getRedis();
  const lockToken = await acquireLock(LOCK_KEY, LOCK_TTL_S);
  if (!lockToken) {
    logger.warn('[clob-flow] another instance holds the lock; exiting');
    process.exit(1);
  }

  const feed = new ClobPriceFeed(redis, { enabled: true });
  feed.onBook = (msg) => persistBookDelta(redis, msg);
  feed.onTrade = (msg) => persistTradePrint(redis, msg);

  let stopped = false;
  let refreshTimer: NodeJS.Timeout | null = null;
  let lockRefreshTimer: NodeJS.Timeout | null = null;

  const refreshSubscriptions = async () => {
    const { tokenIds, markets } = await loadAllTokenIds(redis);
    if (tokenIds.length === 0) {
      logger.warn('[clob-flow] no token IDs in watchlist cache');
      return;
    }
    feed.subscribeBook(tokenIds);
    logger.info('[clob-flow] subscribed', { tokenCount: tokenIds.length, marketCount: markets });
  };

  await refreshSubscriptions();
  refreshTimer = setInterval(() => {
    void refreshSubscriptions().catch((err: unknown) => {
      logger.warn('[clob-flow] refresh failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, REFRESH_INTERVAL_MS);

  lockRefreshTimer = setInterval(() => {
    void redis.expire(LOCK_KEY, LOCK_TTL_S).catch(() => {});
  }, (LOCK_TTL_S * 1000) / 3);

  const shutdown = async (signal: string) => {
    if (stopped) return;
    stopped = true;
    logger.info('[clob-flow] shutting down', { signal });
    if (refreshTimer) clearInterval(refreshTimer);
    if (lockRefreshTimer) clearInterval(lockRefreshTimer);
    feed.destroy();
    try {
      await releaseLock(LOCK_KEY, lockToken);
    } catch (err: unknown) {
      logger.warn('[clob-flow] lock release failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await closeRedis();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info('[clob-flow] worker running');
}

const isMain = process.argv[1]?.endsWith('flowMonitor.ts') || process.argv[1]?.endsWith('flowMonitor.js');
if (isMain) {
  main().catch((err: unknown) => {
    logger.error('[clob-flow] fatal', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
