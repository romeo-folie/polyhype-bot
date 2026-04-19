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
import type { GammaMarket } from '../mapping/gamma.js';
import { parseOutcomePrices, parseClobTokenIds } from '../mapping/gamma.js';
import { computeHalfKelly } from '../mapping/divergenceCalculator.js';
import { executeAndRecordSignal } from '../execution/executor.js';
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
import { fetchOpenMeteoForecast, fetchEnsembleForecast } from './openMeteoClient.js';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const GAMMA_TIMEOUT_MS = 15_000;
const DEDUP_KEY_PREFIX = 'weather:event:';

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
  source: 'noaa' | 'open-meteo' | 'combined';
  /** Number of ensemble members (0 if no ensemble data). */
  ensembleMembers: number;
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
): Promise<ForecastResult | null> {
  const { coords, targetDate, unit } = event;
  const month = parseInt(targetDate.slice(5, 7), 10);

  // Default stddev for this unit — Celsius stddev is ~5/9 of Fahrenheit
  let defaultStd = getDefaultStdDev(daysOut, month);
  if (unit === 'celsius') {
    defaultStd = defaultStd * 5 / 9;
  }

  // Try ensemble first (works for both US and international)
  const ensemble = await fetchEnsembleForecast(
    coords.lat, coords.lon, targetDate, unit, fetchFn,
  );

  if (coords.noaaCoverage) {
    // US city: use NOAA as primary, combine with Open-Meteo
    const noaaForecast = await fetchNwsForecast(coords.lat, coords.lon, targetDate, fetchFn);
    const omForecast = await fetchOpenMeteoForecast(coords.lat, coords.lon, targetDate, unit, fetchFn);

    if (!noaaForecast && !omForecast) return null;

    let forecastHigh: number;
    let source: 'noaa' | 'open-meteo' | 'combined';

    if (noaaForecast && omForecast) {
      // Convert NOAA to event unit if needed
      const noaaHigh = unit === 'celsius'
        ? (noaaForecast.highF - 32) * 5 / 9
        : noaaForecast.highF;
      // Simple average of two sources
      forecastHigh = (noaaHigh + omForecast.highTemp) / 2;
      source = 'combined';

      // Use max of ensemble stddev and source disagreement; floor at fraction of climatology.
      const disagreement = Math.abs(noaaHigh - omForecast.highTemp) / 1.5;
      const ensStd = ensemble?.stddevHigh ?? 0;
      const stdDev = Math.max(ensStd, disagreement, defaultStd * stddevMinFraction);
      return { forecastHigh, stdDev, source, ensembleMembers: ensemble?.memberCount ?? 0 };
    }

    if (noaaForecast) {
      forecastHigh = unit === 'celsius'
        ? (noaaForecast.highF - 32) * 5 / 9
        : noaaForecast.highF;
      source = 'noaa';
    } else {
      forecastHigh = omForecast!.highTemp;
      source = 'open-meteo';
    }

    const stdDev = Math.max(ensemble?.stddevHigh ?? defaultStd, defaultStd * stddevMinFraction);
    return { forecastHigh, stdDev, source, ensembleMembers: ensemble?.memberCount ?? 0 };
  }

  // International city: Open-Meteo only
  const omForecast = await fetchOpenMeteoForecast(coords.lat, coords.lon, targetDate, unit, fetchFn);
  if (!omForecast) return null;

  const stdDev = Math.max(ensemble?.stddevHigh ?? defaultStd, defaultStd * stddevMinFraction);
  return {
    forecastHigh: omForecast.highTemp,
    stdDev,
    source: 'open-meteo',
    ensembleMembers: ensemble?.memberCount ?? 0,
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
}

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
}

