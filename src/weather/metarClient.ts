/**
 * METAR ground-truth client.
 *
 * Fetches hourly METAR observations from aviationweather.gov for international
 * ICAO stations that Polymarket resolves via NOAA WRH (Istanbul/LTFM,
 * Tel Aviv/LLBG, Moscow/UUWW, Taipei/RCTP). Derives the daily maximum from
 * the hourly `temp` field.
 *
 * Endpoint: GET https://aviationweather.gov/api/data/metar?ids={ICAO}&hours=720&format=json
 * No auth required. Max lookback: 720 hours (~30 days).
 *
 * Log marker: [weather-metar]
 */

import { logger } from '../shared/logger.js';

const METAR_BASE = 'https://aviationweather.gov/api/data/metar';
const MAX_HOURS = 720;
const REQUEST_TIMEOUT_MS = 10_000;

export type FetchFn = typeof fetch;

function fetchWithTimeout(url: string, fetchFn: FetchFn): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetchFn(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

interface MetarObservation {
  reportTime: string; // UTC ISO8601, e.g. "2026-04-17 14:00:00"
  temp: number | null;
}

/**
 * Fetch the daily maximum temperature from the METAR record for an ICAO station.
 * Groups observations by UTC date; use the group matching `date`.
 *
 * Returns null if the date is outside the 30-day window or data is unavailable.
 */
export async function fetchMetarDailyHigh(
  icao: string,
  date: string, // YYYY-MM-DD
  fetchFn: FetchFn = fetch,
): Promise<number | null> {
  const url = `${METAR_BASE}?ids=${icao}&hours=${MAX_HOURS}&format=json`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, fetchFn);
  } catch (err) {
    logger.warn('[weather-metar] fetch error', {
      icao, date, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!res.ok) {
    logger.warn('[weather-metar] unexpected status', { icao, date, status: res.status });
    return null;
  }

  const obs = (await res.json()) as MetarObservation[];
  if (!Array.isArray(obs) || obs.length === 0) {
    logger.debug('[weather-metar] no observations returned', { icao, date });
    return null;
  }

  // reportTime is UTC; filter to observations whose UTC date matches the target.
  const dayObs = obs.filter(
    (o) => typeof o.temp === 'number' && o.reportTime?.slice(0, 10) === date,
  );

  if (dayObs.length === 0) {
    logger.debug('[weather-metar] no observations for target date', { icao, date });
    return null;
  }

  const maxTemp = Math.max(...dayObs.map((o) => o.temp as number));
  logger.debug('[weather-metar] daily high fetched', { icao, date, maxTemp, obsCount: dayObs.length });
  return maxTemp;
}
