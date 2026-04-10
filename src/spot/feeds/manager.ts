import { logger } from '../../shared/logger.js';
import { loadConfig } from '../../shared/config.js';
import { BinanceFeed } from './binanceFeed.js';
import { HeliusFeed } from './heliusFeed.js';
import { getRedis, closeRedis } from '../../shared/redis.js';

// Watchdog: if no kline arrives within this window, self-restart via exit(1).
// Docker's restart:unless-stopped will bring it back. 5min is generous — Binance
// emits klines every ~30s per symbol; 5min silence = feed is truly dead.
const WATCHDOG_INTERVAL_MS = 60_000;   // check every 60s
const WATCHDOG_SILENCE_MS  = 5 * 60_000; // exit if silent for 5 min

/**
 * Feed Manager.
 *
 * Orchestrates multiple real-time data feeds.
 */
async function main() {
  const cfg = loadConfig();
  const feeds: { stop: () => void | Promise<void> }[] = [];

  // Track last kline time for watchdog.
  let lastKlineMs = Date.now();
  const noteKline = () => { lastKlineMs = Date.now(); };

  if (cfg.BINANCE_WS_ENABLED) {
    const symbols = cfg.BINANCE_SYMBOLS.split(',').filter(Boolean);
    const binance = new BinanceFeed(symbols);
    binance.onKline = noteKline;
    // Pre-seed kline history from REST before WS subscription so indicators
    // (MACD/RSI/Stochastic) are computable from the first moment of operation.
    await binance.seedKlineHistory();
    binance.start();
    feeds.push(binance);
  }

  // Pyth Hermes feed — always started, no API key required (public endpoint).
  // Covers BTC, ETH, SOL with oracle-grade accuracy. HELIUS_API_KEY is unused.
  const pyth = new HeliusFeed('', ['SOL', 'BTC', 'ETH']);
  pyth.start();
  feeds.push(pyth);

  logger.info('[feeds-manager] all feeds started');

  // Watchdog timer — exits the process if the Binance feed goes silent so
  // Docker's restart:unless-stopped brings it back automatically.
  const watchdog = setInterval(() => {
    const silenceMs = Date.now() - lastKlineMs;
    if (silenceMs > WATCHDOG_SILENCE_MS) {
      logger.error('[feeds-manager] watchdog: no klines received', {
        silenceMs,
        limit: WATCHDOG_SILENCE_MS,
      });
      process.exit(1);
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref(); // don't block clean exit

  // Write a heartbeat key so the Docker health check can verify liveness.
  const redis = getRedis();
  const heartbeat = setInterval(() => {
    void redis.setex('heartbeat:spot-feed', 120, String(Math.floor(Date.now() / 1000)));
  }, 30_000);
  heartbeat.unref();
  // Write immediately so health check passes right away on startup.
  void redis.setex('heartbeat:spot-feed', 120, String(Math.floor(Date.now() / 1000)));

  // Handle termination
  const shutdown = async () => {
    logger.info('[feeds-manager] shutting down...');
    clearInterval(watchdog);
    clearInterval(heartbeat);
    for (const feed of feeds) {
      await feed.stop();
    }
    await closeRedis();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// CLI entrypoint
const isMain = process.argv[1]?.endsWith('manager.ts') || process.argv[1]?.endsWith('manager.js');
if (isMain) {
  main().catch((err: unknown) => {
    logger.error('[feeds-manager] fatal error', { error: String(err) });
    process.exit(1);
  });
}