export function findMispricedBrackets(
  event: ParsedWeatherEvent,
  forecast: ForecastResult,
  daysOut: number,
  minEdge: number,
  stddevMultiplier = 1.0,
  minModelCoverage = 0.95,
  allowedSides: ReadonlySet<'YES' | 'NO'> = new Set(['YES', 'NO']),
): FindMispricedResult {
  const opportunities: WeatherBracketOpportunity[] = [];

  // Effective stddev after calibration multiplier. Multiplier > 1 broadens the
  // distribution (less mass on central bracket, more on adjacent), which is
  // what we'd reach for if shadow analysis shows modelProb is over-confident
  // in the exact forecast point.
  const effectiveStdDev = forecast.stdDev * stddevMultiplier;

  // Compute model probability for each bracket
  const modelProbs: number[] = [];
  for (const bracket of event.brackets) {
    const prob = estimateBracketProbability(
      forecast.forecastHigh,
      bracket.low,
      bracket.high,
      daysOut,
      effectiveStdDev,
    );
    modelProbs.push(prob);
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
    return { opportunities: [], modelSum };
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

    let tradeSide: 'YES' | 'NO';
    let edge: number;

    if (edgeYes >= edgeNo && edgeYes > 0) {
      tradeSide = 'YES';
      edge = edgeYes;
    } else if (edgeNo > 0) {
      tradeSide = 'NO';
      edge = edgeNo;
    } else {
      continue; // No positive edge on either side
    }

    if (edge < minEdge) continue;

    // Skip near-zero markets where liquidity is negligible
    if (bracket.yesPrice < 0.005 && tradeSide === 'YES') continue;
    if (bracket.noPrice < 0.005 && tradeSide === 'NO') continue;

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
      forecastHigh: forecast.forecastHigh,
      forecastStdDev: forecast.stdDev,
      forecastSource: forecast.source,
      ensembleMembers: forecast.ensembleMembers,
      daysOut,
      unit: event.unit,
      overround,
      allowedByConfig: allowedSides.has(tradeSide),
    });
  }

  return { opportunities, modelSum };
}

