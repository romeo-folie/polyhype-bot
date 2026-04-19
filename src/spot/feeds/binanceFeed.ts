import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { logger } from '../../shared/logger.js';
import { loadConfig } from '../../shared/config.js';
import { getRedis } from '../../shared/redis.js';

/**
 * Binance WebSocket Price Feed.
 *
 * Subscribes to @kline_<tf> streams (defaults to 1m + 5m) and writes:
 *   - spot:last:<symbol>           — latest close price (back-compat for poller/correlator)
 *   - spot:prices:<symbol>         — sorted set of <ts>:<price> ticks (back-compat fallback)
 *   - spot:klines:<symbol>:<tf>    — sorted set of OHLCV JSON (real volume from Binance)
 *
 * Emits 'spot:price_moved' Redis Pub/Sub event on each update.
 */

interface KlinePayload {
  t: number; // open time ms
  T: number; // close time ms
  s: string; // symbol
  i: string; // interval (e.g., '1m')
  o: string; // open
  c: string; // close
  h: string; // high
  l: string; // low
  v: string; // base volume
  q: string; // quote volume
  n: number; // trade count
  x: boolean; // is closed
}

interface KlineMessage {
  stream?: string;
  data?: { e?: string; E?: number; s?: string; k?: KlinePayload };
}

/** Stored kline shape (mirrors OHLCVCandle + extras) */
export interface StoredKline {
  t: number; // openTime ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // base volume
  q: number; // quote volume (USD)
  n: number; // trade count
  closed: boolean;
}

const TF_RETENTION_KEYS = {
  '1m':  'KLINE_RETENTION_1M'  as const,
  '5m':  'KLINE_RETENTION_5M'  as const,
  '15m': 'KLINE_RETENTION_15M' as const,
  '1h':  'KLINE_RETENTION_1H'  as const,
  '4h':  'KLINE_RETENTION_4H'  as const,
};

export class BinanceFeed {
  private ws: WebSocket | null = null;
  private tickerCount: Record<string, number> = {};
  private symbols: string[];
  private timeframes: string[];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectCount = 0;
  /** Optional callback fired on every kline received — used by manager watchdog. */
  public onKline: (() => void) | null = null;

  constructor(
    symbols: string[] = [
      'btcusdt',
      'ethusdt',
      'solusdt',
      'xrpusdt',
      'dogeusdt',
      'adausdt',
      'linkusdt',
      'dotusdt',
      'bnbusdt',
      'avaxusdt',
      'suiusdt',
      'taousdt',
    ],
  ) {
    // Note: shibusdt/pepeusdt removed from defaults — SHIB/PEPE have no Hyperliquid perp entries
    // in HL_SYMBOL_MAP, so spot moves would never trigger valid arb cycles. Add back if HL lists them.
    // Default list mirrors the prod BINANCE_SYMBOLS .env value to keep dev/test
    // and prod in sync (.env override always wins via feeds/manager.ts).
    this.symbols = symbols.map((s) => s.toLowerCase());
    const cfg = loadConfig();
    this.timeframes = cfg.BINANCE_KLINE_TIMEFRAMES.split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (!this.timeframes.includes('1m')) this.timeframes.unshift('1m');
  }

  /**
   * Pre-seed kline history from Binance REST API before the WebSocket starts.
   *
   * Without this, indicators like MACD (needs 26 bars) and RSI (needs 14 bars)
   * are null for the first 26+ minutes after every deploy, killing the news-
   * sentiment futures path and making confluence scores silently 0.
   *
   * Fetches the last `retention` closed 1m and 5m candles for every subscribed
   * symbol via the public klines endpoint (no auth required, 82 requests total).
   * Writes into the same Redis sorted-set format as handleKline so buildCandles()
   * sees a continuous history immediately on startup.
   */
  public async seedKlineHistory(): Promise<void> {
    const cfg = loadConfig();
    const redis = getRedis();
    const BINANCE_REST = 'https://api.binance.com/api/v3/klines';

    logger.info('[binance] seeding kline history from REST API', {
      symbols: this.symbols.length,
      timeframes: this.timeframes,
    });

    let seeded = 0;
    let failed = 0;

    for (const sym of this.symbols) {
      for (const tf of this.timeframes) {
        try {
          const retentionKey = TF_RETENTION_KEYS[tf as keyof typeof TF_RETENTION_KEYS];
          const retention = retentionKey ? cfg[retentionKey] : 240;
          const url = `${BINANCE_REST}?symbol=${sym.toUpperCase()}&interval=${tf}&limit=${retention.toString()}`;

          const res = await fetch(url);
          if (!res.ok) {
            logger.warn('[binance] kline seed HTTP error', { symbol: sym, tf, status: res.status });
            failed++;
            continue;
          }

          // Binance klines response: array of arrays
          // [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, ...]
          const rows = await res.json() as [number, string, string, string, string, string, number, string, number, ...unknown[]][];

          const klineKey = `spot:klines:${sym}:${tf}`;
          const pipeline = redis.pipeline();

          for (const row of rows) {
            const [openTime, open, high, low, close, volume, , quoteVolume, tradeCount] = row;
            const stored: StoredKline = {
              t: openTime,
              o: parseFloat(open),
              h: parseFloat(high),
              l: parseFloat(low),
              c: parseFloat(close),
              v: parseFloat(volume),
              q: parseFloat(quoteVolume),
              n: tradeCount,
              closed: true,
            };
            // Upsert each candle — same approach as handleKline
            pipeline.zremrangebyscore(klineKey, openTime, openTime);
            pipeline.zadd(klineKey, openTime, JSON.stringify(stored));
          }

          // Trim and set TTL matching the live feed
          pipeline.zremrangebyrank(klineKey, 0, -1 - retention);
          pipeline.expire(klineKey, 86400);
          await pipeline.exec();
          seeded++;
        } catch (err) {
          logger.warn('[binance] kline seed error', { symbol: sym, tf, error: String(err) });
          failed++;
        }
      }
    }

    logger.info('[binance] kline seed complete', { seeded, failed });
  }

