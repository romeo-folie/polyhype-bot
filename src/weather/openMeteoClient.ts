/**
 * Open-Meteo Weather Forecast Client
 *
 * Fetches weather forecasts from the Open-Meteo API for international cities
 * (NOAA/NWS only covers the US). Also provides ensemble forecast data for
 * dynamic uncertainty estimation.
 *
 * Two endpoints:
 *   1. Deterministic forecast: daily high/low temperature, precip probability
 *   2. Ensemble forecast: 31 GFS members for dynamic stddev estimation
 *
 * No API key required. Fair-use rate limits: ~10,000 requests/day.
 * Global coverage using regional models (JMA for Japan, KMA for Korea, etc.).
 *
 * Log marker: [weather]
 */

import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getRedis } from '../shared/redis.js';

const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';
const ENSEMBLE_BASE = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const ARCHIVE_BASE = 'https://archive-api.open-meteo.com/v1/archive';
const REQUEST_TIMEOUT_MS = 10_000;

// Rate limiter: ~2 req/sec to stay well within fair-use limits.
// Serializes requests via a promise chain so concurrent calls queue.
// Skipped when a custom fetchFn is injected (test / DI path).
const RATE_LIMIT_DELAY_MS = 500;
let requestQueue: Promise<void> = Promise.resolve();

function rateLimitWait(): Promise<void> {
  requestQueue = requestQueue.then(
    () => new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS)),
  );
  return requestQueue;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface OpenMeteoForecast {
  /** Forecast high temperature in the requested unit. */
  highTemp: number;
  /** Forecast low temperature in the requested unit. */
  lowTemp: number;
  /** Precipitation probability (0-100). */
  precipProbability: number;
  /** The date this forecast applies to (YYYY-MM-DD). */
  forecastDate: string;
}

export interface EnsembleForecast {
  /** Mean of ensemble member high temperatures. */
  meanHigh: number;
  /** Standard deviation of ensemble member high temperatures. */
  stddevHigh: number;
  /** Mean of ensemble member low temperatures. */
  meanLow: number;
  /** Standard deviation of ensemble member low temperatures. */
  stddevLow: number;
  /** Number of ensemble members used. */
  memberCount: number;
  /** The date this forecast applies to (YYYY-MM-DD). */
  forecastDate: string;
  /** Which ensemble model was used. */
  ensembleModel: 'gfs' | 'ecmwf';
}

/** Injectable fetch function for testing. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ── Internal helpers ───────────────────────────────────────────────────────

function fetchWithTimeout(url: string, fetchFn: FetchFn = fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  return fetchFn(url, { signal: controller.signal }).finally(() => {
    clearTimeout(timer);
  });
}

// Backoff between retry attempts: 750ms, then 1500ms (linear, not exponential —
// the 10s per-attempt timeout already bounds total latency, and the shared
// rate-limit queue spaces production requests regardless).
const RETRY_BACKOFF_MS = 750;

/**
 * fetchWithTimeout plus bounded retries on transient failures.
 *
 * Retries 5xx responses and thrown network errors (timeouts/aborts/resets) up
 * to `retryCount` additional attempts. NEVER retries HTTP 429 — we're already
 * rate-limited at that point and hammering the API makes it worse; the response
 * is returned immediately so the caller's existing `!res.ok` logging fires.
 * Other non-5xx statuses (4xx) are returned immediately as well.
 *
 * `retryCount = 0` (the default) is a transparent pass-through, so direct
 * callers and existing tests see exactly one attempt unless they opt in.
 * Production opts in via WEATHER_FORECAST_RETRY_COUNT threaded through
 * fetchForecast (weatherScanner.ts).
 */
async function fetchWithRetry(
  url: string,
  fetchFn: FetchFn,
  retryCount: number,
): Promise<Response> {
  const maxAttempts = Math.max(1, retryCount + 1);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await new Promise<void>((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt - 1)));
    }
    try {
      const res = await fetchWithTimeout(url, fetchFn);
      if (res.status === 429) return res; // rate-limited — never retry
      if (res.status >= 500 && attempt < maxAttempts) {
        logger.debug('[weather] retrying Open-Meteo after 5xx', {
          status: res.status,
          attempt,
          maxAttempts,
        });
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        logger.debug('[weather] retrying Open-Meteo after network error', {
          error: err instanceof Error ? err.message : String(err),
          attempt,
          maxAttempts,
        });
        continue;
      }
    }
  }
  throw lastErr;
}

