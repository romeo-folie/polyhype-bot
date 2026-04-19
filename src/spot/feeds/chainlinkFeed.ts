import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { Redis } from 'ioredis';
import { logger } from '../../shared/logger.js';

/**
 * Chainlink RTDS (Polymarket) WebSocket price feed.
 *
 * Subscribes to `crypto_prices_chainlink` / `update` on
 * `wss://ws-live-data.polymarket.com` and maintains an in-process per-symbol
 * ringbuffer of recent ticks. The oracle-lag scanner uses `getMoveSince()` to
 * detect recent Chainlink price moves that Polymarket's BTC Up/Down markets
 * have not yet reacted to.
 *
 * Optional Redis pub/sub: when constructed with a `redis` client, every tick
 * is also republished as `oracle:price_moved`, with the latest value cached
 * at `oracle:last:<symbol>` (EX 120) and a windowed history at
 * `oracle:prices:<symbol>` (ZSET capped at 600 entries). This mirrors the
 * `spot:price_moved` pattern from BinanceFeed so consumers in other workers
 * can act on Chainlink ticks without holding their own WS subscription.
 */

const CHAINLINK_WS_URL = 'wss://ws-live-data.polymarket.com';
const CHAINLINK_TOPIC = 'crypto_prices_chainlink';
const CHAINLINK_TYPE = 'update';

/** Default symbols we subscribe to. Scanner picks which to consume. */
const DEFAULT_SYMBOLS = [
  'btc/usd',
  'eth/usd',
  'sol/usd',
  'xrp/usd',
  'doge/usd',
  'bnb/usd',
  'hype/usd',
];

/** One normalized Chainlink tick. */
export interface ChainlinkTick {
  /** e.g. 'btc/usd' (lowercased) */
  symbol: string;
  /** float price from payload.value */
  value: number;
  /** oracle publish timestamp (ms) from payload.timestamp */
  oracleTs: number;
  /** local wall-clock time when we received the frame (ms) */
  receivedAt: number;
}

/** Result of getMoveSince(). */
export interface ChainlinkMove {
  oldPrice: number;
  newPrice: number;
  /** (newPrice - oldPrice) / oldPrice — signed fractional move (0.01 = 1%) */
  pctMove: number;
  /** how many buffered ticks fell inside the window (≥2) */
  ticks: number;
}

interface RawChainlinkMessage {
  topic?: unknown;
  type?: unknown;
  payload?: {
    symbol?: unknown;
    value?: unknown;
    timestamp?: unknown;
  };
}

/**
 * Pure parser — takes a raw WS frame and returns a normalized tick or null.
 *
 * Exposed so task 006's unit tests can hit the parse boundary without
 * spinning up a WebSocket. Filters on topic + type, so messages from the
 * sibling `crypto_prices` (Binance) topic are dropped.
 */
export function parseChainlinkMessage(raw: string | Buffer): ChainlinkTick | null {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  let msg: RawChainlinkMessage;
  try {
    msg = JSON.parse(text) as RawChainlinkMessage;
  } catch {
    return null;
  }
  if (msg.topic !== CHAINLINK_TOPIC || msg.type !== CHAINLINK_TYPE) return null;
  const payload = msg.payload;
  if (!payload || typeof payload !== 'object') return null;

  const symbolRaw = payload.symbol;
  const valueRaw = payload.value;
  const tsRaw = payload.timestamp;

  if (typeof symbolRaw !== 'string' || symbolRaw.length === 0) return null;
  if (typeof valueRaw !== 'number' || !Number.isFinite(valueRaw) || valueRaw <= 0) return null;
  if (typeof tsRaw !== 'number' || !Number.isFinite(tsRaw) || tsRaw <= 0) return null;

  return {
    symbol: symbolRaw.toLowerCase(),
    value: valueRaw,
    oracleTs: tsRaw,
    receivedAt: Date.now(),
  };
}

/**
 * In-memory ringbuffer of recent ticks for a single symbol.
 * Backed by a plain array used as a circular buffer — O(1) push, O(n) scan.
 * 600 slots ≈ 10 minutes of headroom at ~1 tick/sec.
 */
