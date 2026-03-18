/**
 * Phase 1: Data Ingestion & Filtering Pipeline
 *
 * Cron entrypoint for the world-monitor-scraper.
 * Fetches RSS + scraped headlines → deduplicates → scores urgency → returns high-urgency items.
 */

import { getRedis } from '../shared/redis.js';
import { logger } from '../shared/logger.js';
import { fetchRssFeeds } from './rss.js';
import { scrapeHeadlines } from './scraper.js';
import { filterSeen } from './dedup.js';
import { scoreItems } from './scorer.js';
import type { ScoredItem } from './scorer.js';

const URGENCY_THRESHOLD = Number(process.env['URGENCY_THRESHOLD'] ?? 8);

export async function runIngestion(): Promise<ScoredItem[]> {
  const redis = getRedis();
  const rssItems = await fetchRssFeeds();
  const scraped = await scrapeHeadlines();
  const all = [...rssItems, ...scraped];
  const newItems = await filterSeen(all, redis);
  const scored = await scoreItems(newItems);
  const highUrgency = scored.filter((i) => i.urgencyScore >= URGENCY_THRESHOLD);
  logger.info(
    `[ingestion] ${all.length} total → ${newItems.length} new → ${highUrgency.length} high-urgency`,
  );
  return highUrgency;
}

// Entrypoint when run directly (npx tsx src/ingestion/index.ts)
const isMain = process.argv[1]?.endsWith('ingestion/index.ts') ?? false;
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
