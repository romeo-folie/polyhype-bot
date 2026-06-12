/**
 * METAR ground-truth client.
 *
 * Fetches hourly METAR observations from aviationweather.gov for international
 * ICAO stations. Derives the daily maximum from the hourly `temp` field.
 *
 * Endpoint: GET https://aviationweather.gov/api/data/metar?ids={ICAO}&hours=720&format=json
 * No auth required.
 *
 * Effective lookback: ~8–9 days, NOT the 30 days the `hours=720` query
 * parameter suggests. aviationweather.gov caps responses at ~400 observations
 * regardless of the requested range, so older dates return empty. Callers
 * that need a longer historical window should route via `wuClient.ts`
 * instead — METAR is only suitable for day-after fetches.
 * As of 2026-06-12, istanbul (LTFM) resolves through this client: the
 * market settles on NOAA's timeseries for LTFM (same METAR feed) and WU
 * returns HTTP 400 for that station. All other international stations
 * stay on WU (2026-04-24 backfill audit).
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
 * Convert a METAR UTC reportTime to the calendar date (YYYY-MM-DD) in the
 * given IANA timezone. Returns null when the timestamp is unparseable.
 */
function reportTimeToLocalDate(
  reportTime: string,
  formatter: Intl.DateTimeFormat,
): string | null {
  const iso = reportTime.trim().replace(' ', 'T');
  // Append Z only when no UTC designator/offset is already present —
  // "…+00:00" is valid ISO 8601 and must not be double-suffixed.
  const hasZone = iso.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(iso);
  const utc = new Date(hasZone ? iso : `${iso}Z`);
  if (Number.isNaN(utc.getTime())) return null;
  // en-CA locale renders as YYYY-MM-DD.
  return formatter.format(utc);
}

/**
 * Fetch the daily maximum temperature from the METAR record for an ICAO station.
 *
 * When `tz` is provided, observations are grouped by the station's LOCAL
 * calendar date — Polymarket settles on the station's local day, so a UTC
 * grouping would drop the first hours of the local day and absorb the first
 * hours of the next one (3h misalignment for Istanbul, UTC+3). Without `tz`
 * the legacy UTC grouping applies.
 *
 * Returns null if the date is outside the effective ~8–9 day window or data is unavailable.
 */
export async function fetchMetarDailyHigh(
  icao: string,
  date: string, // YYYY-MM-DD, in the station's local calendar when tz is given
  fetchFn: FetchFn = fetch,
  tz?: string, // IANA timezone of the station, e.g. 'Europe/Istanbul'
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

  let obs: MetarObservation[];
  try {
    obs = (await res.json()) as MetarObservation[];
  } catch {
    logger.warn('[weather-metar] JSON parse failed', { icao, date });
    return null;
  }
  if (!Array.isArray(obs) || obs.length === 0) {
    logger.debug('[weather-metar] no observations returned', { icao, date });
    return null;
  }

  let formatter: Intl.DateTimeFormat | null = null;
  if (tz) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      logger.warn('[weather-metar] invalid timezone — falling back to UTC grouping', { icao, tz });
    }
  }

  // reportTime is UTC; keep observations whose station-local (or, without a
  // usable tz, UTC) calendar date matches the target.
  const dayObs = obs.filter((o) => {
    if (typeof o.temp !== 'number' || !o.reportTime) return false;
    const obsDate = formatter
      ? reportTimeToLocalDate(o.reportTime, formatter)
      : o.reportTime.slice(0, 10);
    return obsDate === date;
  });

  if (dayObs.length === 0) {
    logger.debug('[weather-metar] no observations for target date', { icao, date });
    return null;
  }

  const maxTemp = Math.max(...dayObs.map((o) => o.temp!));
  logger.debug('[weather-metar] daily high fetched', { icao, date, maxTemp, obsCount: dayObs.length });
  return maxTemp;
}
