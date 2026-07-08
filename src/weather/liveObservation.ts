/**
 * Intraday live observation clients for weather drift strategy (Phase 5).
 *
 * Routes to the correct intraday observation source for each city based on
 * CityCoordinates.resolutionSource:
 *   'wu'    → fetchWuIntradayHigh    (Weather Underground, same-day hourly)
 *   'metar' → fetchMetarIntradayHigh (aviationweather.gov, hours=48 filter)
 *   'hko'   → fetchHkoIntradayHigh   (HKO rhrread API, Redis-accumulated max)
 *
 * All three share the same output contract: WeatherLiveObservation.
 * A city with no viable intraday source returns confidence:'none'.
 *
 * Observations are cached in Redis at weather:live_obs:<city>:<date> for
 * WEATHER_DRIFT_LIVE_OBS_MAX_AGE_MIN minutes so a single scan cycle only
 * incurs one external request per city.
 *
 * Log marker: [weather-live-obs]
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { lookupCity } from './noaaClient.js';
import { fetchWuHistoricalExtremeWithTimestamp } from './wuClient.js';

const REQUEST_TIMEOUT_MS = 10_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type LiveObsSource = 'wu-live' | 'metar-live' | 'hko-live' | 'none';
export type LiveObsConfidence = 'settlement_aligned' | 'proxy' | 'none';

export interface WeatherLiveObservation {
  city: string;
  targetDate: string;
  /** Intraday running extreme temperature in the city's native unit, null when
   *  unavailable. For metric='high' this is the running daily MAX; for
   *  metric='low' it is the running daily MIN. */
  observedMax: number | null;
  /** Which daily extreme observedMax tracks — drives the oracle direction. */
  metric: 'high' | 'low';
  source: LiveObsSource;
  /** Settlement-aligned: same source as the final reconciler; proxy: different source or intraday proxy. */
  confidence: LiveObsConfidence;
  /** True when observedMax comes from a Redis-accumulated running extreme that can
   *  only move in the extreme direction within the day (max only up / min only down)
   *  AND whose underlying readings are final (never retroactively revised). Only such
   *  a source is safe for an IRREVERSIBLE lock-in: WU re-fetches an array that can be
   *  QC-corrected downward (the 2026-06-29 Seoul failure), so it is NOT monotonic;
   *  HKO (rhrread current-reading) and METAR (final published reports), both
   *  Redis-accumulated, ARE. See WEATHER_LOCKIN_MONOTONIC_SOURCES_ONLY. */
  monotonic: boolean;
  /** ISO8601 UTC timestamp of the most recent observation that contributed to observedMax. */
  observedAt: string | null;
  /** True when observedMax is built from a feed that ROUNDS to whole degrees (e.g. the
   *  HKO rhrread fallback: a displayed 32 can be a true 31.5–32.4 — the 2026-07-08 false
   *  lock-in fired on a rounded 31.8). Certainty consumers must add 0.5° slack. Absent/
   *  false for one-decimal or exact feeds. */
  integerRounded?: boolean;
}

// ── Redis cache ───────────────────────────────────────────────────────────────

const LIVE_OBS_CACHE_PREFIX = 'weather:live_obs:';

// The cache key includes the metric so a city's highest- and lowest-temperature
// observations (running max vs running min for the same city/date) never collide.
function liveObsCacheKey(metric: 'high' | 'low', city: string, targetDate: string): string {
  return `${LIVE_OBS_CACHE_PREFIX}${metric}:${city}:${targetDate}`;
}

