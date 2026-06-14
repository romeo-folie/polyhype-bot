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
import { fetchWuHistoricalExtreme } from './wuClient.js';

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
  /** ISO8601 UTC timestamp of the most recent observation that contributed to observedMax. */
  observedAt: string | null;
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
  const extreme = await fetchWuHistoricalExtreme(
    icao,
    isoCountry,
    targetDate,
    unit,
    redis,
    metric,
    fetchFn,
  );
  // WU historical endpoint does not return per-observation timestamps in the
  // extreme computation path, so observedAt is approximated as the fetch time.
  return { observedMax: extreme, observedAt: extreme != null ? new Date().toISOString() : null };
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

  const temps = dayObs.map((o) => o.temp as number);
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
const HKO_RHRREAD_URL =
  'https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en';
const HKO_STATION_NAME = 'Hong Kong Observatory';

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
): Promise<{ observedMax: number | null; observedAt: string | null }> {
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

  if (res != null && res.ok) {
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

  // Update the Redis running extreme if the new reading is more extreme.
  // For 'high' a higher reading wins; for 'low' a lower reading wins.
  if (currentReading != null) {
    try {
      const storedRaw = await redis.get(accKey);
      const seed = metric === 'low' ? Infinity : -Infinity;
      const stored = storedRaw != null ? parseFloat(storedRaw) : seed;
      const isMoreExtreme = metric === 'low'
        ? currentReading < stored
        : currentReading > stored;
      if (!isFinite(stored) || isMoreExtreme) {
        await redis.set(accKey, String(currentReading), 'EX', HKO_INTRADAY_MAX_TTL_S);
        logger.debug('[weather-live-obs] HKO intraday extreme updated', {
          targetDate,
          metric,
          previous: isFinite(stored) ? stored : null,
          current: currentReading,
        });
      }
    } catch {
      // Redis write is best-effort.
    }
  }

  // Return the running extreme from Redis (may be from an earlier observation today).
  try {
    const storedRaw = await redis.get(accKey);
    if (storedRaw != null) {
      const running = parseFloat(storedRaw);
      if (isFinite(running)) {
        return { observedMax: running, observedAt: observedAt ?? new Date().toISOString() };
      }
    }
  } catch {
    // Fall through to null.
  }

  return { observedMax: currentReading, observedAt };
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
export function classifyOracleState(
  observed: number,
  direction: 'YES' | 'NO',
  bracket: { low: number | null; high: number | null },
  metric: 'high' | 'low' = 'high',
): 'oracle_impossible' | 'oracle_confirmed' | null {
  const { low, high } = bracket;
  const isTail = low === null || high === null;

  if (metric === 'low') {
    // Daily minimum can only fall further intraday.
    if (!isTail) {
      // Interior: YES impossible once the running min drops below the bracket floor.
      if (observed < low! - 0.5) {
        return direction === 'YES' ? 'oracle_impossible' : 'oracle_confirmed';
      }
      return null;
    }
    if (low === null) {
      // Low-tail "high or below": YES means final min ≤ high (rounds < high+0.5).
      // Once the running min is already there, it can only go lower → YES confirmed.
      if (observed < high! + 0.5) {
        return direction === 'YES' ? 'oracle_confirmed' : 'oracle_impossible';
      }
      return null;
    }
    // High-tail "low or higher": YES means final min ≥ low (rounds ≥ low-0.5).
    // Once the running min has dropped below low-0.5 it can never recover → YES impossible.
    if (observed < low - 0.5) {
      return direction === 'YES' ? 'oracle_impossible' : 'oracle_confirmed';
    }
    return null;
  }

  // metric === 'high': daily maximum can only rise further intraday.
  if (!isTail) {
    // Interior bracket: YES is impossible once the running max has exceeded the
    // bracket's upper rounding boundary (the day can only get hotter).
    if (observed > high! + 0.5) {
      return direction === 'YES' ? 'oracle_impossible' : 'oracle_confirmed';
    }
    // If observed is still within or below the bracket, we can't conclude
    // anything yet — the day may not be over.
    return null;
  }

  if (low === null) {
    // Low-tail: "high or below" — YES means final max ≤ high; rounds < high + 0.5.
    // If observed already > high + 0.5, the final max will round ≥ high+1, so YES is impossible.
    if (observed > high! + 0.5) {
      return direction === 'YES' ? 'oracle_impossible' : 'oracle_confirmed';
    }
    return null;
  }

  // High-tail: "low or higher" — YES means final max ≥ low; rounds ≥ low - 0.5.
  // If observed already ≥ low - 0.5, the running max has reached the tail, so YES is confirmed.
  if (observed >= low - 0.5) {
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
    const { observedMax, observedAt } = await fetchHkoIntradayExtreme(targetDate, redis, metric, fetchFn);
    result = {
      city,
      targetDate,
      observedMax,
      metric,
      source: 'hko-live',
      // HKO rhrread is the official observatory reading — same station as the
      // final dailyExtract settlement source, so intraday readings are settlement_aligned
      // when they support an irreversible oracle conclusion (max only up / min only down).
      confidence: observedMax != null ? 'settlement_aligned' : 'none',
      observedAt,
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
      // WU intraday returns the same hourly observations the final daily extract
      // is derived from, so intraday extreme is settlement_aligned for irreversible
      // oracle conclusions (running max only increases / running min only decreases).
      confidence: observedMax != null ? 'settlement_aligned' : 'none',
      observedAt,
    };
  } else if (resolutionSource === 'metar' && opts.metarEnabled) {
    const { observedMax, observedAt } = await fetchMetarIntradayExtreme(
      wuStation,
      targetDate,
      fetchFn,
      metric,
    );
    result = {
      city,
      targetDate,
      observedMax,
      metric,
      source: 'metar-live',
      // METAR hourly observations are a proxy — no city currently uses METAR as
      // its primary resolution source, so this is always 'proxy' until verified.
      confidence: observedMax != null ? 'proxy' : 'none',
      observedAt,
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
