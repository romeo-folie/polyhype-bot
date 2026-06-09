/**
 * Weather Thesis Evaluator
 *
 * Pure helper that computes the current thesis state for an open weather
 * position. Shared by the forecast-invalidation scanner and the drift
 * strategy scanner so they evaluate positions identically.
 *
 * No Redis writes are performed here — the caller receives back write signals
 * (shouldWriteModalStreak, shouldDeleteModalStreak, shouldRefreshSupportedMarker)
 * and decides when and whether to persist them. This keeps the evaluator
 * unit-testable without a Redis mock.
 *
 * Log marker: none — callers own logging.
 */

import { getSql } from '../db/client.js';
import { canonicalCityKey, lookupCity } from './noaaClient.js';
import {
  computeBiasedProb,
  forecastRoundsIntoBracket,
  parseBracketLabel,
} from './weatherScanner.js';
import type { ForecastResult, BiasedProbResult } from './weatherScanner.js';
import type { CityBias } from './cityBias.js';

export type { ForecastResult, BiasedProbResult };

// ── Open position shape ──────────────────────────────────────────────────────

export interface OpenWeatherPosition {
  id: string;
  marketId: string;
  direction: 'YES' | 'NO';
  entryPrice: number;
  sharesHeld: number;
  /** Null for reconciler-imported rows with no linked maker order. */
  consensusProbability: number | null;
  sourcedFrom: string;
  /** Market question text — city/date/bracket source for reconciled rows. */
  question: string | null;
}

export async function fetchOpenWeatherPositions(): Promise<OpenWeatherPosition[]> {
  const sql = getSql();
  return sql<OpenWeatherPosition[]>`
    SELECT
      id::text                      AS id,
      market_id                     AS "marketId",
      direction                     AS direction,
      entry_price::float8           AS "entryPrice",
      shares_held::float8           AS "sharesHeld",
      consensus_probability::float8 AS "consensusProbability",
      sourced_from                  AS "sourcedFrom",
      question                      AS "question"
    FROM positions
    WHERE (sourced_from LIKE 'weather:%' OR sourced_from LIKE 'reconciled:weather%')
      AND pending_settlement = false
      AND closed_at IS NULL
      AND shares_held > 0
    ORDER BY opened_at DESC
  `;
}

// ── Metadata parsing ─────────────────────────────────────────────────────────

