/**
 * GDELT v2 geopolitical event fetcher.
 *
 * Uses a single combined ArtList query per cycle for full theme coverage while
 * minimizing API call pressure.
 *
 * Endpoint:
 *   https://api.gdeltproject.org/api/v2/doc/doc
 */

import axios from 'axios';
import { logger } from '../shared/logger.js';
import type { RssItem } from './rss.js';

const GDELT_TIMEOUT_MS = 15_000;
const GDELT_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_MAX_RETRIES = 1;
const GDELT_RETRY_DELAY_MS = 6_000;

/** Timespan in hours to look back. Matches the 5-minute cron cycle with overlap. */
const GDELT_TIMESPAN_HOURS = 1;
const GDELT_MAX_RECORDS = 75;

interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string; // YYYYMMDDTHHMMSSZ
  language?: string;
}

interface GdeltResponse {
  articles?: GdeltArticle[];
}

/**
 * Combined thematic query keeps full coverage in one API request.
 * This is more rate-limit friendly than issuing one request per theme.
 */
const GDELT_THEME_QUERY =
  '(theme:CRISISLEX_CRISISLEXREC OR theme:WB_2243_CONFLICT_AND_VIOLENCE OR theme:TERROR OR theme:PROTEST OR theme:ELECTION OR theme:REVOLUTION OR theme:DIPLOMACY OR theme:SANCTIONS OR theme:MILITARY OR theme:GEOPOLITICS)';

/**
 * Parse GDELT compact date format: YYYYMMDDTHHMMSSZ → Date.
 */
function parseGdeltDate(seendate: string | undefined): Date {
  if (!seendate) return new Date();
  const match = seendate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return new Date();
  const [, year, month, day, hour, minute, second] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const maybeResponse = (err as { response?: { status?: number } }).response;
  return maybeResponse?.status === 429;
}

async function fetchGdeltCombined(): Promise<RssItem[]> {
  const retryDelayMs = process.env.NODE_ENV === 'test' ? 0 : GDELT_RETRY_DELAY_MS;

  const params = new URLSearchParams({
    query: GDELT_THEME_QUERY,
    mode: 'artlist',
    maxrecords: GDELT_MAX_RECORDS.toString(),
    format: 'json',
    timespan: `${GDELT_TIMESPAN_HOURS.toString()}h`,
  });

  const url = `${GDELT_BASE}?${params.toString()}`;
  let data: GdeltResponse;

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await axios.get<GdeltResponse>(url, {
        timeout: GDELT_TIMEOUT_MS,
        headers: { 'User-Agent': 'PGA-Bot/1.0 (geopolitical-agent)' },
      });
      data = response.data;
      break;
    } catch (err: unknown) {
      const retryable = isRateLimitError(err) && attempt < GDELT_MAX_RETRIES;
      if (!retryable) throw err;

      logger.warn('[scraper] GDELT rate-limited; retrying combined fetch', {
        attempt: attempt + 1,
        waitMs: retryDelayMs,
      });
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }

  const articles = data.articles ?? [];
  const items: RssItem[] = [];

  for (const article of articles) {
    const title = article.title?.trim();
    const articleUrl = article.url?.trim();
    if (!title || !articleUrl) continue;

    if (article.language && article.language.toLowerCase() !== 'english') continue;

    items.push({
      title,
      url: articleUrl,
      publishedAt: parseGdeltDate(article.seendate),
      source: 'GDELT Combined',
    });
  }

  return items;
}

/**
 * Fetch geopolitical headlines from GDELT v2.
 *
 * Single combined query per cycle (full theme coverage), deduplicated by URL.
 * Failures are logged and return empty array (fail-silent behavior).
 */
export async function scrapeHeadlines(): Promise<RssItem[]> {
  const result = await fetchGdeltCombined().then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );

  if (result.status === 'rejected') {
    logger.warn('[scraper] GDELT fetch failed', { error: String(result.reason) });
    logger.info('[scraper] GDELT fetch complete', { count: 0 });
    return [];
  }

  const seenUrls = new Set<string>();
  const deduped: RssItem[] = [];

  for (const item of result.value) {
    if (seenUrls.has(item.url)) continue;
    seenUrls.add(item.url);
    deduped.push(item);
  }

  logger.info('[scraper] GDELT fetch complete', { count: deduped.length });
  return deduped;
}
