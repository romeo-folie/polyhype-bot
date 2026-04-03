/**
 * Market Warmer (Phase 4)
 *
 * Pre-populates the Hybrid Registry (Redis) with structural mappings and correlation
 * directions for active price-target markets.
 *
 * This ensures 0ms latency for the high-speed consensus formula during live spot moves.
 * Runs as a background worker or periodic cron.
 */

import { logger } from '../shared/logger.js';
import { getRedis } from '../shared/redis.js';
import { searchEvents, parseClobTokenIds } from '../mapping/gamma.js';
import { estimateFastConsensus } from './fastPathConsensus.js';
import { BINANCE_SYMBOL_TO_ASSET } from '../shared/assets.js';

const ASSET_SEARCH_QUERIES: Record<string, string[]> = {
  bitcoin: ['bitcoin', 'BTC', 'price'],
  ethereum: ['ethereum', 'ETH', 'price'],
  solana: ['solana', 'SOL', 'price'],
};

/**
 * Warm the cache for a specific asset.
 */
async function warmAsset(assetId: string, redis: ReturnType<typeof getRedis>): Promise<void> {
  const queries = ASSET_SEARCH_QUERIES[assetId] || [assetId];
  logger.info('[market-warmer] warming asset', { assetId, queries });

  for (const query of queries) {
    try {
      const events = await searchEvents({ query, activeOnly: true });
      for (const event of events) {
        for (const market of event.markets) {
          const cacheKey = `mapping:consensus:v2:${market.id}`;

          // Only warm if not already cached
          const existing = await redis.get(cacheKey);
          if (existing) continue;

          // Attempt structural extraction via estimateFastConsensus with dummy move data.
          // This will populate the cache for the market.
          await estimateFastConsensus(
            {
              assetId,
              currentPrice: 1,
              referencePrice: 1,
              changePercent: 0,
              windowMinutes: 1,
              detectedAt: new Date().toISOString(),
            },
            {
              marketId: market.id,
              conditionId: market.conditionId,
              clobTokenIds: parseClobTokenIds(market.clobTokenIds),
              question: market.question,
              description: market.description,
              currentYesPrice: 0.5,
              correlationDirection: 'positive',
              feesEnabled: market.feesEnabled || false,
            },
            undefined,
            { redis },
          );
        }
      }
    } catch (err) {
      logger.error('[market-warmer] failed to warm query', { query, error: String(err) });
    }
  }
}

/**
 * Main warmer loop.
 */
export async function runMarketWarmer(): Promise<void> {
  const redis = getRedis();
  const assetsSet = new Set(Object.values(BINANCE_SYMBOL_TO_ASSET));
  const uniqueAssets = Array.from(assetsSet);

  logger.info('[market-warmer] starting warm-up cycle', { assetCount: uniqueAssets.length });

  for (const assetId of uniqueAssets) {
    await warmAsset(assetId, redis);
  }

  logger.info('[market-warmer] warm-up cycle complete');
}

// If run directly
if (process.argv[1]?.endsWith('marketWarmer.ts')) {
  runMarketWarmer().catch((err) => {
    logger.error('[market-warmer] fatal error', { error: String(err) });
    process.exit(1);
  });
}
