import { WebSocket } from 'ws';
import { logger } from '../../shared/logger.js';
import { getRedis } from '../../shared/redis.js';

/**
 * Pyth Network Price Feed IDs (Mainnet).
 * Verified correct for high-accuracy SOL, BTC, and ETH tracking via Hermes.
 */
const PYTH_FEED_IDS: Record<string, string> = {
  SOL: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  BTC: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  ETH: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
};

/**
 * HeliusFeed (now powered by Pyth Hermes for stability).
 * Bypasses RPC account-change limitations by using Pyth's dedicated push service.
 */
export class HeliusFeed {
  private ws: WebSocket | null = null;
  private tickerCount: Record<string, number> = {};
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectCount = 0;

  constructor(_apiKey: string, private symbols: string[] = ['SOL']) {
    // API key currently not needed for public Pyth Hermes
  }

  public async start(): Promise<void> {
    // Hermes public endpoint for high-speed price updates
    const wsUrl = 'wss://hermes.pyth.network/ws';
    logger.info('[pyth] connecting to Hermes WebSocket...', { symbols: this.symbols });

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      logger.info('[pyth] connected to Hermes');
      this.reconnectCount = 0; // Reset on success
      const ids = this.symbols
        .map(s => PYTH_FEED_IDS[s])
        .filter(Boolean)
        .map(id => `0x${id}`);

      if (ids.length > 0) {
        this.ws?.send(JSON.stringify({
          type: 'subscribe',
          ids
        }));
        logger.info('[pyth] subscribed to price feeds', { count: ids.length });
      }
    });

    this.ws.on('message', (data: string) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'price_update' && msg.price_feed) {
          void this.handleUpdate(msg.price_feed);
        }
      } catch (err) {
        // Ignore parsing errors for binary/system messages
      }
    });

    this.ws.on('error', (err) => {
      logger.error('[pyth] WebSocket error', { error: err.message });
    });

    this.ws.on('close', () => {
      if (this.ws) {
        this.reconnectCount++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectCount), 30000);
        logger.warn(`[pyth] connection closed, reconnecting in ${delay / 1000}s (attempt ${this.reconnectCount})...`);
        this.reconnectTimeout = setTimeout(() => this.start(), delay);
      }
    });
  }

  private async handleUpdate(feed: any): Promise<void> {
    try {
      // Pyth Hermes price is (price * 10^expo)
      const price = Number(feed.price.price) * Math.pow(10, feed.price.expo);
      const feedIdClean = feed.id.startsWith('0x') ? feed.id.slice(2) : feed.id;
      const symbol = Object.keys(PYTH_FEED_IDS).find(k => PYTH_FEED_IDS[k] === feedIdClean) || 'unknown';
      const timestamp = Date.now();

      if (!isFinite(price) || price <= 0 || symbol === 'unknown') return;

      const redis = getRedis();
      const pipeline = redis.pipeline();

      // Update spot price cache
      pipeline.hset('spot:prices', symbol.toLowerCase(), price.toString());
      pipeline.hset('spot:last_updated', symbol.toLowerCase(), timestamp.toString());

      // Publish event for Arb Worker
      pipeline.publish('spot:price_moved', JSON.stringify({ symbol: symbol.toLowerCase(), price, timestamp }));

      await pipeline.exec();

      // Pulse: log to info once every 10 updates per symbol
      this.tickerCount[symbol] = (this.tickerCount[symbol] || 0) + 1;
      if (this.tickerCount[symbol] % 10 === 0) {
        logger.info(`[pyth] ${symbol.toUpperCase()} tick (hermes): $${price.toLocaleString()}`);
      }
    } catch (err) {
      logger.error('[pyth] update handling error', { error: String(err) });
    }
  }

  public stop(): void {
    logger.info('[pyth] stopping feeds');
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.ws) {
      const socket = this.ws;
      this.ws = null; // Prevent reconnect on close
      socket.removeAllListeners();
      socket.terminate();
    }
  }
}
