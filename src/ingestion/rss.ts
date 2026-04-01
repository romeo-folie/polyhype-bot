/**
 * RSS feed scraper for geopolitical OSINT headlines.
 *
 * Fetches configurable RSS feeds with per-feed timeout and fail-silent semantics.
 */

import Parser from 'rss-parser';
import { logger } from '../shared/logger.js';
import type { FeedConfig } from './categories/types.js';

export interface RssItem {
  title: string;
  url: string;
  publishedAt: Date;
  source: string;
}

const DEFAULT_FEEDS: FeedConfig[] = [
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' },
  { url: 'https://feeds.skynews.com/feeds/rss/world.xml' },
];

const FEED_TIMEOUT_MS = 10_000;

export async function fetchRssFeeds(feeds?: FeedConfig[]): Promise<RssItem[]> {
  const urls: FeedConfig[] =
    feeds ??
    (process.env.RSS_FEED_URLS
      ? process.env.RSS_FEED_URLS
          .split(',')
          .map((u) => u.trim())
          .filter(Boolean)
          .map((url) => ({ url }))
      : DEFAULT_FEEDS);

  const parser = new Parser();
  const results: RssItem[] = [];

  const settled = await Promise.allSettled(
    urls.map(async (feedConfig) => {
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, FEED_TIMEOUT_MS);

      try {
        const requestInit: RequestInit = {
          redirect: 'follow',
          signal: controller.signal,
        };
        if (feedConfig.headers) {
          requestInit.headers = feedConfig.headers;
        }

        const response = await fetch(feedConfig.url, requestInit);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} for ${feedConfig.url}`);
        }

        const xml = await response.text();
        const feed = await parser.parseString(xml);
        const source = feed.title ?? feedConfig.url;

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
      } finally {
        clearTimeout(timer);
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
