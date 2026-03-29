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
  private symbols: string[];
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(symbols: string[] = ['btcusdt', 'ethusdt', 'solusdt']) {
    this.symbols = symbols.map(s => s.toLowerCase());
  }

  public start(): void {
    const streamNames = this.symbols.map(s => `${s}@ticker`).join('/');
    const url = `wss://stream.binance.com:9443/ws/${streamNames}`;

    logger.info('[binance] connecting to WebSocket', { symbols: this.symbols });

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info('[binance] connected');
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    });

    this.ws.on('message', (data: string) => {
      try {
        const msg = JSON.parse(data);
        // Binance @ticker format:
        // { "s":"BTCUSDT", "c":"65000.50", "E": 123456789 }
        if (msg.s && msg.c) {
          void this.handleTicker(msg);
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

  private async handleTicker(msg: any): Promise<void> {
    const symbol = msg.s.toLowerCase();
    const price = parseFloat(msg.c);
    const timestamp = msg.E || Date.now();

    const redis = getRedis();
    const lastKey = `spot:last:${symbol}`;
    const pricesKey = `spot:prices:${symbol}`;

    const pipeline = redis.pipeline();
    // Update latest
    pipeline.set(lastKey, JSON.stringify({ price, timestamp, source: 'binance' }));
    // Add to history (score=timestamp)
    pipeline.zadd(pricesKey, timestamp, `${timestamp}:${price}`);
    // Prune history (keep 60m)
    pipeline.zremrangebyscore(pricesKey, '-inf', timestamp - 60 * 60 * 1000);
    // Expire
    pipeline.expire(lastKey, 7200);
    pipeline.expire(pricesKey, 7200);
    
    // Publish event for Arb Worker
    pipeline.publish('spot:price_moved', JSON.stringify({ symbol, price, timestamp }));

    await pipeline.exec();
    
    logger.debug('[binance] updated', { symbol, price });
  }

  private reconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, 5000);
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
