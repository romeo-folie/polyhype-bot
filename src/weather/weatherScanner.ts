/**
 * Weather Market Scanner
 *
 * Discovers Polymarket weather markets via Gamma API, fetches NOAA forecasts,
 * and computes edge by comparing forecast probability against market price.
 *
 * Weather markets are typically structured as:
 *   "Will the high temperature in [city] exceed X°F on [date]?"
 *   "Will it rain in [city] on [date]?"
 *
 * Edge source: NOAA/GFS ensemble forecasts updated every 6h vs Polymarket
 * prices that reprice slowly. Research shows weather markets are overconfident
 * at short horizons (theta=0.69) — the sell side is structurally favoured for
 * <48h markets.
 *
 * Ships dark (WEATHER_SCANNER_ENABLED=false). Shadow-log all found
 * opportunities regardless of enabled state.
 *
 * Log marker: [weather]
 * Dedup key:  weather:attempted:{marketId}  (TTL: WEATHER_DEDUP_TTL_S)
 */

import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { searchEvents, parseOutcomePrices, parseClobTokenIds } from '../mapping/gamma.js';
import type { GammaMarket } from '../mapping/gamma.js';
import {
  lookupCity,
  fetchGfsEnsembleForecast,
  estimateExceedanceProbability,
} from './noaaClient.js';
import type { FetchFn } from './noaaClient.js';

const DEDUP_KEY_PREFIX = 'weather:attempted:';

// ── Question parsing ───────────────────────────────────────────────────────

export interface ParsedWeatherQuestion {
  /** Extracted city name (lowercased). */
  city: string;
  /** Temperature threshold in Fahrenheit. */
  tempThresholdF: number;
  /** Target date as YYYY-MM-DD. */
  targetDate: string;
  /** Whether the market asks about exceeding (over) or staying below (under). */
  direction: 'over' | 'under';
  /** Whether this is about high temperature or low temperature. */
  metric: 'high' | 'low';
}

/**
 * Known city names for extraction, sorted longest-first so "New York City"
 * matches before "New York".
 */
const KNOWN_CITIES = [
  'new york city', 'new york', 'nyc', 'los angeles', 'la', 'chicago',
  'miami', 'houston', 'phoenix', 'philadelphia', 'san antonio', 'san diego',
  'dallas', 'denver', 'seattle', 'boston', 'atlanta', 'las vegas', 'portland',
  'detroit', 'minneapolis', 'washington dc', 'washington', 'san francisco',
  'london', 'paris', 'tokyo',
].sort((a, b) => b.length - a.length);

// Patterns for extracting temperature threshold:
// "exceed 80°F", "above 80°F", "reach 80°F", "over 80 degrees", "below 32°F"
const TEMP_PATTERNS = [
  // "exceed/above/over/reach N°F" or "exceed/above/over/reach N degrees"
  /(?:exceed|above|over|reach|surpass|hit)\s+(\d+(?:\.\d+)?)\s*(?:°\s*F|degrees?\s*(?:F|fahrenheit)?)/i,
  // "high temperature ... N°F"
  /(?:high\s+)?temperature\s+(?:in\s+\w+\s+)?(?:exceed|above|over|reach)\s+(\d+(?:\.\d+)?)\s*(?:°\s*F|degrees?)/i,
  // "below/under N°F" (for under direction)
  /(?:below|under|drop\s+below|fall\s+below)\s+(\d+(?:\.\d+)?)\s*(?:°\s*F|degrees?\s*(?:F|fahrenheit)?)/i,
  // Bare "N°F" near keywords
  /(\d+(?:\.\d+)?)\s*(?:°\s*F|degrees?\s*F)/i,
];

// Direction detection
const OVER_KEYWORDS = /\b(?:exceed|above|over|reach|surpass|hit|higher\s+than|more\s+than|at\s+least)\b/i;
const UNDER_KEYWORDS = /\b(?:below|under|drop\s+below|fall\s+below|lower\s+than|less\s+than|at\s+most)\b/i;

// High vs low temperature detection
const LOW_TEMP_KEYWORDS = /\b(?:low\s+temperature|overnight\s+low|minimum\s+temperature|nightly\s+low)\b/i;

// Date extraction patterns
const DATE_PATTERNS = [
  // "on April 15" / "on April 15, 2026"
  /\bon\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s*(\d{4}))?\b/i,
  // "on 04/15/2026" or "on 2026-04-15"
  /\bon\s+(\d{4})-(\d{2})-(\d{2})\b/,
  /\bon\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
  // "April 15" anywhere
  /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s*(\d{4}))?/i,
];

const MONTH_MAP: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4,
  may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
};

/**
 * Parse a Polymarket weather question into structured fields.
 * Returns null if the question cannot be parsed.
 */
