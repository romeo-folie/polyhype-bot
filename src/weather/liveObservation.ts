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
import { fetchWuHistoricalHigh } from './wuClient.js';

const REQUEST_TIMEOUT_MS = 10_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type LiveObsSource = 'wu-live' | 'metar-live' | 'hko-live' | 'none';
export type LiveObsConfidence = 'settlement_aligned' | 'proxy' | 'none';

export interface WeatherLiveObservation {
  city: string;
  targetDate: string;
  /** Intraday running maximum temperature in city's native unit. null when unavailable. */
  observedMax: number | null;
  source: LiveObsSource;
  /** Settlement-aligned: same source as the final reconciler; proxy: different source or intraday proxy. */
  confidence: LiveObsConfidence;
  /** ISO8601 UTC timestamp of the most recent observation that contributed to observedMax. */
  observedAt: string | null;
}

// ── Redis cache ───────────────────────────────────────────────────────────────

const LIVE_OBS_CACHE_PREFIX = 'weather:live_obs:';

async function readCachedObs(
  redis: Redis,
  city: string,
  targetDate: string,
  maxAgeMin: number,
): Promise<WeatherLiveObservation | null> {
  try {
    const raw = await redis.get(`${LIVE_OBS_CACHE_PREFIX}${city}:${targetDate}`);
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
    await redis.set(`${LIVE_OBS_CACHE_PREFIX}${obs.city}:${obs.targetDate}`, value, 'EX', ttlS);
  } catch {
    // Cache write is best-effort.
  }
}

// ── WU live ───────────────────────────────────────────────────────────────────

/**
 * Fetch the intraday running maximum from Weather Underground.
 * Uses the same historical endpoint with today's date — WU returns all hourly
 * observations up to now, so max(obs.temp) is the intraday high so far.
 */
