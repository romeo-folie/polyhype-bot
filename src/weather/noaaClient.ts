/**
 * NWS Forecast Client
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
const DEFAULT_USER_AGENT = `polymarket-weather-scanner/1.0 (contact: ${process.env.WEATHER_CONTACT_EMAIL ?? 'ops@polymarket-agent.local'})`;

// ── Rate limiter: max 1 request/sec to NOAA ────────────────────────────────
// Serializes requests via a promise chain so concurrent calls queue instead
// of racing past the elapsed check.
let requestQueue: Promise<void> = Promise.resolve();

function rateLimitWait(): Promise<void> {
  requestQueue = requestQueue.then(
    () => new Promise((r) => setTimeout(r, 1000)),
  );
  return requestQueue;
}

// ── City coordinates for Polymarket weather markets ──────────────────────────
export interface CityCoordinates {
  lat: number;
  lon: number;
  /** Whether this city is in NOAA coverage (US only). */
  noaaCoverage: boolean;
  /** Temperature unit used by Polymarket for this city. */
  unit: 'fahrenheit' | 'celsius';
  /** Polymarket resolution station identifier (ICAO/WU for most cities; 'HKO' for Hong Kong Observatory). */
  wuStation: string;
  /** Which ground-truth fetcher to use for this city's resolution source. */
  resolutionSource: 'wu' | 'metar' | 'hko';
  /** ISO 3166-1 alpha-2 country code — required for WU cities (constructs ICAO:9:ISO2 location key). */
  isoCountry?: string;
}