// ── Open-Meteo response shapes ─────────────────────────────────────────────

interface DailyForecastResponse {
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
  };
}

interface EnsembleDailyResponse {
  daily?: {
    time?: string[];
    temperature_2m_max?: number[][];
    temperature_2m_min?: number[][];
  };
}

/** Minimal shape of the archive endpoint response — kept separate from
 *  DailyForecastResponse so the two endpoints can diverge without silent
 *  misparsing. We request both daily extremes so one call grounds both the
 *  highest- and lowest-temperature markets. */
interface ArchiveDailyResponse {
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch Open-Meteo deterministic forecast for a given lat/lon and target date.
 *
 * @param unit - 'fahrenheit' or 'celsius' (matches the market's unit)
 */
export async function fetchOpenMeteoForecast(
  lat: number,
  lon: number,
  targetDate: string,
  unit: 'fahrenheit' | 'celsius' = 'fahrenheit',
  fetchFn?: FetchFn,
  retryCount = 0,
): Promise<OpenMeteoForecast | null> {
  const isInjected = fetchFn !== undefined;
  const doFetch = fetchFn ?? fetch;
  try {
    if (!isInjected) await rateLimitWait();

    const params = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      temperature_unit: unit,
      timezone: 'auto',
      start_date: targetDate.slice(0, 10),
      end_date: targetDate.slice(0, 10),
    });

    const url = `${FORECAST_BASE}?${params.toString()}`;
    const res = await fetchWithRetry(url, doFetch, retryCount);

    if (!res.ok) {
      logger.warn('[weather] Open-Meteo forecast API error', {
        status: res.status,
        lat,
        lon,
      });
      return null;
    }

    const data = (await res.json()) as DailyForecastResponse;
    const daily = data.daily;
    if (!daily?.time?.length || !daily.temperature_2m_max?.length || !daily.temperature_2m_min?.length) {
      logger.warn('[weather] Open-Meteo returned no daily data', { lat, lon, targetDate });
      return null;
    }

    // Find the index matching our target date
    const targetStr = targetDate.slice(0, 10);
    const idx = daily.time.indexOf(targetStr);
    if (idx === -1) {
      logger.debug('[weather] Open-Meteo target date not in response', {
        targetDate: targetStr,
        availableDates: daily.time,
      });
      return null;
    }

    const highTemp = daily.temperature_2m_max[idx];
    const lowTemp = daily.temperature_2m_min[idx];
    if (highTemp === undefined || lowTemp === undefined) return null;

    const precipProb = daily.precipitation_probability_max?.[idx] ?? 0;

    return {
      highTemp: Math.round(highTemp * 10) / 10,
      lowTemp: Math.round(lowTemp * 10) / 10,
      precipProbability: precipProb,
      forecastDate: targetStr,
    };
  } catch (err) {
    logger.warn('[weather] fetchOpenMeteoForecast failed', {
      error: err instanceof Error ? err.message : String(err),
      lat,
      lon,
      targetDate,
    });
    return null;
  }
}

/**
 * Fetch HRRR (High-Resolution Rapid Refresh) deterministic forecast via the
 * Open-Meteo forecast API. HRRR uses 3 km resolution with hourly updates and
 * radar data assimilation — the most accurate short-range (0–18h) model for
 * US locations. Only valid for US coordinates; always returns Fahrenheit.
 */