export function parseWeatherQuestion(question: string): ParsedWeatherQuestion | null {
  const q = question.trim();

  // Extract city
  const qLower = q.toLowerCase();
  let city: string | null = null;
  for (const c of KNOWN_CITIES) {
    if (qLower.includes(c)) {
      city = c;
      break;
    }
  }
  if (!city) return null;

  // Extract temperature
  let tempThresholdF: number | null = null;
  for (const pattern of TEMP_PATTERNS) {
    const match = q.match(pattern);
    if (match?.[1]) {
      tempThresholdF = parseFloat(match[1]);
      if (isFinite(tempThresholdF)) break;
      tempThresholdF = null;
    }
  }
  if (tempThresholdF === null) return null;

  // Detect direction
  const hasOver = OVER_KEYWORDS.test(q);
  const hasUnder = UNDER_KEYWORDS.test(q);
  const direction: 'over' | 'under' = hasUnder && !hasOver ? 'under' : 'over';

  // Detect metric (high vs low temperature)
  const metric: 'high' | 'low' = LOW_TEMP_KEYWORDS.test(q) ? 'low' : 'high';

  // Extract date
  let targetDate: string | null = null;
  for (const pattern of DATE_PATTERNS) {
    const match = q.match(pattern);
    if (!match) continue;

    // ISO format: 2026-04-15
    if (match[1] && match[2] && match[3] && /^\d{4}$/.test(match[1])) {
      targetDate = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
      break;
    }

    // US format: MM/DD/YYYY (match[1] must be numeric to distinguish from named months)
    if (match[1] && match[2] && match[3] && /^\d{4}$/.test(match[3]) && /^\d{1,2}$/.test(match[1])) {
      targetDate = `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
      break;
    }

    // Named month: "April 15" or "April 15, 2026"
    if (match[1] && match[2]) {
      const monthNum = MONTH_MAP[match[1].toLowerCase()];
      if (monthNum) {
        const year = match[3] ? parseInt(match[3], 10) : new Date().getFullYear();
        targetDate = `${year.toString()}-${monthNum.toString().padStart(2, '0')}-${match[2].padStart(2, '0')}`;
        break;
      }
    }
  }
  if (!targetDate) return null;

  return { city, tempThresholdF, targetDate, direction, metric };
}

// ── Edge computation ───────────────────────────────────────────────────────

export interface WeatherOpportunity {
  marketId: string;
  conditionId: string;
  question: string;
  clobTokenIds: string[];
  /** Market YES price. */
  marketPrice: number;
  /** Our forecast probability of the YES outcome. */
  forecastProbability: number;
  /** Edge = forecastProbability - marketPrice (positive = market underpriced). */
  edge: number;
  /** Which side to trade: YES (buy YES) or NO (buy NO). */
  tradeSide: 'YES' | 'NO';
  /** Parsed question fields. */
  parsed: ParsedWeatherQuestion;
  /** Days until the target date. */
  daysOut: number;
  /** Forecast details. */
  forecastHighF: number;
  forecastLowF: number;
}

/**
 * Compute the days between now and a target date string (YYYY-MM-DD).
 */
export function daysUntil(targetDate: string, now?: Date): number {
  const target = new Date(targetDate + 'T12:00:00Z');
  const current = now ?? new Date();
  const diffMs = target.getTime() - current.getTime();
  return Math.max(0, Math.round(diffMs / (24 * 60 * 60 * 1000)));
}

// ── Scanner ────────────────────────────────────────────────────────────────

/**
 * Scan Polymarket for weather markets and compute edge against NOAA forecasts.
 *
 * Steps:
 *   1. Discover weather markets via Gamma API (search "weather" + "temperature")
 *   2. Parse each question to extract city, threshold, date, direction
 *   3. Fetch NOAA forecast for the city + date
 *   4. Compute edge: forecast probability vs market price
 *   5. Dedup via Redis
 *   6. Shadow-log all opportunities
 *
 * Always shadow-logs, regardless of WEATHER_SCANNER_ENABLED.
 */
export async function scanWeatherMarkets(
  redis: Redis,
  fetchFn?: FetchFn,
): Promise<WeatherOpportunity[]> {
  const cfg = loadConfig();
  const opportunities: WeatherOpportunity[] = [];

  // Step 1: Discover weather markets
  let markets: GammaMarket[] = [];
  try {
    const [weatherEvents, tempEvents] = await Promise.all([
      searchEvents({ query: 'weather', limit: cfg.WEATHER_MAX_MARKETS }),
      searchEvents({ query: 'temperature', limit: cfg.WEATHER_MAX_MARKETS }),
    ]);

    // Flatten events into markets, dedup by market ID
    const seen = new Set<string>();
    for (const event of [...weatherEvents, ...tempEvents]) {
      for (const market of event.markets) {
        if (!market.active || market.closed) continue;
        if (seen.has(market.id)) continue;
        seen.add(market.id);
        markets.push(market);
      }
    }
  } catch (err) {
    logger.warn('[weather] Gamma API search failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (markets.length === 0) {
    logger.debug('[weather] no weather markets found on Gamma');
    return [];
  }

  // Cap to max
  markets = markets.slice(0, cfg.WEATHER_MAX_MARKETS);

  let parsed = 0;
  let dedupSkipped = 0;
  let noForecast = 0;
  let noUsCity = 0;

  for (const market of markets) {
    // Step 2: Parse the question
    const question = parseWeatherQuestion(market.question);
    if (!question) continue;
    parsed++;

    // Check NOAA coverage
    const coords = lookupCity(question.city);
    if (!coords?.noaaCoverage) {
      noUsCity++;
      continue;
    }

    // Step 5: Dedup check
    const dedupKey = `${DEDUP_KEY_PREFIX}${market.id}`;
    const exists = await redis.get(dedupKey);
    if (exists) {
      dedupSkipped++;
      continue;
    }

    // Step 3: Fetch NOAA forecast
    const forecast = await fetchGfsEnsembleForecast(
      coords.lat,
      coords.lon,
      question.targetDate,
      fetchFn,
    );
    if (!forecast) {
      noForecast++;
      continue;
    }

    // Step 4: Compute edge
    const relevantTemp =
      question.metric === 'high' ? forecast.highF : forecast.lowF;
    const daysOut = daysUntil(question.targetDate);

    // Probability that the actual temperature exceeds the threshold
    const pExceed = estimateExceedanceProbability(
      relevantTemp,
      question.tempThresholdF,
      daysOut,
    );

    // Market price
    let yesPrice: number;
    try {
      const prices = parseOutcomePrices(market.outcomePrices);
      const raw = prices[0];
      if (raw === undefined) continue;
      yesPrice = parseFloat(raw);
      if (!isFinite(yesPrice)) continue;
    } catch {
      continue;
    }

    // If market asks "over", YES = temperature exceeds threshold
    // If market asks "under", YES = temperature stays below threshold
    let forecastPYes: number;
    if (question.direction === 'over') {
      forecastPYes = pExceed;
    } else {
      forecastPYes = 1 - pExceed;
    }

    // Determine which side has edge
    // edgeYes = forecastPYes - yesPrice, edgeNo = -(edgeYes)
    const edgeYes = forecastPYes - yesPrice;

    let tradeSide: 'YES' | 'NO';
    let edge: number;
    if (edgeYes >= 0) {
      tradeSide = 'YES';
      edge = edgeYes;
    } else {
      tradeSide = 'NO';
      edge = -edgeYes;
    }

    // Mark dedup before logging
    await redis.set(dedupKey, '1', 'EX', cfg.WEATHER_DEDUP_TTL_S);

    let clobTokenIds: string[];
    try {
      clobTokenIds = parseClobTokenIds(market.clobTokenIds);
    } catch {
      continue;
    }

    const opp: WeatherOpportunity = {
      marketId: market.id,
      conditionId: market.conditionId,
      question: market.question,
      clobTokenIds,
      marketPrice: yesPrice,
      forecastProbability: forecastPYes,
      edge,
      tradeSide,
      parsed: question,
      daysOut,
      forecastHighF: forecast.highF,
      forecastLowF: forecast.lowF,
    };

    // Step 6: Shadow-log every opportunity
    const meetsEdge = edge >= cfg.WEATHER_MIN_EDGE;
    const wouldTrade = cfg.WEATHER_SCANNER_ENABLED && meetsEdge;

    logger.info('[weather] opportunity evaluated', {
      marketId: market.id,
      question: market.question.slice(0, 120),
      city: question.city,
      tempThreshold: question.tempThresholdF,
      direction: question.direction,
      metric: question.metric,
      targetDate: question.targetDate,
      daysOut,
      forecastTemp: relevantTemp,
      forecastPYes: forecastPYes.toFixed(3),
      marketYesPrice: yesPrice.toFixed(3),
      edge: edge.toFixed(3),
      tradeSide,
      meetsEdge,
      wouldTrade,
      enabled: cfg.WEATHER_SCANNER_ENABLED,
    });

    if (meetsEdge) {
      opportunities.push(opp);
    }
  }

  logger.info('[weather] scan summary', {
    totalMarkets: markets.length,
    parsedQuestions: parsed,
    dedupSkipped,
    noUsCity,
    noForecast,
    opportunitiesFound: opportunities.length,
    enabled: cfg.WEATHER_SCANNER_ENABLED,
  });

  return opportunities;
}

/**
 * Orchestrator: run a full weather scan cycle.
 *
 * Always shadow-logs. Only executes trades when WEATHER_SCANNER_ENABLED=true.
 * Follows the same pattern as the near-zero scanner and NegRisk scanner.
 */
export async function runWeatherScan(redis: Redis, fetchFn?: FetchFn): Promise<void> {
  const cfg = loadConfig();

  const opportunities = await scanWeatherMarkets(redis, fetchFn);

  if (opportunities.length === 0) return;

  // Only proceed with execution when enabled
  if (!cfg.WEATHER_SCANNER_ENABLED) {
    logger.info('[weather] scanner disabled — shadow-logged only', {
      opportunities: opportunities.length,
    });
    return;
  }

  // Execution will be wired in a follow-up PR.
  // For now, log what would be traded.
  for (const opp of opportunities) {
    logger.info('[weather] would execute trade', {
      marketId: opp.marketId,
      tradeSide: opp.tradeSide,
      edge: opp.edge.toFixed(3),
      forecastProbability: opp.forecastProbability.toFixed(3),
      marketPrice: opp.marketPrice.toFixed(3),
      city: opp.parsed.city,
      daysOut: opp.daysOut,
    });
  }
}