// Cities active on Polymarket weather markets.
// US cities use Fahrenheit, international cities use Celsius.
export const CITY_COORDINATES: Record<string, CityCoordinates> = {
  // US cities (Fahrenheit) — all resolve via Weather Underground
  'new york':      { lat: 40.7128, lon: -74.006,    noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KLGA', resolutionSource: 'wu', isoCountry: 'US' },
  chicago:         { lat: 41.8781, lon: -87.6298,   noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KORD', resolutionSource: 'wu', isoCountry: 'US' },
  miami:           { lat: 25.7617, lon: -80.1918,   noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KMIA', resolutionSource: 'wu', isoCountry: 'US' },
  // Hobby (KHOU), not IAH — Polymarket resolves against KHOU
  houston:         { lat: 29.6454, lon: -95.2789,   noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KHOU', resolutionSource: 'wu', isoCountry: 'US' },
  dallas:          { lat: 32.7767, lon: -96.797,    noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KDAL', resolutionSource: 'wu', isoCountry: 'US' },
  // Buckley SFB (KBKF) in Aurora, not Denver airport — Polymarket resolves against KBKF
  denver:          { lat: 39.7016, lon: -104.7516,  noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KBKF', resolutionSource: 'wu', isoCountry: 'US' },
  seattle:         { lat: 47.6062, lon: -122.3321,  noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KSEA', resolutionSource: 'wu', isoCountry: 'US' },
  atlanta:         { lat: 33.749,  lon: -84.388,    noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KATL', resolutionSource: 'wu', isoCountry: 'US' },
  austin:          { lat: 30.2672, lon: -97.7431,   noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KAUS', resolutionSource: 'wu', isoCountry: 'US' },
  'los angeles':   { lat: 34.0522, lon: -118.2437,  noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KLAX', resolutionSource: 'wu', isoCountry: 'US' },
  'san francisco': { lat: 37.7749, lon: -122.4194,  noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KSFO', resolutionSource: 'wu', isoCountry: 'US' },
  // International cities (Celsius) — WU unless noted
  london:          { lat: 51.5074, lon: -0.1278,    noaaCoverage: false, unit: 'celsius', wuStation: 'EGLC', resolutionSource: 'wu', isoCountry: 'GB' },
  paris:           { lat: 48.8566, lon: 2.3522,     noaaCoverage: false, unit: 'celsius', wuStation: 'LFPG', resolutionSource: 'wu', isoCountry: 'FR' },
  toronto:         { lat: 43.6532, lon: -79.3832,   noaaCoverage: false, unit: 'celsius', wuStation: 'CYYZ', resolutionSource: 'wu', isoCountry: 'CA' },
  'sao paulo':     { lat: -23.5505, lon: -46.6333,  noaaCoverage: false, unit: 'celsius', wuStation: 'SBGR', resolutionSource: 'wu', isoCountry: 'BR' },
  'buenos aires':  { lat: -34.6037, lon: -58.3816,  noaaCoverage: false, unit: 'celsius', wuStation: 'SAEZ', resolutionSource: 'wu', isoCountry: 'AR' },
  ankara:          { lat: 39.9334, lon: 32.8597,    noaaCoverage: false, unit: 'celsius', wuStation: 'LTAC', resolutionSource: 'wu', isoCountry: 'TR' },
  lucknow:         { lat: 26.8467, lon: 80.9462,    noaaCoverage: false, unit: 'celsius', wuStation: 'VILK', resolutionSource: 'wu', isoCountry: 'IN' },
  // NOAA WRH station LLBG — coords pinned to airport; resolved via METAR, not WU
  'tel aviv':      { lat: 31.9965, lon: 34.8906,    noaaCoverage: false, unit: 'celsius', wuStation: 'LLBG', resolutionSource: 'metar' },
  // Resolves via Hong Kong Observatory. HKO reports to 1 dp; bracket labels are integer °C.
  'hong kong':     { lat: 22.3020, lon: 114.1740,   noaaCoverage: false, unit: 'celsius', wuStation: 'HKO',  resolutionSource: 'hko' },
  // Malpensa (LIMC), not Linate (LIML) — Polymarket resolves against LIMC
  milan:           { lat: 45.6306, lon: 8.7281,     noaaCoverage: false, unit: 'celsius', wuStation: 'LIMC', resolutionSource: 'wu', isoCountry: 'IT' },
  madrid:          { lat: 40.4168, lon: -3.7038,    noaaCoverage: false, unit: 'celsius', wuStation: 'LEMD', resolutionSource: 'wu', isoCountry: 'ES' },
  warsaw:          { lat: 52.2297, lon: 21.0122,    noaaCoverage: false, unit: 'celsius', wuStation: 'EPWA', resolutionSource: 'wu', isoCountry: 'PL' },
  shenzhen:        { lat: 22.5431, lon: 114.0579,   noaaCoverage: false, unit: 'celsius', wuStation: 'ZGSZ', resolutionSource: 'wu', isoCountry: 'CN' },
  // NOAA WRH station LTFM — coords pinned to airport; resolved via METAR, not WU
  istanbul:        { lat: 41.2611, lon: 28.7425,    noaaCoverage: false, unit: 'celsius', wuStation: 'LTFM', resolutionSource: 'metar' },
  'mexico city':   { lat: 19.4326, lon: -99.1332,   noaaCoverage: false, unit: 'celsius', wuStation: 'MMMX', resolutionSource: 'wu', isoCountry: 'MX' },
  amsterdam:       { lat: 52.3676, lon: 4.9041,     noaaCoverage: false, unit: 'celsius', wuStation: 'EHAM', resolutionSource: 'wu', isoCountry: 'NL' },
  // Marcos A. Gelabert/Albrook (MPMG), not Tocumen (MPTO)
  'panama city':   { lat: 8.9833,  lon: -79.5556,   noaaCoverage: false, unit: 'celsius', wuStation: 'MPMG', resolutionSource: 'wu', isoCountry: 'PA' },
  // Halim Perdanakusuma (WIHH), not Soekarno-Hatta (WIII)
  jakarta:         { lat: -6.2661, lon: 106.8908,   noaaCoverage: false, unit: 'celsius', wuStation: 'WIHH', resolutionSource: 'wu', isoCountry: 'ID' },
  jeddah:          { lat: 21.4858, lon: 39.1925,    noaaCoverage: false, unit: 'celsius', wuStation: 'OEJN', resolutionSource: 'wu', isoCountry: 'SA' },
  // NOAA WRH station UUWW — Vnukovo International; resolved via METAR
  moscow:          { lat: 55.5915, lon: 37.2615,    noaaCoverage: false, unit: 'celsius', wuStation: 'UUWW', resolutionSource: 'metar' },
  // NOAA WRH station RCTP — Taiwan Taoyuan International; resolved via METAR
  taipei:          { lat: 25.0777, lon: 121.2328,   noaaCoverage: false, unit: 'celsius', wuStation: 'RCTP', resolutionSource: 'metar' },
};

// ── Aliases: map Polymarket event title city names to canonical keys ───────
const CITY_ALIASES: Record<string, string> = {
  'new york city': 'new york',
  'nyc': 'new york',
  'ny': 'new york',
  'la': 'los angeles',
  'l.a.': 'los angeles',
  'sf': 'san francisco',
  'dc': 'washington dc',
  'd.c.': 'washington dc',
  'são paulo': 'sao paulo',
  'saopaulo': 'sao paulo',
  'buenosaires': 'buenos aires',
  'mexicocity': 'mexico city',
  'panamacity': 'panama city',
  'telaviv': 'tel aviv',
  'hongkong': 'hong kong',
};

/**
 * Look up city coordinates by name. Case-insensitive, supports aliases.
 */
export function lookupCity(cityName: string): CityCoordinates | null {
  const key = cityName.trim().toLowerCase();
  const resolved = CITY_ALIASES[key] ?? key;
  return CITY_COORDINATES[resolved] ?? null;
}

/**
 * Resolve a city name (possibly aliased) to the canonical key used by
 * `CITY_COORDINATES`. Returns null if the city is unknown. Callers that
 * persist city as an identifier (e.g. weather_ground_truth.city) must use
 * this to avoid alias-duplicated rows.
 */
export function canonicalCityKey(cityName: string): string | null {
  const key = cityName.trim().toLowerCase();
  const resolved = CITY_ALIASES[key] ?? key;
  return CITY_COORDINATES[resolved] ? resolved : null;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface NwsForecast {
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
    headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'application/geo+json' },
  }).finally(() => {
    clearTimeout(timer);
  });
}

function celsiusToFahrenheit(c: number): number {
  return c * 9 / 5 + 32;
}

/**
 * Extract the local calendar date (YYYY-MM-DD) from an ISO 8601 string.
 * NWS period timestamps include a local offset (e.g. "2026-04-15T18:00:00-04:00").
 * We match on the local date portion to avoid UTC conversion shifting the calendar day.
 */
function toLocalDateStr(isoString: string): string {
  // ISO strings from NWS are formatted as "YYYY-MM-DDThh:mm:ss±hh:mm"
  // The first 10 characters are the local date.
  const dateOnly = isoString.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return dateOnly;
  // Fallback: parse and use UTC (shouldn't happen with NWS data)
  const d = new Date(isoString);
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
export async function fetchNwsForecast(
  lat: number,
  lon: number,
  targetDate: string,
  fetchFn: FetchFn = fetch,
): Promise<NwsForecast | null> {
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

    // Match periods to the target date using local date portion
    const targetDateStr = targetDate.trim().slice(0, 10); // YYYY-MM-DD
    const matchingPeriods = periods.filter(
      (p) => p.startTime && toLocalDateStr(p.startTime) === targetDateStr,
    );

    if (matchingPeriods.length === 0) {
      logger.debug('[weather] no forecast periods match target date', {
        targetDate: targetDateStr,
        availableDates: periods
          .filter((p) => p.startTime)
          .map((p) => toLocalDateStr(p.startTime!))
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
    logger.warn('[weather] fetchNwsForecast failed', {
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
 * Get the default forecast standard deviation for a given forecast horizon.
 * Calibrated from NWS MOS verification studies.
 *
 * Returned values are calibrated in degrees Fahrenheit (°F).
 * For Celsius markets, convert the returned value by multiplying by 5/9.
 *
 * @param daysOut - Number of days until the target date (0 = today)
 * @param month - Optional month (1-12) for seasonal adjustment
 * @returns Standard deviation in °F
 */
export function getDefaultStdDev(daysOut: number, month?: number): number {
  let base: number;
  if (daysOut <= 1) base = 3.5;
  else if (daysOut <= 2) base = 4.5;
  else if (daysOut <= 3) base = 5.0;
  else if (daysOut <= 5) base = 6.5;
  else base = 8.0;

  // Seasonal adjustment: winter forecasts have ~25% more error,
  // summer forecasts ~15% less (NWS verification data)
  if (month !== undefined) {
    if (month >= 12 || month <= 2) return base * 1.25;
    if (month >= 6 && month <= 8) return base * 0.85;
  }
  return base;
}

/**
 * Estimate the probability of temperature exceeding a threshold given a
 * point forecast and horizon-dependent uncertainty.
 *
 * Uses a normal distribution approximation with updated stddev values
 * calibrated from NWS MOS verification studies.
 *
 * @param forecastTemp - Point forecast temperature
 * @param threshold - Market threshold temperature
 * @param daysOut - Number of days until the target date (0 = today)
 * @param stdDevOverride - Optional stddev from ensemble data (replaces default)
 * @returns Probability that actual temperature exceeds the threshold [0, 1]
 */
export function estimateExceedanceProbability(
  forecastTemp: number,
  threshold: number,
  daysOut: number,
  stdDevOverride?: number,
): number {
  const stdDev = stdDevOverride ?? getDefaultStdDev(daysOut);

  // z-score: how many std devs the threshold is above the forecast
  const z = (threshold - forecastTemp) / stdDev;

  // P(X > threshold) = 1 - Phi(z) where Phi is the standard normal CDF
  return 1 - normalCdf(z);
}

/**
 * Estimate the probability that temperature falls within a bracket [low, high).
 *
 * For interior brackets: P(low <= T < high) = CDF(high) - CDF(low)
 * Uses half-integer boundaries to account for whole-degree resolution rounding.
 *
 * @param forecastTemp - Point forecast temperature
 * @param bracketLow - Lower bracket boundary (null for low-tail bracket)
 * @param bracketHigh - Upper bracket boundary (null for high-tail bracket)
 * @param daysOut - Number of days until the target date
 * @param stdDevOverride - Optional stddev from ensemble data
 * @returns Probability [0, 1]
 */
export function estimateBracketProbability(
  forecastTemp: number,
  bracketLow: number | null,
  bracketHigh: number | null,
  daysOut: number,
  stdDevOverride?: number,
): number {
  const stdDev = stdDevOverride ?? getDefaultStdDev(daysOut);

  // Use half-integer boundaries to handle whole-degree rounding.
  // "39°F or below" means T <= 39, so effective upper boundary is 39.5
  // "40-41°F" means 40 <= T <= 41, so boundaries are [39.5, 41.5)
  // "58°F or higher" means T >= 58, so effective lower boundary is 57.5

  if (bracketLow === null && bracketHigh !== null) {
    // Low-tail bracket: P(T <= bracketHigh) = CDF at bracketHigh + 0.5
    const z = (bracketHigh + 0.5 - forecastTemp) / stdDev;
    return normalCdf(z);
  }

  if (bracketHigh === null && bracketLow !== null) {
    // High-tail bracket: P(T >= bracketLow) = 1 - CDF at bracketLow - 0.5
    const z = (bracketLow - 0.5 - forecastTemp) / stdDev;
    return 1 - normalCdf(z);
  }

  if (bracketLow !== null && bracketHigh !== null) {
    // Interior bracket: P(bracketLow <= T <= bracketHigh)
    const zHigh = (bracketHigh + 0.5 - forecastTemp) / stdDev;
    const zLow = (bracketLow - 0.5 - forecastTemp) / stdDev;
    return normalCdf(zHigh) - normalCdf(zLow);
  }

  // Both null — shouldn't happen
  return 0;
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