export async function fetchHrrrForecast(
  lat: number,
  lon: number,
  targetDate: string,
  fetchFn?: FetchFn,
  retryCount = 0,
): Promise<OpenMeteoForecast | null> {
  const isInjected = fetchFn !== undefined;
  const doFetch = fetchFn ?? fetch;
  try {
    if (!isInjected) await rateLimitWait();

    const params = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      // Open-Meteo exposes HRRR under the `gfs_hrrr` MultiDomains alias; the
      // plain `hrrr` string is rejected with HTTP 400. Verified against the
      // live API 2026-04-20.
      models: 'gfs_hrrr',
      temperature_unit: 'fahrenheit',
      timezone: 'auto',
      start_date: targetDate.slice(0, 10),
      end_date: targetDate.slice(0, 10),
    });

    const url = `${FORECAST_BASE}?${params.toString()}`;
    const res = await fetchWithRetry(url, doFetch, retryCount);

    if (!res.ok) {
      logger.warn('[weather] HRRR forecast API error', { status: res.status, lat, lon });
      return null;
    }

    const data = (await res.json()) as DailyForecastResponse;
    const daily = data.daily;
    if (!daily?.time?.length || !daily.temperature_2m_max?.length || !daily.temperature_2m_min?.length) {
      logger.warn('[weather] HRRR returned no daily data', { lat, lon, targetDate });
      return null;
    }

    const targetStr = targetDate.slice(0, 10);
    const idx = daily.time.indexOf(targetStr);
    if (idx === -1) return null;

    const highTemp = daily.temperature_2m_max[idx];
    const lowTemp = daily.temperature_2m_min[idx];
    if (highTemp === undefined || lowTemp === undefined) return null;

    return {
      highTemp: Math.round(highTemp * 10) / 10,
      lowTemp: Math.round(lowTemp * 10) / 10,
      precipProbability: daily.precipitation_probability_max?.[idx] ?? 0,
      forecastDate: targetStr,
    };
  } catch (err) {
    logger.warn('[weather] fetchHrrrForecast failed', {
      error: err instanceof Error ? err.message : String(err),
      lat,
      lon,
      targetDate,
    });
    return null;
  }
}

/**
 * Fetch ensemble forecast data for dynamic stddev estimation.
 *
 * By default uses GFS (31 members, `gfs_seamless`). Set `useEcmwf=true` to
 * use ECMWF IFS 0.25° (51 members, `ecmwf_ifs025`), which has ~0.2–0.5°C
 * lower Tmax MAE at 1-day lead globally. Returns the mean and standard
 * deviation of ensemble member daily high temperatures, capturing
 * regime-dependent uncertainty (frontal passages → high stddev, stable
 * high-pressure → low stddev). The result is tagged with `ensembleModel`
 * so callers can log which model supplied the stddev.
 *
 * @param unit - 'fahrenheit' or 'celsius'
 * @param useEcmwf - use ECMWF IFS instead of GFS (default false)
 */
// ── Redis read-through cache for ensemble fetches ───────────────────────────
//
// The ensemble models only re-run ~every 6h, but every weather scan is a fresh
// host-cron process so in-memory memos die between scans — the scanner re-fetched
// each ensemble on every scan, exhausting Open-Meteo's daily quota (429s). This
// cache is keyed model:lat:lon:date(:metric) and shared across paths AND processes.
// TTL is tiered by lead time (near ≤1d vs far ≥2d). Fail-safe: any Redis miss/error
// falls through to a live fetch, and only successful (non-null) results are stored,
// so Redis can never block a forecast or pin a transient failure. Skipped when a
// fetchFn is injected (tests) or the cache is disabled.
const ENSEMBLE_CACHE_PREFIX = 'weather:om_ens:';

function ensembleCacheTtlS(targetDate: string): number {
  const cfg = loadConfig();
  const targetMs = Date.parse(`${targetDate.slice(0, 10)}T00:00:00Z`);
  const todayMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const daysOut = Number.isFinite(targetMs) ? Math.round((targetMs - todayMs) / 86_400_000) : 0;
  return daysOut <= 1
    ? cfg.WEATHER_ENSEMBLE_CACHE_NEAR_TTL_S
    : cfg.WEATHER_ENSEMBLE_CACHE_FAR_TTL_S;
}

async function cachedEnsembleFetch<T>(
  key: string,
  targetDate: string,
  isInjected: boolean,
  fetcher: () => Promise<T | null>,
): Promise<T | null> {
  if (isInjected || !loadConfig().WEATHER_ENSEMBLE_CACHE_ENABLED) return fetcher();
  let redis: ReturnType<typeof getRedis>;
  try {
    redis = getRedis();
  } catch {
    return fetcher();
  }
  try {
    const raw = await redis.get(key);
    if (raw !== null && raw !== undefined) return JSON.parse(raw) as T;
  } catch {
    // Redis read failed — fall through to a live fetch.
  }
  const val = await fetcher();
  if (val !== null) {
    try {
      await redis.set(key, JSON.stringify(val), 'EX', ensembleCacheTtlS(targetDate));
    } catch {
      // Best-effort write; a cache-write failure must never break a forecast.
    }
  }
  return val;
}

