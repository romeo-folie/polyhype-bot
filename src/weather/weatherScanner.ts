/**
 * Weather Bracket Market Scanner
 *
 * Discovers Polymarket weather bracket events via Gamma API (tag_slug=highest-temperature),
 * fetches forecasts from NOAA (US) and Open-Meteo (international), and computes
 * edge by comparing forecast bracket probabilities against market prices.
 *
 * Polymarket weather markets are negRisk events with ~11 brackets each:
 *   - "39°F or below" (low tail)
 *   - "40-41°F", "42-43°F", ... (interior, 2°F for US / 1°C for intl)
 *   - "58°F or higher" (high tail)
 *
 * Resolution oracle: Weather Underground (wunderground.com/history/daily/...).
 * Forecast oracles: NOAA/NWS (US), Open-Meteo (global + ensemble uncertainty).
 *
 * Ships dark (WEATHER_SCANNER_ENABLED=false). Shadow-log all found
 * opportunities regardless of enabled state.
 *
 * Log marker: [weather]
 * Dedup key:  weather:event:{eventSlug}  (TTL: WEATHER_DEDUP_TTL_S)
 */

import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { evaluateWeatherNearResEntry } from './nearResEntry.js';
import type { GammaMarket } from '../mapping/gamma.js';
import { parseOutcomePrices, parseClobTokenIds } from '../mapping/gamma.js';
import { runWeatherLockInScan } from './weatherLockIn.js';
import { runWeatherInvalidationScan, FORECAST_INVALIDATED_KEY_PREFIX } from './weatherInvalidation.js';
import { computeHalfKelly } from '../mapping/divergenceCalculator.js';
import { executeAndRecordSignal } from '../execution/executor.js';
import { hasOpenPosition } from '../execution/positionLedger.js';
import type { TradeSignal } from '../mapping/index.js';
import { getBankroll } from '../shared/bankroll.js';
import {
  lookupCity,
  canonicalCityKey,
  fetchNwsForecast,
  estimateBracketProbability,
  getDefaultStdDev,
} from './noaaClient.js';
import type { CityCoordinates, FetchFn } from './noaaClient.js';
import { cityLocalDate, cityDayEndUtcMs } from './resolutionTime.js';
import { fetchOpenMeteoForecast, fetchEnsembleForecast, fetchHrrrForecast } from './openMeteoClient.js';
import { getCityBias, getCityActuals } from './cityBias.js';
import type { CityBias, CityActuals } from './cityBias.js';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const GAMMA_TIMEOUT_MS = 15_000;
const DEDUP_KEY_PREFIX = 'weather:event:';
const RES_DAY_DEDUP_KEY_PREFIX = 'weather:event_resday:';
const RES_DAY_EARLY_KEY_PREFIX = 'weather:event_resday_early:';
const MARKET_STATE_KEY_PREFIX = 'weather:market_state:';
// Set after a successful new entry; lets subsequent scans bypass the event-level dedup for size-up re-evaluation.
const ACTIVE_EVENT_KEY_PREFIX = 'weather:active_event:';
const ACTIVE_EVENT_TTL_S = 72 * 3600;

/**
 * Resolve the `WEATHER_TRADE_SIDES` config value into a set the scanner
 * can check per-opportunity. `BOTH` (default) is legacy behavior;
 * `YES`/`NO` restrict execution to a single side while shadow-logging
 * both for calibration.
 */
export function parseAllowedSides(
  mode: 'YES' | 'NO' | 'BOTH',
): ReadonlySet<'YES' | 'NO'> {
  if (mode === 'BOTH') return new Set(['YES', 'NO']);
  return new Set([mode]);
}

// ── Gamma 429 circuit breaker (mirrors gamma.ts pattern) ─────────────────
let rateLimitedUntilMs = 0;
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

// ── Gamma event types (weather-specific fields) ──────────────────────────

interface WeatherGammaMarket extends GammaMarket {
  groupItemTitle?: string;
  groupItemThreshold?: string;
}

interface WeatherGammaEvent {
  id: string;
  title: string;
  slug: string;
  active: boolean;
  closed: boolean;
  negRisk?: boolean;
  endDate?: string;
  markets: WeatherGammaMarket[];
}

// ── Bracket parsing ──────────────────────────────────────────────────────

export interface ParsedBracket {
  /** Market ID from Gamma. */
  marketId: string;
  conditionId: string;
  clobTokenIds: string[];
  /** Ordinal position (0 = low tail, 10 = high tail). */
  threshold: number;
  /** Lower bound of the bracket (null for low-tail). */
  low: number | null;
  /** Upper bound of the bracket (null for high-tail). */
  high: number | null;
  /** Human-readable label from groupItemTitle. */
  label: string;
  /** Full market question (for executor / category inference). */
  question: string;
  /** Current YES price on the market. */
  yesPrice: number;
  /** Current NO price on the market. */
  noPrice: number;
}

export interface ParsedWeatherEvent {
  /** Gamma event ID. */
  eventId: string;
  /** Event slug. */
  slug: string;
  /** City name (lowercased, canonical). */
  city: string;
  /** City coordinates + metadata. */
  coords: CityCoordinates;
  /** Target date (YYYY-MM-DD). */
  targetDate: string;
  /** Temperature unit. */
  unit: 'fahrenheit' | 'celsius';
  /** Parsed brackets sorted by threshold ascending. */
  brackets: ParsedBracket[];
  /** All market IDs in the event including closed/inactive ones — used for
   *  position-fallback checks where the held bracket may already be closed. */
  allMarketIds: string[];
  /** Event end date. */
  endDate: string | null;
}

/**
 * Extract city name from a weather event title.
 * Titles follow: "Highest temperature in {City} on {Month} {Day}?"
 */
export function extractCityFromTitle(title: string): string | null {
  const match = title.match(/highest\s+temperature\s+in\s+(.+?)\s+on\s+/i);
  if (!match?.[1]) return null;
  return match[1].trim().toLowerCase();
}

/**
 * Extract target date from a weather event title or slug.
 * Title: "Highest temperature in Chicago on April 14?"
 * Slug: "highest-temperature-in-chicago-on-april-14-2026"
 */
export function extractDateFromEvent(title: string, slug: string, endDate?: string): string | null {
  const MONTH_MAP: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4,
    may: 5, june: 6, july: 7, august: 8,
    september: 9, october: 10, november: 11, december: 12,
  };

  // Try slug first (more reliable, often includes year)
  const slugMatch = slug.match(
    /on-(\w+)-(\d{1,2})(?:-(\d{4}))?$/,
  );
  if (slugMatch?.[1] && slugMatch[2]) {
    const monthNum = MONTH_MAP[slugMatch[1].toLowerCase()];
    if (monthNum) {
      const year = slugMatch[3]
        ? parseInt(slugMatch[3], 10)
        : new Date().getFullYear();
      return `${year.toString()}-${monthNum.toString().padStart(2, '0')}-${slugMatch[2].padStart(2, '0')}`;
    }
  }

  // Try title
  const titleMatch = title.match(
    /on\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s*(\d{4}))?/i,
  );
  if (titleMatch?.[1] && titleMatch[2]) {
    const monthNum = MONTH_MAP[titleMatch[1].toLowerCase()];
    if (monthNum) {
      const year = titleMatch[3]
        ? parseInt(titleMatch[3], 10)
        : new Date().getFullYear();
      return `${year.toString()}-${monthNum.toString().padStart(2, '0')}-${titleMatch[2].padStart(2, '0')}`;
    }
  }

  // Fallback: derive from endDate (events end at noon UTC on target day)
  if (endDate) {
    return endDate.slice(0, 10);
  }

  return null;
}

// Bracket label patterns:
// Fahrenheit: "39°F or below", "40-41°F", "58°F or higher"
// Celsius: "6°C or below", "7°C", "16°C or higher"

const BRACKET_LOW_TAIL = /^(\d+)\s*°\s*([FC])\s+or\s+below$/i;
const BRACKET_HIGH_TAIL = /^(\d+)\s*°\s*([FC])\s+or\s+higher$/i;
const BRACKET_RANGE_F = /^(\d+)\s*-\s*(\d+)\s*°\s*F$/i;
const BRACKET_SINGLE_C = /^(\d+)\s*°\s*C$/i;

/**
 * Parse a bracket label into numeric bounds.
 * Returns [low, high] where null means tail (unbounded).
 */
export function parseBracketLabel(
  label: string,
): { low: number | null; high: number | null; unit: 'fahrenheit' | 'celsius' } | null {
  // Low tail: "39°F or below" / "6°C or below"
  let m = label.match(BRACKET_LOW_TAIL);
  if (m?.[1] && m[2]) {
    const unit = m[2].toUpperCase() === 'F' ? 'fahrenheit' as const : 'celsius' as const;
    return { low: null, high: parseInt(m[1], 10), unit };
  }

  // High tail: "58°F or higher" / "16°C or higher"
  m = label.match(BRACKET_HIGH_TAIL);
  if (m?.[1] && m[2]) {
    const unit = m[2].toUpperCase() === 'F' ? 'fahrenheit' as const : 'celsius' as const;
    return { low: parseInt(m[1], 10), high: null, unit };
  }

  // Fahrenheit range: "40-41°F"
  m = label.match(BRACKET_RANGE_F);
  if (m?.[1] && m[2]) {
    return { low: parseInt(m[1], 10), high: parseInt(m[2], 10), unit: 'fahrenheit' };
  }

  // Single Celsius: "7°C"
  m = label.match(BRACKET_SINGLE_C);
  if (m?.[1]) {
    const val = parseInt(m[1], 10);
    return { low: val, high: val, unit: 'celsius' };
  }

  return null;
}

// ── Event discovery ──────────────────────────────────────────────────────

/**
 * Fetch active weather events from Gamma API using tag_slug=highest-temperature.
 * Orders by liquidity descending so we evaluate the most-traded events first.
 * Includes a 429 circuit breaker to avoid compounding rate limits.
 *
 * Note: the previous tag `temperature` was retired by Polymarket (returns ~1
 * stale event as of 2026-04-19). `highest-temperature` is the canonical tag
 * for the daily-city bracket events this scanner targets.
 */
