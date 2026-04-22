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
const WU_KEY_FALLBACK = 'e1f10a1e78da46f5b10a1e78da96f525';
const WU_KEY_TTL_S = 7 * 24 * 60 * 60;
const WU_KEY_REFRESH_URL =
  'https://www.wunderground.com/history/daily/gb/london/EGLC/date/2026-1-1';

export type FetchFn = typeof fetch;

async function extractKeyFromPage(html: string): Promise<string | null> {
  // Key is a 32-char hex string used as apiKey in the weather.com calls
  const m = html.match(/"apiKey"\s*:\s*"([0-9a-f]{32})"/i);
  return m?.[1] ?? null;
}

async function refreshKey(redis: Redis, fetchFn: FetchFn): Promise<string> {
  try {
    const res = await fetchFn(WU_KEY_REFRESH_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; pga-weather/1.0)' },
    });
    if (res.ok) {
      const html = await res.text();
      const key = await extractKeyFromPage(html);
      if (key) {
        await redis.set(WU_REDIS_KEY, key, 'EX', WU_KEY_TTL_S);
        logger.info('[weather-wu] api key refreshed from page');
        return key;
      }
    }
  } catch (err) {
    logger.warn('[weather-wu] key refresh fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  logger.warn('[weather-wu] falling back to hardcoded key');
  return WU_KEY_FALLBACK;
}

async function getKey(redis: Redis, fetchFn: FetchFn, force = false): Promise<string> {
  if (!force) {
    const cached = await redis.get(WU_REDIS_KEY);
    if (cached) return cached;
  }
  return refreshKey(redis, fetchFn);
}

interface WuObservation {
  valid_time_gmt: number;
  temp: number | null;
}

/**
 * Fetch the daily maximum temperature from WU for a specific ICAO station and date.
 * Returns null if the station is unavailable or data is missing for that date.
 *
 * @param icao       ICAO station code (e.g. 'EGLC')
 * @param isoCountry ISO 3166-1 alpha-2 country code (e.g. 'GB')
 * @param date       Target date YYYY-MM-DD
 * @param unit       Temperature unit: 'fahrenheit' | 'celsius'
 */
export async function fetchWuHistoricalHigh(
  icao: string,
  isoCountry: string,
  date: string,
  unit: 'fahrenheit' | 'celsius',
  redis: Redis,
  fetchFn: FetchFn = fetch,
): Promise<number | null> {
  const dateStr = date.replace(/-/g, '');
  const units = unit === 'fahrenheit' ? 'e' : 'm';

  for (let attempt = 0; attempt < 2; attempt++) {
    const key = await getKey(redis, fetchFn, attempt > 0);
    const url =
      `https://api.weather.com/v1/location/${icao}:9:${isoCountry}/observations/historical.json` +
      `?apiKey=${key}&units=${units}&startDate=${dateStr}&endDate=${dateStr}`;

    let res: Response;
    try {
      res = await fetchFn(url);
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

    const data = (await res.json()) as { observations?: WuObservation[] };
    const obs = data.observations;
    if (!obs?.length) {
      logger.debug('[weather-wu] no observations returned', { icao, date });
      return null;
    }

    const temps = obs.map((o) => o.temp).filter((t): t is number => typeof t === 'number');
    if (!temps.length) return null;

    const maxTemp = Math.max(...temps);
    logger.debug('[weather-wu] daily high fetched', { icao, date, maxTemp, obsCount: obs.length });
    return Math.round(maxTemp * 10) / 10;
  }

  return null;
}
