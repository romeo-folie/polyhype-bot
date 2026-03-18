/**
 * Task 1.1 — RSS feed scraper.
 *
 * Fetches geopolitical news from RSS feeds using rss-parser.
 * Returns RawArticle[] with dedup-ready SHA-256 IDs.
 */

import { createHash } from 'node:crypto';
import Parser from 'rss-parser';
import { logger } from '../shared/logger.js';
import type { RawArticle } from './types.js';

const RSS_FEEDS = [
  { name: 'Bellingcat', url: 'https://www.bellingcat.com/feed/' },
  { name: 'Crisis Group', url: 'https://www.crisisgroup.org/rss.xml' },
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'Reuters World', url: 'https://feeds.reuters.com/Reuters/worldNews' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
] as const;

const FEED_TIMEOUT_MS = 10_000;

function makeId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

export async function scrapeRssFeeds(): Promise<RawArticle[]> {
  const parser = new Parser({
    timeout: FEED_TIMEOUT_MS,
    requestOptions: {
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    },
  });

  const results = await Promise.allSettled(
    RSS_FEEDS.map(async (feed) => {
      const parsed = await parser.parseURL(feed.url);
      return (parsed.items ?? []).map((item): RawArticle => ({
        id: makeId(item.link ?? item.guid ?? item.title ?? ''),
        source: feed.name,
        url: item.link ?? '',
        title: item.title ?? '',
        summary: truncate(item.contentSnippet ?? item.content ?? '', 500),
        publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
      }));
    }),
  );

  const articles: RawArticle[] = [];
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      articles.push(...result.value);
    } else {
      const feed = RSS_FEEDS[i];
      logger.warn(`[rss] failed to fetch feed: ${feed?.name}`, {
        url: feed?.url,
        error: String(result.reason),
      });
    }
  }

  logger.info(`[rss] scraped ${String(articles.length)} articles from RSS feeds`);
  return articles;
}