/**
 * Ensemble forecast stats for (lat, lon, targetDate, model). Redis-cached
 * read-through (see cachedEnsembleFetch); the network implementation is
 * fetchEnsembleForecastUncached.
 */
export async function fetchEnsembleForecast(
  lat: number,
  lon: number,
  targetDate: string,
  unit: 'fahrenheit' | 'celsius' = 'fahrenheit',
  fetchFn?: FetchFn,
  useEcmwf = false,
  retryCount = 0,
  metric: 'high' | 'low' = 'high',
): Promise<EnsembleForecast | null> {
  // unit is part of the key (like fetchEnsembleHourly): the API applies temperature_unit
  // to all returned values, so a fahrenheit and a celsius response must not collide.
  const key = `${ENSEMBLE_CACHE_PREFIX}fc:${useEcmwf ? 'ecmwf' : 'gfs'}:${lat.toFixed(4)}:${lon.toFixed(4)}:${targetDate.slice(0, 10)}:${unit}:${metric}`;
  return cachedEnsembleFetch(key, targetDate, fetchFn !== undefined, () =>
    fetchEnsembleForecastUncached(lat, lon, targetDate, unit, fetchFn, useEcmwf, retryCount, metric));
}

async function fetchEnsembleForecastUncached(
  lat: number,
  lon: number,
  targetDate: string,
  unit: 'fahrenheit' | 'celsius' = 'fahrenheit',
  fetchFn?: FetchFn,
  useEcmwf = false,
  retryCount = 0,
  metric: 'high' | 'low' = 'high',
): Promise<EnsembleForecast | null> {
  const isInjected = fetchFn !== undefined;
  const doFetch = fetchFn ?? fetch;
  // "Lowest temperature" markets resolve on the daily minimum, so the ensemble
  // spread must come from the per-member daily-min distribution, not the max.
  const dailyVar = metric === 'low' ? 'temperature_2m_min' : 'temperature_2m_max';
  try {
    if (!isInjected) await rateLimitWait();

    // ECMWF IFS 0.25° (51 members) is more accurate than GFS (31 members) at
    // 1-day lead globally. Gate on useEcmwf so the switch is a single env-var flip.
    const model = useEcmwf ? 'ecmwf_ifs025' : 'gfs_seamless';
    const params = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      daily: dailyVar,
      models: model,
      temperature_unit: unit,
      timezone: 'auto',
      start_date: targetDate.slice(0, 10),
      end_date: targetDate.slice(0, 10),
    });

    const url = `${ENSEMBLE_BASE}?${params.toString()}`;
    const res = await fetchWithRetry(url, doFetch, retryCount);

    if (!res.ok) {
      logger.warn('[weather] Open-Meteo ensemble API error', {
        status: res.status,
        lat,
        lon,
      });
      return null;
    }

    const data = (await res.json()) as EnsembleDailyResponse;
    const daily = data.daily;
    const series = metric === 'low' ? daily?.temperature_2m_min : daily?.temperature_2m_max;
    if (!daily?.time?.length || !series?.length) {
      logger.warn('[weather] Open-Meteo ensemble returned no daily data', { lat, lon, targetDate, metric });
      return null;
    }

    const targetStr = targetDate.slice(0, 10);
    const idx = daily.time.indexOf(targetStr);
    if (idx === -1) return null;

    const members = series[idx];
    const ensembleModel: EnsembleForecast['ensembleModel'] = useEcmwf ? 'ecmwf' : 'gfs';
    if (!members || !Array.isArray(members) || members.length < 2) {
      // Open-Meteo ensemble returns members as columns, not nested arrays
      // Try parsing flat array: all values for the single target day
      return parseEnsembleFlat(daily, targetStr, ensembleModel, metric);
    }

    return computeEnsembleStats(members, targetStr, ensembleModel);
  } catch (err) {
    logger.warn('[weather] fetchEnsembleForecast failed', {
      error: err instanceof Error ? err.message : String(err),
      lat,
      lon,
      targetDate,
    });
    return null;
  }
}

