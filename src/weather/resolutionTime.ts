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

/** Return the current hour-of-day (0-23) in the given IANA timezone. */
export function cityLocalHour(tz: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' })
    .format(new Date());
  return parseInt(h, 10);
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

interface ParsedWeatherMarket {
  /** City as written in the question, lower-cased. */
  city: string;
  /** IANA timezone of the resolution station. */
  tz: string;
  /** City-local target date (YYYY-MM-DD) — the "on June 13" the market is about. */
  targetDate: string;
}

/**
 * Parse the city, timezone, and city-local target date out of a weather market
 * question ("Will the highest temperature in Hong Kong be …on May 31?").
 * Shared by the target-date and end-date helpers below. Returns null when the
 * question cannot be parsed or the city is unrecognised.
 *
 * `rawEndDate` (Gamma's endDate, or the digest's closed_at) anchors year
 * inference when the question omits a year, avoiding a January/December boundary
 * bug.
 */
function parseWeatherCityDate(question: string, rawEndDate?: string): ParsedWeatherMarket | null {
  // Extract city: "highest|lowest temperature in <city> <verb>"
  const cityMatch = question.match(
    /(?:highest|lowest) temperature in ([^?]+?) (?:be |exceed |fall |drop |reach |\d)/i,
  );
  if (!cityMatch) return null;
  const city = cityMatch[1]!.trim().toLowerCase();
  const coords = lookupCity(city);
  if (!coords) return null;

  // Extract date: "on <Month> <D>[st|nd|rd|th][, <YYYY>]"
  const dateMatch = question.match(/\bon (\w+ \d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?)\??/i);
  if (!dateMatch) return null;
  const rawDate = dateMatch[1]!.replace(/(\d+)(?:st|nd|rd|th)\b/g, '$1').trim();

  let parsed: Date;
  if (/\d{4}/.test(rawDate)) {
    parsed = new Date(rawDate);
  } else {
    // Year omitted. A weather market resolves at city-local midnight just AFTER
    // its target date, so the anchor (endDate / closed_at) is within ~36h of the
    // target. Pick the year whose Month-Day lands CLOSEST to the anchor rather
    // than blindly reusing the anchor's year — the latter shifts a "December 31"
    // market that redeems on January 1 into the wrong year (Dec 31 of the new
    // year), which then fails the digest's weather-day match and hides the row.
    const rawMs = rawEndDate ? new Date(rawEndDate).getTime() : Date.now();
    const anchorMs = isFinite(rawMs) ? rawMs : Date.now();
    const anchorYear = new Date(anchorMs).getUTCFullYear();
    let best: Date | null = null;
    for (const y of [anchorYear - 1, anchorYear, anchorYear + 1]) {
      const cand = new Date(`${rawDate} ${y}`);
      if (isNaN(cand.getTime())) continue;
      if (
        !best ||
        Math.abs(cand.getTime() - anchorMs) < Math.abs(best.getTime() - anchorMs)
      ) {
        best = cand;
      }
    }
    if (!best) return null;
    parsed = best;
  }
  if (isNaN(parsed.getTime())) return null;
  return { city, tz: coords.tz, targetDate: parsed.toISOString().slice(0, 10) };
}

/**
 * Derive the city-local target date (YYYY-MM-DD) a weather market is about — the
 * "on June 13" in the question — independent of the city's timezone. Used to
 * group resolutions by the weather day they belong to (a "June 13" market
 * resolves at city-local midnight, which for Western-hemisphere cities is the
 * NEXT UTC day, so closed_at's UTC date is the wrong grouping key).
 *
 * Returns null when the question cannot be parsed or the city is unrecognised.
 */
export function weatherTargetDateFromQuestion(question: string, rawEndDate?: string): string | null {
  return parseWeatherCityDate(question, rawEndDate)?.targetDate ?? null;
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
  const parsed = parseWeatherCityDate(question, rawEndDate);
  if (!parsed) return null;
  return new Date(cityDayEndUtcMs(parsed.targetDate, parsed.tz)).toISOString();
}
