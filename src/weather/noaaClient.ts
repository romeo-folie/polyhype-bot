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
  /** Bracket containment semantics of the resolution source. Absent (default) =
   *  'round': integer resolution, bracket "N°" spans [N−0.5, N+0.5). 'floor':
   *  ONE-DECIMAL resolution where the containing bracket is the integer floor —
   *  "N°" = [N.0, N.9]. Verified for Hong Kong 2026-07-08: HKO "Absolute Daily
   *  Max" resolves to one decimal and the official 31.6 on 07-06 resolved the
   *  "31°C" bracket YES. Certainty logic (lock-in, classifyOracleState) must
   *  require observed ≥ high+1 (not > high+0.5) to call a floor bracket exceeded —
   *  the 2026-07-08 false lock-in (pos 5628) fired through this half-degree gap. */
  bracketSemantics?: 'floor';
  /** ISO 3166-1 alpha-2 country code — required for WU cities (constructs ICAO:9:ISO2 location key). */
  isoCountry?: string;
  /** IANA timezone identifier — used to determine the city's local calendar date. */
  tz: string;
}

// Cities active on Polymarket weather markets.
// US cities use Fahrenheit, international cities use Celsius.
//
// lat/lon = the RESOLUTION STATION's coordinates, not the city center.
// Polymarket settles each market against a specific station (named in the
// market description); forecasting the city center instead bakes a
// geography offset (coastal marine layer, airport elevation, 25km+ of
// distance) into every probability. cityBias then has to absorb terrain
// as if it were model error — and non-constant gaps (KLAX marine layer:
// −11°F some June days) cannot be absorbed by a mean shift at all.
// Aligned 2026-06-12 after the LTBA/LTFM mismatch audit; verify against
// `stationAudit.ts` (runs with the weather reconciler) before editing.
export const CITY_COORDINATES: Record<string, CityCoordinates> = {
  // US cities (Fahrenheit) — all resolve via Weather Underground
  'new york':      { lat: 40.7769, lon: -73.8740,   noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KLGA', resolutionSource: 'wu', isoCountry: 'US', tz: 'America/New_York'     },
  chicago:         { lat: 41.9786, lon: -87.9048,   noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KORD', resolutionSource: 'wu', isoCountry: 'US', tz: 'America/Chicago'       },
  miami:           { lat: 25.7959, lon: -80.2870,   noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KMIA', resolutionSource: 'wu', isoCountry: 'US', tz: 'America/New_York'     },
  // Hobby (KHOU), not IAH — Polymarket resolves against KHOU
  houston:         { lat: 29.6454, lon: -95.2789,   noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KHOU', resolutionSource: 'wu', isoCountry: 'US', tz: 'America/Chicago'       },
  dallas:          { lat: 32.8471, lon: -96.8518,   noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KDAL', resolutionSource: 'wu', isoCountry: 'US', tz: 'America/Chicago'       },
  // Buckley SFB (KBKF) in Aurora, not Denver airport — Polymarket resolves against KBKF
  denver:          { lat: 39.7016, lon: -104.7516,  noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KBKF', resolutionSource: 'wu', isoCountry: 'US', tz: 'America/Denver'        },
  seattle:         { lat: 47.4502, lon: -122.3088,  noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KSEA', resolutionSource: 'wu', isoCountry: 'US', tz: 'America/Los_Angeles'   },
  atlanta:         { lat: 33.6407, lon: -84.4277,   noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KATL', resolutionSource: 'wu', isoCountry: 'US', tz: 'America/New_York'     },
  austin:          { lat: 30.1945, lon: -97.6699,   noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KAUS', resolutionSource: 'wu', isoCountry: 'US', tz: 'America/Chicago'       },
  // KLAX is on the coast — downtown LA (the old coords) runs up to 11°F hotter
  // when the marine layer holds at the airport. Forecast the airport.
  'los angeles':   { lat: 33.9416, lon: -118.4085,  noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KLAX', resolutionSource: 'wu', isoCountry: 'US', tz: 'America/Los_Angeles'   },
  'san francisco': { lat: 37.6213, lon: -122.3790,  noaaCoverage: true,  unit: 'fahrenheit', wuStation: 'KSFO', resolutionSource: 'wu', isoCountry: 'US', tz: 'America/Los_Angeles'   },
  // International cities (Celsius) — WU unless noted
  london:          { lat: 51.5053, lon: 0.0553,     noaaCoverage: false, unit: 'celsius', wuStation: 'EGLC', resolutionSource: 'wu', isoCountry: 'GB', tz: 'Europe/London'             },
  // Paris-Le Bourget (LFPB), NOT Charles de Gaulle (LFPG) — Polymarket's
  // description names Le Bourget. LFPG cost us the May-31 and Jun-11 2026
  // markets (resolved 1°C above our CDG reading both times).
  paris:           { lat: 48.9694, lon: 2.4414,     noaaCoverage: false, unit: 'celsius', wuStation: 'LFPB', resolutionSource: 'wu', isoCountry: 'FR', tz: 'Europe/Paris'              },
  toronto:         { lat: 43.6777, lon: -79.6248,   noaaCoverage: false, unit: 'celsius', wuStation: 'CYYZ', resolutionSource: 'wu', isoCountry: 'CA', tz: 'America/Toronto'           },
  'sao paulo':     { lat: -23.4356, lon: -46.4731,  noaaCoverage: false, unit: 'celsius', wuStation: 'SBGR', resolutionSource: 'wu', isoCountry: 'BR', tz: 'America/Sao_Paulo'        },
  'buenos aires':  { lat: -34.8222, lon: -58.5358,  noaaCoverage: false, unit: 'celsius', wuStation: 'SAEZ', resolutionSource: 'wu', isoCountry: 'AR', tz: 'America/Argentina/Buenos_Aires' },
  // Esenboğa (LTAC) sits 25km north of Ankara and ~200m higher — forecast it directly.
  ankara:          { lat: 40.1281, lon: 32.9951,    noaaCoverage: false, unit: 'celsius', wuStation: 'LTAC', resolutionSource: 'wu', isoCountry: 'TR', tz: 'Europe/Istanbul'           },
  lucknow:         { lat: 26.7606, lon: 80.8893,    noaaCoverage: false, unit: 'celsius', wuStation: 'VILK', resolutionSource: 'wu', isoCountry: 'IN', tz: 'Asia/Kolkata'              },
  // Ben Gurion (LLBG). Originally routed through METAR; switched to WU
  // 2026-04-24 after the aviationweather.gov endpoint was found to cap at
  // ~400 obs regardless of the `hours` param (effective ~9-day window, not
  // the 30 days the code assumed). WU has 35+ days of LLBG history.
  'tel aviv':      { lat: 31.9965, lon: 34.8906,    noaaCoverage: false, unit: 'celsius', wuStation: 'LLBG', resolutionSource: 'wu', isoCountry: 'IL', tz: 'Asia/Jerusalem'            },
  // Resolves via Hong Kong Observatory. HKO reports to 1 dp; bracket labels are integer °C.
  'hong kong':     { lat: 22.3020, lon: 114.1740,   noaaCoverage: false, unit: 'celsius', wuStation: 'HKO',  resolutionSource: 'hko', bracketSemantics: 'floor', tz: 'Asia/Hong_Kong'          },
  // Malpensa (LIMC), not Linate (LIML) — Polymarket resolves against LIMC
  milan:           { lat: 45.6306, lon: 8.7281,     noaaCoverage: false, unit: 'celsius', wuStation: 'LIMC', resolutionSource: 'wu', isoCountry: 'IT', tz: 'Europe/Rome'               },
  madrid:          { lat: 40.4719, lon: -3.5626,    noaaCoverage: false, unit: 'celsius', wuStation: 'LEMD', resolutionSource: 'wu', isoCountry: 'ES', tz: 'Europe/Madrid'             },
  warsaw:          { lat: 52.1657, lon: 20.9671,    noaaCoverage: false, unit: 'celsius', wuStation: 'EPWA', resolutionSource: 'wu', isoCountry: 'PL', tz: 'Europe/Warsaw'             },
  shenzhen:        { lat: 22.6393, lon: 113.8108,   noaaCoverage: false, unit: 'celsius', wuStation: 'ZGSZ', resolutionSource: 'wu', isoCountry: 'CN', tz: 'Asia/Shanghai'             },
  // Istanbul Airport (LTFM) — the station Polymarket actually resolves
  // against (market description links weather.gov/wrh/timeseries?site=LTFM).
  // We previously proxied via Atatürk (LTBA) because WU returns HTTP 400 for
  // LTFM, assuming cityBias would absorb the offset. It cannot: LTFM is on
  // the Black Sea coast and diverges from LTBA by up to 4°C depending on
  // wind (Jun 9 2026: LTFM 23 / LTBA 27 — market resolved 23, we held the
  // LTBA view and lost). WU still has no LTFM history, so resolution goes
  // through METAR (aviationweather.gov), which carries the same observations
  // NOAA's timeseries page renders. METAR's ~8-day window is fine for the
  // reconciler's day-after fetch.
  istanbul:        { lat: 41.2753, lon: 28.7519,    noaaCoverage: false, unit: 'celsius', wuStation: 'LTFM', resolutionSource: 'metar', isoCountry: 'TR', tz: 'Europe/Istanbul'        },
  'mexico city':   { lat: 19.4363, lon: -99.0721,   noaaCoverage: false, unit: 'celsius', wuStation: 'MMMX', resolutionSource: 'wu', isoCountry: 'MX', tz: 'America/Mexico_City'      },
  amsterdam:       { lat: 52.3105, lon: 4.7683,     noaaCoverage: false, unit: 'celsius', wuStation: 'EHAM', resolutionSource: 'wu', isoCountry: 'NL', tz: 'Europe/Amsterdam'          },
  // Marcos A. Gelabert/Albrook (MPMG), not Tocumen (MPTO)
  'panama city':   { lat: 8.9833,  lon: -79.5556,   noaaCoverage: false, unit: 'celsius', wuStation: 'MPMG', resolutionSource: 'wu', isoCountry: 'PA', tz: 'America/Panama'           },
  // Halim Perdanakusuma (WIHH), not Soekarno-Hatta (WIII)
  jakarta:         { lat: -6.2661, lon: 106.8908,   noaaCoverage: false, unit: 'celsius', wuStation: 'WIHH', resolutionSource: 'wu', isoCountry: 'ID', tz: 'Asia/Jakarta'              },
  jeddah:          { lat: 21.6796, lon: 39.1565,    noaaCoverage: false, unit: 'celsius', wuStation: 'OEJN', resolutionSource: 'wu', isoCountry: 'SA', tz: 'Asia/Riyadh'              },
  // Vnukovo (UUWW). Switched METAR → WU 2026-04-24 (same reason as tel aviv).
  // Market resolves via NOAA's timeseries page for the same ICAO — both
  // render the UUWW METAR feed, so WU remains equivalent here.
  moscow:          { lat: 55.5915, lon: 37.2615,    noaaCoverage: false, unit: 'celsius', wuStation: 'UUWW', resolutionSource: 'wu', isoCountry: 'RU', tz: 'Europe/Moscow'             },
  // Songshan (RCSS), downtown Taipei — the station Polymarket's description
  // names. We previously used Taoyuan (RCTP), 30km west on the coast and
  // systematically cooler; that gap is likely why taipei's bias never
  // stabilised and the city ended up in WEATHER_EXCLUDED_CITIES.
  taipei:          { lat: 25.0694, lon: 121.5521,   noaaCoverage: false, unit: 'celsius', wuStation: 'RCSS', resolutionSource: 'wu', isoCountry: 'TW', tz: 'Asia/Taipei'               },
  // ── Added 2026-06-12 (station-audit discovery): all cities below were
  // live on Polymarket without tracking. Stations/units extracted from the
  // market descriptions; every ICAO verified to return WU observations.
  // Ground truth + bias accumulate via the reconciler from day one; keep
  // them in WEATHER_EXCLUDED_CITIES until the bias window has samples.
  beijing:         { lat: 40.0801, lon: 116.5846,   noaaCoverage: false, unit: 'celsius', wuStation: 'ZBAA', resolutionSource: 'wu', isoCountry: 'CN', tz: 'Asia/Shanghai'              },
  busan:           { lat: 35.1795, lon: 128.9382,   noaaCoverage: false, unit: 'celsius', wuStation: 'RKPK', resolutionSource: 'wu', isoCountry: 'KR', tz: 'Asia/Seoul'                 },
  'cape town':     { lat: -33.9648, lon: 18.6017,   noaaCoverage: false, unit: 'celsius', wuStation: 'FACT', resolutionSource: 'wu', isoCountry: 'ZA', tz: 'Africa/Johannesburg'        },
  chengdu:         { lat: 30.5785, lon: 103.9471,   noaaCoverage: false, unit: 'celsius', wuStation: 'ZUUU', resolutionSource: 'wu', isoCountry: 'CN', tz: 'Asia/Shanghai'              },
  chongqing:       { lat: 29.7192, lon: 106.6417,   noaaCoverage: false, unit: 'celsius', wuStation: 'ZUCK', resolutionSource: 'wu', isoCountry: 'CN', tz: 'Asia/Shanghai'              },
  guangzhou:       { lat: 23.3924, lon: 113.2988,   noaaCoverage: false, unit: 'celsius', wuStation: 'ZGGG', resolutionSource: 'wu', isoCountry: 'CN', tz: 'Asia/Shanghai'              },
  helsinki:        { lat: 60.3172, lon: 24.9633,    noaaCoverage: false, unit: 'celsius', wuStation: 'EFHK', resolutionSource: 'wu', isoCountry: 'FI', tz: 'Europe/Helsinki'            },
  jinan:           { lat: 36.8572, lon: 117.2161,   noaaCoverage: false, unit: 'celsius', wuStation: 'ZSJN', resolutionSource: 'wu', isoCountry: 'CN', tz: 'Asia/Shanghai'              },
  // WU labels OPKC "Masroor Airbase" but the URL ICAO is OPKC (Jinnah Intl);
  // the URL ICAO is what the fetcher queries, so coords follow OPKC.
  karachi:         { lat: 24.9065, lon: 67.1608,    noaaCoverage: false, unit: 'celsius', wuStation: 'OPKC', resolutionSource: 'wu', isoCountry: 'PK', tz: 'Asia/Karachi'               },
  'kuala lumpur':  { lat: 2.7456,  lon: 101.7099,   noaaCoverage: false, unit: 'celsius', wuStation: 'WMKK', resolutionSource: 'wu', isoCountry: 'MY', tz: 'Asia/Kuala_Lumpur'          },
  manila:          { lat: 14.5086, lon: 121.0194,   noaaCoverage: false, unit: 'celsius', wuStation: 'RPLL', resolutionSource: 'wu', isoCountry: 'PH', tz: 'Asia/Manila'                },
  munich:          { lat: 48.3538, lon: 11.7861,    noaaCoverage: false, unit: 'celsius', wuStation: 'EDDM', resolutionSource: 'wu', isoCountry: 'DE', tz: 'Europe/Berlin'              },
  qingdao:         { lat: 36.3614, lon: 120.0883,   noaaCoverage: false, unit: 'celsius', wuStation: 'ZSQD', resolutionSource: 'wu', isoCountry: 'CN', tz: 'Asia/Shanghai'              },
  seoul:           { lat: 37.4602, lon: 126.4407,   noaaCoverage: false, unit: 'celsius', wuStation: 'RKSI', resolutionSource: 'wu', isoCountry: 'KR', tz: 'Asia/Seoul'                 },
  shanghai:        { lat: 31.1443, lon: 121.8083,   noaaCoverage: false, unit: 'celsius', wuStation: 'ZSPD', resolutionSource: 'wu', isoCountry: 'CN', tz: 'Asia/Shanghai'              },
  singapore:       { lat: 1.3644,  lon: 103.9915,   noaaCoverage: false, unit: 'celsius', wuStation: 'WSSS', resolutionSource: 'wu', isoCountry: 'SG', tz: 'Asia/Singapore'             },
  tokyo:           { lat: 35.5494, lon: 139.7798,   noaaCoverage: false, unit: 'celsius', wuStation: 'RJTT', resolutionSource: 'wu', isoCountry: 'JP', tz: 'Asia/Tokyo'                 },
  wellington:      { lat: -41.3272, lon: 174.8053,  noaaCoverage: false, unit: 'celsius', wuStation: 'NZWN', resolutionSource: 'wu', isoCountry: 'NZ', tz: 'Pacific/Auckland'           },
  wuhan:           { lat: 30.7838, lon: 114.2081,   noaaCoverage: false, unit: 'celsius', wuStation: 'ZHHH', resolutionSource: 'wu', isoCountry: 'CN', tz: 'Asia/Shanghai'              },
  zhengzhou:       { lat: 34.5197, lon: 113.8409,   noaaCoverage: false, unit: 'celsius', wuStation: 'ZHCC', resolutionSource: 'wu', isoCountry: 'CN', tz: 'Asia/Shanghai'              },
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
 * Calibrated from NWS MOS verification studies extended with ECMWF ensemble
 * verification data for the 8-14 day range.
 *
 * Returned values are calibrated in degrees Fahrenheit (°F).
 * For Celsius markets, convert the returned value by multiplying by 5/9.
 *
 * Days 1-7: NWS MOS verification (short/medium range)
 * Days 8-14: ECMWF ensemble verification (~10°F at day 10, ~12.5°F at day 14)
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
  else if (daysOut <= 7) base = 8.0;
  else if (daysOut <= 10) base = 10.0;
  else base = 12.5; // days 11-14

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
  semantics: 'round' | 'floor' = 'round',
): number {
  const stdDev = stdDevOverride ?? getDefaultStdDev(daysOut);

  // Bracket boundaries depend on the resolution source's precision (see
  // CityCoordinates.bracketSemantics — all markets resolve by CONTAINMENT):
  //   'round' (whole-degree sources, the default): the source rounds its
  //     measurement to an integer, so "40-41°F" ≈ [39.5, 41.5) in true °.
  //   'floor' (one-decimal sources, e.g. HKO): the containing bracket is the
  //     integer floor of a one-decimal value, so "31°C" = [31.0, 32.0) —
  //     boundaries sit half a degree HIGHER than the round convention. Pricing
  //     HK on 'round' shifted every bracket probability by that half degree.
  const hiEdge = semantics === 'floor' ? 1.0 : 0.5;
  const loEdge = semantics === 'floor' ? 0.0 : 0.5;

  if (bracketLow === null && bracketHigh !== null) {
    // Low-tail bracket: P(T <= bracketHigh per source precision)
    const z = (bracketHigh + hiEdge - forecastTemp) / stdDev;
    return normalCdf(z);
  }

  if (bracketHigh === null && bracketLow !== null) {
    // High-tail bracket: P(T >= bracketLow per source precision)
    const z = (bracketLow - loEdge - forecastTemp) / stdDev;
    return 1 - normalCdf(z);
  }

  if (bracketLow !== null && bracketHigh !== null) {
    // Interior bracket: P(bracketLow <= T <= bracketHigh)
    const zHigh = (bracketHigh + hiEdge - forecastTemp) / stdDev;
    const zLow = (bracketLow - loEdge - forecastTemp) / stdDev;
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
