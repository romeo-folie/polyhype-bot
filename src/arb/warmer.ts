import { getRedis } from '../shared/redis.js';
import { logger } from '../shared/logger.js';
import { searchEvents, parseClobTokenIds } from '../mapping/gamma.js';
import { getPriceFeed } from '../shared/feedSingleton.js';
import { CRYPTO_ASSET_SEARCH_QUERIES } from './cryptoArbScanner.js';
import { loadConfig } from '../shared/config.js';

/**
 * Arb Market Warmer.
 * 
 * Periodically searches for crypto-related price-target markets on Gamma
 * and registers them with the WebSocket ClobPriceFeed. This ensures
 * that order books are pre-warmed in memory before a price move occurs,
 * eliminating the first-discovery REST API latency gap.
 */
export class ArbMarketWarmer {
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(intervalMs = 600_000) { // 10 minutes default
    this.intervalMs = intervalMs;
  }

  public async start(): Promise<void> {
    const cfg = loadConfig();
    if (!cfg.ARB_ENABLED || !cfg.CRYPTO_ARB_ENABLED) {
      logger.info('[warmer] arb/crypto-arb disabled, warmer not starting');
      return;
    }

    logger.info('[warmer] starting arb market warmer', { intervalMs: this.intervalMs });
    
    // Immediate first run
    await this.warmUp();
    
    this.timer = setInterval(() => {
      void this.warmUp().catch((err) => {
        logger.error('[warmer] periodic warmup failed', { 
          error: err instanceof Error ? err.message : String(err) 
        });
      });
    }, this.intervalMs);
  }

  public async warmUp(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const redis = getRedis();
      const feed = getPriceFeed(redis);
      const assets = Object.keys(CRYPTO_ASSET_SEARCH_QUERIES);
      
      let discoveredCount = 0;
      let watchedCount = 0;

      for (const assetId of assets) {
        const queries = CRYPTO_ASSET_SEARCH_QUERIES[assetId] || [assetId];
        for (const query of queries) {
          try {
            const events = await searchEvents({ query, limit: 10, activeOnly: true });
            for (const event of events) {
              for (const market of event.markets) {
                if (!market.active || market.closed) continue;
                
                discoveredCount++;
                try {
                  const clobTokenIds = parseClobTokenIds(market.clobTokenIds);
                  if (clobTokenIds.length >= 1) {
                    await feed.watch(market.id, clobTokenIds);
                    watchedCount++;
                  }
                } catch (e) {
                  // Skip invalid tokens
                }
              }
            }
          } catch (err) {
            logger.warn('[warmer] search failed for query', { 
              query, 
              error: err instanceof Error ? err.message : String(err) 
            });
          }
        }
      }

      logger.info('[warmer] warmup cycle complete', { 
        discoveredCount, 
        watchedCount,
        assetsCount: assets.length 
      });
    } finally {
      this.isRunning = false;
    }
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('[warmer] stopped');
  }
}
