/**
 * GDELT v2 geopolitical event fetcher.
 *
 * Replaces the original Cheerio scraper targeting worldmonitor.app and pizzint.watch,
 * both of which are client-side React SPAs that return no usable HTML to a basic HTTP
 * client. GDELT v2's ArtList API is a public, no-auth-required JSON endpoint that
 * updates every 15 minutes and covers the same geopolitical signal space.
 *
 * GDELT v2 ArtList endpoint:
 *   https://api.gdeltproject.org/api/v2/artlist/artlist
 *   ?query=<theme or keyword>
 *   &mode=artlist
 *   &maxrecords=<n>
 *   &format=json
 *   &timespan=<Nh>   (hours of lookback)
 *
 * Themes used:
 *   - CRISISLEX_CRISISLEXREC  (breaking crisis/conflict)
 *   - PROTEST                 (civil unrest)
 *   - WB_2243_CONFLICT_AND_VIOLENCE (conflict/violence)
 *   - TERROR                  (terrorism)
 *
 * Failures are logged and return empty arrays — never throws.
 */

import axios from 'axios';
import { logger } from '../shared/logger.js';
import type { RssItem } from './rss.js';

const GDELT_TIMEOUT_MS = 15_000;
const GDELT_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_MAX_RETRIES = 1;
const GDELT_RETRY_DELAY_MS = 6_000;

/** Timespan in hours to look back. Matches the 5-minute cron cycle with generous overlap. */
const GDELT_TIMESPAN_HOURS = 1;
const GDELT_MAX_RECORDS = 50;

interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string; // YYYYMMDDTHHMMSSZ
  domain?: string;
  language?: string;
  sourcecountry?: string;
}

interface GdeltResponse {
  articles?: GdeltArticle[];
}

/** GDELT themes that map to geopolitical urgency signals relevant to Polymarket. */
const GDELT_QUERIES: Array<{ theme: string; label: string }> = [
  { theme: 'CRISISLEX_CRISISLEXREC', label: 'GDELT Crisis' },
  { theme: 'WB_2243_CONFLICT_AND_VIOLENCE', label: 'GDELT Conflict' },
  { theme: 'TERROR', label: 'GDELT Terror' },
  { theme: 'PROTEST', label: 'GDELT Protest' },
];

/**
 * Parse GDELT's compact date format: YYYYMMDDTHHMMSSZ → Date
 * Returns current time on parse failure.
 */
function parseGdeltDate(seendate: string | undefined): Date {
  if (!seendate) return new Date();
  // Format: 20260319T080000Z
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

async function fetchGdeltTheme(theme: string, label: string): Promise<RssItem[]> {
  const params = new URLSearchParams({
    query: `theme:${theme}`,
    mode: 'artlist',
    maxrecords: String(GDELT_MAX_RECORDS),
    format: 'json',
    timespan: `${String(GDELT_TIMESPAN_HOURS)}h`,
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
    } catch (err) {
      const isRetryable = isRateLimitError(err) && attempt < GDELT_MAX_RETRIES;
      if (!isRetryable) throw err;

      logger.warn('[scraper] GDELT rate-limited; retrying theme fetch', {
        theme,
        attempt: attempt + 1,
        waitMs: GDELT_RETRY_DELAY_MS,
      });
      await sleep(GDELT_RETRY_DELAY_MS);
    }
  }

  const articles = data?.articles ?? [];
  const items: RssItem[] = [];

  for (const article of articles) {
    const title = article.title?.trim();
    const articleUrl = article.url?.trim();
    if (!title || !articleUrl) continue;

    // Skip non-English articles — LLM urgency scorer expects English
    if (article.language && article.language.toLowerCase() !== 'english') continue;

    items.push({
      title,
      url: articleUrl,
      publishedAt: parseGdeltDate(article.seendate),
      source: label,
    });
  }

  return items;
}

/**
 * Fetch geopolitical headlines from GDELT v2 across multiple crisis themes.
 *
 * GDELT enforces a 5-second rate limit between requests. Themes are queried
 * sequentially with a 6-second gap to stay within the limit.
 *
 * Results are deduplicated by URL before returning. Failures per-theme are logged
 * and skipped — at least one theme succeeding is sufficient for pipeline operation.
 */
/** Delay between GDELT requests to respect the 5-second rate limit. Overridable in tests. */
export const GDELT_REQUEST_DELAY_MS = 6_000;

export async function scrapeHeadlines(
  _delayMs = GDELT_REQUEST_DELAY_MS,
): Promise<RssItem[]> {
  const delayMs = process.env['NODE_ENV'] === 'test' ? 0 : _delayMs;
  const results: Array<PromiseSettledResult<RssItem[]>> = [];
  for (let i = 0; i < GDELT_QUERIES.length; i++) {
    if (i > 0 && delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    const { theme, label } = GDELT_QUERIES[i]!;
    const result = await fetchGdeltTheme(theme, label).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    results.push(result);
  }
  const seenUrls = new Set<string>();
  const deduped: RssItem[] = [];

  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn('[scraper] GDELT theme fetch failed', { error: String(result.reason) });
      continue;
    }
    for (const item of result.value) {
      if (seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);
      deduped.push(item);
    }
  }

  logger.info('[scraper] GDELT fetch complete', { count: deduped.length });
  return deduped;
}
