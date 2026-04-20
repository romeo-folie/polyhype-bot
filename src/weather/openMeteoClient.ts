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
  };
}

/** Minimal shape of the archive endpoint response — kept separate from
 *  DailyForecastResponse so the two endpoints can diverge without silent
 *  misparsing. The archive API only returns `temperature_2m_max` for our use. */
interface ArchiveDailyResponse {
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
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
    const res = await fetchWithTimeout(url, doFetch);

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
 * Fetch GFS ensemble forecast data for dynamic stddev estimation.
 *
 * Returns the mean and standard deviation of the 31 GFS ensemble members'
 * daily high temperature forecast. This captures regime-dependent uncertainty
 * (frontal passages → high stddev, stable high-pressure → low stddev).
 *
 * @param unit - 'fahrenheit' or 'celsius'
 */
export async function fetchEnsembleForecast(
  lat: number,
  lon: number,
  targetDate: string,
  unit: 'fahrenheit' | 'celsius' = 'fahrenheit',
  fetchFn?: FetchFn,
  useEcmwf = false,
): Promise<EnsembleForecast | null> {
  const isInjected = fetchFn !== undefined;
  const doFetch = fetchFn ?? fetch;
  try {
    if (!isInjected) await rateLimitWait();

    // ECMWF IFS 0.25° (51 members) is more accurate than GFS (31 members) at
    // 1-day lead globally. Gate on useEcmwf so the switch is a single env-var flip.
    const model = useEcmwf ? 'ecmwf_ifs025' : 'gfs_seamless';
    const params = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      daily: 'temperature_2m_max',
      models: model,
      temperature_unit: unit,
      timezone: 'auto',
      start_date: targetDate.slice(0, 10),
      end_date: targetDate.slice(0, 10),
    });

    const url = `${ENSEMBLE_BASE}?${params.toString()}`;
    const res = await fetchWithTimeout(url, doFetch);

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
    if (!daily?.time?.length || !daily.temperature_2m_max?.length) {
      logger.warn('[weather] Open-Meteo ensemble returned no daily data', { lat, lon, targetDate });
      return null;
    }

    const targetStr = targetDate.slice(0, 10);
    const idx = daily.time.indexOf(targetStr);
    if (idx === -1) return null;

    const members = daily.temperature_2m_max[idx];
    const ensembleModel = useEcmwf ? 'ecmwf' : 'gfs' as const;
    if (!members || !Array.isArray(members) || members.length < 2) {
      // Open-Meteo ensemble returns members as columns, not nested arrays
      // Try parsing flat array: all values for the single target day
      const r = parseEnsembleFlat(daily, targetStr);
      return r ? { ...r, ensembleModel } : null;
    }

    return { ...computeEnsembleStats(members, targetStr), ensembleModel };
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
): EnsembleForecast | null {
  const members: number[] = [];
  const time = daily.time as string[] | undefined;
  if (!time) return null;
  const idx = time.indexOf(targetDate);
  if (idx === -1) return null;

  // Collect all member keys
  for (const [key, val] of Object.entries(daily)) {
    if (key.startsWith('temperature_2m_max_member') && Array.isArray(val)) {
      const v = val[idx];
      if (typeof v === 'number' && isFinite(v)) {
        members.push(v);
      }
    }
  }

  // Also check if the main key has a flat array of numbers (single day)
  if (members.length === 0) {
    const mainVal = daily.temperature_2m_max;
    if (Array.isArray(mainVal)) {
      for (const v of mainVal) {
        if (typeof v === 'number' && isFinite(v)) {
          members.push(v);
        }
      }
    }
  }

  if (members.length < 2) return null;
  return computeEnsembleStats(members, targetDate); // ensembleModel overridden by caller
}

// ── Historical archive (ground-truth reconciliation) ──────────────────────

export interface HistoricalHigh {
  /** Observed daily high temperature in the requested unit. */
  observedHigh: number;
  /** The date this reading applies to (YYYY-MM-DD). */
  targetDate: string;
  /** Unit of the reading. */
  unit: 'fahrenheit' | 'celsius';
}

/**
 * Fetch the observed daily high for a past date from the Open-Meteo archive.
 * Used by the weather reconciler to validate shadow-scan predictions against
 * ground truth (what the forecast actually verified as).
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
      daily: 'temperature_2m_max',
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

    return {
      observedHigh: Math.round(observedHigh * 10) / 10,
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

function computeEnsembleStats(members: number[], forecastDate: string): EnsembleForecast {
  const n = members.length;
  const mean = members.reduce((s, v) => s + v, 0) / n;
  const variance = members.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const stddev = Math.sqrt(variance);

  return {
    meanHigh: Math.round(mean * 10) / 10,
    stddevHigh: Math.round(stddev * 100) / 100,
    // For ensemble, we only fetch high temp — low temp uses deterministic
    meanLow: mean, // placeholder — not used for bracket probability
    stddevLow: stddev,
    memberCount: n,
    forecastDate,
    ensembleModel: 'gfs', // overridden by caller when useEcmwf=true
  };
}
