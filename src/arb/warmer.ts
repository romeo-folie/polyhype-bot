import { getRedis } from '../shared/redis.js';
import { logger } from '../shared/logger.js';
import { searchEvents, parseClobTokenIds, listRecentCryptoEvents, parseOutcomes } from '../mapping/gamma.js';
import { getPriceFeed } from '../shared/feedSingleton.js';
import { ASSET_SEARCH_QUERIES } from '../shared/assets.js';
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

  constructor(intervalMs = 600_000) {
    // 10 minutes default
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
          error: err instanceof Error ? err.message : String(err),
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
      const assets = Object.keys(ASSET_SEARCH_QUERIES);

      let discoveredCount = 0;
      let watchedCount = 0;

      for (const assetId of assets) {
        const queries = ASSET_SEARCH_QUERIES[assetId] || [assetId];
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
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Discover Up/Down crypto markets (ephemeral, tag-based discovery)
      let upDownDiscovered = 0;
      let upDownWatched = 0;
      const warmCfg = loadConfig();
      if (!warmCfg.UPDOWN_ENABLED) {
        logger.debug('[warmer] Up/Down discovery skipped (UPDOWN_ENABLED=false)');
      } else try {
        const cryptoEvents = await listRecentCryptoEvents({ maxHoursToResolution: warmCfg.UPDOWN_MAX_HOURS_TO_RESOLUTION });
        for (const event of cryptoEvents) {
          for (const market of event.markets) {
            if (!market.active || market.closed) continue;
            // Filter to Up/Down markets about Bitcoin
            try {
              const outcomes = parseOutcomes(market.outcomes);
              const hasUpDown = outcomes.some((o) => o.toLowerCase() === 'up') &&
                outcomes.some((o) => o.toLowerCase() === 'down');
              if (!hasUpDown) continue;
              const question = market.question.toLowerCase();
              if (!question.includes('bitcoin')) continue;

              upDownDiscovered++;
              const clobTokenIds = parseClobTokenIds(market.clobTokenIds);
              if (clobTokenIds.length !== 2) continue;

              // Normalize ordering: ensure index 0 = UP token, index 1 = DOWN token
              const upIdx = outcomes.findIndex((o) => o.toLowerCase() === 'up');
              const downIdx = outcomes.findIndex((o) => o.toLowerCase() === 'down');
              if (upIdx === -1 || downIdx === -1 || upIdx === downIdx) continue;

              const normalizedClobTokenIds = [clobTokenIds[upIdx]!, clobTokenIds[downIdx]!];
              await feed.watch(market.id, normalizedClobTokenIds);
              upDownWatched++;
            } catch {
              // Skip invalid markets
            }
          }
        }
      } catch (err) {
        logger.warn('[warmer] Up/Down crypto event discovery failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      logger.info('[warmer] warmup cycle complete', {
        discoveredCount,
        watchedCount,
        upDownDiscovered,
        upDownWatched,
        assetsCount: assets.length,
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