// ── Main scanner ─────────────────────────────────────────────────────────

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

  // Hoisted out of the per-event loop — the mode is a static config read, so
  // reparsing per event is wasted work and makes the read point less obvious.
  const allowedSides = parseAllowedSides(cfg.WEATHER_TRADE_SIDES);

  let parsedCount = 0;
  let dedupSkipped = 0;
  let noForecast = 0;
  let horizonSkipped = 0;
  let eventsWithOpportunities = 0;

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
    if (daysOut === 0) continue; // Already resolved or resolving today

    // Step 5: Dedup by event slug (covers all brackets in the event)
    const dedupKey = `${DEDUP_KEY_PREFIX}${event.slug}`;
    const claimed = await redis.set(dedupKey, '1', 'EX', cfg.WEATHER_DEDUP_TTL_S, 'NX');
    if (!claimed) {
      dedupSkipped++;
      continue;
    }

    // Step 3: Fetch forecast
    const forecast = await fetchForecast(event, daysOut, fetchFn, cfg.WEATHER_STDDEV_MIN_FRACTION);
    if (!forecast) {
      noForecast++;
      continue;
    }

    // Step 4: Find mispriced brackets (coverage guard inside; returns empty opportunities
    // when bracket data is incomplete — e.g. late-day thinning from 11 → 4 brackets).
    // modelSum is returned by findMispricedBrackets so shadow logging reuses the exact
    // values used for gating rather than recomputing them.
    const { opportunities, modelSum } = findMispricedBrackets(
      event,
      forecast,
      daysOut,
      cfg.WEATHER_MIN_EDGE,
      cfg.WEATHER_STDDEV_MULTIPLIER,
      cfg.WEATHER_MIN_MODEL_COVERAGE,
      allowedSides,
    );
    const effectiveStdDev = forecast.stdDev * cfg.WEATHER_STDDEV_MULTIPLIER;
    const coverageStatus = modelSum >= cfg.WEATHER_MIN_MODEL_COVERAGE ? 'ok' : 'skipped_low_coverage';

    // Step 6: Shadow-log every evaluated event
    const overround = event.brackets.reduce((s, b) => s + b.yesPrice, 0);
    const bestEdge = opportunities.length > 0
      ? Math.max(...opportunities.map((o) => o.edge))
      : 0;
    const allowedInEvent = opportunities.filter((o) => o.allowedByConfig).length;

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
      overround: overround.toFixed(3),
      modelSum: modelSum.toFixed(4),
      coverageStatus,
      opportunitiesFound: opportunities.length,
      allowedInEvent,
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
        opportunities.length === 0 ||
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
        overround,
        modelSum: parseFloat(modelSum.toFixed(4)),
        status: coverageStatus,
        opportunitiesFound: opportunities.length,
        allowedInEvent,
        tradeSidesMode: cfg.WEATHER_TRADE_SIDES,
        scannerEnabled: cfg.WEATHER_SCANNER_ENABLED,
      },
    });

    // Log each opportunity individually for shadow analysis.
    // Shadow still records disallowed-side opps so calibration analysis keeps
    // accruing validation data for the gated side — only wouldTrade flips.
    for (const opp of opportunities) {
      const wouldTrade = cfg.WEATHER_SCANNER_ENABLED && opp.allowedByConfig;
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
        daysOut: opp.daysOut,
        tradeSidesMode: cfg.WEATHER_TRADE_SIDES,
        allowedByConfig: opp.allowedByConfig,
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
          effectiveStdDev: opp.forecastStdDev * cfg.WEATHER_STDDEV_MULTIPLIER,
          stddevMultiplier: cfg.WEATHER_STDDEV_MULTIPLIER,
          tradeSidesMode: cfg.WEATHER_TRADE_SIDES,
          allowedByConfig: opp.allowedByConfig,
          daysOut: opp.daysOut,
          wouldTrade,
        },
      });
    }

    if (opportunities.length > 0) {
      eventsWithOpportunities++;
      allOpportunities.push(...opportunities);
    }
  }

  const allowedOpportunities = allOpportunities.filter((o) => o.allowedByConfig);
  logger.info('[weather] scan summary', {
    totalEvents: rawEvents.length,
    parsedEvents: parsedCount,
    dedupSkipped,
    horizonSkipped,
    noForecast,
    eventsWithOpportunities,
    totalOpportunities: allOpportunities.length,
    allowedOpportunities: allowedOpportunities.length,
    sideFiltered: allOpportunities.length - allowedOpportunities.length,
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

  const opportunities = await scanWeatherMarkets(redis, fetchFn);

  if (opportunities.length === 0) return;

  if (!cfg.WEATHER_SCANNER_ENABLED) {
    logger.info('[weather] scanner disabled — shadow-logged only', {
      opportunities: opportunities.length,
    });
    return;
  }

  // Filter by WEATHER_TRADE_SIDES. Opportunities on gated sides are shadow-only.
  const tradable = opportunities.filter((o) => o.allowedByConfig);
  if (tradable.length === 0) {
    logger.info('[weather] no tradable opportunities after side filter', {
      shadowOpportunities: opportunities.length,
      tradeSidesMode: cfg.WEATHER_TRADE_SIDES,
    });
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

  const maxStakeCap = bankrollUsd * cfg.WEATHER_MAX_STAKE_FRACTION;
  const perCityCount = new Map<string, number>();
  let executed = 0;
  let cumulativeStakeUsd = 0;

  for (const opp of tradable) {
    if (executed >= cfg.WEATHER_MAX_POSITIONS_PER_SCAN) {
      logger.info('[weather] per-scan count cap reached', {
        cap: cfg.WEATHER_MAX_POSITIONS_PER_SCAN,
        skippedRemaining: tradable.length - (tradable.indexOf(opp)),
      });
      break;
    }

    const cityCount = perCityCount.get(opp.city) ?? 0;
    if (cityCount >= cfg.WEATHER_MAX_PER_CITY) {
      logger.info('[weather] per-city cap reached — skipping opp', {
        city: opp.city,
        cap: cfg.WEATHER_MAX_PER_CITY,
        marketId: opp.marketId,
      });
      continue;
    }

    // Half-Kelly on P(YES)/yesPrice — computeHalfKelly expects YES-convention
    // inputs and returns a non-negative fraction. Cap at WEATHER_MAX_STAKE_FRACTION.
    const kellyFraction = computeHalfKelly(
      opp.modelProbability,
      opp.yesPrice,
      cfg.WEATHER_KELLY_FRACTION,
    );
    if (kellyFraction <= 0) {
      logger.info('[weather] skipping — kelly non-positive', {
        marketId: opp.marketId,
        modelProb: opp.modelProbability.toFixed(3),
        yesPrice: opp.yesPrice.toFixed(3),
      });
      continue;
    }
    const stakeUsd = Math.min(bankrollUsd * kellyFraction, maxStakeCap);

    if (cumulativeStakeUsd + stakeUsd > cfg.WEATHER_MAX_SCAN_EXPOSURE_USD) {
      logger.info('[weather] per-scan exposure cap would be exceeded — stopping', {
        cumulativeStakeUsd: cumulativeStakeUsd.toFixed(2),
        proposedStakeUsd: stakeUsd.toFixed(2),
        cap: cfg.WEATHER_MAX_SCAN_EXPOSURE_USD,
      });
      break;
    }

    const signal = buildWeatherSignal(opp, stakeUsd);
    try {
      const result = await executeAndRecordSignal(signal, redis);
      executed++;
      perCityCount.set(opp.city, cityCount + 1);
      cumulativeStakeUsd += stakeUsd;
      logger.info('[weather] execution result', {
        marketId: opp.marketId,
        eventSlug: opp.eventSlug,
        city: opp.city,
        bracket: opp.bracketLabel,
        tradeSide: opp.tradeSide,
        stakeUsd: stakeUsd.toFixed(2),
        edge: opp.edge.toFixed(3),
        skipped: result.skipped,
        skipReason: result.skipReason,
        executionVenue: result.executionVenue,
        entryPrice: result.entryPrice,
        sharesFilled: result.sharesFilled,
      });
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
