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
  latencyMs?: number;
}

const DEFAULT_FEEDS: FeedConfig[] = [
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' },
  { url: 'https://feeds.skynews.com/feeds/rss/world.xml' },
  { url: 'http://feeds.bbci.co.uk/news/world/rss.xml' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml' },
];

const FEED_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; PGA/1.0; +https://github.com/romeo-folie/polymarket-geopolitical-agent)';

function buildDefaultHeaders(): Record<string, string> {
  const raw = process.env.RSS_USER_AGENT;
  const userAgent = raw?.trim();
  return {
    'user-agent': userAgent && userAgent.length > 0 ? userAgent : DEFAULT_USER_AGENT,
    accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1',
  };
}

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
          headers: {
            ...buildDefaultHeaders(),
            ...(feedConfig.headers ?? {}),
          },
        };

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

  for (const [index, result] of settled.entries()) {
    if (result.status === 'rejected') {
      logger.warn('[rss] feed fetch failed', {
        url: urls[index]?.url,
        error: String(result.reason),
      });
    }
  }

  return results;
}
