/**
 * CLOB WebSocket price feed.
 *
 * Subscribes to real-time order book updates for watched markets and caches
 * the current best-bid per outcome in Redis:
 *   YES best-bid → `ws:price:yes:<marketId>`
 *   NO  best-bid → `ws:price:no:<marketId>`
 *   (`ws:price:<marketId>` legacy alias is kept in sync with YES.)
 * TTL = 30s.
 *
 * Source of truth is the `book` event (full bid/ask snapshots Polymarket
 * emits on subscribe and when the touch moves). `price_change` events report
 * per-level deltas at arbitrary price levels — NOT the best-bid — so they
 * are intentionally not cached. Caching from `price_change.price` was the
 * root of a 2026-04-24 silent-loss incident where a non-touch level update
 * at $0.30 overwrote a real $0.78 best-bid, triggering a stop-loss on
 * fiction and logging a +54% realized trade as a −40% loss.
 *
 * Usage:
 *   const feed = new ClobPriceFeed(redis);
 *   await feed.watch(marketId, clobTokenIds);   // subscribe
 *   feed.unwatch(marketId);                     // unsubscribe
 *   feed.destroy();                             // close connection
 */

import WebSocket from 'ws';
import type { Redis } from 'ioredis';
import { logger } from './logger.js';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PRICE_CACHE_TTL_S = 30;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// Cap reconnect attempts to prevent keeping cron processes alive indefinitely
// on a persistent WS failure. After RECONNECT_MAX_ATTEMPTS the feed gives up
// and falls back to Gamma REST on all subsequent price requests.
const RECONNECT_MAX_ATTEMPTS = 10;

export const WS_YES_PRICE_KEY = (marketId: string): string => `ws:price:yes:${marketId}`;
export const WS_NO_PRICE_KEY = (marketId: string): string => `ws:price:no:${marketId}`;
export const WS_PRICE_KEY = (marketId: string): string => `ws:price:${marketId}`; // legacy

// ── Phase 2: CLOB flow monitor keys ──
export const CLOB_BOOK_STATE_KEY = (tokenId: string): string => `clob:book_state:${tokenId}`;
export const CLOB_TAPE_KEY = (marketId: string): string => `clob:tape:${marketId}`;
export const CLOB_TAPE_MAX_LEN = 1000;
export const CLOB_TRADE_CHANNEL = 'clob:trade';
export const CLOB_BOOK_DELTA_CHANNEL = 'clob:book_delta';

export class ClobPriceFeed {
  private ws: WebSocket | null = null;
  private watchedMarkets = new Map<string, string[]>(); // marketId -> clobTokenIds
  private tokenToMarket = new Map<string, string>(); // tokenId -> marketId
  private reconnectAttempt = 0;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private enabled: boolean;
  /** Optional handler for `book` events (used by flowMonitor). */
  public onBook: ((msg: Record<string, unknown>) => void | Promise<void>) | null = null;
  /** Optional handler for trade prints (used by flowMonitor). */
  public onTrade: ((msg: Record<string, unknown>) => void | Promise<void>) | null = null;

  constructor(
    private readonly redis: Redis,
    opts?: { enabled?: boolean },
  ) {
    this.enabled = opts?.enabled ?? true;
  }

  /**
   * Subscribe to a list of token IDs without registering them as YES/NO
   * cache feeds. Used by `flowMonitor` which only cares about book/trade
   * dispatch via `onBook` / `onTrade` callbacks.
   */
  subscribeBook(tokenIds: string[]): void {
    if (!this.enabled || tokenIds.length === 0) return;
    for (const t of tokenIds) {
      if (!this.tokenToMarket.has(t)) {
        // Use the token id itself as a sentinel marketId so dispatch works
        // even when the caller isn't tracking individual market IDs.
        this.tokenToMarket.set(t, t);
      }
    }
    if (!this.ws) {
      this.connect();
    } else if (this.ws.readyState === WebSocket.OPEN) {
      this.subscribe(tokenIds);
    }
  }