export async function fetchWeatherEvents(
  limit: number,
): Promise<WeatherGammaEvent[]> {
  // Circuit breaker: skip if rate-limited recently
  if (Date.now() < rateLimitedUntilMs) {
    logger.debug('[weather] Gamma rate-limit backoff active, skipping fetch');
    return [];
  }

  const params = new URLSearchParams({
    tag_slug: 'highest-temperature',
    limit: limit.toString(),
    active: 'true',
    closed: 'false',
    order: 'liquidity',
    ascending: 'false',
  });

  const url = `${GAMMA_BASE}/events?${params.toString()}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, GAMMA_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal }).finally(() => {
      clearTimeout(timer);
    });

    if (res.status === 429) {
      rateLimitedUntilMs = Date.now() + RATE_LIMIT_BACKOFF_MS;
      logger.warn('[weather] Gamma 429 rate-limited, backing off 5 min');
      return [];
    }

    if (!res.ok) {
      logger.warn('[weather] Gamma temperature events API error', {
        status: res.status,
      });
      return [];
    }
    const data = (await res.json()) as WeatherGammaEvent[];
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.warn('[weather] Gamma temperature events fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Parse a Gamma weather event into our internal representation.
 * Returns null if the event can't be parsed (not a temperature bracket event).
 */
export function parseWeatherEvent(event: WeatherGammaEvent): ParsedWeatherEvent | null {
  if (!event.negRisk) return null;

  const cityRaw = extractCityFromTitle(event.title);
  if (!cityRaw) return null;

  const coords = lookupCity(cityRaw);
  if (!coords) return null;

  const targetDate = extractDateFromEvent(event.title, event.slug, event.endDate);
  if (!targetDate) return null;

  const brackets: ParsedBracket[] = [];

  for (const market of event.markets) {
    if (market.closed || !market.active) continue;

    const label = market.groupItemTitle;
    if (!label) continue;

    const parsed = parseBracketLabel(label);
    if (!parsed) continue;
    if (parsed.unit !== coords.unit) continue;

    let clobTokenIds: string[];
    try {
      clobTokenIds = parseClobTokenIds(market.clobTokenIds);
    } catch {
      continue;
    }

    let yesPrice: number;
    let noPrice: number;
    try {
      const prices = parseOutcomePrices(market.outcomePrices);
      const rawYes = prices[0];
      const rawNo = prices[1];
      if (rawYes === undefined || rawNo === undefined) continue;
      yesPrice = parseFloat(rawYes);
      noPrice = parseFloat(rawNo);
      if (
        !isFinite(yesPrice) || !isFinite(noPrice) ||
        yesPrice < 0 || yesPrice > 1 ||
        noPrice < 0 || noPrice > 1
      ) continue;
    } catch {
      continue;
    }

    const parsedThreshold = market.groupItemThreshold
      ? parseInt(market.groupItemThreshold, 10)
      : NaN;
    const thresholdIdx = Number.isFinite(parsedThreshold)
      ? parsedThreshold
      : brackets.length;

    brackets.push({
      marketId: market.id,
      conditionId: market.conditionId,
      clobTokenIds,
      threshold: thresholdIdx,
      low: parsed.low,
      high: parsed.high,
      label,
      question: market.question,
      yesPrice,
      noPrice,
    });
  }

  if (brackets.length < 3) return null; // need at least low-tail + 1 interior + high-tail

  // Sort by threshold ascending
  brackets.sort((a, b) => a.threshold - b.threshold);

  return {
    eventId: event.id,
    slug: event.slug,
    city: canonicalCityKey(cityRaw) ?? cityRaw,
    coords,
    targetDate,
    unit: coords.unit,
    brackets,
    allMarketIds: event.markets.map((m) => m.id),
    endDate: event.endDate ?? null,
  };
}

// ── Forecast fetching ────────────────────────────────────────────────────

interface ForecastResult {
  /** Point forecast high temperature in the event's unit. */
  forecastHigh: number;
  /** Standard deviation to use for probability model. */
  stdDev: number;
  /** Source of the forecast. */
  source: 'noaa' | 'open-meteo' | 'combined' | 'hrrr-combined';
  /** Number of ensemble members (0 if no ensemble data). */
  ensembleMembers: number;
  /**
   * Ensemble model used when ensemble data is available. Note: the final
   * stdDev may also be influenced by cross-source disagreement or a
   * climatology floor, so this field is not guaranteed to be the sole
   * provenance of stdDev.
   */
  ensembleModel: 'gfs' | 'ecmwf' | 'none';
  /** Optional shadow ensemble for side-by-side calibration comparison. */
  shadowEnsemble?: {
    stdDev: number;
    ensembleMembers: number;
    ensembleModel: 'gfs' | 'ecmwf';
  } | null;
}

/**
 * Fetch forecast for a weather event. Uses NOAA for US cities,
 * Open-Meteo for international. Fetches ensemble data when available
 * for dynamic stddev.
 */
export async function fetchForecast(
  event: ParsedWeatherEvent,
  daysOut: number,
  fetchFn?: FetchFn,
  stddevMinFraction = 0.7,
  useEcmwf = false,
  useHrrr = false,
  dualEnsembleShadow = false,
  maxCrossSourceSpread = Infinity,
): Promise<ForecastResult | null> {
  const { coords, targetDate, unit } = event;
  const month = parseInt(targetDate.slice(5, 7), 10);

  // Default stddev for this unit — Celsius stddev is ~5/9 of Fahrenheit
  let defaultStd = getDefaultStdDev(daysOut, month);
  if (unit === 'celsius') {
    defaultStd = defaultStd * 5 / 9;
  }

  // The stddevMinFraction floor guards against pathologically under-dispersed
  // short-range ensembles. Cap its reference at the day-7 stddev so that
  // extending the horizon to 14 days doesn't inflate the floor and suppress
  // tight ensemble signals that are genuinely informative at extended range.
  const floorStd = unit === 'celsius'
    ? getDefaultStdDev(Math.min(daysOut, 7), month) * 5 / 9
    : getDefaultStdDev(Math.min(daysOut, 7), month);

  // Try ensemble first (works for both US and international).
  // Both fetches are submitted to Promise.all, but when fetchFn is the
  // production rate-limited queue they are still serialized by the limiter —
  // the shadow fetch adds one extra rate-limit slot per event when enabled.
  const [ensemble, shadowEnsembleRaw] = await Promise.all([
    fetchEnsembleForecast(coords.lat, coords.lon, targetDate, unit, fetchFn, useEcmwf),
    dualEnsembleShadow
      ? fetchEnsembleForecast(coords.lat, coords.lon, targetDate, unit, fetchFn, !useEcmwf)
      : Promise.resolve(null),
  ]);
  const ensembleModel: ForecastResult['ensembleModel'] = ensemble?.ensembleModel ?? 'none';
  const shadowEnsembleModel = shadowEnsembleRaw?.ensembleModel ?? null;

  if (coords.noaaCoverage) {
    // US city: fetch NOAA, Open-Meteo, and (when enabled at 1-day) HRRR in parallel.
    const hrrrEnabled = useHrrr && daysOut <= 1;
    const [noaaForecast, omForecast, hrrrForecast] = await Promise.all([
      fetchNwsForecast(coords.lat, coords.lon, targetDate, fetchFn),
      fetchOpenMeteoForecast(coords.lat, coords.lon, targetDate, unit, fetchFn),
      hrrrEnabled ? fetchHrrrForecast(coords.lat, coords.lon, targetDate, fetchFn) : Promise.resolve(null),
    ]);

    // Collect available deterministic highs. NOAA is in °F — convert if needed.
    const noaaHigh = noaaForecast
      ? (unit === 'celsius' ? (noaaForecast.highF - 32) * 5 / 9 : noaaForecast.highF)
      : null;
    // HRRR is always °F — convert if the event uses Celsius (US cities are always °F, but be safe).
    const hrrrHigh = hrrrForecast
      ? (unit === 'celsius' ? (hrrrForecast.highTemp - 32) * 5 / 9 : hrrrForecast.highTemp)
      : null;
    const omHigh = omForecast?.highTemp ?? null;

    const availableHighs = [noaaHigh, omHigh, hrrrHigh].filter((v): v is number => v !== null);
    if (availableHighs.length === 0) {
      // NWS covers only ~7 days; at daysOut > 7 noaaHigh is always null by design.
      // If Open-Meteo also failed here, the only deterministic source for US cities
      // is absent — warn so the gap is visible in logs.
      if (daysOut > 7) {
        logger.warn('[weather] US forecast null at extended horizon — NWS capped at 7 days, Open-Meteo unavailable', {
          city: event.city,
          targetDate,
          daysOut,
        });
      }
      return null;
    }

    // Cross-source spread gate: only fires when HRRR contributed a value.
    // Normal NOAA/OM disagreement is already absorbed by the spread-driven stdDev inflation
    // below; this gate is specifically designed to catch glitchy HRRR batches that return
    // physically-impossible temperatures (e.g. 24°F in late-May Chicago).
    if (hrrrHigh !== null) {
      if (availableHighs.length === 1) {
        // HRRR is the sole source — no other model to cross-validate against.
        // A glitch would be undetectable, so skip rather than trust it blindly.
        logger.warn('[weather] HRRR is sole forecast source — skipping (cannot cross-validate)', {
          city: event.city,
          targetDate,
          hrrrHigh,
        });
        return null;
      }
      const rawSpread = Math.max(...availableHighs) - Math.min(...availableHighs);
      if (rawSpread > maxCrossSourceSpread) {
        logger.warn('[weather] cross-source spread too large — skipping forecast', {
          city: event.city,
          targetDate,
          rawSpread: Math.round(rawSpread * 10) / 10,
          maxCrossSourceSpread,
          noaaHigh,
          omHigh,
          hrrrHigh,
        });
        return null;
      }
    }

    const forecastHigh = availableHighs.reduce((s, v) => s + v, 0) / availableHighs.length;
    const hrrrContributed = hrrrHigh !== null;
    const source: ForecastResult['source'] = hrrrContributed
      ? 'hrrr-combined'
      : availableHighs.length > 1 ? 'combined' : (noaaHigh !== null ? 'noaa' : 'open-meteo');

    // Disagreement = spread across available sources / 1.5 to scale to ~1σ.
    const spread = availableHighs.length > 1
      ? (Math.max(...availableHighs) - Math.min(...availableHighs)) / 1.5
      : 0;
    // Single-source: use defaultStd as the ensemble fallback so a partial outage
    // (only NOAA responds, ensemble null) doesn't silently tighten uncertainty to the
    // stddevMinFraction floor. Multi-source: spread already adds variance, so 0 fallback is fine.
    const stdDev = availableHighs.length === 1
      ? Math.max(ensemble?.stddevHigh ?? defaultStd, floorStd * stddevMinFraction)
      : Math.max(ensemble?.stddevHigh ?? 0, spread, floorStd * stddevMinFraction);
    const shadowStdDev = shadowEnsembleRaw
      ? (availableHighs.length === 1
        ? Math.max(shadowEnsembleRaw.stddevHigh, floorStd * stddevMinFraction)
        : Math.max(shadowEnsembleRaw.stddevHigh, spread, floorStd * stddevMinFraction))
      : null;

    return {
      forecastHigh,
      stdDev,
      source,
      ensembleMembers: ensemble?.memberCount ?? 0,
      ensembleModel,
      shadowEnsemble: shadowStdDev != null && shadowEnsembleModel
        ? {
          stdDev: shadowStdDev,
          ensembleMembers: shadowEnsembleRaw?.memberCount ?? 0,
          ensembleModel: shadowEnsembleModel,
        }
        : null,
    };
  }

  // International city: Open-Meteo only (HRRR is US-only)
  const omForecast = await fetchOpenMeteoForecast(coords.lat, coords.lon, targetDate, unit, fetchFn);
  if (!omForecast) return null;

  const stdDev = Math.max(ensemble?.stddevHigh ?? defaultStd, floorStd * stddevMinFraction);
  const shadowStdDev = shadowEnsembleRaw
    ? Math.max(shadowEnsembleRaw.stddevHigh, floorStd * stddevMinFraction)
    : null;
  return {
    forecastHigh: omForecast.highTemp,
    stdDev,
    source: 'open-meteo',
    ensembleMembers: ensemble?.memberCount ?? 0,
    ensembleModel,
    shadowEnsemble: shadowStdDev != null && shadowEnsembleModel
      ? {
        stdDev: shadowStdDev,
        ensembleMembers: shadowEnsembleRaw?.memberCount ?? 0,
        ensembleModel: shadowEnsembleModel,
      }
      : null,
  };
}

// ── Opportunity detection ────────────────────────────────────────────────

export interface WeatherBracketOpportunity {
  /** Gamma market ID for the bracket to trade. */
  marketId: string;
  conditionId: string;
  /** Event-level info. */
  eventId: string;
  eventSlug: string;
  city: string;
  targetDate: string;
  /** Bracket details. */
  bracketLabel: string;
  /** Full market question — passed to executor + category inference. */
  question: string;
  clobTokenIds: string[];
  /** Market prices. */
  yesPrice: number;
  noPrice: number;
  /** Our model's probability for this bracket. */
  modelProbability: number;
  /** Vig-adjusted market implied probability. */
  adjustedMarketProb: number;
  /** Raw edge versus the selected trade side's quoted price: YES uses modelProbability - yesPrice; NO uses (1 - modelProbability) - noPrice. */
  edge: number;
  /** Which side to trade. */
  tradeSide: 'YES' | 'NO';
  /** Price we'd pay for the trade side. */
  outcomePrice: number;
  /** Forecast details. */
  forecastHigh: number;
  forecastStdDev: number;
  /** Actual stddev that entered estimateBracketProbability: max(rawStdDev, empiricalStddev) when bias correction active. */
  effectiveStdDev: number;
  forecastSource: string;
  ensembleMembers: number;
  daysOut: number;
  unit: 'fahrenheit' | 'celsius';
  /** Sum of all bracket YES prices (overround diagnostic). */
  overround: number;
  /**
   * True if `tradeSide` is permitted by `WEATHER_TRADE_SIDES`. When false the
   * opportunity is shadow-logged but not tradable; kept populated on the opp
   * so the executor layer (and shadow observations) can gate cleanly.
   */
  allowedByConfig: boolean;
  /** Raw forecast high before any bias correction was applied. Equal to forecastHigh when meanShiftApplied=false. */
  rawForecastHigh: number;
  /** Forecast high after subtracting cityMeanBias, or same as rawForecastHigh if correction was not applied. */
  correctedForecastHigh: number;
  /** Per-city mean forecast bias (forecastHigh − observedHigh). Null when no bias data available. */
  cityMeanBias: number | null;
  /** Per-city empirical standard deviation of forecast errors. Null when no bias data available. */
  cityEmpiricalStddev: number | null;
  /** Number of samples used for this city's bias estimate. Null when no bias data available. */
  citySampleSize: number | null;
  /** True when the mean-bias shift was applied to the forecast centre (requires biasMode=full AND meanShiftHelpful). The empirical σ overlay runs whenever biasMode=full regardless of this flag. */
  meanShiftApplied: boolean;
  /**
   * Which tier of bias handling ran for this opportunity:
   *   - `none` — no bias data trusted (either disabled, missing, or sampleSize < min)
   *   - `weak` — min ≤ n < trusted: σ widened by WEATHER_WEAK_BIAS_STDDEV_MULTIPLIER, mean unchanged
   *   - `full` — n ≥ trusted: mean shifted by -cityMeanBias, σ = max(raw, empirical)
   */
  biasMode: 'none' | 'weak' | 'full';
  /** Market end date from Gamma — used by the near-res entry gate. */
  endDate: string | null;
  /** Alternate shadow-model bracket probability (same event, alternate ensemble model). */
  shadowModelProbability?: number | null;
  /** Alternate shadow-model edge on the selected trade side. */
  shadowEdge?: number | null;
  /** Alternate shadow-model ensemble identifier. */
  shadowEnsembleModel?: 'gfs' | 'ecmwf' | null;
  /** Alternate shadow-model effective stddev. */
  shadowEffectiveStdDev?: number | null;
  /** Alternate shadow-model member count. */
  shadowEnsembleMembers?: number | null;
  /** True when blocked because the market repriced against the thesis without enough model improvement. */
  blockedByMarketDisagreement?: boolean;
  /** Prior side-relative price used by the disagreement gate. */
  previousOutcomePrice?: number | null;
  /** Prior win probability used by the disagreement gate. */
  previousWinProbability?: number | null;
  /**
   * True when the shadow ensemble disagrees with the primary model and
   * WEATHER_DUAL_ENSEMBLE_VETO_ENABLED is on. Fires when shadowEdge is
   * available but ≤ 0 — whichever model is in shadow sees no edge on this side.
   * Shadow model identity is whichever is not primary: ECMWF when
   * WEATHER_MODEL_ECMWF_ENABLED=false (GFS primary), GFS when =true.
   */
  blockedByEnsembleVeto?: boolean;
  /**
   * True when this opportunity was generated because the event-level dedup was bypassed
   * for size-up re-evaluation. Execution must verify an open position exists before
   * proceeding; the executor will treat it as a size-up if one is found.
   */
  sizeUpScanOnly?: boolean;
  /** True when this opportunity came through the resolution-day early-entry path.
   *  The early-entry gate already verified sufficient local time remains, so the
   *  near-res entry gate (which uses Gamma's endDate, not local midnight) should
   *  be bypassed to avoid a double-gate conflict. */
  earlyResolutionDayEntry?: boolean;
  /** True when the scanner ran on the market's resolution day (city-local timezone).
   *  Propagated to TradeSignal._isResolutionDay so the executor can apply the
   *  WEATHER_EARLY_ENTRY_MAX_PRICE cap only on pre-resolution-day entries. */
  isResolutionDay?: boolean;
  /** Reason a YES candidate was gated off (interior_bracket / market_price_below_min /
   *  model_prob_below_min), or null when YES was not gated. Set even on NO opportunities
   *  that arose because the model preferred YES but the YES gate blocked it. */
  yesGateReason?: string | null;
  /** True when this NO opportunity is a fallback from a gated YES (the model's
   *  preferred side was YES but it was gated off). Lets shadow analysis exclude
   *  these from the "native NO" cohort so YES-gate win-rate study stays clean. */
  yesFellBackToNo?: boolean;
}

interface WeatherMarketState {
  tradeSide: 'YES' | 'NO';
  outcomePrice: number;
  winProbability: number;
  observedAt: string;
}

function weatherMarketStateKey(marketId: string, side: 'YES' | 'NO'): string {
  return `${MARKET_STATE_KEY_PREFIX}${marketId}:${side}`;
}

function weatherWinProbability(opp: WeatherBracketOpportunity): number {
  return opp.tradeSide === 'YES' ? opp.modelProbability : 1 - opp.modelProbability;
}

async function applyMarketDisagreementGate(
  redis: Redis,
  opps: WeatherBracketOpportunity[],
  cfg: ReturnType<typeof loadConfig>,
): Promise<WeatherBracketOpportunity[]> {
  if (!cfg.WEATHER_MARKET_DISAGREEMENT_ENABLED || opps.length === 0) return opps;

  const keys = opps.map((opp) => weatherMarketStateKey(opp.marketId, opp.tradeSide));
  const priorRaws = await redis.mget(...keys);

  const gated: WeatherBracketOpportunity[] = [];
  const pipeline = redis.pipeline();

  for (let i = 0; i < opps.length; i++) {
    const opp = opps[i]!;
    const priorRaw = priorRaws[i];
    let previousOutcomePrice: number | null = null;
    let previousWinProbability: number | null = null;
    let blockedByMarketDisagreement = false;

    if (priorRaw) {
      try {
        const prior = JSON.parse(priorRaw) as WeatherMarketState;
        previousOutcomePrice = Number.isFinite(prior.outcomePrice) ? prior.outcomePrice : null;
        previousWinProbability = Number.isFinite(prior.winProbability) ? prior.winProbability : null;
        const currentWinProbability = weatherWinProbability(opp);
        const adverseMove =
          previousOutcomePrice != null ? opp.outcomePrice - previousOutcomePrice : 0;
        const winProbImprovement =
          previousWinProbability != null ? currentWinProbability - previousWinProbability : Number.POSITIVE_INFINITY;
        blockedByMarketDisagreement =
          adverseMove >= cfg.WEATHER_MARKET_DISAGREEMENT_MIN_ADVERSE_MOVE
          && winProbImprovement <= cfg.WEATHER_MARKET_DISAGREEMENT_MAX_WINPROB_IMPROVEMENT;
      } catch {
        // Ignore malformed prior state and overwrite below.
      }
    }

    if (blockedByMarketDisagreement) {
      logger.info('[weather] blocking stale thesis after adverse repricing', {
        marketId: opp.marketId,
        city: opp.city,
        bracket: opp.bracketLabel,
        tradeSide: opp.tradeSide,
        previousOutcomePrice,
        currentOutcomePrice: opp.outcomePrice,
        previousWinProbability,
        currentWinProbability: weatherWinProbability(opp),
      });
    }

    gated.push({
      ...opp,
      blockedByMarketDisagreement,
      previousOutcomePrice,
      previousWinProbability,
    });

    const nextState: WeatherMarketState = {
      tradeSide: opp.tradeSide,
      outcomePrice: opp.outcomePrice,
      winProbability: weatherWinProbability(opp),
      observedAt: new Date().toISOString(),
    };
    pipeline.set(keys[i]!, JSON.stringify(nextState), 'EX', cfg.WEATHER_MARKET_DISAGREEMENT_TTL_S);
  }

  await pipeline.exec();
  return gated;
}

/**
// cityLocalDate and cityDayEndUtcMs are imported from resolutionTime.ts —
// the single source of truth for city-local weather resolution boundaries.

/**
 * Compute the days between now and a target date string (YYYY-MM-DD).
 */
export function daysUntil(targetDate: string, now?: Date): number {
  const target = new Date(targetDate + 'T12:00:00Z');
  const current = now ?? new Date();
  const diffMs = target.getTime() - current.getTime();
  return Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
}

/**
 * True when the corrected forecast's central estimate rounds into [low, high].
 * Single source of truth shared by the entry scanner's interior-NO guard and the
 * forecast-invalidation modal-inversion trigger, so the two can never drift. Only
 * bounded brackets carry the signal — a tail (null bound) has an open side the
 * forecast cannot round out of, so it returns false.
 */
export function forecastRoundsIntoBracket(
  correctedForecastHigh: number,
  low: number | null,
  high: number | null,
): boolean {
  if (low === null || high === null) return false;
  const rounded = Math.round(correctedForecastHigh);
  return rounded >= low && rounded <= high;
}

/**
 * Analyze a single weather event and find mispriced brackets.
 *
 * `stddevMultiplier` (default 1.0) widens or tightens the forecast distribution
 * before bracket probabilities are computed. Calibration knob — see
 * `WEATHER_STDDEV_MULTIPLIER` in config. Adjusted stddev is what feeds
 * `estimateBracketProbability`; raw `forecast.stdDev` is preserved on the
 * returned opportunity (`forecastStdDev`) so shadow analysis can compare.
 */
export interface FindMispricedResult {
  opportunities: WeatherBracketOpportunity[];
  /** Sum of all bracket model probabilities — used for coverage check and shadow logging. */
  modelSum: number;
  /** True when the mean-bias shift was applied to the forecast centre (biasMode=full AND meanShiftHelpful). */
  meanShiftApplied: boolean;
  /** Tri-state tier of bias handling for this invocation (`none` | `weak` | `full`). */
  biasMode: 'none' | 'weak' | 'full';
  /**
   * The σ actually fed to `estimateBracketProbability`, after the static
   * stddevMultiplier AND any bias-mode adjustment (weak-band inflator or
   * full-tier empirical-σ overlay). Surfacing this lets callers log the real
   * value used rather than recomputing a pre-bias figure that disagrees with
   * the model run.
   */
  effectiveStdDev: number;
}

export interface FindMispricedOptions {
  stddevMultiplier?: number;
  minModelCoverage?: number;
  allowedSides?: ReadonlySet<'YES' | 'NO'>;
  cityBias?: CityBias | null;
  biasCorrectionEnabled?: boolean;
  biasMinSamples?: number;
  /** Sample count at which full mean-bias correction is trusted. Between min and
   *  trusted the scanner enters the weak band (widen σ, don't shift mean). */
  biasTrustedSamples?: number;
  /** σ inflator used inside the weak band (default 1.2 = +20%). */
  weakBiasStddevMultiplier?: number;
  /** Skip NO bets on tail brackets when modelProb exceeds this (default 0.5). */
  maxTailNoBetModelProb?: number;
  /** Recent WU daily highs for base-rate gate on tail NO bets. */
  cityActuals?: CityActuals | null;
  /** Minimum actuals samples before base-rate gate fires (default 7). Fail open below. */
  baseRateMinSamples?: number;
  /** Block tail NO when WU base-rate YES fraction ≥ this threshold (default 0.70). */
  baseRateNoBlockThreshold?: number;
  // ── YES-bet quality gates (NO bets unaffected) ────────────────────────────
  /** Allow interior-bracket YES bets (e.g. "24°C"). Default false — interior YES
   *  wins only 4-14% historically; tail brackets have genuine directional edge. */
  yesAllowInteriorBrackets?: boolean;
  /** Minimum market (outcome) price for YES entries. Below 0.30 the market has
   *  better information (intraday temps); win rate collapses. Default 0.30. */
  yesMinMarketPrice?: number;
  /** Minimum model probability for YES entries. Default 0.50. */
  yesMinModelProb?: number;
}

export interface BiasedProbResult {
  modelProbability: number;
  effectiveStdDev: number;
  correctedForecastHigh: number;
  biasMode: 'none' | 'weak' | 'full';
}

/**
 * Compute the model probability for a single bracket given a forecast and bias options.
 * Shared by findMispricedBrackets and the forecast-invalidation revaluation scanner.
 */
export function computeBiasedProb(
  bracketLow: number | null,
  bracketHigh: number | null,
  daysOut: number,
  forecast: ForecastResult,
  options: Pick<FindMispricedOptions,
    'stddevMultiplier' | 'cityBias' | 'biasCorrectionEnabled' |
    'biasMinSamples' | 'biasTrustedSamples' | 'weakBiasStddevMultiplier'
  > = {},
): BiasedProbResult {
  const {
    stddevMultiplier = 1.0,
    cityBias = null,
    biasCorrectionEnabled = false,
    biasMinSamples = 14,
    biasTrustedSamples: biasTrustedSamplesRaw = 14,
    weakBiasStddevMultiplier = 1.2,
  } = options;
  const biasTrustedSamples = Math.max(biasTrustedSamplesRaw, biasMinSamples);

  let biasMode: 'none' | 'weak' | 'full' = 'none';
  if (biasCorrectionEnabled && cityBias !== null) {
    if (cityBias.sampleSize >= biasTrustedSamples) {
      biasMode = 'full';
    } else if (cityBias.sampleSize >= biasMinSamples) {
      biasMode = 'weak';
    }
  }
  const meanShiftHelpful = cityBias?.meanShiftHelpful === true;
  const meanShiftApplied = biasMode === 'full' && meanShiftHelpful;
  const rawForecastHigh = forecast.forecastHigh;
  const correctedForecastHigh = meanShiftApplied
    ? rawForecastHigh - cityBias!.meanBias
    : rawForecastHigh;
  const rawEffectiveStdDev = forecast.stdDev * stddevMultiplier;
  let effectiveStdDev: number;
  if (biasMode === 'full') {
    effectiveStdDev = Math.max(rawEffectiveStdDev, cityBias!.empiricalStddev * stddevMultiplier);
  } else if (biasMode === 'weak') {
    effectiveStdDev = rawEffectiveStdDev * weakBiasStddevMultiplier;
  } else {
    effectiveStdDev = rawEffectiveStdDev;
  }
  const modelProbability = estimateBracketProbability(
    correctedForecastHigh,
    bracketLow,
    bracketHigh,
    daysOut,
    effectiveStdDev,
  );
  return { modelProbability, effectiveStdDev, correctedForecastHigh, biasMode };
}

export function findMispricedBrackets(
  event: ParsedWeatherEvent,
  forecast: ForecastResult,
  daysOut: number,
  minEdge: number,
  options: FindMispricedOptions = {},
): FindMispricedResult {
  const {
    stddevMultiplier = 1.0,
    minModelCoverage = 0.95,
    allowedSides = new Set<'YES' | 'NO'>(['YES', 'NO']),
    cityBias = null,
    biasCorrectionEnabled = false,
    biasMinSamples = 14,
    biasTrustedSamples: biasTrustedSamplesRaw = 14,
    weakBiasStddevMultiplier = 1.2,
    maxTailNoBetModelProb = 0.5,
    cityActuals = null,
    baseRateMinSamples = 7,
    baseRateNoBlockThreshold = 0.70,
    // YES gate defaults are "off" at the function level so tests that don't
    // explicitly configure them are unaffected. scanWeatherMarkets always passes
    // the live config values which enforce the restrictive thresholds.
    yesAllowInteriorBrackets = true,
    yesMinMarketPrice = 0,
    yesMinModelProb = 0,
  } = options;
  // Defense-in-depth clamp: loadConfig() cross-validates trusted ≥ min, but this
  // helper is also called directly from tests and could accept arbitrary values.
  // Clamping here means a caller passing trusted < min never causes 'full' to
  // fire on thinner samples than the weak band requires.
  const biasTrustedSamples = Math.max(biasTrustedSamplesRaw, biasMinSamples);
  const opportunities: WeatherBracketOpportunity[] = [];

  // Three-tier trust model for per-city bias metadata:
  //   - n < biasMinSamples           → 'none': ignore bias entirely
  //   - min ≤ n < biasTrustedSamples → 'weak': σ widened, mean NOT shifted
  //   - n ≥ biasTrustedSamples       → 'full': mean shift + empirical σ overlay
  // Weak-band mean correction is the riskiest part to trust on small samples
  // (observed April 2026: 6–13 sample cities ran 26.7% WR / -664% return vs
  // historical 68% NO accuracy). Widening σ is the safer response.
  let biasMode: 'none' | 'weak' | 'full' = 'none';
  if (biasCorrectionEnabled && cityBias !== null) {
    if (cityBias.sampleSize >= biasTrustedSamples) {
      biasMode = 'full';
    } else if (cityBias.sampleSize >= biasMinSamples) {
      biasMode = 'weak';
    }
  }
  const meanShiftHelpful = cityBias?.meanShiftHelpful === true;
  const meanShiftApplied = biasMode === 'full' && meanShiftHelpful;

  const rawForecastHigh = forecast.forecastHigh;
  // Only the trusted tier subtracts meanBias — weak-band samples are too noisy
  // to justify shifting the forecast centre. The empirical σ overlay still runs
  // whenever biasMode=full regardless of whether the mean shift is applied.
  const correctedForecastHigh = meanShiftApplied ? rawForecastHigh - cityBias!.meanBias : rawForecastHigh;
  const forecastHighForCalc = correctedForecastHigh;

  // Effective stddev:
  //   - full: max of ensemble spread and empirical σ (prevents overconfidence
  //     in stable regimes where ensemble spread is tight but realized error is larger)
  //   - weak: inflate by weakBiasStddevMultiplier (de-confidence; ignore empiricalStddev
  //     directly since the sample is too thin to trust its magnitude)
  //   - none: raw stddev × stddevMultiplier
  const rawEffectiveStdDev = forecast.stdDev * stddevMultiplier;
  let effectiveStdDev: number;
  if (biasMode === 'full') {
    effectiveStdDev = Math.max(rawEffectiveStdDev, cityBias!.empiricalStddev * stddevMultiplier);
  } else if (biasMode === 'weak') {
    effectiveStdDev = rawEffectiveStdDev * weakBiasStddevMultiplier;
  } else {
    effectiveStdDev = rawEffectiveStdDev;
  }

  // Compute model probability for each bracket
  const modelProbs: number[] = [];
  const shadowModelProbs: Array<number | null> = [];
  for (const bracket of event.brackets) {
    const prob = estimateBracketProbability(
      forecastHighForCalc,
      bracket.low,
      bracket.high,
      daysOut,
      effectiveStdDev,
    );
    modelProbs.push(prob);
    if (forecast.shadowEnsemble) {
      shadowModelProbs.push(
        estimateBracketProbability(
          forecastHighForCalc,
          bracket.low,
          bracket.high,
          daysOut,
          forecast.shadowEnsemble.stdDev,
        ),
      );
    } else {
      shadowModelProbs.push(null);
    }
  }

  // Coverage guard: model probs must sum to ≥ minModelCoverage.
  // Late-day bracket thinning (11 → 4 brackets) causes low coverage; the
  // surviving brackets inherit missing mass and produce synthetic edge.
  const modelSum = modelProbs.reduce((s, p) => s + p, 0);
  if (modelSum < minModelCoverage) {
    logger.warn('[weather] model probabilities below coverage threshold, skipping event', {
      city: event.city,
      targetDate: event.targetDate,
      modelSum: modelSum.toFixed(4),
      bracketCount: event.brackets.length,
      threshold: minModelCoverage,
    });
    return { opportunities: [], modelSum, meanShiftApplied, biasMode, effectiveStdDev };
  }

  // Compute overround (diagnostic): sum of all market YES prices.
  // Used for logging, not for edge computation — edges use actual bid prices.
  const overround = event.brackets.reduce((s, b) => s + b.yesPrice, 0);

  // Vig-adjusted probabilities (diagnostic only — logged for analysis)
  const adjustedMarketProbs = event.brackets.map((b) =>
    overround > 0 ? b.yesPrice / overround : 0,
  );

  for (let i = 0; i < event.brackets.length; i++) {
    const bracket = event.brackets[i]!;
    const modelProb = modelProbs[i]!;
    const adjustedMarketProb = adjustedMarketProbs[i]!;

    // Edge per side using actual bid prices (not vig-adjusted event-level probs).
    // YES edge: model says bracket is more likely than yesPrice implies
    // NO edge: model says bracket is less likely than (1 - noPrice) implies
    const edgeYes = modelProb - bracket.yesPrice;
    const edgeNo = (1 - modelProb) - bracket.noPrice;
    const shadowModelProb = shadowModelProbs[i] ?? null;

    // YES quality gate: evaluate BEFORE side selection so that a gated YES
    // falls back to the NO candidate rather than suppressing the bracket entirely.
    // "NO bets are unaffected" holds only when the gate runs pre-selection.
    let yesGateReason: string | null = null;
    if (bracket.low !== null && bracket.high !== null && !yesAllowInteriorBrackets) {
      yesGateReason = 'interior_bracket';
    } else if (bracket.yesPrice < yesMinMarketPrice) {
      yesGateReason = 'market_price_below_min';
    } else if (modelProb < yesMinModelProb) {
      yesGateReason = 'model_prob_below_min';
    }
    const yesGateBlocked = yesGateReason !== null;

    let tradeSide: 'YES' | 'NO';
    let edge: number;

    if (!yesGateBlocked && edgeYes >= edgeNo && edgeYes > 0) {
      tradeSide = 'YES';
      edge = edgeYes;
    } else if (edgeNo > 0) {
      if (yesGateBlocked && edgeYes > 0) {
        logger.debug('[weather] YES gated — falling back to NO', {
          city: event.city, bracket: bracket.label, reason: yesGateReason,
          edgeYes: edgeYes.toFixed(3), edgeNo: edgeNo.toFixed(3),
        });
      }
      tradeSide = 'NO';
      edge = edgeNo;
    } else {
      if (yesGateBlocked && edgeYes > 0) {
        logger.debug('[weather] YES gated — no NO fallback, skipping', {
          city: event.city, bracket: bracket.label, reason: yesGateReason,
        });
      }
      continue; // No eligible positive edge on either side
    }

    if (edge < minEdge) continue;

    // Gate: tail brackets ("X or higher" / "X or below") produce spuriously positive
    // NO edge when the model's P(YES) is high — edgeNo = (1-modelProb) - noPrice can
    // be positive at modelProb=0.82 if noPrice=0.08. Betting NO there means betting
    // against our own forecast direction; skip unless model genuinely leans NO.
    if (tradeSide === 'NO' && (bracket.low === null || bracket.high === null) && modelProb > maxTailNoBetModelProb) {
      logger.debug('[weather] skipping tail NO — model favours YES', {
        city: event.city,
        bracket: bracket.label,
        modelProb: modelProb.toFixed(3),
        maxTailNoBetModelProb,
      });
      continue;
    }

    // Gate: tail NO bets where recent WU actuals strongly favour YES.
    // The GFS model can drift cold relative to WU (the resolution source), so even
    // a low modelProb on YES doesn't mean NO is safe if the city historically hits
    // this threshold most days.
    // Cache miss → fail CLOSED: no actuals means we can't verify the base rate,
    // and entering a tail NO blind is the high-risk direction. Skip the scan cycle;
    // the cache will populate within hours.
    // Thin sample → fail open: some data exists, just not enough to be confident
    // either way, so let the model probability decide.
    if (tradeSide === 'NO' && (bracket.low === null || bracket.high === null)) {
      if (cityActuals === null) {
        logger.info('[weather] skipping tail NO — actuals cache absent, failing closed', {
          city: event.city,
          bracket: bracket.label,
        });
        continue;
      }
      if (
        cityActuals.unit === event.unit &&
        cityActuals.sampleSize >= baseRateMinSamples
      ) {
        const threshold = bracket.high === null ? bracket.low! : bracket.high!;
        const yesFraction =
          bracket.high === null
            ? cityActuals.highs.filter((h) => h >= threshold).length / cityActuals.highs.length
            : cityActuals.highs.filter((h) => h <= threshold).length / cityActuals.highs.length;
        if (yesFraction >= baseRateNoBlockThreshold) {
          logger.info('[weather] skipping tail NO — base rate strongly favors YES', {
            city: event.city,
            bracket: bracket.label,
            threshold,
            yesFraction: Math.round(yesFraction * 1000) / 1000,
            sampleSize: cityActuals.sampleSize,
            baseRateNoBlockThreshold,
          });
          continue;
        }
      }
    }

    // Gate: interior NO bets where the corrected forecast itself rounds into this
    // bracket. The model's central estimate resolves YES, so we'd be betting against
    // our own best guess — skip regardless of apparent edge.
    if (tradeSide === 'NO' && forecastRoundsIntoBracket(correctedForecastHigh, bracket.low, bracket.high)) {
      logger.debug('[weather] skipping interior NO — forecast rounds into bracket', {
        city: event.city,
        bracket: bracket.label,
        correctedForecastHigh,
        roundedForecast: Math.round(correctedForecastHigh),
      });
      continue;
    }

    // Skip near-zero markets where liquidity is negligible. Hard floor on both
    // sides, independent of the configurable yesMinMarketPrice gate — otherwise
    // WEATHER_YES_MIN_MARKET_PRICE=0 would re-expose thin near-zero YES books.
    if (bracket.yesPrice < 0.005 && tradeSide === 'YES') continue;
    if (bracket.noPrice < 0.005 && tradeSide === 'NO') continue;

    // A YES-gate fallback: the model's preferred side was YES (edgeYes >= edgeNo,
    // edgeYes > 0) but the YES gate blocked it, so this NO exists only because YES
    // was gated. yesGateReason is persisted ONLY in this case — a native NO (YES
    // never had edge, or NO was genuinely better) must stay untagged so shadow
    // analysis can segment fallback-NO out of the native-NO cohort.
    const yesFellBackToNo =
      yesGateBlocked && tradeSide === 'NO' && edgeYes >= edgeNo && edgeYes > 0;

    opportunities.push({
      marketId: bracket.marketId,
      conditionId: bracket.conditionId,
      eventId: event.eventId,
      eventSlug: event.slug,
      city: event.city,
      targetDate: event.targetDate,
      bracketLabel: bracket.label,
      question: bracket.question,
      clobTokenIds: bracket.clobTokenIds,
      yesPrice: bracket.yesPrice,
      noPrice: bracket.noPrice,
      modelProbability: modelProb,
      adjustedMarketProb,
      edge,
      tradeSide,
      outcomePrice: tradeSide === 'YES' ? bracket.yesPrice : bracket.noPrice,
      forecastHigh: correctedForecastHigh,
      forecastStdDev: forecast.stdDev,
      effectiveStdDev,
      forecastSource: forecast.source,
      ensembleMembers: forecast.ensembleMembers,
      daysOut,
      unit: event.unit,
      overround,
      allowedByConfig: allowedSides.has(tradeSide),
      rawForecastHigh,
      correctedForecastHigh,
      cityMeanBias: cityBias?.meanBias ?? null,
      cityEmpiricalStddev: cityBias?.empiricalStddev ?? null,
      citySampleSize: cityBias?.sampleSize ?? null,
      meanShiftApplied,
      biasMode,
      endDate: event.endDate,
      shadowModelProbability: shadowModelProb,
      shadowEdge: shadowModelProb == null
        ? null
        : (tradeSide === 'YES'
          ? shadowModelProb - bracket.yesPrice
          : (1 - shadowModelProb) - bracket.noPrice),
      shadowEnsembleModel: forecast.shadowEnsemble?.ensembleModel ?? null,
      shadowEffectiveStdDev: forecast.shadowEnsemble?.stdDev ?? null,
      shadowEnsembleMembers: forecast.shadowEnsemble?.ensembleMembers ?? null,
      // Veto is evaluated later in scanWeatherMarkets once cfg is available.
      blockedByEnsembleVeto: false,
      // Only tag the reason when YES actually got gated into this NO fallback —
      // a native NO must keep yesGateReason=null even if e.g. the interior gate
      // would have tripped, so the native-NO cohort stays clean.
      yesGateReason: yesFellBackToNo ? yesGateReason : null,
      yesFellBackToNo,
    });
  }

  return { opportunities, modelSum, meanShiftApplied, biasMode, effectiveStdDev };
}

// ── Main scanner ─────────────────────────────────────────────────────────

/**
 * Returns true if any of the given market IDs has an open YES or NO position
 * in the ledger. Accepts allMarketIds (not just active brackets) so a held
 * bracket whose market was closed/inactive in the Gamma API response is not
 * missed.
 */
async function hasAnyOpenWeatherPosition(redis: Redis, marketIds: string[]): Promise<boolean> {
  const checks = marketIds.flatMap((id) => [
    hasOpenPosition(redis, id, 'YES'),
    hasOpenPosition(redis, id, 'NO'),
  ]);
  const results = await Promise.all(checks);
  return results.some(Boolean);
}

/**
 * Scan Polymarket for weather bracket events and find mispriced brackets.
 *
 * Steps:
 *   1. Discover weather events via Gamma API (tag_slug=highest-temperature)
 *   2. Parse each event to extract city, date, bracket structure
 *   3. Fetch forecast (NOAA + Open-Meteo + ensemble)
 *   4. Compute bracket probabilities and find edge
 *   5. Dedup via Redis (per event, not per bracket)
 *   6. Shadow-log all opportunities
 */
export async function scanWeatherMarkets(
  redis: Redis,
  fetchFn?: FetchFn,
): Promise<WeatherBracketOpportunity[]> {
  const cfg = loadConfig();
  const allOpportunities: WeatherBracketOpportunity[] = [];

  // Step 1: Discover weather events
  const rawEvents = await fetchWeatherEvents(cfg.WEATHER_MAX_EVENTS);

  if (rawEvents.length === 0) {
    logger.debug('[weather] no temperature events found on Gamma');
    return [];
  }

  const allowedSides = parseAllowedSides(cfg.WEATHER_TRADE_SIDES);

  let parsedCount = 0;
  let dedupSkipped = 0;
  let sizeUpRescanned = 0;
  let earlyResolutionDayEntries = 0;
  let noForecast = 0;
  let horizonSkipped = 0;
  let eventsWithOpportunities = 0;
  let totalDisagreementBlocked = 0;

  for (const rawEvent of rawEvents) {
    // Step 2: Parse the event
    const event = parseWeatherEvent(rawEvent);
    if (!event) continue;
    parsedCount++;

    // Check horizon
    const daysOut = daysUntil(event.targetDate);
    if (daysOut > cfg.WEATHER_MAX_HORIZON_DAYS) {
      horizonSkipped++;
      continue;
    }
    // Use the city's local calendar date, not UTC. daysUntil anchors at noon
    // UTC and returns 1 before noon on the target date via Math.ceil; the
    // calendar comparison fires the guard precisely at local midnight so western
    // cities (e.g. Houston, UTC-5) aren't blocked 5 hours before their day starts.
    const isResolutionDay = event.targetDate === cityLocalDate(event.coords.tz);
    // Gamma can lag resolution by minutes-to-hours and keep returning yesterday's
    // event as active=true. daysUntil floors at 0 for both today-post-noon and
    // past dates, so use the calendar check to distinguish: if daysOut===0 but
    // it's not today, the market has already resolved — skip it.
    if (!isResolutionDay && daysOut === 0) {
      horizonSkipped++;
      continue;
    }
    // Step 5: Dedup by event slug (covers all brackets in the event).
    // When SIZE_UP_ENABLED, bypass for events with an active position ONLY on the
    // target/resolution day, so the executor can add to the position once the
    // forecast for that day is effectively locked in. Off-day top-ups are
    // intentionally not allowed — they would chase a forecast that can still drift.
    // Fresh-entry prevention is delegated to hasOpenPosition checks in the
    // execution phase.
    const dedupKey = `${DEDUP_KEY_PREFIX}${event.slug}`;
    let isSizeUpScan = false;
    let isEarlyResolutionDayEntry = false;
    let earlyEntryKey: string | null = null;
    if (isResolutionDay) {
      const endOfTargetDayMs = cityDayEndUtcMs(event.targetDate, event.coords.tz);
      const hoursRemaining = (endOfTargetDayMs - Date.now()) / 3_600_000;

      // Check for an existing position first — size-up always takes priority over
      // fresh entry so existing positions are never accidentally routed through the
      // early-entry path and stripped of their sizeUpScanOnly flag.
      const activeMarker =
        (await redis.exists(`${ACTIVE_EVENT_KEY_PREFIX}${event.slug}`).catch(() => 0)) > 0;
      const hasPosition =
        activeMarker ||
        (await hasAnyOpenWeatherPosition(redis, event.allMarketIds).catch(() => false));

      if (cfg.SIZE_UP_ENABLED && hasPosition) {
        // Existing position → size-up path. Use a resolution-day-specific dedup key
        // so a pre-noon scan that already claimed the normal dedup key doesn't block
        // the first post-noon size-up. TTL covers the remainder of the target day so
        // at most one size-up fires per event per day.
        const rdKey = `${RES_DAY_DEDUP_KEY_PREFIX}${event.slug}`;
        const rdTtlS = Math.max(
          cfg.WEATHER_DEDUP_TTL_S,
          Math.ceil((endOfTargetDayMs - Date.now()) / 1000),
        );
        const claimed = await redis.set(rdKey, '1', 'EX', rdTtlS, 'NX').catch(() => null);
        if (!claimed) {
          dedupSkipped++;
          continue;
        }
        isSizeUpScan = true;
        sizeUpRescanned++;
        logger.debug('[weather] resolution-day size-up re-evaluation', {
          eventSlug: event.slug,
          city: event.city,
        });
      } else if (
        !hasPosition &&
        cfg.WEATHER_RES_DAY_EARLY_ENTRY_ENABLED &&
        hoursRemaining >= cfg.WEATHER_RES_DAY_MIN_HOURS_REMAINING
      ) {
        // Early-entry window: no existing position, enough hours remain before the
        // local daily high is observed. Ensemble agreement enforced per-opportunity
        // below (shadowEdge > 0; null also blocks — fail closed).
        earlyEntryKey = `${RES_DAY_EARLY_KEY_PREFIX}${event.slug}`;
        const rdEarlyTtlS = Math.max(
          cfg.WEATHER_DEDUP_TTL_S,
          Math.ceil((endOfTargetDayMs - Date.now()) / 1000),
        );
        const claimed = await redis.set(earlyEntryKey, '1', 'EX', rdEarlyTtlS, 'NX').catch(() => null);
        if (!claimed) {
          dedupSkipped++;
          continue;
        }
        isEarlyResolutionDayEntry = true;
        earlyResolutionDayEntries++;
        logger.debug('[weather] resolution-day early fresh entry', {
          eventSlug: event.slug,
          city: event.city,
          hoursRemaining: +hoursRemaining.toFixed(1),
        });
        // Fall through to forecast + bracket evaluation.
      } else {
        dedupSkipped++;
        // Covers: SIZE_UP_ENABLED=false with a position; SIZE_UP_ENABLED=true but
        // no position and early-entry disabled/threshold-not-met; or early-entry
        // disabled with no position and size-up disabled.
        const reason = cfg.SIZE_UP_ENABLED ? 'no_active_position' : 'size_up_disabled';
        logger.debug('[weather] resolution-day skip', {
          eventSlug: event.slug,
          city: event.city,
          reason,
        });
        continue;
      }
    } else {
      // Non-resolution day: size-ups are gated to the target/resolution day only,
      // so there is no dedup bypass here — a claimed key means this event was
      // already evaluated in the current window and we skip it. Top-ups resume on
      // the target day via the isResolutionDay branch above.
      const claimed = await redis.set(dedupKey, '1', 'EX', cfg.WEATHER_DEDUP_TTL_S, 'NX').catch(() => null);
      if (!claimed) {
        dedupSkipped++;
        continue;
      }
    }

    // Step 3: Fetch forecast
    const forecast = await fetchForecast(
      event,
      daysOut,
      fetchFn,
      cfg.WEATHER_STDDEV_MIN_FRACTION,
      cfg.WEATHER_MODEL_ECMWF_ENABLED,
      cfg.WEATHER_HRRR_ENABLED,
      cfg.WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED,
      cfg.WEATHER_HRRR_MAX_CROSS_SOURCE_SPREAD,
    );
    if (!forecast) {
      noForecast++;
      // Release the early-entry dedup slot so a later scan can retry once
      // forecast data is available (transient API failure should not burn the
      // whole early-entry window for the day).
      if (earlyEntryKey) await redis.del(earlyEntryKey).catch(() => null);
      continue;
    }

    // Fetch per-city bias (null when WEATHER_BIAS_CORRECTION_ENABLED=false or cache miss).
    const cityBias = cfg.WEATHER_BIAS_CORRECTION_ENABLED
      ? await getCityBias(redis, event.city)
      : null;

    // Fetch per-city WU actuals for tail NO base-rate gate (always, regardless of
    // bias correction flag — this gate is independent of the mean-shift correction).
    const cityActuals = await getCityActuals(redis, event.city);

    // Step 4: Find mispriced brackets (coverage guard inside; returns empty opportunities
    // when bracket data is incomplete — e.g. late-day thinning from 11 → 4 brackets).
    // modelSum is returned by findMispricedBrackets so shadow logging reuses the exact
    // values used for gating rather than recomputing them.
    const {
      opportunities,
      modelSum,
      meanShiftApplied: meanShiftApplied,
      biasMode: eventBiasMode,
      effectiveStdDev,
    } = findMispricedBrackets(
      event,
      forecast,
      daysOut,
      cfg.WEATHER_MIN_EDGE,
      {
        stddevMultiplier: cfg.WEATHER_STDDEV_MULTIPLIER,
        minModelCoverage: cfg.WEATHER_MIN_MODEL_COVERAGE,
        allowedSides,
        cityBias,
        biasCorrectionEnabled: cfg.WEATHER_BIAS_CORRECTION_ENABLED,
        biasMinSamples: cfg.WEATHER_BIAS_MIN_SAMPLES,
        biasTrustedSamples: cfg.WEATHER_BIAS_TRUSTED_SAMPLES,
        weakBiasStddevMultiplier: cfg.WEATHER_WEAK_BIAS_STDDEV_MULTIPLIER,
        maxTailNoBetModelProb: cfg.WEATHER_THRESHOLD_NO_BET_MAX_PROB,
        cityActuals,
        baseRateMinSamples: cfg.WEATHER_BASE_RATE_MIN_SAMPLES,
        baseRateNoBlockThreshold: cfg.WEATHER_BASE_RATE_NO_BLOCK_THRESHOLD,
        yesAllowInteriorBrackets: cfg.WEATHER_YES_ALLOW_INTERIOR_BRACKETS,
        yesMinMarketPrice: cfg.WEATHER_YES_MIN_MARKET_PRICE,
        yesMinModelProb: cfg.WEATHER_YES_MIN_MODEL_PROB,
      },
    );
    const afterMarketGate = await applyMarketDisagreementGate(redis, opportunities, cfg);
    const gatedOpportunities = afterMarketGate.map((opp) => ({
      ...opp,
      blockedByEnsembleVeto: isEarlyResolutionDayEntry
        // Early resolution-day entries require positive ensemble agreement.
        // Null shadowEdge (no ECMWF data) also blocks — fail closed.
        ? (opp.shadowEdge == null || opp.shadowEdge <= 0)
        : (cfg.WEATHER_DUAL_ENSEMBLE_VETO_ENABLED &&
           opp.shadowEdge != null &&
           opp.shadowEdge <= 0),
    }));
    // `effectiveStdDev` above is the post-bias σ actually used by
    // estimateBracketProbability (weak-band inflator or full-tier empirical-σ
    // overlay already applied). Surfaced up from findMispricedBrackets so the
    // event-level shadow payload matches the per-opp records.
    const coverageStatus = modelSum >= cfg.WEATHER_MIN_MODEL_COVERAGE ? 'ok' : 'skipped_low_coverage';

    // Step 6: Shadow-log every evaluated event
    const overround = event.brackets.reduce((s, b) => s + b.yesPrice, 0);
    const bestEdge = gatedOpportunities.length > 0
      ? Math.max(...gatedOpportunities.map((o) => o.edge))
      : 0;
    const allowedInEvent = gatedOpportunities.filter(
      (o) => o.allowedByConfig && !o.blockedByMarketDisagreement && !o.blockedByEnsembleVeto,
    ).length;
    const disagreementBlocked = gatedOpportunities.filter((o) => o.blockedByMarketDisagreement).length;
    const ensembleVetoBlocked = gatedOpportunities.filter((o) => o.blockedByEnsembleVeto).length;
    totalDisagreementBlocked += disagreementBlocked;

    logger.info('[weather] event evaluated', {
      eventId: event.eventId,
      slug: event.slug,
      city: event.city,
      targetDate: event.targetDate,
      daysOut,
      unit: event.unit,
      brackets: event.brackets.length,
      forecastHigh: forecast.forecastHigh.toFixed(1),
      forecastStdDev: forecast.stdDev.toFixed(2),
      effectiveStdDev: effectiveStdDev.toFixed(2),
      stddevMultiplier: cfg.WEATHER_STDDEV_MULTIPLIER,
      forecastSource: forecast.source,
      ensembleMembers: forecast.ensembleMembers,
      ensembleModel: forecast.ensembleModel,
      shadowEnsembleModel: forecast.shadowEnsemble?.ensembleModel ?? null,
      shadowEnsembleMembers: forecast.shadowEnsemble?.ensembleMembers ?? null,
      shadowForecastStdDev: forecast.shadowEnsemble?.stdDev?.toFixed(2) ?? null,
      overround: overround.toFixed(3),
      modelSum: modelSum.toFixed(4),
      coverageStatus,
      opportunitiesFound: gatedOpportunities.length,
      allowedInEvent,
      disagreementBlocked,
      ensembleVetoBlocked,
      tradeSidesMode: cfg.WEATHER_TRADE_SIDES,
      bestEdge: bestEdge.toFixed(3),
      enabled: cfg.WEATHER_SCANNER_ENABLED,
    });
    void enqueueWrite('shadow_observations', {
      kind: 'weather_event',
      source: 'arb',
      // Block when the feature is disabled, no opportunities exist, or every
      // opportunity is on a side gated off by WEATHER_TRADE_SIDES — matches
      // weather_bracket semantics so event-level `wouldBlock` aggregates stay
      // consistent with bracket-level `wouldTrade` counts.
      wouldBlock:
        !cfg.WEATHER_SCANNER_ENABLED ||
        gatedOpportunities.length === 0 ||
        allowedInEvent === 0,
      metricValue: bestEdge,
      threshold: cfg.WEATHER_MIN_EDGE,
      payload: {
        eventId: event.eventId,
        slug: event.slug,
        city: event.city,
        targetDate: event.targetDate,
        daysOut,
        unit: event.unit,
        brackets: event.brackets.length,
        forecastHigh: forecast.forecastHigh,
        forecastStdDev: forecast.stdDev,
        // Effective stddev = forecastStdDev * WEATHER_STDDEV_MULTIPLIER. Both
        // are logged so calibration analysis can compare modelProb under
        // different multipliers without re-deriving from raw stddev.
        effectiveStdDev,
        stddevMultiplier: cfg.WEATHER_STDDEV_MULTIPLIER,
        forecastSource: forecast.source,
        ensembleMembers: forecast.ensembleMembers,
        ensembleModel: forecast.ensembleModel,
        shadowEnsembleModel: forecast.shadowEnsemble?.ensembleModel ?? null,
        shadowEnsembleMembers: forecast.shadowEnsemble?.ensembleMembers ?? null,
        shadowForecastStdDev: forecast.shadowEnsemble?.stdDev ?? null,
        overround,
        modelSum: parseFloat(modelSum.toFixed(4)),
        status: coverageStatus,
        opportunitiesFound: gatedOpportunities.length,
        allowedInEvent,
        disagreementBlocked,
        ensembleVetoBlocked,
        tradeSidesMode: cfg.WEATHER_TRADE_SIDES,
        scannerEnabled: cfg.WEATHER_SCANNER_ENABLED,
        cityMeanBias: cityBias?.meanBias ?? null,
        cityEmpiricalStddev: cityBias?.empiricalStddev ?? null,
        citySampleSize: cityBias?.sampleSize ?? null,
        meanShiftApplied: meanShiftApplied,
        biasMode: eventBiasMode,
        meanShiftHelpful: cityBias?.meanShiftHelpful ?? false,
        cityRawMae: cityBias?.rawMae ?? null,
        cityCorrectedMae: cityBias?.correctedMae ?? null,
        biasMinSamples: cfg.WEATHER_BIAS_MIN_SAMPLES,
        biasTrustedSamples: cfg.WEATHER_BIAS_TRUSTED_SAMPLES,
        weakBiasStddevMultiplier: cfg.WEATHER_WEAK_BIAS_STDDEV_MULTIPLIER,
      },
    });

    // Log each opportunity individually for shadow analysis.
    // Shadow still records disallowed-side opps so calibration analysis keeps
    // accruing validation data for the gated side — only wouldTrade flips.
    for (const opp of gatedOpportunities) {
      const wouldTrade =
        cfg.WEATHER_SCANNER_ENABLED &&
        opp.allowedByConfig &&
        !opp.blockedByMarketDisagreement &&
        !opp.blockedByEnsembleVeto;
      logger.info('[weather] bracket opportunity', {
        marketId: opp.marketId,
        eventSlug: opp.eventSlug,
        city: opp.city,
        targetDate: opp.targetDate,
        bracket: opp.bracketLabel,
        tradeSide: opp.tradeSide,
        modelProb: opp.modelProbability.toFixed(3),
        marketPrice: opp.outcomePrice.toFixed(3),
        adjustedMarketProb: opp.adjustedMarketProb.toFixed(3),
        edge: opp.edge.toFixed(3),
        outcomePrice: opp.outcomePrice.toFixed(3),
        forecastHigh: opp.forecastHigh.toFixed(1),
        ensembleModel: forecast.ensembleModel,
        shadowEnsembleModel: forecast.shadowEnsemble?.ensembleModel ?? null,
        shadowEnsembleMembers: forecast.shadowEnsemble?.ensembleMembers ?? null,
        shadowModelProb: opp.shadowModelProbability ?? null,
        shadowEdge: opp.shadowEdge ?? null,
        shadowEffectiveStdDev: opp.shadowEffectiveStdDev ?? null,
        daysOut: opp.daysOut,
        tradeSidesMode: cfg.WEATHER_TRADE_SIDES,
        allowedByConfig: opp.allowedByConfig,
        blockedByMarketDisagreement: opp.blockedByMarketDisagreement ?? false,
        blockedByEnsembleVeto: opp.blockedByEnsembleVeto ?? false,
        previousOutcomePrice: opp.previousOutcomePrice ?? null,
        previousWinProbability: opp.previousWinProbability ?? null,
        wouldTrade,
      });
      void enqueueWrite('shadow_observations', {
        kind: 'weather_bracket',
        source: 'arb',
        marketId: opp.marketId,
        direction: opp.tradeSide,
        wouldBlock: !wouldTrade,
        metricValue: opp.edge,
        threshold: cfg.WEATHER_MIN_EDGE,
        payload: {
          eventSlug: opp.eventSlug,
          city: opp.city,
          targetDate: opp.targetDate,
          bracket: opp.bracketLabel,
          tradeSide: opp.tradeSide,
          modelProb: opp.modelProbability,
          marketPrice: opp.outcomePrice,
          adjustedMarketProb: opp.adjustedMarketProb,
          outcomePrice: opp.outcomePrice,
          forecastHigh: opp.forecastHigh,
          // Both raw and effective stddev are stored explicitly so downstream
          // analyzers can read either without recomputing. Effective is what
          // entered estimateBracketProbability; raw lets calibration sweeps
          // try alternative multipliers post-hoc via normalCdf.
          forecastStdDev: opp.forecastStdDev,
          effectiveStdDev: opp.effectiveStdDev,
          stddevMultiplier: cfg.WEATHER_STDDEV_MULTIPLIER,
          ensembleModel: forecast.ensembleModel,
          forecastSource: forecast.source,
          ensembleMembers: forecast.ensembleMembers,
          shadowEnsembleModel: forecast.shadowEnsemble?.ensembleModel ?? null,
          shadowEnsembleMembers: forecast.shadowEnsemble?.ensembleMembers ?? null,
          shadowModelProb: opp.shadowModelProbability ?? null,
          shadowEdge: opp.shadowEdge ?? null,
          shadowEffectiveStdDev: opp.shadowEffectiveStdDev ?? null,
          tradeSidesMode: cfg.WEATHER_TRADE_SIDES,
          allowedByConfig: opp.allowedByConfig,
          blockedByMarketDisagreement: opp.blockedByMarketDisagreement ?? false,
          blockedByEnsembleVeto: opp.blockedByEnsembleVeto ?? false,
          previousOutcomePrice: opp.previousOutcomePrice ?? null,
          previousWinProbability: opp.previousWinProbability ?? null,
          daysOut: opp.daysOut,
          wouldTrade,
          rawForecastHigh: opp.rawForecastHigh,
          correctedForecastHigh: opp.correctedForecastHigh,
          cityMeanBias: opp.cityMeanBias,
          cityEmpiricalStddev: opp.cityEmpiricalStddev,
          citySampleSize: opp.citySampleSize,
          meanShiftApplied: opp.meanShiftApplied,
          biasMode: opp.biasMode,
          meanShiftHelpful: cityBias?.meanShiftHelpful ?? false,
          cityRawMae: cityBias?.rawMae ?? null,
          cityCorrectedMae: cityBias?.correctedMae ?? null,
          // YES-gate provenance: lets shadow analysis segment fallback-NO rows
          // out of the native-NO cohort when studying YES-gate win rates.
          yesGateReason: opp.yesGateReason ?? null,
          yesFellBackToNo: opp.yesFellBackToNo ?? false,
        },
      });
    }

    if (gatedOpportunities.length > 0) {
      eventsWithOpportunities++;
      if (isSizeUpScan) {
        for (const opp of gatedOpportunities) opp.sizeUpScanOnly = true;
      }
      if (isEarlyResolutionDayEntry) {
        for (const opp of gatedOpportunities) opp.earlyResolutionDayEntry = true;
      }
      for (const opp of gatedOpportunities) opp.isResolutionDay = isResolutionDay;
      allOpportunities.push(...gatedOpportunities);
    }
  }

  const totalEnsembleVetoBlocked = allOpportunities.filter((o) => o.blockedByEnsembleVeto).length;
  const allowedOpportunities = allOpportunities.filter(
    (o) => o.allowedByConfig && !o.blockedByMarketDisagreement && !o.blockedByEnsembleVeto,
  );
  logger.info('[weather] scan summary', {
    totalEvents: rawEvents.length,
    parsedEvents: parsedCount,
    dedupSkipped,
    sizeUpRescanned,
    earlyResolutionDayEntries,
    horizonSkipped,
    noForecast,
    eventsWithOpportunities,
    totalOpportunities: allOpportunities.length,
    allowedOpportunities: allowedOpportunities.length,
    sideFiltered: allOpportunities.filter((o) => !o.allowedByConfig).length,
    totalDisagreementBlocked,
    totalEnsembleVetoBlocked,
    tradeSidesMode: cfg.WEATHER_TRADE_SIDES,
    enabled: cfg.WEATHER_SCANNER_ENABLED,
  });

  // Return shadow-logged opportunities in edge-descending order. Callers that
  // execute must filter on `allowedByConfig`; the orchestrator below does so.
  allOpportunities.sort((a, b) => b.edge - a.edge);
  return allOpportunities;
}

/**
 * Build a TradeSignal for a weather bracket opportunity.
 *
 * Conventions (matching executor):
 *   - consensusProbability is P(YES). `opp.modelProbability` is already P(YES)
 *     regardless of tradeSide, so it is passed through unmodified. The executor
 *     flips to (1 - p) internally when direction is NO.
 *   - outcomePrice is side-relative (price of the side we are buying). `opp.outcomePrice`
 *     is already constructed that way.
 */
function buildWeatherSignal(opp: WeatherBracketOpportunity, stakeUsd: number): TradeSignal {
  // Compute the city-local resolution end time rather than using Gamma's endDate,
  // which is 24h late for UTC+ cities (HK, Taipei, etc.).
  const coords = lookupCity(opp.city);
  const correctEndDate = coords
    ? new Date(cityDayEndUtcMs(opp.targetDate, coords.tz)).toISOString()
    : (opp.endDate ?? undefined);
  return {
    marketId: opp.marketId,
    conditionId: opp.conditionId,
    clobTokenIds: opp.clobTokenIds,
    direction: opp.tradeSide,
    stakeUsd,
    edgeMagnitude: opp.edge,
    consensusProbability: opp.modelProbability,
    outcomePrice: opp.outcomePrice,
    question: opp.question,
    source: 'weather',
    sourcedFrom: `weather:${opp.city}:${opp.targetDate}:${opp.bracketLabel}`,
    reasoning: `Forecast high ${opp.forecastHigh.toFixed(1)}°, model P=${opp.modelProbability.toFixed(3)} vs market ${opp.outcomePrice.toFixed(3)}; ${opp.tradeSide} bracket "${opp.bracketLabel}" daysOut=${opp.daysOut}`,
    // Authorise a size-up of an already-held position ONLY when this opportunity
    // came from the resolution-day size-up re-evaluation (sizeUpScanOnly). On any
    // other (off-day) scan the executor must not top up a held bracket.
    ...(opp.sizeUpScanOnly === true ? { sizeUpSanctioned: true } : {}),
    _isResolutionDay: opp.isResolutionDay ?? false,
    ...(correctEndDate ? { endDate: correctEndDate } : {}),
  };
}

/**
 * Build the bracket-strategy opposite-side TradeSignal for a weather opportunity.
 * The primary signal bets on the model-favoured side; this leg rests on the other
 * side as a GTC maker at a wider discount. If both legs fill the position is a
 * guaranteed $1 payout (free arb). Neither leg requires the other to fill first.
 */
function buildBracketOppositeSignal(
  opp: WeatherBracketOpportunity,
  stakeUsd: number,
): TradeSignal | null {
  const oppositeDir: 'YES' | 'NO' = opp.tradeSide === 'YES' ? 'NO' : 'YES';
  // oppositePrice is the Gamma mid for the side we are NOT primarily trading.
  const oppositePrice = opp.tradeSide === 'YES' ? opp.noPrice : opp.yesPrice;
  // Bail if the opposite-side price is missing or degenerate — the scanner only
  // guards the primary side's price against < 0.005, not the opposite side's.
  if (!Number.isFinite(oppositePrice) || oppositePrice < 0.005) return null;
  const coords = lookupCity(opp.city);
  const correctEndDate = coords
    ? new Date(cityDayEndUtcMs(opp.targetDate, coords.tz)).toISOString()
    : (opp.endDate ?? undefined);
  return {
    marketId: opp.marketId,
    conditionId: opp.conditionId,
    clobTokenIds: opp.clobTokenIds,
    direction: oppositeDir,
    stakeUsd,
    edgeMagnitude: 0,
    consensusProbability: opp.modelProbability,
    outcomePrice: oppositePrice,
    question: opp.question,
    source: 'weather',
    sourcedFrom: `weather:${opp.city}:${opp.targetDate}:${opp.bracketLabel}`,
    reasoning: `Bracket opposite of ${opp.tradeSide}; primary edge=${opp.edge.toFixed(3)} daysOut=${opp.daysOut}`,
    _isBracketOpposite: true,
    _isResolutionDay: opp.isResolutionDay ?? false,
    ...(correctEndDate ? { endDate: correctEndDate } : {}),
  };
}

/**
 * Orchestrator: run a full weather scan cycle.
 *
 * Always shadow-logs. Real trades fire only when both `WEATHER_SCANNER_ENABLED`
 * and `WEATHER_EXECUTION_ENABLED` are true. The separation lets the scanner
 * live in shadow+side-filter mode while real execution stays dark.
 *
 * Execution caps (applied in order, sorted by edge desc):
 *   1. `WEATHER_MAX_POSITIONS_PER_SCAN` — total count across the scan
 *   2. `WEATHER_MAX_PER_CITY` — per-city count (brackets in one event are correlated)
 *   3. `WEATHER_MAX_SCAN_EXPOSURE_USD` — cumulative stake ceiling
 */
export async function runWeatherScan(redis: Redis, fetchFn?: FetchFn): Promise<void> {
  const cfg = loadConfig();

  // Lock-in scan protects existing positions independently of new-entry
  // scanning — run first so it fires regardless of scan state.
  await runWeatherLockInScan(redis);

  const opportunities = await scanWeatherMarkets(redis, fetchFn);

  // Forecast-invalidation scan runs AFTER scanWeatherMarkets so its Gamma call
  // does not trigger the shared 429 circuit breaker before the main scanner can
  // fetch events. Keys set here are checked by the execution loop below (same
  // cycle), so size-up blocking still applies within the current scan.
  await runWeatherInvalidationScan(redis, fetchFn);

  if (opportunities.length === 0) return;

  if (!cfg.WEATHER_SCANNER_ENABLED) {
    logger.info('[weather] scanner disabled — shadow-logged only', {
      opportunities: opportunities.length,
    });
    return;
  }

  // Cities excluded from execution while their bias recalibrates. Shadow
  // observations still flow so bias keeps converging in the background.
  // Entries are canonicalized via canonicalCityKey so aliases ("LA", "NYC",
  // "São Paulo") match the same way the rest of the pipeline does.
  const excludedCities = new Set<string>();
  for (const raw of (cfg.WEATHER_EXCLUDED_CITIES ?? '').split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const canonical = canonicalCityKey(trimmed) ?? trimmed.toLowerCase();
    if (!canonicalCityKey(trimmed)) {
      logger.warn('[weather] WEATHER_EXCLUDED_CITIES entry not recognised — using as-is', { entry: trimmed });
    }
    excludedCities.add(canonical);
  }

  // Filter by WEATHER_TRADE_SIDES, market-disagreement gate, ensemble-veto gate,
  // and excluded-city list. Excluded-city opps remain in shadow records so
  // calibration data stays clean.
  let tradable = opportunities.filter(
    (o) =>
      (o.sizeUpScanOnly || o.allowedByConfig) &&
      (o.sizeUpScanOnly || !o.blockedByMarketDisagreement) &&
      (o.sizeUpScanOnly || !o.blockedByEnsembleVeto) &&
      !excludedCities.has(o.city.toLowerCase()),
  );

  if (excludedCities.size > 0) {
    const suppressed = opportunities.filter(
      (o) => o.allowedByConfig && excludedCities.has(o.city.toLowerCase()),
    ).length;
    if (suppressed > 0) {
      logger.info('[weather] excluded cities suppressed tradable opportunities', {
        excludedCities: [...excludedCities],
        suppressed,
      });
    }
    const sizeUpSuppressed = opportunities.filter(
      (o) => o.sizeUpScanOnly && excludedCities.has(o.city.toLowerCase()),
    ).length;
    if (sizeUpSuppressed > 0) {
      logger.info('[weather] excluded cities blocked size-up on existing position', {
        excludedCities: [...excludedCities],
        sizeUpSuppressed,
      });
    }
  }
  if (tradable.length === 0) {
    logger.info('[weather] no tradable opportunities after side filter', {
      shadowOpportunities: opportunities.length,
      tradeSidesMode: cfg.WEATHER_TRADE_SIDES,
    });
    return;
  }

  // Max-lookahead gate: only enter markets resolving within WEATHER_MAX_LOOKAHEAD_HOURS.
  // Forecasts beyond 28h are too uncertain to trade — 1-day-out only.
  if (cfg.WEATHER_MAX_LOOKAHEAD_HOURS > 0) {
    const nowMs = Date.now();
    const before = tradable.length;
    tradable = tradable.filter((opp) => {
      if (opp.sizeUpScanOnly) return true; // size-ups bypass max-lookahead gate
      if (!opp.endDate) return true;
      const endMs = new Date(opp.endDate).getTime();
      if (!Number.isFinite(endMs)) return true;
      const hoursUntil = (endMs - nowMs) / (1000 * 60 * 60);
      const tooFarOut = hoursUntil > cfg.WEATHER_MAX_LOOKAHEAD_HOURS;
      if (tooFarOut) {
        logger.info('[weather] skipping — market too far out', {
          marketId: opp.marketId,
          city: opp.city,
          bracket: opp.bracketLabel,
          hoursUntil: hoursUntil.toFixed(1),
          maxLookaheadHours: cfg.WEATHER_MAX_LOOKAHEAD_HOURS,
          endDate: opp.endDate,
        });
      }
      return !tooFarOut;
    });
    if (tradable.length < before) {
      logger.info('[weather] max-lookahead gate filtered opportunities', {
        before,
        after: tradable.length,
        blocked: before - tradable.length,
        maxLookaheadHours: cfg.WEATHER_MAX_LOOKAHEAD_HOURS,
      });
    }
  }

  if (tradable.length === 0) {
    logger.info('[weather] no tradable opportunities after max-lookahead gate', {});
    return;
  }

  // Near-resolution entry gate applied to the tradable list so both shadow-mode
  // "would execute" logs and the live execution loop see the same filtered set.
  if (cfg.WEATHER_NEAR_RES_ENTRY_ENABLED) {
    const before = tradable.length;
    tradable = tradable.filter((opp) => {
      if (opp.sizeUpScanOnly) return true; // size-ups bypass near-res gate
      // Early resolution-day entries already passed the cityDayEndUtcMs time gate
      // (WEATHER_RES_DAY_MIN_HOURS_REMAINING). Gamma's endDate is set to noon UTC
      // which can be only a few hours away for western cities at 02:00-06:00 local,
      // causing a false positive here — the market is nowhere near closing for trading.
      if (opp.earlyResolutionDayEntry) return true;
      const eval_ = evaluateWeatherNearResEntry(
        opp.endDate ?? undefined,
        cfg.WEATHER_NEAR_RES_ENTRY_HOURS,
      );
      if (eval_.shouldSkip) {
        logger.info('[weather] skipping — within near-res entry window', {
          marketId: opp.marketId,
          city: opp.city,
          bracket: opp.bracketLabel,
          hoursLeft: eval_.hoursLeft.toFixed(1),
          threshold: cfg.WEATHER_NEAR_RES_ENTRY_HOURS,
          endDate: opp.endDate,
        });
      }
      return !eval_.shouldSkip;
    });
    if (tradable.length < before) {
      logger.info('[weather] near-res entry gate filtered opportunities', {
        before,
        after: tradable.length,
        blocked: before - tradable.length,
      });
    }
  }

  if (tradable.length === 0) {
    logger.info('[weather] no tradable opportunities after near-res entry gate', {});
    return;
  }

  // Kill-switch: when execution is off, preserve the pre-wire "would execute"
  // log line so shadow analysis keeps working and operators can see what *would*
  // have fired without any order placement.
  if (!cfg.WEATHER_EXECUTION_ENABLED) {
    for (const opp of tradable) {
      logger.info('[weather] would execute trade', {
        marketId: opp.marketId,
        eventSlug: opp.eventSlug,
        tradeSide: opp.tradeSide,
        edge: opp.edge.toFixed(3),
        modelProbability: opp.modelProbability.toFixed(3),
        outcomePrice: opp.outcomePrice.toFixed(3),
        city: opp.city,
        bracket: opp.bracketLabel,
        daysOut: opp.daysOut,
      });
    }
    return;
  }

  const bankrollUsd = await getBankroll(redis);
  if (bankrollUsd <= 0) {
    logger.warn('[weather] skipping execution — bankroll is zero', { bankrollUsd });
    return;
  }

  // Guard: WEATHER_MAX_STAKE_USD below MIN_BET_USD means the executor's floor-bump
  // would raise the stake above the configured ceiling (e.g. cap=$4, bump to $5).
  // Skip execution entirely rather than silently violate the hard cap.
  if (cfg.WEATHER_MAX_STAKE_USD > 0 && cfg.WEATHER_MAX_STAKE_USD < cfg.MIN_BET_USD) {
    logger.warn('[weather] WEATHER_MAX_STAKE_USD is below MIN_BET_USD — skipping execution to preserve hard cap', {
      WEATHER_MAX_STAKE_USD: cfg.WEATHER_MAX_STAKE_USD,
      MIN_BET_USD: cfg.MIN_BET_USD,
    });
    return;
  }

  const fractionCap = bankrollUsd * cfg.WEATHER_MAX_STAKE_FRACTION;
  const maxStakeCap = cfg.WEATHER_MAX_STAKE_USD > 0
    ? Math.min(fractionCap, cfg.WEATHER_MAX_STAKE_USD)
    : fractionCap;
  const perCityCount = new Map<string, number>();
  let executed = 0;
  let cumulativeStakeUsd = 0;
  // Set to true after any non-skipped execution (including size-ups) so the
  // next attempt can pause long enough for the global governor to reset.
  let needsGovernorPause = false;

  for (let i = 0; i < tradable.length; i++) {
    const opp = tradable[i]!;

    if (executed >= cfg.WEATHER_MAX_POSITIONS_PER_SCAN) {
      logger.info('[weather] per-scan count cap reached', {
        cap: cfg.WEATHER_MAX_POSITIONS_PER_SCAN,
        skippedRemaining: tradable.length - i,
      });
      break;
    }

    // Size-up scan: skip markets where we have no open position — the event-level
    // dedup was bypassed solely to allow top-ups, not fresh entries.
    if (opp.sizeUpScanOnly) {
      const held = await hasOpenPosition(redis, opp.marketId, opp.tradeSide);
      if (!held) {
        logger.debug('[weather] size-up scan: skipping — no open position', {
          marketId: opp.marketId,
          city: opp.city,
          bracket: opp.bracketLabel,
        });
        continue;
      }
      // Phase 3: block size-up when forecast invalidation has degraded the thesis.
      if (cfg.WEATHER_FORECAST_INVALIDATION_ENABLED) {
        const invalidKey = `${FORECAST_INVALIDATED_KEY_PREFIX}${opp.marketId}:${opp.tradeSide}`;
        const isInvalidated = (await redis.exists(invalidKey).catch(() => 0)) > 0;
        if (isInvalidated) {
          logger.info('[weather] size-up blocked by forecast invalidation', {
            marketId: opp.marketId,
            city: opp.city,
            bracket: opp.bracketLabel,
            tradeSide: opp.tradeSide,
          });
          continue;
        }
      }
    }

    const cityCount = perCityCount.get(opp.city) ?? 0;
    // Size-ups are additive to an existing position, not new city entries.
    if (!opp.sizeUpScanOnly && cityCount >= cfg.WEATHER_MAX_PER_CITY) {
      logger.info('[weather] per-city cap reached — skipping opp', {
        city: opp.city,
        cap: cfg.WEATHER_MAX_PER_CITY,
        marketId: opp.marketId,
      });
      continue;
    }

    // Half-Kelly sizing: use the win probability and price of the side we're buying.
    // For YES: p = P(YES) = modelProbability, price = yesPrice.
    // For NO:  p = P(NO)  = 1 - modelProbability, price = noPrice (= outcomePrice for NO).
    // opp.outcomePrice is already side-relative so it covers both.
    const winProb = opp.tradeSide === 'YES' ? opp.modelProbability : 1 - opp.modelProbability;
    const kellyFraction = computeHalfKelly(winProb, opp.outcomePrice, cfg.WEATHER_KELLY_FRACTION);
    if (kellyFraction <= 0) {
      logger.info('[weather] skipping — kelly non-positive', {
        marketId: opp.marketId,
        tradeSide: opp.tradeSide,
        winProb: winProb.toFixed(3),
        outcomePrice: opp.outcomePrice.toFixed(3),
      });
      continue;
    }
    const stakeUsd = Math.min(bankrollUsd * kellyFraction, maxStakeCap);
    // Gate on the worst-case filled amount: executor bumps stakes ≥60% of
    // MIN_BET_USD up to the floor, so the actual committed amount may be higher
    // than the Kelly-derived stakeUsd. Using max(stakeUsd, MIN_BET_USD) keeps
    // the exposure check tight even after the floor bump.
    const worstCaseStakeUsd = Math.max(stakeUsd, cfg.MIN_BET_USD);

    if (cumulativeStakeUsd + worstCaseStakeUsd > cfg.WEATHER_MAX_SCAN_EXPOSURE_USD) {
      logger.info('[weather] per-scan exposure cap would be exceeded — stopping', {
        cumulativeStakeUsd: cumulativeStakeUsd.toFixed(2),
        proposedStakeUsd: worstCaseStakeUsd.toFixed(2),
        cap: cfg.WEATHER_MAX_SCAN_EXPOSURE_USD,
      });
      break;
    }

    // Pause here — after all caps are checked so we only wait when an execution
    // is actually going to be attempted. Avoids burning scan time when caps
    // have already exhausted the remaining opportunities.
    if (needsGovernorPause) {
      const minIntervalMs = Math.ceil(60_000 / cfg.ARB_GLOBAL_MAX_TRADES_PER_MIN);
      await new Promise((r) => setTimeout(r, minIntervalMs + 200));
      needsGovernorPause = false;
    }

    const signal = buildWeatherSignal(opp, stakeUsd);
    try {
      const result = await executeAndRecordSignal(signal, redis);
      const filledStakeUsd = result.signal.stakeUsd;
      logger.info('[weather] execution result', {
        marketId: opp.marketId,
        eventSlug: opp.eventSlug,
        city: opp.city,
        bracket: opp.bracketLabel,
        tradeSide: opp.tradeSide,
        stakeUsd: filledStakeUsd.toFixed(2),
        edge: opp.edge.toFixed(3),
        skipped: result.skipped,
        skipReason: result.skipReason,
        executionVenue: result.executionVenue,
        entryPrice: result.entryPrice,
        sharesFilled: result.sharesFilled,
      });
      // `governorStamped` is true iff THIS call accepted a new Polymarket order
      // and stamped the shared global governor — including a fresh maker_pending
      // GTC (the executor stamps on order *acceptance*, not only on fill). It is
      // false for skips, and crucially for a resumed poll of an already-posted
      // pending order (which consumes no fresh rate-limit budget and was already
      // counted on the scan that first posted it). We rely on this explicit
      // signal rather than inferring from entryExecutionPath, because a fresh
      // post and a resumed poll share the same 'maker_pending' path string.
      //
      // Arm the pause whenever the governor was stamped — even on the CLOB
      // taker-failure path (which stamps before the buy, then errors), since the
      // rate-limit budget was still consumed. Previously maker_pending neither
      // armed the pause (so the next opp skipped on `global_governor` and the
      // whole scan cascaded) nor was bounded by the per-scan caps.
      if (result.governorStamped === true) {
        needsGovernorPause = true;
      }
      // Count toward per-scan caps/exposure only when a new order was actually
      // committed: governor stamped AND no error. The taker-failure path stamps
      // but errors (no position), so excluding errors keeps it from burning caps
      // or setting the active-event marker. Resumed polls have governorStamped
      // false and so are naturally excluded from re-counting across scans.
      const orderCommitted = result.governorStamped === true && !result.error;
      if (orderCommitted) {
        // Size-up determination: result.isSizeUp is only set by the executor on
        // a confirmed FILL, so a maker_pending size-up would read as undefined.
        // opp.sizeUpScanOnly is the scanner-side source of truth (size-ups only
        // reach execution via the size-up re-evaluation bypass), so prefer it.
        const isSizeUp = opp.sizeUpScanOnly === true || result.isSizeUp === true;
        // Per-city / per-scan COUNT caps track fresh new positions only.
        // Size-ups top up an existing position, so they consume exposure
        // budget but not a new-position slot.
        if (!isSizeUp) {
          executed++;
          perCityCount.set(opp.city, cityCount + 1);
        }
        // All committed orders — fills and resting maker GTCs, fresh entries and
        // size-ups — commit capital, so they all count toward per-scan exposure.
        cumulativeStakeUsd += filledStakeUsd;
      }

      // The cross-scan active-event marker tracks whether a position now exists
      // for this event, so it is set on any CONFIRMED fill — fresh OR resumed.
      // It is decoupled from `orderCommitted` (which gates per-scan caps on
      // governorStamped to avoid re-counting a resumed order): a maker GTC that
      // FILLS on a later resume cycle does not re-stamp the governor, but it IS
      // a real position and must still mark the event. Excludes maker_pending
      // (not yet a position — the reconciler records it on a later cycle, the
      // executor's per-market pending tracking prevents duplicate posts, and
      // leaving it unmarked preserves sibling-bracket entry and retry) and the
      // errored taker-failure path (no position opened). Refreshing on size-up
      // fills lets subsequent scans bypass dedup for further top-ups.
      // TTL must cover the full remaining horizon so the marker outlasts the
      // position. Use max(72h, (maxHorizonDays+1)*24h) to handle any config.
      const positionConfirmed =
        !result.skipped && !result.error && result.entryExecutionPath !== 'maker_pending';
      if (positionConfirmed) {
        const activeTtlS = Math.max(
          ACTIVE_EVENT_TTL_S,
          (cfg.WEATHER_MAX_HORIZON_DAYS + 1) * 24 * 3600,
        );
        await redis
          .set(`${ACTIVE_EVENT_KEY_PREFIX}${opp.eventSlug}`, '1', 'EX', activeTtlS)
          .catch(() => {});
      }
      // Bracket strategy: post opposite-side GTC at a wider maker discount.
      // Bracket stake: target the same share count as the primary so that
      // YES+NO together pay exactly $1 per pair regardless of which side resolves.
      // Use the executor's actual outputs rather than pre-executor inputs:
      //   - result.signal.stakeUsd reflects any MIN_BET_USD floor-bump
      //   - result.entryPrice is the real posted maker price (may differ from opp.outcomePrice)
      //   - result.sharesFilled is authoritative when the primary filled immediately
      const bracketOppositePrice = opp.tradeSide === 'YES' ? opp.noPrice : opp.yesPrice;
      const primaryStake = result.signal.stakeUsd;
      const primaryPrice = result.entryPrice ?? opp.outcomePrice;
      const primaryShares =
        result.sharesFilled != null
          ? result.sharesFilled
          : primaryPrice > 0 ? primaryStake / primaryPrice : 0;
      const bracketStakeUsd =
        primaryShares > 0 && bracketOppositePrice > 0
          ? primaryShares * bracketOppositePrice
          : primaryStake;
      const bracketWorstCase = Math.max(bracketStakeUsd, cfg.MIN_BET_USD);

      // Guards:
      //   - fresh entries only (not size-ups)
      //   - primary must have committed a new order (no bracket on skipped primaries)
      //   - primary must have been an empty/ghost-book entry: on real books the opposite
      //     token is efficiently priced and the bracket would pay up for the low-probability
      //     side without the structural sub-$1 cost guarantee
      //   - pre-resolution-day only: on resolution day one side has already collapsed in
      //     price (distressed sellers at 0.11) so the bracket becomes a tail bet, not the
      //     liquidity-provision mechanism it was designed to be
      if (
        cfg.WEATHER_BRACKET_ENABLED
        && !opp.sizeUpScanOnly
        && orderCommitted
        && result.wasEmptyBook === true
        && !opp.isResolutionDay
        && cumulativeStakeUsd + bracketWorstCase <= cfg.WEATHER_MAX_SCAN_EXPOSURE_USD
      ) {
        const bracketSignal = buildBracketOppositeSignal(opp, bracketStakeUsd);
        if (!bracketSignal) {
          logger.debug('[weather] bracket opposite skipped — opposite-side price degenerate', {
            marketId: opp.marketId, city: opp.city, bracket: opp.bracketLabel,
          });
        } else
        try {
          if (needsGovernorPause) {
            const minIntervalMs = Math.ceil(60_000 / cfg.ARB_GLOBAL_MAX_TRADES_PER_MIN);
            await new Promise((r) => setTimeout(r, minIntervalMs + 200));
            needsGovernorPause = false;
          }
          const bracketResult = await executeAndRecordSignal(bracketSignal, redis);
          logger.info('[weather] bracket opposite result', {
            marketId: opp.marketId,
            city: opp.city,
            bracket: opp.bracketLabel,
            oppositeSide: bracketSignal.direction,
            skipped: bracketResult.skipped,
            skipReason: bracketResult.skipReason,
            entryPrice: bracketResult.entryPrice,
          });
          if (bracketResult.governorStamped === true) needsGovernorPause = true;
          if (bracketResult.governorStamped === true && !bracketResult.error) {
            cumulativeStakeUsd += bracketWorstCase;
          }
        } catch (err) {
          logger.warn('[weather] bracket opposite execution threw', {
            marketId: opp.marketId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.error('[weather] execution threw', {
        marketId: opp.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('[weather] execution cycle complete', {
    executed,
    cumulativeStakeUsd: cumulativeStakeUsd.toFixed(2),
    tradableOpportunities: tradable.length,
  });
}

// ── Standalone entrypoint (cron) ──────────────────────────────────────────

async function main() {
  const { getRedis, closeRedis } = await import('../shared/redis.js');
  const redis = getRedis();
  try {
    await runWeatherScan(redis);
  } finally {
    await closeRedis();
  }
}

const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/weatherScanner.js') === true;

if (isMainModule) {
  void main().catch((err: unknown) => {
    logger.error('[weather] fatal error', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
