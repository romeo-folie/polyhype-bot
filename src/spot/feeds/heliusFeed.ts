import { Connection, PublicKey, type AccountInfo } from '@solana/web3.js';
import { parsePriceData } from '@pythnetwork/client';
import { logger } from '../../shared/logger.js';
import { getRedis } from '../../shared/redis.js';

// Mapping of ticker symbols to Pyth account addresses
const PYTH_ACCOUNTS: Record<string, string> = {
  'SOL': 'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG', // Mainnet SOL/USD
  'BTC': 'GVXRSae21x2HAd67YM5NooJC9iLeDbaS3vF6p7o9nZk',  // Mainnet BTC/USD
  'ETH': 'JBu1mRs7zS9vM9hc88mPfv7mYkLez27QJ4SuRQGms2M',  // Mainnet ETH/USD
};

/**
 * Helius / Solana Pyth Network Feed.
 * 
 * Uses standard Solana RPC WebSockets via Helius infrastructure to monitor 
 * Pyth price accounts with sub-second latency.
 */
export class HeliusFeed {
  private connection: Connection;
  private symbols: string[];
  private subscriptionIds: number[] = [];

  constructor(apiKey: string, symbols: string[] = ['SOL']) {
    const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    
    this.connection = new Connection(url, {
      wsEndpoint: wsUrl,
      commitment: 'processed',
    });
    this.symbols = symbols.map(s => s.toUpperCase());
  }

  public async start(): Promise<void> {
    logger.info('[helius] starting feeds', { symbols: this.symbols });

    for (const symbol of this.symbols) {
      const addr = PYTH_ACCOUNTS[symbol];
      if (!addr) {
        logger.warn(`[helius] no Pyth account mapping for ${symbol}, skipping`);
        continue;
      }

      const pubkey = new PublicKey(addr);
      
      const subId = this.connection.onAccountChange(
        pubkey,
        (accountInfo: AccountInfo<Buffer>) => {
          void this.handleAccountChange(symbol, accountInfo);
        },
        'processed'
      );

      this.subscriptionIds.push(subId);
      logger.info(`[helius] subscribed to ${symbol} (Pyth: ${addr})`);
    }
  }

  private async handleAccountChange(symbol: string, accountInfo: AccountInfo<Buffer>): Promise<void> {
    try {
      const priceData = parsePriceData(accountInfo.data);
      const price = priceData.aggregate.price;
      const timestamp = Date.now();

      if (price == null || isNaN(price)) return;

      const redis = getRedis();
      const lastKey = `spot:last:${symbol.toLowerCase()}`;
      const pricesKey = `spot:prices:${symbol.toLowerCase()}`;

      const pipeline = redis.pipeline();
      // Update latest
      pipeline.set(lastKey, JSON.stringify({ price, timestamp, source: 'helius' }));
      // Add to history
      pipeline.zadd(pricesKey, timestamp, `${timestamp}:${price}`);
      // Prune history
      pipeline.zremrangebyscore(pricesKey, '-inf', timestamp - 60 * 60 * 1000);
      // Expire
      pipeline.expire(lastKey, 7200);
      pipeline.expire(pricesKey, 7200);
      
      // Publish event for Arb Worker
      pipeline.publish('spot:price_moved', JSON.stringify({ symbol: symbol.toLowerCase(), price, timestamp }));

      await pipeline.exec();

      logger.debug('[helius] updated', { symbol, price });
    } catch (err) {
      logger.error('[helius] parse error', { symbol, error: String(err) });
    }
  }

  public async stop(): Promise<void> {
    for (const subId of this.subscriptionIds) {
      await this.connection.removeAccountChangeListener(subId).catch(() => {});
    }
    this.subscriptionIds = [];
  }
}