/**
 * Open-Meteo ensemble API may return member data as separate keys
 * (temperature_2m_max_member01, ...). Handle the flat response format.
 */
function parseEnsembleFlat(
  daily: Record<string, unknown>,
  targetDate: string,
  ensembleModel: EnsembleForecast['ensembleModel'],
  metric: 'high' | 'low' = 'high',
): EnsembleForecast | null {
  const members: number[] = [];
  const time = daily.time as string[] | undefined;
  if (!time) return null;
  const idx = time.indexOf(targetDate);
  if (idx === -1) return null;

  const baseKey = metric === 'low' ? 'temperature_2m_min' : 'temperature_2m_max';
  const memberPrefix = `${baseKey}_member`;

  // Collect all member keys
  for (const [key, val] of Object.entries(daily)) {
    if (key.startsWith(memberPrefix) && Array.isArray(val)) {
      const v = val[idx];
      if (typeof v === 'number' && isFinite(v)) {
        members.push(v);
      }
    }
  }

  // Also check if the main key has a flat array of numbers (single day)
  if (members.length === 0) {
    const mainVal = daily[baseKey];
    if (Array.isArray(mainVal)) {
      for (const v of mainVal) {
        if (typeof v === 'number' && isFinite(v)) {
          members.push(v);
        }
      }
    }
  }

  if (members.length < 2) return null;
  return computeEnsembleStats(members, targetDate, ensembleModel);
}

// ── Historical archive (ground-truth reconciliation) ──────────────────────

export interface HistoricalHigh {
  /** Observed daily high temperature in the requested unit. */
  observedHigh: number;
  /** Observed daily low temperature in the requested unit. null when the
   *  archive omits the min (older responses / partial data). */
  observedLow: number | null;
  /** The date this reading applies to (YYYY-MM-DD). */
  targetDate: string;
  /** Unit of the reading. */
  unit: 'fahrenheit' | 'celsius';
}

/**
 * Fetch the observed daily extremes (high AND low) for a past date from the
 * Open-Meteo archive. Used by the weather reconciler to validate shadow-scan
 * predictions against ground truth (what the forecast actually verified as).
 *
 * One archive call returns both extremes, so the reconciler can ground both the
 * "Highest temperature" and "Lowest temperature" markets for a city/date. The
 * function still returns null only when the HIGH is unavailable (preserving the
 * historical contract); `observedLow` is null when only the min is missing.
 *
 * Archive data lags real time by a few days — callers should only request dates
 * at least 1 full UTC day in the past, and be prepared for null when the archive
 * hasn't caught up yet.
 *
 * @param unit - match the market's unit so comparisons are apples-to-apples
 */
export async function fetchHistoricalHigh(
  lat: number,
  lon: number,
  targetDate: string,
  unit: 'fahrenheit' | 'celsius' = 'fahrenheit',
  fetchFn?: FetchFn,
): Promise<HistoricalHigh | null> {
  const isInjected = fetchFn !== undefined;
  const doFetch = fetchFn ?? fetch;
  const targetStr = targetDate.slice(0, 10);
  try {
    if (!isInjected) await rateLimitWait();

    const params = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      daily: 'temperature_2m_max,temperature_2m_min',
      temperature_unit: unit,
      timezone: 'auto',
      start_date: targetStr,
      end_date: targetStr,
    });

    const url = `${ARCHIVE_BASE}?${params.toString()}`;
    const res = await fetchWithTimeout(url, doFetch);

    if (!res.ok) {
      logger.warn('[weather] Open-Meteo archive API error', {
        status: res.status,
        lat,
        lon,
        targetDate: targetStr,
      });
      return null;
    }

    const data = (await res.json()) as ArchiveDailyResponse;
    const daily = data.daily;
    if (!daily?.time?.length || !daily.temperature_2m_max?.length) {
      logger.warn('[weather] Open-Meteo archive returned no daily data', {
        lat, lon, targetDate: targetStr,
      });
      return null;
    }

    const idx = daily.time.indexOf(targetStr);
    if (idx === -1) {
      logger.debug('[weather] Open-Meteo archive target date missing', {
        targetDate: targetStr,
        availableDates: daily.time,
      });
      return null;
    }

    const observedHigh = daily.temperature_2m_max[idx];
    if (observedHigh === undefined || !Number.isFinite(observedHigh)) return null;

    const rawLow = daily.temperature_2m_min?.[idx];
    const observedLow =
      rawLow !== undefined && Number.isFinite(rawLow) ? Math.round(rawLow * 10) / 10 : null;

    return {
      observedHigh: Math.round(observedHigh * 10) / 10,
      observedLow,
      targetDate: targetStr,
      unit,
    };
  } catch (err) {
    logger.warn('[weather] fetchHistoricalHigh failed', {
      error: err instanceof Error ? err.message : String(err),
      lat,
      lon,
      targetDate: targetStr,
    });
    return null;
  }
}

