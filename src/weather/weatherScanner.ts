/**
 * Weather Bracket Market Scanner
 *
 * Discovers Polymarket weather bracket events via Gamma API (tag_slug=temperature),
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
import {
  lookupCity,
  fetchNwsForecast,
  estimateBracketProbability,
  getDefaultStdDev,
} from './noaaClient.js';
import type { CityCoordinates, FetchFn } from './noaaClient.js';
import { fetchOpenMeteoForecast, fetchEnsembleForecast } from './openMeteoClient.js';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const GAMMA_TIMEOUT_MS = 15_000;
const DEDUP_KEY_PREFIX = 'weather:event:';

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
 * Fetch active weather events from Gamma API using tag_slug=temperature.
 * Orders by liquidity descending so we evaluate the most-traded events first.
 * Includes a 429 circuit breaker to avoid compounding rate limits.
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
    tag_slug: 'temperature',
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
    city: cityRaw,
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

      // Use max of ensemble stddev and source disagreement
      const disagreement = Math.abs(noaaHigh - omForecast.highTemp) / 1.5;
      const ensStd = ensemble?.stddevHigh ?? 0;
      const stdDev = Math.max(ensStd, disagreement, defaultStd * 0.7);
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

    const stdDev = ensemble?.stddevHigh ?? defaultStd;
    return { forecastHigh, stdDev, source, ensembleMembers: ensemble?.memberCount ?? 0 };
  }

  // International city: Open-Meteo only
  const omForecast = await fetchOpenMeteoForecast(coords.lat, coords.lon, targetDate, unit, fetchFn);
  if (!omForecast) return null;

  const stdDev = ensemble?.stddevHigh ?? defaultStd;
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
 */
export function findMispricedBrackets(
  event: ParsedWeatherEvent,
  forecast: ForecastResult,
  daysOut: number,
  minEdge: number,
): WeatherBracketOpportunity[] {
  const opportunities: WeatherBracketOpportunity[] = [];

  // Compute model probability for each bracket
  const modelProbs: number[] = [];
  for (const bracket of event.brackets) {
    const prob = estimateBracketProbability(
      forecast.forecastHigh,
      bracket.low,
      bracket.high,
      daysOut,
      forecast.stdDev,
    );
    modelProbs.push(prob);
  }

  // Sum-to-one diagnostic: model probs should sum to ~1.0
  const modelSum = modelProbs.reduce((s, p) => s + p, 0);
  if (Math.abs(modelSum - 1.0) > 0.01) {
    logger.warn('[weather] model probabilities do not sum to 1', {
      city: event.city,
      targetDate: event.targetDate,
      modelSum: modelSum.toFixed(4),
    });
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
    });
  }

  return opportunities;
}

// ── Main scanner ─────────────────────────────────────────────────────────

/**
 * Scan Polymarket for weather bracket events and find mispriced brackets.
 *
 * Steps:
 *   1. Discover weather events via Gamma API (tag_slug=temperature)
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
    const forecast = await fetchForecast(event, daysOut, fetchFn);
    if (!forecast) {
      noForecast++;
      continue;
    }

    // Step 4: Find mispriced brackets
    const opportunities = findMispricedBrackets(event, forecast, daysOut, cfg.WEATHER_MIN_EDGE);

    // Step 6: Shadow-log every evaluated event
    const overround = event.brackets.reduce((s, b) => s + b.yesPrice, 0);
    const bestEdge = opportunities.length > 0
      ? Math.max(...opportunities.map((o) => o.edge))
      : 0;

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
      forecastSource: forecast.source,
      ensembleMembers: forecast.ensembleMembers,
      overround: overround.toFixed(3),
      opportunitiesFound: opportunities.length,
      bestEdge: bestEdge.toFixed(3),
      enabled: cfg.WEATHER_SCANNER_ENABLED,
    });
    void enqueueWrite('shadow_observations', {
      kind: 'weather_event',
      source: 'arb',
      wouldBlock: opportunities.length === 0,
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
        forecastSource: forecast.source,
        ensembleMembers: forecast.ensembleMembers,
        overround,
        opportunitiesFound: opportunities.length,
        enabled: cfg.WEATHER_SCANNER_ENABLED,
      },
    });

    // Log each opportunity individually for shadow analysis
    for (const opp of opportunities) {
      const wouldTrade = cfg.WEATHER_SCANNER_ENABLED;
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

  logger.info('[weather] scan summary', {
    totalEvents: rawEvents.length,
    parsedEvents: parsedCount,
    dedupSkipped,
    horizonSkipped,
    noForecast,
    eventsWithOpportunities,
    totalOpportunities: allOpportunities.length,
    enabled: cfg.WEATHER_SCANNER_ENABLED,
  });

  // Sort by edge descending
  allOpportunities.sort((a, b) => b.edge - a.edge);
  return allOpportunities;
}

/**
 * Orchestrator: run a full weather scan cycle.
 *
 * Always shadow-logs. Only executes trades when WEATHER_SCANNER_ENABLED=true.
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

  // Execution will be wired in a follow-up PR.
  for (const opp of opportunities) {
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
