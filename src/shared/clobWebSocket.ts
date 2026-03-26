/**
 * CLOB WebSocket price feed.
 *
 * Subscribes to real-time order book price updates for watched markets.
 * Caches latest YES ask price in Redis: key = `ws:price:<marketId>`, TTL = 30s.
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

export const WS_PRICE_KEY = (marketId: string): string => `ws:price:${marketId}`;

export class ClobPriceFeed {
  private ws: WebSocket | null = null;
  private watchedMarkets = new Map<string, string[]>(); // marketId -> clobTokenIds
  private tokenToMarket = new Map<string, string>(); // tokenId -> marketId
  private reconnectAttempt = 0;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private enabled: boolean;

  constructor(
    private readonly redis: Redis,
    opts?: { enabled?: boolean },
  ) {
    this.enabled = opts?.enabled ?? true;
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
    const raw = await this.redis.get(WS_PRICE_KEY(marketId));
    if (raw === null) return null;
    const p = parseFloat(raw);
    return isFinite(p) ? p : null;
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

      if (
        m['type'] === 'price_change' &&
        typeof m['asset_id'] === 'string' &&
        typeof m['price'] === 'string'
      ) {
        const tokenId = m['asset_id'];
        const price = parseFloat(m['price']);
        if (!isFinite(price)) continue;

        const marketId = this.tokenToMarket.get(tokenId);
        if (!marketId) continue;

        // Only cache YES token price (index 0 in clobTokenIds)
        const tokens = this.watchedMarkets.get(marketId);
        if (!tokens || tokens[0] !== tokenId) continue;

        await this.redis.setex(WS_PRICE_KEY(marketId), PRICE_CACHE_TTL_S, price.toFixed(6));
        logger.debug('[clob-ws] price cached', { marketId, price });
      }
    }
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
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
