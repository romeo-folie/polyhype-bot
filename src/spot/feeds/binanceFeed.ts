import { WebSocket } from 'ws';
import { logger } from '../../shared/logger.js';
import { getRedis } from '../../shared/redis.js';

/**
 * Binance WebSocket Price Feed.
 * 
 * Subscribes to ticker streams and updates Redis "hot price" cache.
 * Emits 'spot:price_moved' event via Redis Pub/Sub to trigger arb worker.
 */
export class BinanceFeed {
  private ws: WebSocket | null = null;
  private tickerCount: Record<string, number> = {};
  private symbols: string[];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectCount = 0;

  constructor(symbols: string[] = ['btcusdt', 'ethusdt', 'solusdt', 'xrpusdt', 'bnbusdt', 'taousdt', 'dogeusdt', 'adausdt', 'avaxusdt', 'linkusdt', 'suiusdt']) {
    // Note: shibusdt/pepeusdt removed from defaults — SHIB/PEPE have no Hyperliquid perp entries
    // in HL_SYMBOL_MAP, so spot moves would never trigger valid arb cycles. Add back if HL lists them.
    this.symbols = symbols.map(s => s.toLowerCase());
  }

  public start(): void {
    const streamNames = this.symbols.map(s => `${s}@ticker`).join('/');
    const url = `wss://stream.binance.com:9443/ws/${streamNames}`;

    logger.info('[binance] connecting to WebSocket', { symbols: this.symbols });

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info('[binance] connected');
      this.reconnectCount = 0; // Reset on success
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    });

    this.ws.on('message', (data: string) => {
      try {
        const msg = JSON.parse(data.toString()) as { s?: string; c?: string; E?: number };
        // Binance @ticker format:
        // { "s":"BTCUSDT", "c":"65000.50", "E": 123456789 }
        if (msg.s && msg.c) {
          void this.handleTicker(msg as { s: string; c: string; E?: number });
        }
      } catch (err) {
        logger.error('[binance] message parse error', { error: String(err) });
      }
    });

    this.ws.on('error', (err: Error) => {
      logger.error('[binance] connection error', { error: err.message });
    });

    this.ws.on('close', () => {
      logger.warn('[binance] connection closed, reconnecting in 5s...');
      this.reconnect();
    });
  }

  private async handleTicker(msg: { s: string; c: string; E?: number }): Promise<void> {
    try {
      const symbol = msg.s.toLowerCase();
      const price = parseFloat(msg.c);
      const timestamp = msg.E ?? Date.now();

      const redis = getRedis();
      const lastKey = `spot:last:${symbol}`;
      const pricesKey = `spot:prices:${symbol}`;

      // Read the CURRENT value before overwriting — this becomes the previous price
      // for the arb worker's reference price comparison.
      let previousPrice: number | null = null;
      try {
        const existing = await redis.get(lastKey);
        if (existing) {
          const parsed = JSON.parse(existing) as { price?: number };
          if (typeof parsed.price === 'number' && parsed.price > 0) {
            previousPrice = parsed.price;
          }
        }
      } catch { /* first tick — no previous price yet */ }

      const pipeline = redis.pipeline();
      // Update latest
      pipeline.set(lastKey, JSON.stringify({ price, timestamp, source: 'binance' }));
      // Add to history (score=timestamp)
      pipeline.zadd(pricesKey, timestamp, `${String(timestamp)}:${String(price)}`);
      // Prune history (keep 60m)
      pipeline.zremrangebyscore(pricesKey, '-inf', timestamp - 60 * 60 * 1000);
      // Expire
      pipeline.expire(lastKey, 7200);
      pipeline.expire(pricesKey, 7200);

      // Publish event for Arb Worker — include previousPrice so it doesn't need to re-read
      pipeline.publish('spot:price_moved', JSON.stringify({ symbol, price, timestamp, previousPrice }));

      const pipelineResults = await pipeline.exec();
      // Check for per-command errors in the pipeline result.
      if (pipelineResults) {
        for (const [err] of pipelineResults) {
          if (err) {
            logger.warn('[binance] pipeline command error', { symbol, error: String(err) });
            break; // Log once per tick — avoid log flooding on persistent issues
          }
        }
      }
      
      // Pulse: log to info once every 20 updates per symbol to show "life"
      this.tickerCount[symbol] = (this.tickerCount[symbol] ?? 0) + 1;
      if ((this.tickerCount[symbol] ?? 0) % 20 === 0) {
        logger.info(`[binance] ${symbol.toUpperCase()} tick: $${String(price)}`);
      }
    } catch (err) {
      logger.error('[binance] handleTicker error', { error: String(err) });
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
    logger.warn(`[binance] reconnecting in ${String(delay / 1000)}s (attempt ${String(this.reconnectCount)}/${this.MAX_RECONNECTS})...`);
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
