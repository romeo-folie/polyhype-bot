import 'dotenv/config';
import { logger } from '../../shared/logger.js';
import { loadConfig } from '../../shared/config.js';
import { BinanceFeed } from './binanceFeed.js';
import { HeliusFeed } from './heliusFeed.js';
import { closeRedis } from '../../shared/redis.js';

/**
 * Feed Manager.
 * 
 * Orchestrates multiple real-time data feeds.
 */
async function main() {
  const cfg = loadConfig();
  const feeds: { stop: () => void | Promise<void> }[] = [];

  if (cfg.BINANCE_WS_ENABLED) {
    const symbols = cfg.BINANCE_SYMBOLS.split(',').filter(Boolean);
    const binance = new BinanceFeed(symbols);
    binance.start();
    feeds.push(binance);
  }

  if (cfg.HELIUS_API_KEY) {
    // For TDD, we currently support SOL from Helius/Pyth
    const helius = new HeliusFeed(cfg.HELIUS_API_KEY, ['SOL']);
    await helius.start();
    feeds.push(helius);
  }

  logger.info('[feeds-manager] all feeds started');

  // Handle termination
  const shutdown = async () => {
    logger.info('[feeds-manager] shutting down...');
    for (const feed of feeds) {
      await feed.stop();
    }
    await closeRedis();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error('[feeds-manager] fatal error', { error: String(err) });
  process.exit(1);
});