  /** Subscribe to price updates for a market. Idempotent — skips if already watched. */
  async watch(marketId: string, clobTokenIds: string[]): Promise<void> {
    if (!this.enabled) return;

    // Skip if already watching this market with the same tokens
    if (this.watchedMarkets.has(marketId)) return;

    this.watchedMarkets.set(marketId, clobTokenIds);
    for (const tokenId of clobTokenIds) {
      this.tokenToMarket.set(tokenId, marketId);
    }
    if (!this.ws) {
      // No connection yet — start one. The 'open' handler will subscribe all watched markets.
      this.connect();
    } else if (this.ws.readyState === WebSocket.OPEN) {
      // Already connected — subscribe immediately.
      this.subscribe(clobTokenIds);
    }
    // If readyState is CONNECTING, do nothing: the 'open' handler will subscribe all
    // watched markets (including this one just added above) when the handshake completes.
    // Calling connect() again here would spawn a duplicate connection.
  }

  /** Remove a market from the watch list. */
  unwatch(marketId: string): void {
    const tokens = this.watchedMarkets.get(marketId);
    if (tokens) {
      for (const t of tokens) this.tokenToMarket.delete(t);
      this.watchedMarkets.delete(marketId);
    }
  }

  /** Get the cached YES price for a market. Returns null on cache miss. */
  async getCachedPrice(marketId: string): Promise<number | null> {
    const rawYes = await this.redis.get(WS_YES_PRICE_KEY(marketId));
    const raw = rawYes ?? (await this.redis.get(WS_PRICE_KEY(marketId)));
    if (raw === null) return null;
    const p = parseFloat(raw);
    return isFinite(p) ? p : null;
  }

  /**
   * Get the cached bid-side spread. Both cached values are best-bids (see
   * `cacheBookBestBid`), so for a binary market:
   *   YES bid + NO bid = 1.0 − spread
   * → spread = 1.0 − (YES bid + NO bid)
   *
   * Returns 0 when the book is tighter than our cache resolution; caller
   * decides whether 0 means "no slack to deduct" or "cache not yet warm".
   */
  async getCachedSpread(marketId: string): Promise<number | null> {
    const [yes, no] = await Promise.all([
      this.redis.get(WS_YES_PRICE_KEY(marketId)),
      this.redis.get(WS_NO_PRICE_KEY(marketId)),
    ]);
    if (yes === null || no === null) return null;
    const pYes = parseFloat(yes);
    const pNo = parseFloat(no);
    if (!isFinite(pYes) || !isFinite(pNo)) return null;
    return Math.max(0, 1.0 - (pYes + pNo));
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  // ── Internals (package-visible for testing via `as any`) ──────────────────

  private connect(): void {
    if (this.destroyed) return;

    this.ws = new WebSocket(WS_URL);

    let established = false;

    this.ws.on('open', () => {
      established = true;
      this.reconnectAttempt = 0;
      logger.info('[clob-ws] connected');
      const allTokens = [...this.tokenToMarket.keys()];
      if (allTokens.length > 0) this.subscribe(allTokens);
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data.toString()).catch((err: unknown) => {
        logger.warn('[clob-ws] handleMessage error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      if (!this.destroyed) {
        const phase = established ? 'post-open' : 'pre-open';
        const reasonStr = reason.length > 0 ? reason.toString() : '(no reason)';
        logger.warn('[clob-ws] connection closed — scheduling reconnect', {
          phase,
          code,
          reason: reasonStr,
          attempt: this.reconnectAttempt + 1,
        });
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err: Error) => {
      logger.warn('[clob-ws] error', { error: err.message });
    });
  }

  private subscribe(tokenIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ assets_ids: tokenIds, type: 'market' }));
  }

  /** Exported for testing via cast. */
  async handleMessage(raw: string): Promise<void> {
    let messages: unknown[];
    try {
      const parsed = JSON.parse(raw) as unknown;
      messages = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];
    } catch {
      return; // ignore malformed
    }

