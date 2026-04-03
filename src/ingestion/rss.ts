/**
 * RSS feed scraper for geopolitical OSINT headlines.
 *
 * Fetches configurable RSS feeds with per-feed timeout and fail-silent semantics.
 */

import Parser from 'rss-parser';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import type { FeedConfig } from './categories/types.js';

export interface RssItem {
  title: string;
  url: string;
  publishedAt: Date;
  source: string;
  latencyMs?: number;
}

const FEED_TIMEOUT_MS = 10_000;

function buildDefaultHeaders(userAgent: string): Record<string, string> {
  return {
    'User-Agent': userAgent,
    'Accept': 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.google.com/',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };
}

export async function fetchRssFeeds(feeds?: FeedConfig[]): Promise<RssItem[]> {
  const cfg = loadConfig();
  const rawUrls: FeedConfig[] =
    feeds ??
    cfg.RSS_FEED_URLS
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean)
      .map((url) => ({ url }));

  const urls = rawUrls.map(f => ({
    ...f,
    url: f.url.startsWith('http') ? f.url : `https://${f.url}`
  }));

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
            ...buildDefaultHeaders(cfg.RSS_USER_AGENT),
            ...(feedConfig.headers ?? {}),
          },
        };

        const response = await fetch(feedConfig.url, requestInit);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} for ${feedConfig.url}`);
        }

        const xml = await response.text();
        if (!xml || xml.trim().startsWith('<!DOCTYPE html>')) {
           throw new Error(`Invalid XML response (likely HTML/WAF block) for ${feedConfig.url}`);
        }

        const feed = await parser.parseString(xml);
        if (!feed || !feed.items) {
           throw new Error(`Malformed feed data for ${feedConfig.url}`);
        }

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
