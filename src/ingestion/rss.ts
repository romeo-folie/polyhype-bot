/**
 * RSS feed scraper for geopolitical OSINT headlines.
 *
 * Fetches configurable RSS feeds with per-feed timeout and fail-silent semantics.
 */

import Parser from 'rss-parser';
import { logger } from '../shared/logger.js';

export interface RssItem {
  title: string;
  url: string;
  publishedAt: Date;
  source: string;
}

const DEFAULT_FEEDS = [
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
  'https://www.aljazeera.com/xml/rss/all.xml',
];

const FEED_TIMEOUT_MS = 10_000;

export async function fetchRssFeeds(feedUrls?: string[]): Promise<RssItem[]> {
  const urls =
    feedUrls ??
    (process.env['RSS_FEED_URLS']
      ? process.env['RSS_FEED_URLS'].split(',').map((u) => u.trim()).filter(Boolean)
      : DEFAULT_FEEDS);

  const parser = new Parser({ timeout: FEED_TIMEOUT_MS });
  const results: RssItem[] = [];

  const settled = await Promise.allSettled(
    urls.map(async (url) => {
      const feed = await parser.parseURL(url);
      const source = feed.title ?? url;
      for (const item of feed.items) {
        const title = item.title?.trim();
        const link = item.link?.trim();
        if (!title || !link) continue;
        results.push({
          title,
          url: link,
          publishedAt: item.isoDate ? new Date(item.isoDate) : new Date(),
          source,
        });
      }
    }),
  );

  for (const result of settled) {
    if (result.status === 'rejected') {
      logger.warn('[rss] feed fetch failed', { error: String(result.reason) });
    }
  }

  return results;
}
