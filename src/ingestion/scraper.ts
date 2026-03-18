/**
 * Cheerio headline scraper for worldmonitor.app and pizzint.watch.
 *
 * Scrapes headlines and returns the same RssItem shape.
 * Failures are logged and return empty arrays (never throws).
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../shared/logger.js';
import type { RssItem } from './rss.js';

const SCRAPE_TIMEOUT_MS = 10_000;

interface SiteConfig {
  url: string;
  source: string;
  /** CSS selector for headline anchor elements */
  selector: string;
}

const SITES: SiteConfig[] = [
  {
    url: 'https://worldmonitor.app',
    source: 'World Monitor',
    // TODO: verify selector once site structure is confirmed
    selector: 'a.headline, article a, .news-item a',
  },
  {
    url: 'https://pizzint.watch',
    source: 'PIZZINT Watch',
    // TODO: verify selector once site structure is confirmed
    selector: 'a.headline, article a, .post-title a',
  },
];

async function scrapeSite(site: SiteConfig): Promise<RssItem[]> {
  const { data } = await axios.get<string>(site.url, {
    timeout: SCRAPE_TIMEOUT_MS,
    headers: { 'User-Agent': 'PGA-Bot/1.0 (geopolitical-agent)' },
  });

  const $ = cheerio.load(data);
  const items: RssItem[] = [];

  $(site.selector).each((_i, el) => {
    const anchor = $(el);
    const title = anchor.text().trim();
    const href = anchor.attr('href');
    if (!title || !href) return;

    const fullUrl = href.startsWith('http') ? href : new URL(href, site.url).toString();
    items.push({
      title,
      url: fullUrl,
      publishedAt: new Date(),
      source: site.source,
    });
  });

  return items;
}

export async function scrapeHeadlines(): Promise<RssItem[]> {
  const results: RssItem[] = [];

  const settled = await Promise.allSettled(SITES.map((site) => scrapeSite(site)));

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      results.push(...result.value);
    } else {
      logger.warn('[scraper] site scrape failed', { error: String(result.reason) });
    }
  }

  return results;
}