class TickRingBuffer {
  private readonly buf: (ChainlinkTick | null)[];
  private readonly capacity: number;
  private writeIdx = 0;
  private size = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buf = new Array<ChainlinkTick | null>(capacity).fill(null);
  }

  push(tick: ChainlinkTick): void {
    this.buf[this.writeIdx] = tick;
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  /** Newest tick in the buffer, or null if empty. */
  latest(): ChainlinkTick | null {
    if (this.size === 0) return null;
    const idx = (this.writeIdx - 1 + this.capacity) % this.capacity;
    return this.buf[idx] ?? null;
  }

  /**
   * Return ticks whose `receivedAt >= cutoff`, in chronological order.
   * Used by getMoveSince to bound the lookback.
   */
  ticksSince(cutoff: number): ChainlinkTick[] {
    if (this.size === 0) return [];
    const out: ChainlinkTick[] = [];
    // Oldest-first traversal
    const startIdx =
      this.size < this.capacity ? 0 : this.writeIdx;
    for (let i = 0; i < this.size; i++) {
      const idx = (startIdx + i) % this.capacity;
      const t = this.buf[idx];
      if (t && t.receivedAt >= cutoff) out.push(t);
    }
    return out;
  }
}

export interface ChainlinkFeedOptions {
  symbols?: string[];
  /** Ring buffer capacity per symbol. Must be ≥ 300. */
  capacity?: number;
  /**
   * Optional Redis client for pub/sub republish. When omitted, the feed runs
   * in pure in-process mode (oracle-lag scanner only). When provided, every
   * tick is also fan-out to `oracle:price_moved`, `oracle:last:<symbol>`,
   * and `oracle:prices:<symbol>`.
   */
  redis?: Redis;
}

/** Redis key for the most-recent Chainlink price per symbol (EX 120). */
function oracleLastKey(symbol: string): string {
  return `oracle:last:${symbol}`;
}

/** Redis ZSET key for the windowed Chainlink price history per symbol. */
function oraclePricesKey(symbol: string): string {
  return `oracle:prices:${symbol}`;
}

/** Pub/sub channel name. Mirrors `spot:price_moved` from BinanceFeed. */
const ORACLE_PRICE_MOVED_CHANNEL = 'oracle:price_moved';

/** Cap on the per-symbol oracle:prices:* ZSET. Matches in-memory ringbuffer. */
const ORACLE_PRICES_ZSET_CAP = 600;

/** TTL on oracle:last:* SET — staleness signal for downstream consumers. */
const ORACLE_LAST_TTL_SEC = 120;

/**
 * Long-lived Chainlink WS subscriber with auto-reconnect.
 *
 * Lifecycle:
 *   const feed = new ChainlinkFeed();
 *   feed.start();           // on worker boot
 *   feed.getMoveSince(...); // from the scanner tick
 *   feed.stop();            // on SIGTERM, before closeRedis()
 */
export class ChainlinkFeed {
  private ws: WebSocket | null = null;
  private readonly symbols: string[];
  private readonly buffers = new Map<string, TickRingBuffer>();
  private readonly capacity: number;
  private readonly redis: Redis | null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectCount = 0;
  private stopped = false;
  private readonly MAX_RECONNECTS = 5;
  private readonly MIN_BACKOFF_MS = 1000;
  private readonly MAX_BACKOFF_MS = 30000;

  constructor(opts: ChainlinkFeedOptions = {}) {
    this.symbols = (opts.symbols ?? DEFAULT_SYMBOLS).map((s) => s.toLowerCase());
    this.capacity = Math.max(300, opts.capacity ?? 600);
    this.redis = opts.redis ?? null;
  }

  /** Open the WS connection and subscribe. Safe to call after stop(). */
  public start(): void {
    this.stopped = false;
    this.openSocket();
  }

  private openSocket(): void {
    if (this.stopped) return;
    logger.info('chainlink_feed_connecting', {
      url: CHAINLINK_WS_URL,
      symbols: this.symbols,
      capacity: this.capacity,
    });

    const ws = new WebSocket(CHAINLINK_WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectCount = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      const frame = JSON.stringify({
        action: 'subscribe',
        subscriptions: [{ topic: CHAINLINK_TOPIC, type: CHAINLINK_TYPE }],
      });
      try {
        ws.send(frame);
      } catch (err) {
        logger.error('chainlink_feed_subscribe_error', { error: String(err) });
      }
      logger.info('chainlink_feed_open', { url: CHAINLINK_WS_URL });
    });

