/**
 * Task 1.2 — Cheerio scraper for worldmonitor.app + pizzint.watch.
 *
 * Best-effort scrapers that gracefully degrade on failure.
 * Returns RawArticle[] matching the same interface as rss-scraper.
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { logger } from '../shared/logger.js';
import type { RawArticle } from './types.js';

const USER_AGENT = 'Mozilla/5.0 (compatible; PolymarketAgent/1.0)';
const FETCH_TIMEOUT_MS = 15_000;
const MIN_HTML_LENGTH = 500;

function makeId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

async function safeFetch(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn(`[web-scraper] non-200 response from ${url}`, { status: res.status });
      return null;
    }
    const html = await res.text();
    if (html.length < MIN_HTML_LENGTH) {
      logger.warn(`[web-scraper] suspiciously short response from ${url}`, { length: html.length });
      return null;
    }
    return html;
  } catch (err) {
    logger.warn(`[web-scraper] fetch failed for ${url}`, { error: String(err) });
    return null;
  }
}

async function scrapeWorldMonitor(): Promise<RawArticle[]> {
  const html = await safeFetch('https://worldmonitor.app');
  if (!html) return [];

  try {
    const $ = cheerio.load(html);
    const articles: RawArticle[] = [];

    // Try common selectors for incident cards / feed items
    const selectors = [
      '.incident-card',
      '.card',
      'article',
      '.feed-item',
      '.post-item',
      '[class*="incident"]',
      '[class*="event"]',
    ];

    for (const selector of selectors) {
      $(selector).each((_i, el) => {
        const $el = $(el);
        const title =
          $el.find('h1, h2, h3, h4, .title, .headline').first().text().trim() ||
          $el.find('a').first().text().trim();
        const link =
          $el.find('a').first().attr('href') ?? '';
        const date = $el.find('time').attr('datetime') ?? $el.find('.date, .time').first().text().trim();

        if (title && link) {
          const fullUrl = link.startsWith('http') ? link : `https://worldmonitor.app${link}`;
          articles.push({
            id: makeId(fullUrl),
            source: 'worldmonitor.app',
            url: fullUrl,
            title: truncate(title, 200),
            summary: truncate(title, 500),
            publishedAt: date ? new Date(date) : new Date(),
          });
        }
      });

      if (articles.length > 0) break;
    }

    logger.info(`[web-scraper] worldmonitor.app: scraped ${String(articles.length)} articles`);
    return articles;
  } catch (err) {
    logger.warn('[web-scraper] worldmonitor.app parse error', { error: String(err) });
    return [];
  }
}

async function scrapePizzint(): Promise<RawArticle[]> {
  const html = await safeFetch('https://pizzint.watch');
  if (!html) return [];

  try {
    const $ = cheerio.load(html);
    const articles: RawArticle[] = [];

    // Try common selectors for threat intelligence feed items
    const selectors = [
      'article',
      '.threat-item',
      '.feed-item',
      '.post',
      '.card',
      '.item',
      '[class*="threat"]',
      '[class*="intel"]',
    ];

    for (const selector of selectors) {
      $(selector).each((_i, el) => {
        const $el = $(el);
        const title =
          $el.find('h1, h2, h3, h4, .title, .headline').first().text().trim() ||
          $el.find('a').first().text().trim();
        const link =
          $el.find('a').first().attr('href') ?? '';
        const date = $el.find('time').attr('datetime') ?? $el.find('.date, .time').first().text().trim();

        if (title && link) {
          const fullUrl = link.startsWith('http') ? link : `https://pizzint.watch${link}`;
          articles.push({
            id: makeId(fullUrl),
            source: 'pizzint.watch',
            url: fullUrl,
            title: truncate(title, 200),
            summary: truncate(title, 500),
            publishedAt: date ? new Date(date) : new Date(),
          });
        }
      });

      if (articles.length > 0) break;
    }

    logger.info(`[web-scraper] pizzint.watch: scraped ${String(articles.length)} articles`);
    return articles;
  } catch (err) {
    logger.warn('[web-scraper] pizzint.watch parse error', { error: String(err) });
    return [];
  }
}

export async function scrapeWebSources(): Promise<RawArticle[]> {
  const results = await Promise.allSettled([scrapeWorldMonitor(), scrapePizzint()]);

  const articles: RawArticle[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      articles.push(...result.value);
    }
  }

  return articles;
}
