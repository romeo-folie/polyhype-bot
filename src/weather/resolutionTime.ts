/**
 * City-local weather resolution-time helpers.
 *
 * Centralises the logic for computing when a weather market actually resolves
 * (local city midnight after the target date) so that the monitor, executor,
 * residual sweep, and scanner all agree on the same boundary.
 *
 * Gamma's endDate field is unreliable for UTC+ cities (off by 24h) and should
 * not be used for guard decisions. Always use cityDayEndUtcMs instead.
 */

import { lookupCity } from './noaaClient.js';

/** Return today's date string (YYYY-MM-DD) in the given IANA timezone. */
export function cityLocalDate(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

/**
 * Return the UTC millisecond timestamp for the end of `targetDate` in `tz`
 * (i.e. local midnight of the following day — the instant the city's calendar
 * day rolls over to the next day).
 *
 * Works for any IANA timezone: UTC+ cities (HK, Taipei, Tokyo) adjust backwards;
 * UTC- cities (NYC, LA, Chicago) adjust forwards.
 */
export function cityDayEndUtcMs(targetDate: string, tz: string): number {
  const parts0 = targetDate.split('-');
  const y = parseInt(parts0[0] ?? '2000', 10);
  const m = parseInt(parts0[1] ?? '1', 10);
  const d = parseInt(parts0[2] ?? '1', 10);
  const utcMidnight = Date.UTC(y, m - 1, d + 1);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(utcMidnight);
  const h   = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0', 10);
  const min = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  const sec = parseInt(parts.find(p => p.type === 'second')?.value ?? '0', 10);
  const localMs = h * 3_600_000 + min * 60_000 + sec * 1000;
  // UTC+ cities: local time at utcMidnight is morning → subtract offset to reach local midnight
  // UTC- cities: local time is afternoon/evening → add remaining hours to midnight
  return localMs <= 12 * 3_600_000
    ? utcMidnight - localMs
    : utcMidnight + (86_400_000 - localMs);
}

/**
 * Parse a weather resolution end time from a `sourcedFrom` string of the form
 * `weather:<city>:<YYYY-MM-DD>:<bracket>`. When the sourcedFrom is
 * `reconciled:weather` (no embedded city/date), falls back to parsing the
 * market question string if provided. Pass `rawEndDate` (Gamma's endDate value)
 * so the year-inference fallback avoids a January/December boundary bug.
 *
 * Returns null when neither source yields a parseable city+date.
 */
export function weatherResolutionEndMs(sourcedFrom: string, question?: string, rawEndDate?: string): number | null {
  if (sourcedFrom.startsWith('weather:')) {
    const parts = sourcedFrom.split(':');
    const city = parts[1];
    const date = parts[2];
    if (city && date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const coords = lookupCity(city);
      if (coords) return cityDayEndUtcMs(date, coords.tz);
    }
  }
  // Fallback: parse city + date from the market question text (used for
  // reconciled:weather imports where sourcedFrom has no embedded city/date).
  if (question) {
    const endDateStr = weatherEndDateFromQuestion(question, rawEndDate);
    if (endDateStr) return new Date(endDateStr).getTime();
  }
  return null;
}

/**
 * Derive the correct city-local resolution end date from a weather market
 * question string ("Will the highest temperature in Hong Kong be …on May 31?").
 *
 * Returns an ISO 8601 string (e.g. "2026-05-31T16:00:00.000Z" for HK May 31)
 * or null when the question cannot be parsed or the city is unrecognised.
 *
 * Used by the reconciler to write a correct endDate on imported weather
 * positions instead of relying on Gamma's API value (which is 24h late for
 * UTC+ cities).
 */
export function weatherEndDateFromQuestion(question: string, rawEndDate?: string): string | null {
  // Extract city: "highest temperature in <city> <verb>"
  const cityMatch = question.match(
    /highest temperature in ([^?]+?) (?:be |exceed |fall |drop |reach |\d)/i,
  );
  if (!cityMatch) return null;
  const city = cityMatch[1]!.trim().toLowerCase();
  const coords = lookupCity(city);
  if (!coords) return null;

  // Extract date: "on <Month> <D>[st|nd|rd|th][, <YYYY>]"
  const dateMatch = question.match(/\bon (\w+ \d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?)\??/i);
  if (!dateMatch) return null;
  const rawDate = dateMatch[1]!.replace(/(\d+)(?:st|nd|rd|th)\b/g, '$1').trim();
  // If no year in the string, derive it from the Gamma endDate when available
  // (avoids a year-boundary bug when called in January for a December market).
  const fallbackYear = rawEndDate
    ? new Date(rawEndDate).getFullYear()
    : new Date().getFullYear();
  const withYear = /\d{4}/.test(rawDate) ? rawDate : `${rawDate} ${fallbackYear}`;
  const parsed = new Date(withYear);
  if (isNaN(parsed.getTime())) return null;
  const targetDate = parsed.toISOString().slice(0, 10);
  return new Date(cityDayEndUtcMs(targetDate, coords.tz)).toISOString();
}