    ws.on('message', (data: RawData) => {
      const tick = parseChainlinkMessage(data as Buffer | string);
      if (!tick) {
        // parseChainlinkMessage filters on topic/type, so control frames,
        // heartbeats, and sibling `crypto_prices` (Binance) topic messages
        // all return null here — same as genuine JSON parse failures. We
        // silently drop both: an attempt to distinguish them turned into
        // noise on control frames vs near-zero real parse errors, so the
        // log marker was dropped. `chainlink_feed_error` + reconnect covers
        // the failure modes we actually care about.
        return;
      }
      if (!this.symbols.includes(tick.symbol)) return;
      let rb = this.buffers.get(tick.symbol);
      if (!rb) {
        rb = new TickRingBuffer(this.capacity);
        this.buffers.set(tick.symbol, rb);
      }
      rb.push(tick);
      // Fan out to Redis when configured. Fire-and-forget — pub/sub failure
      // must never break the in-process oracle-lag scanner that depends on
      // the ringbuffer we just updated.
      if (this.redis) {
        void this.publishTick(tick).catch((err) => {
          logger.warn('chainlink_feed_publish_error', {
            symbol: tick.symbol,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    });

    ws.on('error', (err: Error) => {
      logger.error('chainlink_feed_error', { error: err.message });
    });

    ws.on('close', (code: number, reason: Buffer) => {
      logger.warn('chainlink_feed_close', {
        code,
        reason: reason.toString('utf8'),
      });
      this.ws = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    // Cap reconnectCount at MAX_RECONNECTS so backoff/log attempt stop
    // growing once we reach the ceiling. The worker supervises the process,
    // so we keep retrying indefinitely at the cap — we just log
    // `chainlink_feed_fatal` once on the transition to the ceiling.
    if (this.reconnectCount < this.MAX_RECONNECTS) {
      this.reconnectCount++;
      if (this.reconnectCount === this.MAX_RECONNECTS) {
        logger.error('chainlink_feed_fatal', {
          attempts: this.reconnectCount,
          note: 'max reconnects reached, continuing at cap',
        });
      }
    }
    const expBackoff =
      this.MIN_BACKOFF_MS * Math.pow(2, Math.min(this.reconnectCount - 1, 10));
    const delay = Math.min(expBackoff, this.MAX_BACKOFF_MS);
    logger.warn('chainlink_feed_reconnect', {
      attempt: this.reconnectCount,
      delayMs: delay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  /** Close the WS cleanly and cancel any pending reconnect. */
  public stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* ignore — best-effort shutdown */
      }
      try {
        this.ws.terminate();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  /**
   * Publish a tick to Redis: SET the latest, ZADD to the windowed history,
   * and PUBLISH on the broadcast channel. All three ops go in one pipeline
   * so a partial network failure doesn't leave a torn read.
   *
   * The ZSET member format `${oracleTs}:${value}` keeps each tick distinct
   * even when the oracle re-publishes the same price (member uniqueness is
   * required for ZADD to not overwrite). Score is `oracleTs` so consumers
   * can ZRANGEBYSCORE for time-windowed reads.
   */
  private async publishTick(tick: ChainlinkTick): Promise<void> {
    const redis = this.redis;
    if (!redis) return;
    const lastKey = oracleLastKey(tick.symbol);
    const pricesKey = oraclePricesKey(tick.symbol);
    const member = `${tick.oracleTs}:${tick.value}`;
    const payload = JSON.stringify({
      symbol: tick.symbol,
      value: tick.value,
      oracleTs: tick.oracleTs,
      receivedAt: tick.receivedAt,
    });
    const pipe = redis.pipeline();
    pipe.set(lastKey, String(tick.value), 'EX', ORACLE_LAST_TTL_SEC);
    pipe.zadd(pricesKey, tick.oracleTs, member);
    pipe.zremrangebyrank(pricesKey, 0, -(ORACLE_PRICES_ZSET_CAP + 1));
    pipe.publish(ORACLE_PRICE_MOVED_CHANNEL, payload);
    await pipe.exec();
  }

  /** Latest buffered tick for a symbol, or null if none yet. */
  public getLatest(symbol: string): ChainlinkTick | null {
    const rb = this.buffers.get(symbol.toLowerCase());
    return rb ? rb.latest() : null;
  }

  /**
   * Return the price move between the oldest tick within the last
   * `windowMs` of wall-clock time and the newest buffered tick.
   *
   * Returns null if fewer than 2 qualifying ticks exist.
   */
  public getMoveSince(symbol: string, windowMs: number): ChainlinkMove | null {
    if (!Number.isFinite(windowMs) || windowMs <= 0) return null;
    const rb = this.buffers.get(symbol.toLowerCase());
    if (!rb) return null;
    const cutoff = Date.now() - windowMs;
    const ticks = rb.ticksSince(cutoff);
    if (ticks.length < 2) return null;
    const oldTick = ticks[0];
    const newTick = ticks[ticks.length - 1];
    if (!oldTick || !newTick) return null;
    const oldPrice = oldTick.value;
    const newPrice = newTick.value;
    if (oldPrice <= 0) return null;
    return {
      oldPrice,
      newPrice,
      pctMove: (newPrice - oldPrice) / oldPrice,
      ticks: ticks.length,
    };
  }
}