// ── Ensemble hourly fetch (for conditional oracle) ────────────────────────

/**
 * Per-member hourly temperature trajectories for the remaining hours of a target day.
 * Used by the conditional oracle to estimate the final daily max distribution.
 */
export interface EnsembleHourlyForecast {
  /** Unix epoch seconds for each hour (timezone-unambiguous). */
  hours: number[];
  /** Per-member hourly temperatures: memberTemps[memberIdx][hourIdx]. Native unit. */
  memberTemps: number[][];
  memberCount: number;
  forecastDate: string;
  ensembleModel: 'gfs' | 'ecmwf';
}

interface EnsembleHourlyResponse {
  hourly?: Record<string, unknown>;
}

// In-process memo for ensemble-hourly fetches. The weather scanner is a
// short-lived host-cron process; within one run BOTH the modal-mass entry veto
// (scanWeatherMarkets) and the resolution-day nowcast (weatherDriftStrategy)
// request the same (city, day, model) hourly data. Memoizing dedupes those and
// curbs Open-Meteo 429s. Only successful (non-null) results are cached so a
// transient failure can be retried; the TTL guards any long-lived importer.
interface EnsembleHourlyCacheEntry { ts: number; promise: Promise<EnsembleHourlyForecast | null> }
const ensembleHourlyCache = new Map<string, EnsembleHourlyCacheEntry>();
const ENSEMBLE_HOURLY_CACHE_TTL_MS = 5 * 60 * 1000;

/** Clear the ensemble-hourly memo. Test-only — keeps cases independent. */
export function _resetEnsembleHourlyCache(): void {
  ensembleHourlyCache.clear();
}

/**
 * Fetch per-member hourly temperature_2m trajectories for a target local day.
 * Used only for resolution-day (or daysOut ≤ 1) positions where live obs are
 * available. The window is limited to the target date to keep payloads small.
 *
 * Response format matches the ensemble daily format: member data in flat keys
 * `temperature_2m_member00`, `temperature_2m_member01`, etc.
 *
 * Results are memoized per (lat, lon, day, unit, model) for a short TTL so the
 * modal-mass veto and the res-day nowcast share a single network call. Failures
 * (null) are evicted so they don't poison subsequent retries.
 */
