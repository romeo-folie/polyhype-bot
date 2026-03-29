import { Connection, PublicKey, AccountInfo } from '@solana/web3.js';
import { parsePriceData } from '@pythnetwork/client';
import { logger } from '../../shared/logger.js';
import { getRedis } from '../../shared/redis.js';

/**
 * Pyth Network Price Account IDs on Solana Mainnet.
 */
const PYTH_ACCOUNTS: Record<string, string> = {
  BTC: 'GVXRSBjTuSvU9K79qSgbt7Wqrq97neB9Jhcic65tD8Sx',
  ETH: 'JBu1pE2waHcbMNeGTKsGMBvuyY6MvbevR6p9u89nK9An',
  SOL: 'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG',
};

/**
 * Helius WebSocket Feed for Solana/Pyth data.
 * Monitors account changes for Pyth price accounts to get real-time price moves.
 */
export class HeliusFeed {
  private connection: Connection;
  private subscriptionIds: number[] = [];
  private tickerCount: Record<string, number> = {};
  private watchdog: NodeJS.Timeout | null = null;
  private apiKey: string;

  constructor(apiKey: string, private symbols: string[] = ['SOL']) {
    this.apiKey = apiKey;
    const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    this.connection = new Connection(url, {
      wsEndpoint: wsUrl,
      commitment: 'processed',
    });
  }

  public async start(): Promise<void> {
    logger.info('[helius] starting feeds', { symbols: this.symbols });

    for (const symbol of this.symbols) {
      const pubkey = PYTH_ACCOUNTS[symbol];
      if (!pubkey) {
        logger.warn('[helius] symbol not found in Pyth map', { symbol });
        continue;
      }

      logger.info(`[helius] subscribing to ${symbol} (Pyth: ${pubkey})...`);

      try {
        const id = this.connection.onAccountChange(
          new PublicKey(pubkey),
          (accountInfo) => {
            this.resetWatchdog();
            void this.handleUpdate(symbol, accountInfo);
          },
          'processed',
        );
        this.subscriptionIds.push(id);
        logger.info(`[helius] subscription active for ${symbol}`);
      } catch (err) {
        logger.error(`[helius] failed to subscribe to ${symbol}`, { error: String(err) });
      }
    }
    this.resetWatchdog();
  }

  private resetWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      logger.warn('[helius] stream silent for 60s, force-reconnecting...');
      void this.reconnect();
    }, 60000); // 60s watchdog to detect silent streams
  }

  private async reconnect(): Promise<void> {
    this.stop();
    await new Promise(resolve => setTimeout(resolve, 5000));
    await this.start();
  }

  private async handleUpdate(symbol: string, accountInfo: AccountInfo<Buffer>): Promise<void> {
    try {
      const priceData = parsePriceData(accountInfo.data);
      const price = priceData.aggregate.price;
      const timestamp = Date.now();

      if (!isFinite(price) || price <= 0) return;

      const redis = getRedis();
      const pipeline = redis.pipeline();

      // Update spot price cache
      pipeline.hset('spot:prices', symbol.toLowerCase(), price.toString());
      pipeline.hset('spot:last_updated', symbol.toLowerCase(), timestamp.toString());

      // Publish event for Arb Worker
      pipeline.publish('spot:price_moved', JSON.stringify({ symbol: symbol.toLowerCase(), price, timestamp }));

      await pipeline.exec();

      // Pulse: log to info once every 5 updates per symbol to show "life"
      this.tickerCount[symbol] = (this.tickerCount[symbol] || 0) + 1;
      if (this.tickerCount[symbol] % 5 === 0) {
        logger.info(`[helius] ${symbol.toUpperCase()} tick (on-chain): $${price.toLocaleString()}`);
      }
    } catch (err) {
      logger.error('[helius] parse error', { symbol, error: String(err) });
    }
  }

  public stop(): void {
    logger.info('[helius] stopping feeds');
    if (this.watchdog) clearTimeout(this.watchdog);
    for (const id of this.subscriptionIds) {
      void this.connection.removeAccountChangeListener(id).catch(() => {});
    }
    this.subscriptionIds = [];
  }
}
