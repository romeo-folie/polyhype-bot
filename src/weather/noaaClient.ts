/**
 * NOAA / NWS Forecast Client
 *
 * Fetches weather forecasts from the National Weather Service public API.
 * Two-step process:
 *   1. /points/{lat},{lon} -> get the grid office + coordinates
 *   2. /gridpoints/{office}/{gridX},{gridY}/forecast -> get 7-day forecast
 *
 * NOAA fair-use policy: max 1 request/sec, identify with User-Agent.
 * US coverage only — London and other non-US cities return null.
 *
 * Log marker: [weather]
 */

import { logger } from '../shared/logger.js';

const NWS_BASE = 'https://api.weather.gov';
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = 'polymarket-weather-scanner/1.0 (contact: agent@example.com)';

// ── Rate limiter: max 1 request/sec to NOAA ────────────────────────────────
let lastRequestMs = 0;

async function rateLimitWait(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestMs;
  if (elapsed < 1000) {
    await new Promise((r) => setTimeout(r, 1000 - elapsed));
  }
  lastRequestMs = Date.now();
}

// ── City coordinates for common Polymarket weather markets ─────────────────
export interface CityCoordinates {
  lat: number;
  lon: number;
  /** Whether this city is in NOAA coverage (US only). */
  noaaCoverage: boolean;
}

export const CITY_COORDINATES: Record<string, CityCoordinates> = {
  'new york': { lat: 40.7128, lon: -74.006, noaaCoverage: true },
  nyc: { lat: 40.7128, lon: -74.006, noaaCoverage: true },
  'los angeles': { lat: 34.0522, lon: -118.2437, noaaCoverage: true },
  la: { lat: 34.0522, lon: -118.2437, noaaCoverage: true },
  chicago: { lat: 41.8781, lon: -87.6298, noaaCoverage: true },
  miami: { lat: 25.7617, lon: -80.1918, noaaCoverage: true },
  houston: { lat: 29.7604, lon: -95.3698, noaaCoverage: true },
  phoenix: { lat: 33.4484, lon: -112.074, noaaCoverage: true },
  philadelphia: { lat: 39.9526, lon: -75.1652, noaaCoverage: true },
  'san antonio': { lat: 29.4241, lon: -98.4936, noaaCoverage: true },
  'san diego': { lat: 32.7157, lon: -117.1611, noaaCoverage: true },
  dallas: { lat: 32.7767, lon: -96.797, noaaCoverage: true },
  denver: { lat: 39.7392, lon: -104.9903, noaaCoverage: true },
  seattle: { lat: 47.6062, lon: -122.3321, noaaCoverage: true },
  boston: { lat: 42.3601, lon: -71.0589, noaaCoverage: true },
  atlanta: { lat: 33.749, lon: -84.388, noaaCoverage: true },
  'las vegas': { lat: 36.1699, lon: -115.1398, noaaCoverage: true },
  portland: { lat: 45.5152, lon: -122.6784, noaaCoverage: true },
  detroit: { lat: 42.3314, lon: -83.0458, noaaCoverage: true },
  minneapolis: { lat: 44.9778, lon: -93.265, noaaCoverage: true },
  'washington dc': { lat: 38.9072, lon: -77.0369, noaaCoverage: true },
  washington: { lat: 38.9072, lon: -77.0369, noaaCoverage: true },
  'san francisco': { lat: 37.7749, lon: -122.4194, noaaCoverage: true },
  // Non-US cities — flagged as no NOAA coverage
  london: { lat: 51.5074, lon: -0.1278, noaaCoverage: false },
  paris: { lat: 48.8566, lon: 2.3522, noaaCoverage: false },
  tokyo: { lat: 35.6762, lon: 139.6503, noaaCoverage: false },
};

// ── Aliases: resolve common abbreviations/variants ─────────────────────────
const CITY_ALIASES: Record<string, string> = {
  'new york city': 'new york',
  'ny': 'new york',
  'l.a.': 'los angeles',
  'chi-town': 'chicago',
  'philly': 'philadelphia',
  'sf': 'san francisco',
  'dc': 'washington dc',
  'd.c.': 'washington dc',
};