async function fetchWuIntradayHigh(
  icao: string,
  isoCountry: string,
  targetDate: string,
  unit: 'fahrenheit' | 'celsius',
  redis: Redis,
  fetchFn?: typeof fetch,
): Promise<{ observedMax: number | null; observedAt: string | null }> {
  const max = await fetchWuHistoricalHigh(
    icao,
    isoCountry,
    targetDate,
    unit,
    redis,
    fetchFn,
  );
  // WU historical endpoint does not return per-observation timestamps in the
  // max computation path, so observedAt is approximated as the fetch time.
  return { observedMax: max, observedAt: max != null ? new Date().toISOString() : null };
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
 * Fetch the intraday maximum temperature from hourly METAR observations.
 * Requests the last 48 hours and filters to observations on targetDate (UTC).
 */
export async function fetchMetarIntradayHigh(
  icao: string,
  targetDate: string,
  fetchFn: typeof fetch = fetch,
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

  const maxTemp = Math.max(...dayObs.map((o) => o.temp as number));
  // Use the latest reportTime from today's observations as the observedAt stamp.
  const latestReport = dayObs
    .map((o) => o.reportTime)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const observedAt = latestReport ? new Date(latestReport + 'Z').toISOString() : new Date().toISOString();

  logger.debug('[weather-live-obs] METAR intraday high', {
    icao,
    targetDate,
    maxTemp,
    obsCount: dayObs.length,
  });
  return { observedMax: maxTemp, observedAt };
}

// ── HKO live ──────────────────────────────────────────────────────────────────

// Redis key for accumulating the HKO intraday running max.
// Keyed by date so it resets each calendar day. TTL = 36h for overlap safety.
const HKO_INTRADAY_MAX_PREFIX = 'weather:hko_intraday_max:';
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
 * maximum for targetDate.
 *
 * The rhrread endpoint provides the most recent observation at HKO. Because the
 * daily maximum can only increase, accumulating it in Redis is equivalent to
 * computing max(all observations today).
 */
export async function fetchHkoIntradayHigh(
  targetDate: string,
  redis: Redis,
  fetchFn: typeof fetch = fetch,
): Promise<{ observedMax: number | null; observedAt: string | null }> {
  const maxKey = `${HKO_INTRADAY_MAX_PREFIX}${targetDate}`;

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
        currentReading = station.value;
        // recordTime is in local HKT (UTC+8); convert to UTC ISO8601.
        const recordTime = payload.temperature?.recordTime ?? null;
        observedAt = recordTime
          ? new Date(recordTime).toISOString()
          : new Date().toISOString();
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

  // Update the Redis running max if the new reading is higher.
  if (currentReading != null) {
    try {
      const storedRaw = await redis.get(maxKey);
      const storedMax = storedRaw != null ? parseFloat(storedRaw) : -Infinity;
      if (!isFinite(storedMax) || currentReading > storedMax) {
        await redis.set(maxKey, String(currentReading), 'EX', HKO_INTRADAY_MAX_TTL_S);
        logger.debug('[weather-live-obs] HKO intraday max updated', {
          targetDate,
          previous: isFinite(storedMax) ? storedMax : null,
          current: currentReading,
        });
      }
    } catch {
      // Redis write is best-effort.
    }
  }

  // Return the running max from Redis (may be from an earlier observation today).
  try {
    const storedRaw = await redis.get(maxKey);
    if (storedRaw != null) {
      const runningMax = parseFloat(storedRaw);
      if (isFinite(runningMax)) {
        return { observedMax: runningMax, observedAt: observedAt ?? new Date().toISOString() };
      }
    }
  } catch {
    // Fall through to null.
  }

  return { observedMax: currentReading, observedAt };
}

// ── Oracle state classification ───────────────────────────────────────────────

/**
 * Classify the oracle implication of a live observed maximum for an open position.
 *
 * Rules (daily max only increases intraday):
 *
 * Interior bracket [low, high] (both integers, rounding window [low-0.5, high+0.5)):
 *   observedMax > high + 0.5 → high exceeded, rounds ≥ high+1 → YES impossible, NO confirmed
 *
 * High-tail bracket (low set, high = null; means "low or higher"):
 *   observedMax ≥ low - 0.5 → already rounds into the tail → YES confirmed, NO impossible
 *
 * Low-tail bracket (high set, low = null; means "high or below"):
 *   observedMax > high + 0.5 → already rounds above the tail ceiling → YES impossible, NO confirmed
 *
 * Returns null when the observation is inconclusive (observedMax is within range or
 * below the threshold for high-tail — the day could still end anywhere).
 */
export function classifyOracleState(
  observedMax: number,
  direction: 'YES' | 'NO',
  bracket: { low: number | null; high: number | null },
): 'oracle_impossible' | 'oracle_confirmed' | null {
  const { low, high } = bracket;
  const isTail = low === null || high === null;

  if (!isTail) {
    // Interior bracket: YES is impossible once the running max has exceeded the
    // bracket's upper rounding boundary (the day can only get hotter).
    if (observedMax > high! + 0.5) {
      return direction === 'YES' ? 'oracle_impossible' : 'oracle_confirmed';
    }
    // If observedMax is still within or below the bracket, we can't conclude
    // anything yet — the day may not be over.
    return null;
  }

  if (low === null) {
    // Low-tail: "high or below" — YES means final max ≤ high; rounds < high + 0.5.
    // If observedMax already > high + 0.5, the final max will round ≥ high+1, so YES is impossible.
    if (observedMax > high! + 0.5) {
      return direction === 'YES' ? 'oracle_impossible' : 'oracle_confirmed';
    }
    return null;
  }

  // High-tail: "low or higher" — YES means final max ≥ low; rounds ≥ low - 0.5.
  // If observedMax already ≥ low - 0.5, the running max has reached the tail, so YES is confirmed.
  if (observedMax >= low - 0.5) {
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
    fetchFn?: FetchFn;
  },
): Promise<WeatherLiveObservation> {
  const none: WeatherLiveObservation = {
    city,
    targetDate,
    observedMax: null,
    source: 'none',
    confidence: 'none',
    observedAt: null,
  };

  const coords = lookupCity(city);
  if (!coords) return none;

  // Check cache first.
  const cached = await readCachedObs(redis, city, targetDate, opts.maxAgeMin);
  if (cached) return cached;

  const { resolutionSource, wuStation, isoCountry, unit } = coords;
  const fetchFn = opts.fetchFn ?? fetch;

  let result: WeatherLiveObservation;

  if (resolutionSource === 'hko' && opts.hkoEnabled) {
    const { observedMax, observedAt } = await fetchHkoIntradayHigh(targetDate, redis, fetchFn);
    result = {
      city,
      targetDate,
      observedMax,
      source: 'hko-live',
      // HKO rhrread is the official observatory reading — same station as the
      // final dailyExtract settlement source, so intraday readings are settlement_aligned
      // when they support an irreversible oracle conclusion (max only goes up).
      confidence: observedMax != null ? 'settlement_aligned' : 'none',
      observedAt,
    };
  } else if (resolutionSource === 'wu' && opts.wuEnabled) {
    const { observedMax, observedAt } = await fetchWuIntradayHigh(
      wuStation,
      isoCountry ?? '',
      targetDate,
      unit,
      redis,
      fetchFn,
    );
    result = {
      city,
      targetDate,
      observedMax,
      source: 'wu-live',
      // WU intraday returns the same hourly observations the final daily extract
      // is derived from, so intraday max is settlement_aligned for irreversible
      // oracle conclusions (the running max will only increase).
      confidence: observedMax != null ? 'settlement_aligned' : 'none',
      observedAt,
    };
  } else if (resolutionSource === 'metar' && opts.metarEnabled) {
    const { observedMax, observedAt } = await fetchMetarIntradayHigh(
      wuStation,
      targetDate,
      fetchFn,
    );
    result = {
      city,
      targetDate,
      observedMax,
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
