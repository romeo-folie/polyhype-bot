/**
 * Weather Underground ground-truth client.
 *
 * Calls api.weather.com/v1/location/{ICAO}:9:{ISO2}/observations/historical.json
 * — the same endpoint WU's own Angular frontend uses. The API key is embedded in
 * WU's server-rendered HTML (app-root-state blob) and cached in Redis for 7 days.
 * On a 401 / 403 response it re-extracts the key from a fresh page load and retries
 * once, so key rotations are handled transparently.
 *
 * Log marker: [weather-wu]
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';

const WU_REDIS_KEY = 'weather:wu_api_key';
const WU_KEY_TTL_S = 7 * 24 * 60 * 60;
const WU_KEY_REFRESH_URL =
  'https://www.wunderground.com/history/daily/gb/london/EGLC/date/2026-1-1';
const REQUEST_TIMEOUT_MS = 10_000;

export type FetchFn = typeof fetch;

function fetchWithTimeout(url: string, options: RequestInit, fetchFn: FetchFn): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetchFn(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function extractKeyFromPage(html: string): string | null {
  // WU embeds the key in two forms depending on render path:
  //   JSON app-state: "apiKey":"<hex32>"
  //   URL query param: apiKey=<hex32>
  const m = html.match(/"apiKey"\s*:\s*"([0-9a-f]{32})"|[?&]apiKey=([0-9a-f]{32})/i);
  return m?.[1] ?? m?.[2] ?? null;
}

async function refreshKey(redis: Redis, fetchFn: FetchFn): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      WU_KEY_REFRESH_URL,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      },
      fetchFn,
    );
    if (res.ok) {
      const html = await res.text();
      const key = extractKeyFromPage(html);
      if (key) {
        await redis.set(WU_REDIS_KEY, key, 'EX', WU_KEY_TTL_S);
        logger.info('[weather-wu] api key refreshed from page');
        return key;
      }
      logger.warn('[weather-wu] key not found in page response');
    } else {
      logger.warn('[weather-wu] key refresh page returned non-ok status', { status: res.status });
    }
  } catch (err) {
    logger.warn('[weather-wu] key refresh fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

async function getKey(redis: Redis, fetchFn: FetchFn, force = false): Promise<string | null> {
  const envKey = process.env.WU_API_KEY;
  const validEnvKey = envKey && /^[0-9a-f]{32}$/i.test(envKey) ? envKey : null;

  if (force) {
    // On 401/403 retry: attempt a real page refresh first so key rotation still works,
    // then fall back to env var, then cached — never short-circuit to env var directly.
    const refreshed = await refreshKey(redis, fetchFn);
    if (refreshed) return refreshed;
    if (validEnvKey) {
      await redis.set(WU_REDIS_KEY, validEnvKey, 'EX', WU_KEY_TTL_S);
      return validEnvKey;
    }
    logger.warn('[weather-wu] key refresh failed');
    return null;
  }

  // Normal lookup: Redis cache → env var → page scrape.
  const cached = await redis.get(WU_REDIS_KEY);
  if (cached) return cached;

  if (validEnvKey) {
    // Seed Redis so subsequent per-city calls within the same run hit the cache.
    await redis.set(WU_REDIS_KEY, validEnvKey, 'EX', WU_KEY_TTL_S);
    return validEnvKey;
  }

  const refreshed = await refreshKey(redis, fetchFn);
  if (!refreshed) logger.warn('[weather-wu] key refresh failed and no cached key available');
  return refreshed;
}

interface WuObservation {
  valid_time_gmt: number;
  temp: number | null;
}

/**
 * Fetch the daily extreme temperature (max or min) from WU for a specific ICAO
 * station and date. Returns null if the station is unavailable or data is missing
 * for that date.
 *
 * The WU historical endpoint returns the same array of hourly observations
 * regardless of metric — `max(temps)` is the daily high, `min(temps)` the daily
 * low. "Lowest temperature" Polymarket markets resolve against this daily minimum.
 *
 * @param icao       ICAO station code (e.g. 'EGLC')
 * @param isoCountry ISO 3166-1 alpha-2 country code (e.g. 'GB')
 * @param date       Target date YYYY-MM-DD
 * @param unit       Temperature unit: 'fahrenheit' | 'celsius'
 * @param metric     'high' (daily max, default) | 'low' (daily min)
 */
export async function fetchWuHistoricalExtreme(
  icao: string,
  isoCountry: string,
  date: string,
  unit: 'fahrenheit' | 'celsius',
  redis: Redis,
  metric: 'high' | 'low' = 'high',
  fetchFn: FetchFn = fetch,
): Promise<number | null> {
  const dateStr = date.replace(/-/g, '');
  const units = unit === 'fahrenheit' ? 'e' : 'm';

  for (let attempt = 0; attempt < 2; attempt++) {
    const key = await getKey(redis, fetchFn, attempt > 0);
    if (!key) {
      logger.warn('[weather-wu] no api key available', { icao, date });
      return null;
    }
    const url =
      `https://api.weather.com/v1/location/${icao}:9:${isoCountry}/observations/historical.json` +
      `?apiKey=${key}&units=${units}&startDate=${dateStr}&endDate=${dateStr}`;

    let res: Response;
    try {
      res = await fetchWithTimeout(url, {}, fetchFn);
    } catch (err) {
      logger.warn('[weather-wu] fetch error', {
        icao, date, error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    if (res.status === 401 || res.status === 403) {
      if (attempt === 0) continue; // retry with refreshed key
      logger.warn('[weather-wu] auth failed after key refresh', { icao, date });
      return null;
    }

    if (!res.ok) {
      logger.warn('[weather-wu] unexpected status', { icao, date, status: res.status });
      return null;
    }

    let data: { observations?: WuObservation[] };
    try {
      data = (await res.json()) as { observations?: WuObservation[] };
    } catch {
      logger.warn('[weather-wu] JSON parse failed', { icao, date });
      return null;
    }
    const obs = data.observations;
    if (!obs?.length) {
      logger.debug('[weather-wu] no observations returned', { icao, date });
      return null;
    }

    const temps = obs.map((o) => o.temp).filter((t): t is number => typeof t === 'number');
    if (!temps.length) return null;

    const extreme = metric === 'low' ? Math.min(...temps) : Math.max(...temps);
    logger.debug('[weather-wu] daily extreme fetched', { icao, date, metric, extreme, obsCount: obs.length });
    return Math.round(extreme * 10) / 10;
  }

  return null;
}

/**
 * Fetch the daily MAXIMUM temperature from WU. Thin wrapper over
 * {@link fetchWuHistoricalExtreme} preserving the original call signature.
 */
export function fetchWuHistoricalHigh(
  icao: string,
  isoCountry: string,
  date: string,
  unit: 'fahrenheit' | 'celsius',
  redis: Redis,
  fetchFn: FetchFn = fetch,
): Promise<number | null> {
  return fetchWuHistoricalExtreme(icao, isoCountry, date, unit, redis, 'high', fetchFn);
}

/**
 * Fetch the daily MINIMUM temperature from WU — the resolution value for
 * "Lowest temperature in [city]" markets.
 */
export function fetchWuHistoricalLow(
  icao: string,
  isoCountry: string,
  date: string,
  unit: 'fahrenheit' | 'celsius',
  redis: Redis,
  fetchFn: FetchFn = fetch,
): Promise<number | null> {
  return fetchWuHistoricalExtreme(icao, isoCountry, date, unit, redis, 'low', fetchFn);
}