/**
 * Look up city coordinates by name. Case-insensitive, supports aliases.
 */
export function lookupCity(cityName: string): CityCoordinates | null {
  const key = cityName.trim().toLowerCase();
  const resolved = CITY_ALIASES[key] ?? key;
  return CITY_COORDINATES[resolved] ?? null;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface GfsForecast {
  /** Forecast high temperature in Fahrenheit. */
  highF: number;
  /** Forecast low temperature in Fahrenheit. */
  lowF: number;
  /** Precipitation probability (0-100). */
  precipProbability: number;
  /** The date this forecast applies to (YYYY-MM-DD). */
  forecastDate: string;
  /** Short description from NWS (e.g. "Mostly Sunny"). */
  shortForecast: string;
}

interface NwsPointsResponse {
  properties?: {
    forecast?: string;
    gridId?: string;
    gridX?: number;
    gridY?: number;
  };
}

interface NwsForecastPeriod {
  name?: string;
  startTime?: string;
  temperature?: number;
  temperatureUnit?: string;
  probabilityOfPrecipitation?: { value?: number | null };
  isDaytime?: boolean;
  shortForecast?: string;
}

interface NwsForecastResponse {
  properties?: {
    periods?: NwsForecastPeriod[];
  };
}

/** Injectable fetch function for testing. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ── Internal helpers ───────────────────────────────────────────────────────

function fetchWithTimeout(url: string, fetchFn: FetchFn = fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  return fetchFn(url, {
    signal: controller.signal,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
  }).finally(() => {
    clearTimeout(timer);
  });
}

function celsiusToFahrenheit(c: number): number {
  return c * 9 / 5 + 32;
}

/**
 * Parse a date string into YYYY-MM-DD, normalising timezone-aware ISO strings.
 */
function toDateStr(isoString: string): string {
  const d = new Date(isoString);
  // Use UTC components for consistent date matching
  return `${d.getUTCFullYear().toString()}-${(d.getUTCMonth() + 1).toString().padStart(2, '0')}-${d.getUTCDate().toString().padStart(2, '0')}`;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch NWS forecast for a given lat/lon and target date.
 *
 * Two-step:
 *   1. GET /points/{lat},{lon} to resolve grid office + coordinates
 *   2. GET /gridpoints/{office}/{gridX},{gridY}/forecast to get 7-day forecast
 *
 * Returns null on any error (network, non-US coverage, missing data).
 */
export async function fetchGfsEnsembleForecast(
  lat: number,
  lon: number,
  targetDate: string,
  fetchFn: FetchFn = fetch,
): Promise<GfsForecast | null> {
  try {
    // Step 1: Resolve grid point
    await rateLimitWait();
    const pointsUrl = `${NWS_BASE}/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
    const pointsRes = await fetchWithTimeout(pointsUrl, fetchFn);

    if (!pointsRes.ok) {
      logger.warn('[weather] NWS points API error', {
        status: pointsRes.status,
        lat,
        lon,
      });
      return null;
    }

    const pointsData = (await pointsRes.json()) as NwsPointsResponse;
    const forecastUrl = pointsData.properties?.forecast;
    if (!forecastUrl) {
      logger.warn('[weather] NWS points response missing forecast URL', { lat, lon });
      return null;
    }

    // Step 2: Fetch the forecast
    await rateLimitWait();
    const forecastRes = await fetchWithTimeout(forecastUrl, fetchFn);

    if (!forecastRes.ok) {
      logger.warn('[weather] NWS forecast API error', {
        status: forecastRes.status,
        forecastUrl,
      });
      return null;
    }

    const forecastData = (await forecastRes.json()) as NwsForecastResponse;
    const periods = forecastData.properties?.periods;
    if (!Array.isArray(periods) || periods.length === 0) {
      logger.warn('[weather] NWS forecast has no periods', { forecastUrl });
      return null;
    }

    // Match periods to the target date
    const targetDateStr = targetDate.trim().slice(0, 10); // YYYY-MM-DD
    const matchingPeriods = periods.filter(
      (p) => p.startTime && toDateStr(p.startTime) === targetDateStr,
    );

    if (matchingPeriods.length === 0) {
      logger.debug('[weather] no forecast periods match target date', {
        targetDate: targetDateStr,
        availableDates: periods
          .filter((p) => p.startTime)
          .map((p) => toDateStr(p.startTime!))
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 7),
      });
      return null;
    }

    // Extract high/low from daytime and nighttime periods
    let highF = -Infinity;
    let lowF = Infinity;
    let precipProb = 0;
    let shortForecast = '';

    for (const period of matchingPeriods) {
      if (period.temperature === undefined) continue;

      let tempF = period.temperature;
      // NWS sometimes returns Celsius — convert
      if (period.temperatureUnit === 'C') {
        tempF = celsiusToFahrenheit(tempF);
      }

      if (period.isDaytime) {
        highF = Math.max(highF, tempF);
        if (!shortForecast && period.shortForecast) {
          shortForecast = period.shortForecast;
        }
      } else {
        lowF = Math.min(lowF, tempF);
      }

      // Also update high/low regardless of daytime flag (some APIs only have one)
      highF = Math.max(highF, tempF);
      lowF = Math.min(lowF, tempF);

      const pp = period.probabilityOfPrecipitation?.value;
      if (typeof pp === 'number') {
        precipProb = Math.max(precipProb, pp);
      }
    }

    if (!isFinite(highF) || !isFinite(lowF)) {
      logger.warn('[weather] could not extract temperature from forecast periods', {
        targetDate: targetDateStr,
        matchingPeriods: matchingPeriods.length,
      });
      return null;
    }

    return {
      highF: Math.round(highF * 10) / 10,
      lowF: Math.round(lowF * 10) / 10,
      precipProbability: precipProb,
      forecastDate: targetDateStr,
      shortForecast,
    };
  } catch (err) {
    logger.warn('[weather] fetchGfsEnsembleForecast failed', {
      error: err instanceof Error ? err.message : String(err),
      lat,
      lon,
      targetDate,
    });
    return null;
  }
}

// ── Probability model ──────────────────────────────────────────────────────

/**
 * Estimate the probability of temperature exceeding a threshold given a
 * point forecast and horizon-dependent uncertainty.
 *
 * Uses a normal distribution approximation:
 *   - 1-day horizon: ~3°F standard deviation
 *   - 2-day horizon: ~4°F
 *   - 3-day horizon: ~5°F
 *   - 4+ day horizon: ~6°F
 *
 * These are conservative estimates based on GFS ensemble spread studies.
 *
 * @param forecastTemp - Point forecast temperature (°F)
 * @param threshold - Market threshold temperature (°F)
 * @param daysOut - Number of days until the target date (0 = today)
 * @returns Probability that actual temperature exceeds the threshold [0, 1]
 */
export function estimateExceedanceProbability(
  forecastTemp: number,
  threshold: number,
  daysOut: number,
): number {
  // Standard deviation increases with forecast horizon
  let stdDev: number;
  if (daysOut <= 1) {
    stdDev = 3.0;
  } else if (daysOut <= 2) {
    stdDev = 4.0;
  } else if (daysOut <= 3) {
    stdDev = 5.0;
  } else {
    stdDev = 6.0;
  }

  // z-score: how many std devs the threshold is above the forecast
  const z = (threshold - forecastTemp) / stdDev;

  // Approximate standard normal CDF using Abramowitz and Stegun formula 7.1.26
  // P(X > threshold) = 1 - Phi(z) where Phi is the standard normal CDF
  return 1 - normalCdf(z);
}

/**
 * Standard normal CDF approximation (Abramowitz and Stegun 7.1.26).
 * Accurate to ~1.5e-7.
 */
export function normalCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);

  const t = 1 / (1 + 0.2316419 * absX);
  const d = 0.3989422804014327; // 1/sqrt(2*PI)
  const pdf = d * Math.exp(-0.5 * absX * absX);

  const poly =
    t *
    (0.319381530 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));

  const cdf = 1 - pdf * poly;
  return sign === -1 ? 1 - cdf : cdf;
}
