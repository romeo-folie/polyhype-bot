/**
 * world-monitor-scraper entry point.
 * Run: npm run cron:ingest
 * Scrapes RSS + web sources, deduplicates, scores urgency.
 * Outputs high-urgency articles (score >= 8) to stdout as JSON.
 */

import { loadConfig } from '../shared/config.js';
import { getRedis, closeRedis } from '../shared/redis.js';
import { logger } from '../shared/logger.js';
import { scrapeRssFeeds } from './rss-scraper.js';
import { scrapeWebSources } from './web-scraper.js';
import { filterNew } from './dedup.js';
import { scoreArticles } from './scorer.js';

export async function runIngestion(): Promise<void> {
  // 1. Validate env — fail fast
  const config = loadConfig();

  // 2. Connect Redis (lazy — first call initializes)
  getRedis();

  try {
    // 3. Scrape all sources in parallel
    const [rssResult, webResult] = await Promise.allSettled([
      scrapeRssFeeds(),
      scrapeWebSources(),
    ]);

    const allArticles = [
      ...(rssResult.status === 'fulfilled' ? rssResult.value : []),
      ...(webResult.status === 'fulfilled' ? webResult.value : []),
    ];

    if (rssResult.status === 'rejected') {
      logger.error('[ingestion] RSS scraper failed', { error: String(rssResult.reason) });
    }
    if (webResult.status === 'rejected') {
      logger.error('[ingestion] web scraper failed', { error: String(webResult.reason) });
    }

    logger.info(`[ingestion] total scraped: ${String(allArticles.length)}`);

    // 4. Deduplicate
    const newArticles = await filterNew(allArticles);

    if (newArticles.length === 0) {
      logger.info('[ingestion] no new articles — exiting');
      return;
    }

    // 5. Score
    const scored = await scoreArticles(newArticles);

    // 6. Filter high-urgency
    const threshold = config.URGENCY_THRESHOLD;
    const highUrgency = scored.filter((a) => a.urgencyScore >= threshold);

    logger.info('[ingestion] pipeline complete', {
      totalScraped: allArticles.length,
      newArticles: newArticles.length,
      scored: scored.length,
      highUrgency: highUrgency.length,
      threshold,
    });

    // 7. Output high-urgency articles to stdout
    if (highUrgency.length > 0) {
      console.log(JSON.stringify(highUrgency, null, 2));
    }
  } finally {
    // 8. Graceful shutdown
    await closeRedis();
  }
}

// Entrypoint when run directly (npx tsx src/ingestion/index.ts)
const isMain = process.argv[1]?.endsWith('ingestion/index.ts') ?? false;
if (isMain) {
  runIngestion()
    .then(() => {
      process.exit(0);
    })
    .catch((err: unknown) => {
      logger.error('[ingestion] fatal', { error: String(err) });
      process.exit(1);
    });
}