export function fetchEnsembleHourly(
  lat: number,
  lon: number,
  targetDate: string,
  unit: 'fahrenheit' | 'celsius' = 'fahrenheit',
  fetchFn?: FetchFn,
  useEcmwf = false,
  retryCount = 0,
): Promise<EnsembleHourlyForecast | null> {
  const targetStr = targetDate.slice(0, 10);
  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${targetStr},${unit},${useEcmwf ? 'ecmwf' : 'gfs'}`;
  const now = Date.now();
  const hit = ensembleHourlyCache.get(key);
  if (hit && now - hit.ts < ENSEMBLE_HOURLY_CACHE_TTL_MS) {
    return hit.promise;
  }
  // L1 = the in-process memo above (dedupes within one scan). L2 = the Redis
  // read-through below, which survives across host-cron scans (fresh process each
  // run) and is shared with every other ensemble caller.
  const redisKey = `${ENSEMBLE_CACHE_PREFIX}hr:${useEcmwf ? 'ecmwf' : 'gfs'}:${lat.toFixed(4)}:${lon.toFixed(4)}:${targetStr}:${unit}`;
  const promise = cachedEnsembleFetch(redisKey, targetDate, fetchFn !== undefined, () =>
    fetchEnsembleHourlyUncached(lat, lon, targetDate, unit, fetchFn, useEcmwf, retryCount));
  ensembleHourlyCache.set(key, { ts: now, promise });
  // Don't retain failures — a null/throw should not block a later retry.
  void promise.then(
    (v) => { if (v === null) ensembleHourlyCache.delete(key); },
    () => ensembleHourlyCache.delete(key),
  );
  return promise;
}

async function fetchEnsembleHourlyUncached(
  lat: number,
  lon: number,
  targetDate: string,
  unit: 'fahrenheit' | 'celsius' = 'fahrenheit',
  fetchFn?: FetchFn,
  useEcmwf = false,
  retryCount = 0,
): Promise<EnsembleHourlyForecast | null> {
  const isInjected = fetchFn !== undefined;
  const doFetch = fetchFn ?? fetch;
  const targetStr = targetDate.slice(0, 10);
  try {
    if (!isInjected) await rateLimitWait();

    const model = useEcmwf ? 'ecmwf_ifs025' : 'gfs_seamless';
    const params = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      hourly: 'temperature_2m',
      models: model,
      temperature_unit: unit,
      timezone: 'auto',
      timeformat: 'unixtime',
      start_date: targetStr,
      end_date: targetStr,
    });

    const url = `${ENSEMBLE_BASE}?${params.toString()}`;
    const res = await fetchWithRetry(url, doFetch, retryCount);

    if (!res.ok) {
      logger.warn('[weather] Open-Meteo ensemble hourly API error', {
        status: res.status, lat, lon, targetDate: targetStr,
      });
      return null;
    }

    const data = (await res.json()) as EnsembleHourlyResponse;
    const hourly = data.hourly;
    if (!hourly || typeof hourly !== 'object') {
      logger.warn('[weather] ensemble hourly returned no hourly data', { lat, lon, targetDate: targetStr });
      return null;
    }

    const timeArr = hourly.time as number[] | undefined;
    if (!Array.isArray(timeArr) || timeArr.length === 0) return null;

    // Collect all member keys
    const memberKeys = Object.keys(hourly).filter((k) => k.startsWith('temperature_2m_member'));
    if (memberKeys.length === 0) return null;

    const memberTemps: number[][] = [];
    for (const key of memberKeys) {
      const vals = hourly[key];
      if (!Array.isArray(vals)) continue;
      const row: number[] = [];
      for (const v of vals) {
        row.push(typeof v === 'number' && isFinite(v) ? v : NaN);
      }
      if (row.length === timeArr.length) memberTemps.push(row);
    }

    if (memberTemps.length === 0) return null;

    const ensembleModel: EnsembleHourlyForecast['ensembleModel'] = useEcmwf ? 'ecmwf' : 'gfs';
    return {
      hours: timeArr,
      memberTemps,
      memberCount: memberTemps.length,
      forecastDate: targetStr,
      ensembleModel,
    };
  } catch (err) {
    logger.warn('[weather] fetchEnsembleHourly failed', {
      error: err instanceof Error ? err.message : String(err),
      lat, lon, targetDate: targetStr,
    });
    return null;
  }
}

function computeEnsembleStats(
  members: number[],
  forecastDate: string,
  ensembleModel: EnsembleForecast['ensembleModel'],
): EnsembleForecast {
  const n = members.length;
  const mean = members.reduce((s, v) => s + v, 0) / n;
  const variance = members.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const stddev = Math.sqrt(variance);
  const roundedMean = Math.round(mean * 10) / 10;
  const roundedStddev = Math.round(stddev * 100) / 100;

  // `members` are the per-member values for ONE metric (max members on a high
  // fetch, min members on a low fetch). Both field pairs are filled with the
  // same computed stats so a caller reads valid numbers from whichever pair
  // matches the metric it requested.
  return {
    meanHigh: roundedMean,
    stddevHigh: roundedStddev,
    meanLow: roundedMean,
    stddevLow: roundedStddev,
    memberCount: n,
    forecastDate,
    ensembleModel,
  };
}