    for (const msg of messages) {
      if (typeof msg !== 'object' || msg === null) continue;
      const m = msg as Record<string, unknown>;

      // `book` events carry authoritative bid/ask levels. Cache best-bid per
      // side (YES/NO) for the `watch()`-registered markets; flowMonitor-style
      // `subscribeBook()` callers (tokenToMarket self-mapped) are skipped so
      // we don't cache under a tokenId masquerading as a marketId.
      if (m.event_type === 'book' || m.type === 'book') {
        await this.cacheBookBestBid(m);
        if (this.onBook) {
          try { await this.onBook(m); } catch (err) {
            logger.warn('[clob-ws] onBook error', { error: err instanceof Error ? err.message : String(err) });
          }
        }
        continue;
      }
      if (
        m.event_type === 'last_trade_price' ||
        m.event_type === 'trade' ||
        m.type === 'last_trade_price'
      ) {
        if (this.onTrade) {
          try { await this.onTrade(m); } catch (err) {
            logger.warn('[clob-ws] onTrade error', { error: err instanceof Error ? err.message : String(err) });
          }
        }
        continue;
      }

      // `price_change` is per-level deltas, not a best-bid signal. Silently
      // drop — letting the book-event cache age out via its 30s TTL is safer
      // than overwriting a real best-bid with a random level change.
      // (See module header for the 2026-04-24 incident that motivated this.)
      if (m.type === 'price_change' || m.event_type === 'price_change') {
        continue;
      }

      // Unknown event type — ignore. Explicit continue so future event types
      // don't silently fall into the cache by accident.
      continue;
    }
  }

  /**
   * Cache the best-bid from a CLOB `book` event. Bids are sorted descending
   * in Polymarket's protocol, so `bids[0]` is the authoritative best-bid for
   * the token. We cache under the YES or NO key depending on which side of
   * the watched market the token belongs to.
   */
  private async cacheBookBestBid(m: Record<string, unknown>): Promise<void> {
    const tokenId = typeof m.asset_id === 'string' ? m.asset_id : null;
    if (!tokenId) return;
    const marketId = this.tokenToMarket.get(tokenId);
    if (!marketId) return;
    const tokens = this.watchedMarkets.get(marketId);
    // subscribeBook() self-maps tokenId → tokenId (no watchedMarkets entry).
    // Only cache when a caller has explicitly registered YES/NO token order.
    if (!tokens) return;

    const bids = Array.isArray(m.bids) ? m.bids : null;
    if (!bids || bids.length === 0) return;
    const firstBid = bids[0];
    if (!firstBid || typeof firstBid !== 'object') return;
    const priceField = (firstBid as Record<string, unknown>).price;
    const rawPrice =
      typeof priceField === 'string' ? priceField
      : typeof priceField === 'number' ? String(priceField)
      : null;
    if (rawPrice === null) return;
    const price = parseFloat(rawPrice);
    if (!isFinite(price)) return;
    const formatted = price.toFixed(6);

    if (tokens[0] === tokenId) {
      await Promise.all([
        this.redis.setex(WS_YES_PRICE_KEY(marketId), PRICE_CACHE_TTL_S, formatted),
        this.redis.setex(WS_PRICE_KEY(marketId), PRICE_CACHE_TTL_S, formatted),
      ]);
    } else if (tokens[1] === tokenId) {
      await this.redis.setex(WS_NO_PRICE_KEY(marketId), PRICE_CACHE_TTL_S, formatted);
    }

    logger.debug('[clob-ws] best-bid cached', { marketId, tokenId, bestBid: price });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      // Persistent failure — give up and destroy the feed so the process can exit cleanly.
      // Price reads will fall back to Gamma REST via resolveYesPrice().
      logger.error('[clob-ws] max reconnect attempts reached — giving up', {
        attempts: this.reconnectAttempt,
      });
      this.destroy();
      return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    logger.info('[clob-ws] reconnecting', { attempt: this.reconnectAttempt, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }
}
