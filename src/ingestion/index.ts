/**
 * Phase 1: Data Ingestion & Filtering Pipeline
 *
 * Cron entrypoint for the world-monitor-scraper.
 * Fetches RSS + scraped headlines → deduplicates → scores urgency → returns high-urgency items.
 */

import 'dotenv/config';
import { getRedis } from '../shared/redis.js';
import { logger } from '../shared/logger.js';
import { fetchRssFeeds } from './rss.js';
import { scrapeHeadlines } from './scraper.js';
import { filterSeen } from './dedup.js';
import { scoreItems } from './scorer.js';
import { applyTimingBoost } from './timingWindow.js';
import type { ScoredItem } from './scorer.js';
import type { Redis } from 'ioredis';
import type { CategoryConfig } from './categories/types.js';
import { CATEGORIES } from './categories/index.js';

async function runCategoryPipeline(
  category: CategoryConfig,
  redis: Redis,
): Promise<ScoredItem[]> {
  const [rssItems, scraped] = await Promise.all([
    fetchRssFeeds(category.feeds),
    category.id === 'geopolitical' ? scrapeHeadlines() : Promise.resolve([]),
  ]);

  const all = [...rssItems, ...scraped];
  const newItems = await filterSeen(all, redis);
  const scored = await scoreItems(newItems, {
    systemPrompt: category.scorerPrompt,
    categoryId: category.id,
    categoryLabel: category.label,
    entityContext: category.entityContext,
    redis,
  });

  const boosted = applyTimingBoost(scored);
  const highUrgency = boosted.filter((i) => i.urgencyScore >= category.scoreThreshold);
  logger.info(
    `[ingestion] ${category.id}: ${all.length} total → ${newItems.length} new → ${highUrgency.length} high-urgency`,
  );
  return highUrgency;
}

export async function runIngestion(): Promise<ScoredItem[]> {
  const redis = getRedis();
  const settled = await Promise.allSettled(
    CATEGORIES.map((category) => runCategoryPipeline(category, redis)),
  );

  const highUrgency: ScoredItem[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]!;
    const category = CATEGORIES[i]!;
    if (result.status === 'fulfilled') {
      highUrgency.push(...result.value);
    } else {
      logger.warn('[ingestion] category pipeline failed', {
        category: category.id,
        error: String(result.reason),
      });
    }
  }

  logger.info('[ingestion] pipeline complete', { highUrgencyCount: highUrgency.length });
  return highUrgency;
}

export { runCategoryPipeline };

// Entrypoint when run directly (npx tsx src/ingestion/index.ts)
import { fileURLToPath } from 'node:url';
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runIngestion()
    .then((items) => {
      logger.info(`[ingestion] pipeline complete`, { highUrgencyCount: items.length });
    })
    .catch((err: unknown) => {
      logger.error('[ingestion] fatal', { error: String(err) });
      process.exit(1);
    });
}