  public start(): void {
    // Combined-stream URL: /stream?streams=btcusdt@kline_1m/btcusdt@kline_5m/...
    const streams: string[] = [];
    for (const sym of this.symbols) {
      for (const tf of this.timeframes) {
        streams.push(`${sym}@kline_${tf}`);
      }
    }
    const url = `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;

    logger.info('[binance] connecting to kline WebSocket', {
      symbols: this.symbols,
      timeframes: this.timeframes,
    });

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info('[binance] connected');
      this.reconnectCount = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    });

    this.ws.on('message', (data: RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as KlineMessage;
        const k = msg.data?.k;
        if (k && typeof k.s === 'string' && typeof k.c === 'string') {
          this.onKline?.();
          void this.handleKline(k);
        }
      } catch (err) {
        logger.error('[binance] message parse error', { error: String(err) });
      }
    });

    this.ws.on('error', (err: Error) => {
      logger.error('[binance] connection error', { error: err.message });
    });

    this.ws.on('close', () => {
      logger.warn('[binance] connection closed, scheduling reconnect...');
      this.reconnect();
    });
  }

  private async handleKline(k: KlinePayload): Promise<void> {
    try {
      const symbol = k.s.toLowerCase();
      const tf = k.i;
      const close = parseFloat(k.c);
      const openTime = k.t;
      const eventTime = k.T || Date.now();
      if (!Number.isFinite(close) || close <= 0) return;

      const redis = getRedis();
      const cfg = loadConfig();
      const lastKey = `spot:last:${symbol}`;
      const pricesKey = `spot:prices:${symbol}`;
      const klineKey = `spot:klines:${symbol}:${tf}`;

      // Read previous close once (for the price_moved event payload)
      let previousPrice: number | null = null;
      if (tf === '1m') {
        try {
          const existing = await redis.get(lastKey);
          if (existing) {
            const parsed = JSON.parse(existing) as { price?: number };
            if (typeof parsed.price === 'number' && parsed.price > 0) {
              previousPrice = parsed.price;
            }
          }
        } catch {
          /* first tick — non-fatal */
        }
      }

      const stored: StoredKline = {
        t: openTime,
        o: parseFloat(k.o),
        h: parseFloat(k.h),
        l: parseFloat(k.l),
        c: close,
        v: parseFloat(k.v),
        q: parseFloat(k.q),
        n: typeof k.n === 'number' ? k.n : 0,
        closed: !!k.x,
      };

      const retentionKey = TF_RETENTION_KEYS[tf as keyof typeof TF_RETENTION_KEYS];
      const retention = retentionKey ? cfg[retentionKey] : 240;

      const pipeline = redis.pipeline();

      // Upsert in-progress bar: remove any existing entry at this openTime, then add new.
      pipeline.zremrangebyscore(klineKey, openTime, openTime);
      pipeline.zadd(klineKey, openTime, JSON.stringify(stored));
      // Trim oldest beyond retention.
      pipeline.zremrangebyrank(klineKey, 0, -1 - retention);
      pipeline.expire(klineKey, 86400);

      // Back-compat: keep spot:last and spot:prices in sync from the 1m stream so
      // poller/correlator/threshold-detector legacy paths keep working unchanged.
      if (tf === '1m') {
        pipeline.set(
          lastKey,
          JSON.stringify({ price: close, timestamp: eventTime, source: 'binance' }),
        );
        pipeline.zadd(pricesKey, eventTime, `${String(eventTime)}:${String(close)}`);
        pipeline.zremrangebyscore(pricesKey, '-inf', eventTime - 60 * 60 * 1000);
        pipeline.expire(lastKey, 7200);
        pipeline.expire(pricesKey, 7200);
        pipeline.publish(
          'spot:price_moved',
          JSON.stringify({ symbol, price: close, timestamp: eventTime, previousPrice }),
        );
      }

      const results = await pipeline.exec();
      if (results) {
        for (const [err] of results) {
          if (err) {
            logger.warn('[binance] pipeline command error', { symbol, tf, error: String(err) });
            break;
          }
        }
      }

      if (tf === '1m') {
        this.tickerCount[symbol] = (this.tickerCount[symbol] ?? 0) + 1;
        if ((this.tickerCount[symbol] ?? 0) % 20 === 0) {
          logger.info(`[binance] ${symbol.toUpperCase()} kline: $${String(close)} (vol=${stored.v.toFixed(4)})`);
        }
      }
    } catch (err) {
      logger.error('[binance] handleKline error', { error: String(err) });
    }
  }

  private readonly MAX_RECONNECTS = 10;

  private reconnect(): void {
    if (this.reconnectTimer) return;
    if (this.reconnectCount >= this.MAX_RECONNECTS) {
      logger.error(`[binance] max reconnect attempts (${this.MAX_RECONNECTS}) reached — giving up`);
      return;
    }
    this.reconnectCount++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectCount), 30000);
    logger.warn(
      `[binance] reconnecting in ${String(delay / 1000)}s (attempt ${String(this.reconnectCount)}/${this.MAX_RECONNECTS})...`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, delay);
  }

  public stop(): void {
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