export interface ParsedWeatherMeta {
  city: string;
  targetDate: string;
  bracketLabel: string;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const SOURCED_FROM_RE = /^weather:(.+):(\d{4}-\d{2}-\d{2}):(.+)$/;

/**
 * Derive {city, targetDate, bracketLabel} from a market question of the form
 * "Will the highest temperature in <City> be <bracket> on <Month D>?".
 *
 * Used for reconciled:weather positions whose sourcedFrom carries no embedded
 * metadata. Returns null on any parse failure.
 */
export function parseWeatherMetaFromQuestion(question: string): ParsedWeatherMeta | null {
  const cityMatch = question.match(
    /highest temperature in ([^?]+?) (?:be |exceed |fall |drop |reach |\d)/i,
  );
  if (!cityMatch?.[1]) return null;
  const cityRaw = cityMatch[1].trim().toLowerCase();
  const city = canonicalCityKey(cityRaw) ?? cityRaw;
  if (!lookupCity(city)) return null;

  const bracketMatch = question.match(/\bbe\s+(.+?)\s+on\s+[A-Za-z]/i);
  if (!bracketMatch?.[1]) return null;
  const bracketLabel = bracketMatch[1].trim();
  if (!parseBracketLabel(bracketLabel)) return null;

  const dateMatch = question.match(/\bon\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\s*\?*\s*$/i);
  if (!dateMatch?.[1] || !dateMatch[2]) return null;
  const month = MONTHS[dateMatch[1].toLowerCase()];
  const day = parseInt(dateMatch[2], 10);
  if (!month || day < 1 || day > 31) return null;
  let year = dateMatch[3] ? parseInt(dateMatch[3], 10) : new Date().getUTCFullYear();
  if (!dateMatch[3]) {
    const candidate = Date.UTC(year, month - 1, day);
    if (Date.now() - candidate > 180 * 24 * 3600 * 1000) year += 1;
  }
  const targetDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { city, targetDate, bracketLabel };
}

/**
 * Parse {city, targetDate, bracketLabel} from a position's sourcedFrom field,
 * falling back to the market question for reconciled:weather rows.
 */
export function parseWeatherPositionMeta(
  sourcedFrom: string,
  question?: string | null,
): ParsedWeatherMeta | null {
  const m = sourcedFrom.match(SOURCED_FROM_RE);
  if (m?.[1] && m[2] && m[3]) {
    return { city: m[1], targetDate: m[2], bracketLabel: m[3] };
  }
  if (sourcedFrom.startsWith('reconciled:weather') && question) {
    return parseWeatherMetaFromQuestion(question);
  }
  return null;
}

// ── Thesis evaluation ────────────────────────────────────────────────────────

/** Pre-loaded Redis values needed by evaluateWeatherPositionThesis. */
export interface WeatherThesisRedisValues {
  modalStreakRaw: string | null;
  modalSupportedMarkerRaw: string | null;
}

export interface WeatherThesisInput {
  pos: OpenWeatherPosition;
  bracket: { low: number | null; high: number | null };
  daysOut: number;
  forecast: ForecastResult;
  cityBias: CityBias | null;
  redisValues: WeatherThesisRedisValues;
  // Probability model config
  stddevMultiplier: number;
  biasCorrectionEnabled: boolean;
  biasMinSamples: number;
  biasTrustedSamples: number;
  weakBiasStddevMultiplier: number;
  // Modal inversion config
  modalEnabled: boolean;
  modalMinRuns: number;
  modalMaxHeldProb: number;
  // Hard invalidation thresholds (used to compute dropInvalidated / modalInvalidated)
  invalidationMinDrop: number;
  invalidationMinCurrentHeldProb: number;
  /**
   * Read-only streak mode. When true the evaluator returns the current Redis
   * streak value without incrementing or deleting it, and all three
   * shouldWrite/shouldDelete/shouldRefresh signals are false.
   *
   * Use this in the drift scanner, which runs AFTER the invalidation scanner has
   * already advanced and written the streak for this cycle. Without this flag the
   * drift scanner would double-increment: invalidation writes 1, drift reads 1,
   * then the helper computes 1+1=2 and the shadow row records a wrong streak.
   */
  skipModalStreakAdvance?: boolean;
}

export interface WeatherThesisResult {
  entryHeldProb: number;
  currentModelProb: number;
  currentHeldProb: number;
  drop: number;
  correctedForecastHigh: number;
  effectiveStdDev: number;
  biasMode: 'none' | 'weak' | 'full';
  modalApplicable: boolean;
  roundedForecast: number | null;
  modalInversionRaw: boolean;
  modalSupportsThesis: boolean;
  /** Modal streak after this evaluation (pre-incremented when inverting). */
  modalStreak: number;
  modalWasEverSupported: boolean;
  dropInvalidated: boolean;
  modalInvalidated: boolean;
  invalidated: boolean;
  invalidationReason: 'held_prob_drop' | 'modal_inversion' | 'both' | null;
  // Redis write signals — callers that own streak management use these
  /** Caller should SET the modal streak key to modalStreak when true. */
  shouldWriteModalStreak: boolean;
  /** Caller should DEL the modal streak key when true. */
  shouldDeleteModalStreak: boolean;
  /** Caller should SET/refresh the modal supported marker (14-day TTL) when true. */
  shouldRefreshSupportedMarker: boolean;
}

/**
 * Compute the current thesis state for an open weather position.
 *
 * Pure function — no I/O. The caller pre-fetches the Redis values and
 * applies any Redis writes signalled in the result.
 */
export function evaluateWeatherPositionThesis(input: WeatherThesisInput): WeatherThesisResult {
  const {
    pos,
    bracket,
    daysOut,
    forecast,
    cityBias,
    redisValues,
    stddevMultiplier,
    biasCorrectionEnabled,
    biasMinSamples,
    biasTrustedSamples,
    weakBiasStddevMultiplier,
    modalEnabled,
    modalMinRuns,
    modalMaxHeldProb,
    invalidationMinDrop,
    invalidationMinCurrentHeldProb,
    skipModalStreakAdvance = false,
  } = input;

  const { modelProbability: currentModelProb, effectiveStdDev, correctedForecastHigh, biasMode } =
    computeBiasedProb(bracket.low, bracket.high, daysOut, forecast, {
      stddevMultiplier,
      cityBias,
      biasCorrectionEnabled,
      biasMinSamples,
      biasTrustedSamples,
      weakBiasStddevMultiplier,
    });

  // Entry held probability: P(our side) at entry. Reconciler-imported rows have
  // no consensusProbability — use entryPrice (market's P(our side) at entry).
  const entryHeldProb =
    pos.consensusProbability != null && Number.isFinite(pos.consensusProbability)
      ? (pos.direction === 'YES' ? pos.consensusProbability : 1 - pos.consensusProbability)
      : pos.entryPrice;

  const currentHeldProb = pos.direction === 'YES' ? currentModelProb : 1 - currentModelProb;
  const drop = entryHeldProb - currentHeldProb;

  const dropInvalidated =
    drop >= invalidationMinDrop && currentHeldProb <= invalidationMinCurrentHeldProb;

  // Modal inversion: only applies to bounded brackets (both bounds non-null).
  const modalApplicable = modalEnabled && bracket.low !== null && bracket.high !== null;
  let modalInversionRaw = false;
  let modalSupportsThesis = false;
  let roundedForecast: number | null = null;

  if (modalApplicable) {
    roundedForecast = Math.round(correctedForecastHigh);
    const forecastInBracket = forecastRoundsIntoBracket(
      correctedForecastHigh,
      bracket.low,
      bracket.high,
    );
    modalInversionRaw = pos.direction === 'NO' ? forecastInBracket : !forecastInBracket;
    modalSupportsThesis = !modalInversionRaw;
  }

  const { modalStreakRaw, modalSupportedMarkerRaw } = redisValues;
  const modalWasEverSupported = !!modalSupportedMarkerRaw;

  let modalStreak = 0;
  let shouldWriteModalStreak = false;
  let shouldDeleteModalStreak = false;

  if (skipModalStreakAdvance) {
    // Read-only: return the current Redis value without advancing or deleting.
    // The invalidation scanner has already written the streak this cycle.
    modalStreak = parseInt(modalStreakRaw ?? '0', 10) || 0;
  } else if (modalInversionRaw) {
    modalStreak = (parseInt(modalStreakRaw ?? '0', 10) || 0) + 1;
    shouldWriteModalStreak = true;
  } else if (modalStreakRaw) {
    shouldDeleteModalStreak = true;
  }

  const shouldRefreshSupportedMarker = !skipModalStreakAdvance && modalApplicable && modalSupportsThesis;

  // Mirror weatherInvalidation.ts: if this run first sets the supported marker,
  // update the local variable so the modalInvalidated gate sees the same value
  // the original scanner would see after its in-memory assignment. In practice
  // the two paths are mutually exclusive within one scan (modalInversionRaw=true
  // implies modalSupportsThesis=false), but keeping them consistent is required
  // for Phase 3+ when the drift scanner may gain write ownership of these keys.
  const modalWasEverSupportedEffective = modalWasEverSupported || shouldRefreshSupportedMarker;

  const modalHeldProbOk = currentHeldProb <= modalMaxHeldProb;
  const modalInvalidated =
    modalInversionRaw &&
    modalStreak >= modalMinRuns &&
    modalHeldProbOk &&
    modalWasEverSupportedEffective;

  const invalidated = dropInvalidated || modalInvalidated;
  const invalidationReason = !invalidated
    ? null
    : dropInvalidated && modalInvalidated
      ? 'both'
      : dropInvalidated
        ? 'held_prob_drop'
        : 'modal_inversion';

  return {
    entryHeldProb,
    currentModelProb,
    currentHeldProb,
    drop,
    correctedForecastHigh,
    effectiveStdDev,
    biasMode,
    modalApplicable,
    roundedForecast,
    modalInversionRaw,
    modalSupportsThesis,
    modalStreak,
    modalWasEverSupported,
    dropInvalidated,
    modalInvalidated,
    invalidated,
    invalidationReason,
    shouldWriteModalStreak,
    shouldDeleteModalStreak,
    shouldRefreshSupportedMarker,
  };
}