async function readCachedObs(
  redis: Redis,
  metric: 'high' | 'low',
  city: string,
  targetDate: string,
  maxAgeMin: number,
): Promise<WeatherLiveObservation | null> {
  try {
    const raw = await redis.get(liveObsCacheKey(metric, city, targetDate));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WeatherLiveObservation & { cachedAt: string };
    const ageMs = Date.now() - new Date(parsed.cachedAt).getTime();
    if (ageMs > maxAgeMin * 60_000) return null;
    // Migration shim: HKO rows cached by pre-integerRounded builds are rhrread
    // integers without the flag. Default them to ROUNDED (conservative — adds the
    // 0.5° certainty slack) so a stale cached "32" for a true 31.8 cannot re-fire
    // the 2026-07-08 false lock-in during the cache-TTL window after deploy.
    if (parsed.source === 'hko-live' && parsed.integerRounded === undefined) {
      parsed.integerRounded = true;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeCachedObs(
  redis: Redis,
  obs: WeatherLiveObservation,
  ttlS: number,
): Promise<void> {
  try {
    const value = JSON.stringify({ ...obs, cachedAt: new Date().toISOString() });
    await redis.set(liveObsCacheKey(obs.metric, obs.city, obs.targetDate), value, 'EX', ttlS);
  } catch {
    // Cache write is best-effort.
  }
}

// ── WU live ───────────────────────────────────────────────────────────────────

/**
 * Fetch the intraday running extreme from Weather Underground.
 * Uses the same historical endpoint with today's date — WU returns all hourly
 * observations up to now, so max(obs.temp) is the intraday high so far and
 * min(obs.temp) the intraday low so far (metric='low').
 */
async function fetchWuIntradayExtreme(
  icao: string,
  isoCountry: string,
  targetDate: string,
  unit: 'fahrenheit' | 'celsius',
  redis: Redis,
  metric: 'high' | 'low',
  fetchFn?: typeof fetch,
): Promise<{ observedMax: number | null; observedAt: string | null }> {
  const extreme = await fetchWuHistoricalExtremeWithTimestamp(
    icao,
    isoCountry,
    targetDate,
    unit,
    redis,
    metric,
    fetchFn,
  );
  return {
    observedMax: extreme?.observedMax ?? null,
    observedAt: extreme?.observedAt ?? null,
  };
}

// ── METAR live ────────────────────────────────────────────────────────────────

const METAR_BASE = 'https://aviationweather.gov/api/data/metar';

function fetchWithTimeout(url: string, fetchFn: typeof fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetchFn(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

interface MetarObservation {
  reportTime: string; // UTC ISO8601, e.g. "2026-04-17 14:00:00"
  temp: number | null;
}

/**
 * Fetch the intraday extreme temperature from hourly METAR observations.
 * Requests the last 48 hours and filters to observations on targetDate (UTC).
 * metric='low' reduces with min() to give the intraday running low.
 */
export async function fetchMetarIntradayExtreme(
  icao: string,
  targetDate: string,
  fetchFn: typeof fetch = fetch,
  metric: 'high' | 'low' = 'high',
): Promise<{ observedMax: number | null; observedAt: string | null }> {
  const url = `${METAR_BASE}?ids=${icao}&hours=48&format=json`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, fetchFn);
  } catch (err) {
    logger.warn('[weather-live-obs] METAR fetch error', {
      icao,
      targetDate,
      error: err instanceof Error ? err.message : String(err),
    });
    return { observedMax: null, observedAt: null };
  }

  if (!res.ok) {
    logger.warn('[weather-live-obs] METAR unexpected status', { icao, targetDate, status: res.status });
    return { observedMax: null, observedAt: null };
  }

  let obs: MetarObservation[];
  try {
    obs = (await res.json()) as MetarObservation[];
  } catch {
    logger.warn('[weather-live-obs] METAR JSON parse failed', { icao, targetDate });
    return { observedMax: null, observedAt: null };
  }

  if (!Array.isArray(obs) || obs.length === 0) {
    return { observedMax: null, observedAt: null };
  }

  const dayObs = obs.filter(
    (o) => typeof o.temp === 'number' && o.reportTime?.slice(0, 10) === targetDate,
  );

  if (dayObs.length === 0) return { observedMax: null, observedAt: null };

  const temps = dayObs.map((o) => o.temp!);
  const extreme = metric === 'low' ? Math.min(...temps) : Math.max(...temps);
  // Use the latest reportTime from today's observations as the observedAt stamp.
  const latestReport = dayObs
    .map((o) => o.reportTime)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const observedAt = latestReport ? new Date(latestReport + 'Z').toISOString() : new Date().toISOString();

  logger.debug('[weather-live-obs] METAR intraday extreme', {
    icao,
    targetDate,
    metric,
    extreme,
    obsCount: dayObs.length,
  });
  return { observedMax: extreme, observedAt };
}

/**
 * Fetch the intraday running MAXIMUM from METAR. Thin wrapper preserving the
 * original signature for callers/tests.
 */
export function fetchMetarIntradayHigh(
  icao: string,
  targetDate: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ observedMax: number | null; observedAt: string | null }> {
  return fetchMetarIntradayExtreme(icao, targetDate, fetchFn, 'high');
}

// ── HKO live ──────────────────────────────────────────────────────────────────

// Redis keys for accumulating the HKO intraday running extreme.
// Keyed by date so they reset each calendar day. TTL = 36h for overlap safety.
// Separate keys per metric so the running max and running min never overwrite
// each other when a city has both a highest- and a lowest-temperature market.
const HKO_INTRADAY_MAX_PREFIX = 'weather:hko_intraday_max:';
const HKO_INTRADAY_MIN_PREFIX = 'weather:hko_intraday_min:';
const HKO_INTRADAY_MAX_TTL_S = 36 * 3600;

/**
 * Accumulate a Redis-backed intraday running extreme: store currentReading only
 * when it is MORE extreme than the stored value (higher for 'high', lower for
 * 'low'), then return the running extreme. This makes the result MONOTONIC within
 * the day — a later, lower reading never lowers the stored max — which is the
 * property an irreversible lock-in requires. Shared by HKO (rhrread) and METAR
 * (final published reports); both have non-revising underlying readings.
 * Best-effort: a Redis error falls back to currentReading.
 */
async function accumulateRunningExtreme(
  redis: Redis,
  accKey: string,
  currentReading: number | null,
  metric: 'high' | 'low',
  ttlS: number,
): Promise<number | null> {
  if (currentReading != null) {
    try {
      const storedRaw = await redis.get(accKey);
      const seed = metric === 'low' ? Infinity : -Infinity;
      const stored = storedRaw != null ? parseFloat(storedRaw) : seed;
      const isMoreExtreme = metric === 'low' ? currentReading < stored : currentReading > stored;
      if (!isFinite(stored) || isMoreExtreme) {
        await redis.set(accKey, String(currentReading), 'EX', ttlS);
      }
    } catch {
      // Redis write is best-effort.
    }
  }
  try {
    const storedRaw = await redis.get(accKey);
    if (storedRaw != null) {
      const running = parseFloat(storedRaw);
      if (isFinite(running)) return running;
    }
  } catch {
    // Fall through to currentReading.
  }
  return currentReading;
}

// METAR intraday running-extreme accumulator keys (mirrors HKO). Keyed by
// ICAO+date so each station/day resets; 36h TTL for overlap safety.
const METAR_INTRADAY_MAX_PREFIX = 'weather:metar_intraday_max:';
const METAR_INTRADAY_MIN_PREFIX = 'weather:metar_intraday_min:';
const METAR_INTRADAY_TTL_S = 36 * 3600;
const HKO_RHRREAD_URL =
  'https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en';
const HKO_STATION_NAME = 'Hong Kong Observatory';
// HKO's text-readings page publishes the station's running daily extremes
// ("Max / Min Air Temperature Since Midnight") at ONE DECIMAL — the same precision
// as the "Absolute Daily Max" the markets settle on. rhrread ROUNDS to integers
// (displayed 32 = true 31.5–32.4), which produced the 2026-07-08 false lock-in
// at a true 31.8. Prefer this page; fall back to rhrread when it fails.
const HKO_TEXT_READINGS_URL =
  'https://www.hko.gov.hk/textonly/v2/forecast/text_readings_e.htm';
// One-decimal accumulators are kept in SEPARATE keys: the legacy keys already hold
// ROUNDED integers (e.g. 32 for a true 31.8) which a max() would never let a correct
// one-decimal reading displace.
const HKO_INTRADAY_1DP_MAX_PREFIX = 'weather:hko_intraday_1dp_max:';
const HKO_INTRADAY_1DP_MIN_PREFIX = 'weather:hko_intraday_1dp_min:';

const HKO_TEXT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Parse the "HK Observatory" row of HKO's text-readings page into the one-decimal
 * running daily extremes since midnight. Returns null unless BOTH the page's
 * "Since Midnight (D Mon YYYY)" header matches targetDate (guards the HKT-midnight
 * rollover, same hazard as the rhrread recordTime check) AND the row parses to
 * plausible finite values. Exported for tests.
 *
 * Row shape (tags stripped):
 *   HK Observatory   30.4   77   31.8 / 25.3   +2.0 ...
 *   (current °C)  (humidity)  (max / min since midnight °C)
 */
export function parseHkoTextExtremes(
  pageHtml: string,
  targetDate: string,
): { max: number; min: number } | null {
  const txt = pageHtml.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');

  const [y, m, d] = targetDate.split('-').map((v) => parseInt(v, 10));
  const mon = HKO_TEXT_MONTHS[(m ?? 0) - 1];
  if (!y || !mon || !d) return null;
  if (!txt.includes(`(${d} ${mon} ${y})`)) return null;

  const row = txt.match(
    /HK Observatory\s+(-?\d+(?:\.\d+)?)\s+\d+\s+(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/,
  );
  if (!row) return null;
  const max = parseFloat(row[2]!);
  const min = parseFloat(row[3]!);
  if (!Number.isFinite(max) || !Number.isFinite(min)) return null;
  // Plausibility: HK extremes live well inside [-5, 45]°C and max ≥ min.
  if (max < min || max < -5 || max > 45 || min < -5 || min > 45) return null;
  return { max, min };
}

/** Fetch + parse the HKO one-decimal running extremes. Null on any failure. */
async function fetchHkoOneDecimalExtremes(
  targetDate: string,
  fetchFn: typeof fetch,
): Promise<{ max: number; min: number } | null> {
  try {
    const res = await fetchWithTimeout(HKO_TEXT_READINGS_URL, fetchFn);
    if (!res.ok) {
      logger.warn('[weather-live-obs] HKO text readings unexpected status', {
        targetDate, status: res.status,
      });
      return null;
    }
    const body = await res.text();
    const parsed = parseHkoTextExtremes(body, targetDate);
    if (!parsed) {
      logger.debug('[weather-live-obs] HKO text readings unparseable or wrong date', { targetDate });
    }
    return parsed;
  } catch (err) {
    logger.warn('[weather-live-obs] HKO text readings fetch error', {
      targetDate, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

interface HkoRhrreadStation {
  place: string;
  value: number;
  unit: string;
}

interface HkoRhrreadPayload {
  temperature?: {
    data?: HkoRhrreadStation[];
    recordTime?: string;
  };
}

/**
 * Fetch the current temperature at the Hong Kong Observatory station from the
 * HKO rhrread API, then update and return the Redis-accumulated intraday running
 * extreme for targetDate.
 *
 * The rhrread endpoint provides the most recent observation at HKO. Because the
 * daily maximum can only increase (and the daily minimum can only decrease),
 * accumulating it in Redis is equivalent to computing max/min over all
 * observations today. metric='low' tracks the running minimum.
 */
export async function fetchHkoIntradayExtreme(
  targetDate: string,
  redis: Redis,
  metric: 'high' | 'low' = 'high',
  fetchFn: typeof fetch = fetch,
): Promise<{ observedMax: number | null; observedAt: string | null; integerRounded: boolean }> {
  // Preferred source: the text-readings page's one-decimal running extremes —
  // settlement precision, no rounding gap. Accumulated in DEDICATED 1dp keys so
  // legacy rounded integers (e.g. a stored 32 for a true 31.8) can't mask them.
  const oneDp = await fetchHkoOneDecimalExtremes(targetDate, fetchFn);
  if (oneDp != null) {
    const reading = metric === 'low' ? oneDp.min : oneDp.max;
    const key1dp =
      `${metric === 'low' ? HKO_INTRADAY_1DP_MIN_PREFIX : HKO_INTRADAY_1DP_MAX_PREFIX}${targetDate}`;
    const now = new Date().toISOString();
    const running1dp = await accumulateRunningExtreme(redis, key1dp, reading, metric, HKO_INTRADAY_MAX_TTL_S);
    return { observedMax: running1dp ?? reading, observedAt: now, integerRounded: false };
  }

  const accKey =
    `${metric === 'low' ? HKO_INTRADAY_MIN_PREFIX : HKO_INTRADAY_MAX_PREFIX}${targetDate}`;

  let currentReading: number | null = null;
  let observedAt: string | null = null;

  let res: Response | undefined;
  try {
    res = await fetchWithTimeout(HKO_RHRREAD_URL, fetchFn);
  } catch (err) {
    logger.warn('[weather-live-obs] HKO rhrread fetch error', {
      targetDate,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (res?.ok) {
    let payload: HkoRhrreadPayload;
    try {
      payload = (await res.json()) as HkoRhrreadPayload;
      const station = payload?.temperature?.data?.find(
        (d) => d.place === HKO_STATION_NAME,
      );
      if (station && typeof station.value === 'number' && isFinite(station.value)) {
        const recordTime = payload.temperature?.recordTime ?? null;
        if (recordTime) {
          // Verify the observation belongs to targetDate in HKT (UTC+8).
          // rhrread is a "current reading" endpoint — around/after HKT midnight
          // it returns the next calendar day's reading before positions roll over,
          // which would contaminate the targetDate accumulator with wrong-day data.
          const hktDate = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Hong_Kong',
            year: 'numeric', month: '2-digit', day: '2-digit',
          }).format(new Date(recordTime));
          if (hktDate === targetDate) {
            currentReading = station.value;
            observedAt = new Date(recordTime).toISOString();
          } else {
            logger.debug('[weather-live-obs] HKO observation date mismatch — skipping update', {
              targetDate, observationDate: hktDate, recordTime,
            });
          }
        } else {
          // No recordTime — cannot verify calendar date; skip to avoid cross-date contamination.
          logger.debug('[weather-live-obs] HKO rhrread: no recordTime — skipping update', { targetDate });
        }
      }
    } catch {
      logger.warn('[weather-live-obs] HKO rhrread JSON parse failed', { targetDate });
    }
  } else if (res != null && !res.ok) {
    logger.warn('[weather-live-obs] HKO rhrread unexpected status', {
      targetDate,
      status: res.status,
    });
  }

  // Accumulate the Redis running extreme (max only up / min only down). Returns the
  // running value from an earlier observation today when the current reading is less
  // extreme (or this call had no reading but an earlier one is stored).
  // rhrread fallback values are ROUNDED integers → integerRounded: true so certainty
  // consumers (lock-in, oracle) apply the 0.5° slack.
  const running = await accumulateRunningExtreme(redis, accKey, currentReading, metric, HKO_INTRADAY_MAX_TTL_S);
  if (running != null) {
    return { observedMax: running, observedAt: observedAt ?? new Date().toISOString(), integerRounded: true };
  }
  return { observedMax: currentReading, observedAt, integerRounded: true };
}

/**
 * Fetch the HKO intraday running MAXIMUM. Thin wrapper preserving the original
 * signature for callers/tests.
 */
export function fetchHkoIntradayHigh(
  targetDate: string,
  redis: Redis,
  fetchFn: typeof fetch = fetch,
): Promise<{ observedMax: number | null; observedAt: string | null }> {
  return fetchHkoIntradayExtreme(targetDate, redis, 'high', fetchFn);
}

// ── Oracle state classification ───────────────────────────────────────────────

/**
 * Classify the oracle implication of a live observed daily extreme for an open
 * position. The intraday running value is monotone in one direction:
 *   metric='high' → running daily MAX, only increases.
 *   metric='low'  → running daily MIN, only decreases.
 *
 * `observed` is that running extreme. The conclusions are point-reflections of
 * each other across the two metrics.
 *
 * metric='high' (max only increases):
 *   Interior [low,high]: observed > high+0.5 → rounds ≥ high+1 → YES impossible, NO confirmed.
 *   High-tail "low or higher": observed ≥ low-0.5 → reached tail → YES confirmed, NO impossible.
 *   Low-tail "high or below": observed > high+0.5 → above ceiling → YES impossible, NO confirmed.
 *
 * metric='low' (min only decreases):
 *   Interior [low,high]: observed < low-0.5 → rounds ≤ low-1 → YES impossible, NO confirmed.
 *   High-tail "low or higher": observed < low-0.5 → dropped below floor → YES impossible, NO confirmed.
 *   Low-tail "high or below": observed < high+0.5 → reached ceiling → YES confirmed, NO impossible.
 *
 * Returns null when the observation is inconclusive — the running extreme is
 * still in a region the day could resolve either way from.
 */
export interface OracleClassifyOpts {
  /** Bracket containment semantics of the resolution source (see
   *  CityCoordinates.bracketSemantics). 'round' (default): "N°" = [N−0.5, N+0.5).
   *  'floor': one-decimal resolution, "N°" = [N.0, N.9] — exceeding the bracket
   *  needs observed ≥ high+1, not > high+0.5. */
  semantics?: 'round' | 'floor';
  /** Extra margin (native °) an observation must clear a boundary by before a
   *  CERTAINTY verdict is issued. Use 0.5 when the feed rounds to whole degrees
   *  (a displayed 32 only guarantees a true ≥31.5 — the 2026-07-08 HK false
   *  lock-in). Makes verdicts strictly harder; never flips a direction. */
  certaintySlack?: number;
}

/** Derive OracleClassifyOpts from the city's configured bracket semantics and
 *  whether the observation came from an integer-rounded feed. */
export function oracleClassifyOptsForCity(
  city: string,
  integerRounded?: boolean,
): OracleClassifyOpts {
  const coords = lookupCity(city);
  return {
    semantics: coords?.bracketSemantics === 'floor' ? 'floor' : 'round',
    certaintySlack: integerRounded ? 0.5 : 0,
  };
}

export function classifyOracleState(
  observed: number,
  direction: 'YES' | 'NO',
  bracket: { low: number | null; high: number | null },
  metric: 'high' | 'low' = 'high',
  opts?: OracleClassifyOpts,
): 'oracle_impossible' | 'oracle_confirmed' | null {
  const { low, high } = bracket;
  const isTail = low === null || high === null;
  const floor = opts?.semantics === 'floor';
  const slack = opts?.certaintySlack ?? 0;

  // Boundary predicates under both semantics. `slack` always makes a certainty
  // verdict HARDER to reach (the observation must clear the boundary by more).
  //   round: "N°" = [N−0.5, N+0.5)  → exceeded above when obs >  high+0.5; escaped
  //          below when obs < low−0.5; a tail is reached at its rounding boundary.
  //   floor: "N°" = [N.0, N.9]      → exceeded above when obs ≥ high+1; escaped
  //          below when obs < low;   a tail is reached at its integer boundary.
  const exceedsAbove = (v: number, h: number): boolean =>
    floor ? v >= h + 1 + slack : v > h + 0.5 + slack;
  const escapesBelow = (v: number, l: number): boolean =>
    floor ? v < l - slack : v < l - 0.5 - slack;
  const reachesHighTail = (v: number, l: number): boolean =>
    floor ? v >= l + slack : v >= l - 0.5 + slack;
  const reachesLowTail = (v: number, h: number): boolean =>
    floor ? v < h + 1 - slack : v < h + 0.5 - slack;

  if (metric === 'low') {
    // Daily minimum can only fall further intraday.
    if (!isTail) {
      // Interior: YES impossible once the running min has escaped below the bracket floor.
      if (escapesBelow(observed, low)) {
        return direction === 'YES' ? 'oracle_impossible' : 'oracle_confirmed';
      }
      return null;
    }
    if (low === null) {
      // Low-tail "high or below": YES means the final min lands at/below the ceiling.
      // Once the running min is already there, it can only go lower → YES confirmed.
      if (reachesLowTail(observed, high!)) {
        return direction === 'YES' ? 'oracle_confirmed' : 'oracle_impossible';
      }
      return null;
    }
    // High-tail "low or higher": YES means the final min stays at/above the floor.
    // Once the running min has escaped below it, it can never recover → YES impossible.
    if (escapesBelow(observed, low)) {
      return direction === 'YES' ? 'oracle_impossible' : 'oracle_confirmed';
    }
    return null;
  }

  // metric === 'high': daily maximum can only rise further intraday.
  if (!isTail) {
    // Interior bracket: YES is impossible once the running max has exceeded the
    // bracket's upper boundary (the day can only get hotter).
    if (exceedsAbove(observed, high)) {
      return direction === 'YES' ? 'oracle_impossible' : 'oracle_confirmed';
    }
    // If observed is still within or below the bracket, we can't conclude
    // anything yet — the day may not be over.
    return null;
  }

  if (low === null) {
    // Low-tail: "high or below" — YES means the final max stays at/below the ceiling.
    // If observed has already exceeded it, YES is impossible.
    if (exceedsAbove(observed, high!)) {
      return direction === 'YES' ? 'oracle_impossible' : 'oracle_confirmed';
    }
    return null;
  }

  // High-tail: "low or higher" — YES means the final max reaches the tail floor.
  // If observed is already there, the running max can only rise → YES confirmed.
  if (reachesHighTail(observed, low)) {
    return direction === 'YES' ? 'oracle_confirmed' : 'oracle_impossible';
  }
  return null;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export type FetchFn = typeof fetch;

/**
 * Fetch the live intraday observation for a city on a target date.
 * Routes to the correct source via CityCoordinates.resolutionSource.
 * Caches the result in Redis for maxAgeMin minutes.
 *
 * Always returns a WeatherLiveObservation — observedMax is null and confidence
 * is 'none' when no live source is available or the fetch fails.
 */
export async function fetchLiveObservation(
  city: string,
  targetDate: string,
  redis: Redis,
  opts: {
    wuEnabled: boolean;
    metarEnabled: boolean;
    hkoEnabled: boolean;
    maxAgeMin: number;
    /** Which daily extreme to track. Defaults to 'high'. */
    metric?: 'high' | 'low';
    fetchFn?: FetchFn;
  },
): Promise<WeatherLiveObservation> {
  const metric = opts.metric ?? 'high';
  const none: WeatherLiveObservation = {
    city,
    targetDate,
    observedMax: null,
    metric,
    source: 'none',
    confidence: 'none',
    monotonic: false,
    observedAt: null,
  };

  const coords = lookupCity(city);
  if (!coords) return none;

  // Check cache first.
  const cached = await readCachedObs(redis, metric, city, targetDate, opts.maxAgeMin);
  if (cached) return cached;

  const { resolutionSource, wuStation, isoCountry, unit } = coords;
  const fetchFn = opts.fetchFn ?? fetch;

  let result: WeatherLiveObservation;

  if (resolutionSource === 'hko' && opts.hkoEnabled) {
    const { observedMax, observedAt, integerRounded } =
      await fetchHkoIntradayExtreme(targetDate, redis, metric, fetchFn);
    result = {
      city,
      targetDate,
      observedMax,
      metric,
      source: 'hko-live',
      // HKO readings come from the official observatory station — same station as
      // the final dailyExtract settlement source, so intraday readings are
      // settlement_aligned when they support an irreversible oracle conclusion
      // (max only up / min only down).
      confidence: observedMax != null ? 'settlement_aligned' : 'none',
      // Redis-accumulated running extreme over a non-revising feed (one-decimal
      // text-readings page preferred; rhrread integer fallback).
      monotonic: true,
      observedAt,
      // rhrread fallback rounds to whole degrees — certainty consumers add 0.5° slack.
      integerRounded,
    };
  } else if (resolutionSource === 'wu' && opts.wuEnabled) {
    const { observedMax, observedAt } = await fetchWuIntradayExtreme(
      wuStation,
      isoCountry ?? '',
      targetDate,
      unit,
      redis,
      metric,
      fetchFn,
    );
    result = {
      city,
      targetDate,
      observedMax,
      metric,
      source: 'wu-live',
      // NOTE: confidence stays 'settlement_aligned' (same station as the final
      // extract) for the drift/oracle consumers, but WU is NOT monotonic — its
      // historical endpoint re-fetches an array WU can QC-correct downward, which
      // is the 2026-06-29 Seoul lock-in failure. The lock-in path gates on
      // `monotonic`, so it never trusts a revisable WU max for an irreversible bet.
      confidence: observedMax != null ? 'settlement_aligned' : 'none',
      monotonic: false,
      observedAt,
    };
  } else if (resolutionSource === 'metar' && opts.metarEnabled) {
    const raw = await fetchMetarIntradayExtreme(wuStation, targetDate, fetchFn, metric);
    // METAR published reports are FINAL (never retroactively corrected); accumulating
    // them in Redis yields a guaranteed-monotonic running extreme, and it also rides
    // out a transient under-fetch (a partial response can't lower the stored max).
    const accKey = `${metric === 'low' ? METAR_INTRADAY_MIN_PREFIX : METAR_INTRADAY_MAX_PREFIX}${wuStation}:${targetDate}`;
    const observedMax = await accumulateRunningExtreme(redis, accKey, raw.observedMax, metric, METAR_INTRADAY_TTL_S);
    result = {
      city,
      targetDate,
      observedMax,
      metric,
      source: 'metar-live',
      // This branch runs ONLY when resolutionSource==='metar' (e.g. Istanbul), so
      // METAR IS that city's settlement source — settlement_aligned, not a proxy.
      confidence: observedMax != null ? 'settlement_aligned' : 'none',
      monotonic: true,
      // When this scan's fetch returned nothing but the accumulator still holds a
      // prior max, stamp the current time (as HKO does) so a transient METAR outage
      // doesn't suppress a valid lock-in on the already-confirmed running max.
      observedAt: raw.observedAt ?? (observedMax != null ? new Date().toISOString() : null),
    };
  } else {
    return none;
  }

  if (result.observedMax != null) {
    await writeCachedObs(redis, result, opts.maxAgeMin * 60);
  }
  return result;
}

// ── Market/oracle contradiction classifier ────────────────────────────────────

export type ContradictionClass =
  | 'market_confirms_oracle'    // market AND oracle both imply our side is impaired
  | 'market_contradicts_model'  // market has moved against us; forecast/oracle do not explain it
  | 'oracle_contradicts_market' // oracle implies impairment; market has not repriced
  | 'model_only';               // only forecast drift; no market or oracle confirmation

/**
 * Classify the relationship between forecast model state, live oracle/observed
 * state, and market price for an open weather position.
 *
 * Returns null when there is no material disagreement to audit.
 */
export function classifyContradiction(params: {
  currentHeldBid: number | null;
  entryPrice: number;
  currentHeldProb: number;
  oracleState: 'oracle_impossible' | 'oracle_confirmed' | null;
  oracleConfidence: LiveObsConfidence;
  forecastState: 'stable' | 'watch' | 'thesis_weakened' | 'modal_against';
  marketDeadBid: number;
  contradictionMinModelMarketGap: number;
}): ContradictionClass | null {
  const {
    currentHeldBid,
    entryPrice,
    currentHeldProb,
    oracleState,
    oracleConfidence,
    forecastState,
    marketDeadBid,
    contradictionMinModelMarketGap,
  } = params;

  if (currentHeldBid == null) return null;

  const marketDrop = entryPrice > 0 ? (entryPrice - currentHeldBid) / entryPrice : 0;
  const modelMarketGap = currentHeldProb - currentHeldBid;

  const marketMoved = marketDrop >= 0.30 || currentHeldBid <= marketDeadBid;
  const oracleImpliesImpairment =
    oracleState === 'oracle_impossible' && oracleConfidence !== 'none';
  const forecastDrifted = forecastState === 'thesis_weakened' || forecastState === 'modal_against';
  const highModelMarketGap = modelMarketGap >= contradictionMinModelMarketGap;

  if (marketMoved && oracleImpliesImpairment) {
    return 'market_confirms_oracle';
  }

  if (marketMoved && highModelMarketGap && !oracleImpliesImpairment) {
    // Market says we're losing; model still thinks we're winning; oracle doesn't explain.
    // This is the Istanbul 23°C case: market near zero, model at 99%.
    return 'market_contradicts_model';
  }

  if (oracleImpliesImpairment && !marketMoved) {
    // Oracle says we're losing; market hasn't repriced yet.
    return 'oracle_contradicts_market';
  }

  if (forecastDrifted && !marketMoved && !oracleImpliesImpairment) {
    return 'model_only';
  }

  return null;
}
