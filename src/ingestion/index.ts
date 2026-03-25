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
import { applyTimingBoost } from './timingWindow.js';
import type { ScoredItem } from './scorer.js';

const URGENCY_THRESHOLD = Number(process.env['URGENCY_THRESHOLD'] ?? 8);

export async function runIngestion(): Promise<ScoredItem[]> {
  const redis = getRedis();
  const [rssItems, scraped] = await Promise.all([fetchRssFeeds(), scrapeHeadlines()]);
  const all = [...rssItems, ...scraped];
  const newItems = await filterSeen(all, redis);
  const scored = await scoreItems(newItems);
  // Apply timing window boost — items breaking during Asia/Europe hours (US asleep)
  // get a score multiplier to reflect the repricing lag edge.
  const boosted = applyTimingBoost(scored);
  const highUrgency = boosted.filter((i) => i.urgencyScore >= URGENCY_THRESHOLD);
  logger.info(
    `[ingestion] ${all.length} total → ${newItems.length} new → ${highUrgency.length} high-urgency`,
  );
  return highUrgency;
}

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
