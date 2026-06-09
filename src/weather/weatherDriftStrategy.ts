/**
 * Weather Drift Strategy Scanner
 *
 * Shadow-only lifecycle scanner that evaluates open weather positions for
 * thesis drift each scan cycle. Classifies each position into a WeatherDriftState,
 * writes a 'weather_drift_decision' shadow row, and logs the result.
 *
 * Actions are shadow-only in Phase 2. Live blocking (size-up, cancel, exit) will
 * be enabled in later phases once shadow data is reviewed.
 *
 * Runs from runWeatherScan() after runWeatherInvalidationScan() and before the
 * entry execution loop. This ordering means:
 *  - Invalidation markers are already refreshed when drift runs.
 *  - Modal streak Redis values are already updated by invalidation; drift reads them.
 *  - Drift shadow rows are written before any new entries execute.
 *
 * Gated on WEATHER_DRIFT_SHADOW_ENABLED.
 *
 * Log marker: [weather-drift]
 */

import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { enqueueWrite } from '../db/writeQueue.js';
import type { FetchFn } from './noaaClient.js';
import { getCityBias } from './cityBias.js';
import { cacheForecast, readCachedForecast } from './forecastCache.js';
import { cityLocalDate } from './resolutionTime.js';
import {
  fetchWeatherEvents,
  parseWeatherEvent,
  fetchForecast,
  daysUntil,
} from './weatherScanner.js';
import type { ParsedWeatherEvent, ParsedBracket } from './weatherScanner.js';
import {
  fetchOpenWeatherPositions,
  parseWeatherPositionMeta,
  evaluateWeatherPositionThesis,
} from './weatherThesis.js';
import type { OpenWeatherPosition, WeatherThesisResult } from './weatherThesis.js';

// ── Drift state types ────────────────────────────────────────────────────────

export type WeatherDriftState =
  | 'stable'
  | 'watch'
  | 'thesis_weakened'
  | 'modal_against'
  | 'oracle_impossible'   // Phase 5+
  | 'oracle_confirmed'    // Phase 5+
  | 'exit_candidate'      // Phase 3+
  | 'hedge_candidate'     // Phase 4+
  | 'flip_candidate';     // Phase 6+

export type WeatherDriftAction =
  | 'none'
  | 'cancel_resting'
  | 'block_size_up'
  | 'notify'
  | 'hedge'
  | 'exit'
  | 'flip';

export interface WeatherDriftDecision {
  positionId: string;
  marketId: string;
  direction: 'YES' | 'NO';
  city: string;
  targetDate: string;
  bracketLabel: string;
  daysOut: number;
  isResolutionDay: boolean;
  state: WeatherDriftState;
  action: WeatherDriftAction;
  reason: string;
  entryHeldProb: number;
  currentHeldProb: number;
  currentModelProb: number;
  drop: number;
  correctedForecastHigh: number;
  roundedForecast: number | null;
  effectiveStdDev: number;
  biasMode: 'none' | 'weak' | 'full';
  modalApplicable: boolean;
  modalInversionRaw: boolean;
  modalStreak: number;
  modalWasEverSupported: boolean;
  invalidated: boolean;
  invalidationReason: string | null;
  forecastSource: string;
}

// ── State classification ─────────────────────────────────────────────────────

interface DriftClassifyOptions {
  watchDrop: number;
  thesisWeakenedDrop: number;
  exactEnabled: boolean;
  boundaryBuffer: number;
}

/** True when the corrected forecast is within `buffer` degrees of the nearest bracket boundary. */
function isNearBracketBoundary(
  corrected: number,
  low: number,
  high: number,
  buffer: number,
): boolean {
  // Rounding boundaries for bracket [low, high]: low-0.5 and high+0.5
  const lowerBoundary = low - 0.5;
  const upperBoundary = high + 0.5;
  return (
    Math.abs(corrected - lowerBoundary) <= buffer ||
    Math.abs(corrected - upperBoundary) <= buffer
  );
}

export function classifyDriftState(
  result: WeatherThesisResult,
  bracket: { low: number | null; high: number | null },
  opts: DriftClassifyOptions,
): { state: WeatherDriftState; reason: string } {
  const isTail = bracket.low === null || bracket.high === null;
  const { drop, modalInversionRaw, correctedForecastHigh } = result;
  const { watchDrop, thesisWeakenedDrop, exactEnabled, boundaryBuffer } = opts;

  // Interior bracket: modal rounds against our thesis
  if (!isTail && exactEnabled && modalInversionRaw) {
    return { state: 'modal_against', reason: 'forecast_rounds_against_thesis' };
  }

  // Thesis significantly weakened (both tail and interior)
  if (drop >= thesisWeakenedDrop) {
    return { state: 'thesis_weakened', reason: 'held_prob_drop' };
  }

  // Forecast approaching rounding boundary (interior only, before drop qualifies for watch)
  if (!isTail && exactEnabled && boundaryBuffer > 0) {
    if (isNearBracketBoundary(correctedForecastHigh, bracket.low!, bracket.high!, boundaryBuffer)) {
      return { state: 'watch', reason: 'near_bracket_boundary' };
    }
  }

  // Early warning: held prob drifting
  if (drop >= watchDrop) {
    return { state: 'watch', reason: 'held_prob_drop' };
  }

  return { state: 'stable', reason: 'ok' };
}

// ── Modal streak Redis key helpers ───────────────────────────────────────────

const MODAL_STREAK_KEY_PREFIX = 'weather:forecast_modal_streak:';
const MODAL_STREAK_TTL_S = 2 * 3600;
const MODAL_SUPPORTED_KEY_PREFIX = 'weather:forecast_modal_supported:';
const MODAL_SUPPORTED_TTL_S = 14 * 24 * 3600;

// ── Main scanner ─────────────────────────────────────────────────────────────

/** Run one drift-strategy scan cycle (shadow only in Phase 2). */
export async function runWeatherDriftStrategy(redis: Redis, fetchFn?: FetchFn): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.WEATHER_DRIFT_SHADOW_ENABLED) return;

  let positions: OpenWeatherPosition[];
  try {
    positions = await fetchOpenWeatherPositions();
  } catch (err) {
    logger.warn('[weather-drift] DB query failed — aborting', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (positions.length === 0) return;

  const rawEvents = await fetchWeatherEvents(cfg.WEATHER_MAX_EVENTS);
  const parsedEvents = rawEvents
    .map(parseWeatherEvent)
    .filter((e): e is NonNullable<typeof e> => e !== null);

  const decisions: WeatherDriftDecision[] = [];

  for (const pos of positions) {
    try {
      const meta = parseWeatherPositionMeta(pos.sourcedFrom, pos.question);
      if (!meta) {
        logger.debug('[weather-drift] unparseable sourcedFrom — skipping', {
          positionId: pos.id,
          sourcedFrom: pos.sourcedFrom,
        });
        continue;
      }
      const { city, targetDate, bracketLabel } = meta;

      const event = parsedEvents.find((e) => e.city === city && e.targetDate === targetDate);
      if (!event) {
        logger.debug('[weather-drift] no active Gamma event — skipping', {
          positionId: pos.id,
          city,
          targetDate,
        });
        continue;
      }

      const bracket = event.brackets.find((b) => b.label === bracketLabel);
      if (!bracket) {
        logger.debug('[weather-drift] bracket not found in event — skipping', {
          positionId: pos.id,
          city,
          bracketLabel,
        });
        continue;
      }

      // Read modal streak state. The invalidation scanner runs first in
      // runWeatherScan() and has already updated these keys for this cycle,
      // so we read the current (post-invalidation) streak values.
      // Drift scanner reads only — it does not write modal streak keys (the
      // invalidation scanner owns streak management to avoid double-increments).
      const modalStreakKey = `${MODAL_STREAK_KEY_PREFIX}${pos.id}`;
      const modalSupportedKey = `${MODAL_SUPPORTED_KEY_PREFIX}${pos.id}`;
      const [modalStreakRaw, modalSupportedMarkerRaw] = await redis
        .mget(modalStreakKey, modalSupportedKey)
        .catch((): [null, null] => [null, null]);

      const daysOut = daysUntil(targetDate);
      const isResolutionDay = event.targetDate === cityLocalDate(event.coords.tz);

      let forecast = await fetchForecast(
        event,
        daysOut,
        fetchFn,
        cfg.WEATHER_STDDEV_MIN_FRACTION,
        cfg.WEATHER_MODEL_ECMWF_ENABLED,
        cfg.WEATHER_HRRR_ENABLED,
        cfg.WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED,
        cfg.WEATHER_HRRR_MAX_CROSS_SOURCE_SPREAD,
        { allowEnsembleOnly: true, retryCount: cfg.WEATHER_FORECAST_RETRY_COUNT },
      );
      if (forecast) {
        void cacheForecast(redis, city, targetDate, forecast).catch(() => {});
      } else {
        forecast = await readCachedForecast(redis, city, targetDate).catch(() => null);
        if (!forecast) {
          logger.debug('[weather-drift] forecast unavailable — skipping', {
            positionId: pos.id,
            city,
            targetDate,
          });
          continue;
        }
      }

      const cityBias = cfg.WEATHER_BIAS_CORRECTION_ENABLED
        ? await getCityBias(redis, city)
        : null;

      const result = evaluateWeatherPositionThesis({
        pos,
        bracket: { low: bracket.low, high: bracket.high },
        daysOut,
        forecast,
        cityBias,
        redisValues: { modalStreakRaw, modalSupportedMarkerRaw },
        stddevMultiplier: cfg.WEATHER_STDDEV_MULTIPLIER,
        biasCorrectionEnabled: cfg.WEATHER_BIAS_CORRECTION_ENABLED,
        biasMinSamples: cfg.WEATHER_BIAS_MIN_SAMPLES,
        biasTrustedSamples: cfg.WEATHER_BIAS_TRUSTED_SAMPLES,
        weakBiasStddevMultiplier: cfg.WEATHER_WEAK_BIAS_STDDEV_MULTIPLIER,
        modalEnabled: cfg.WEATHER_FORECAST_INVALIDATION_MODAL_ENABLED,
        modalMinRuns: cfg.WEATHER_FORECAST_INVALIDATION_MODAL_MIN_RUNS,
        modalMaxHeldProb: cfg.WEATHER_FORECAST_INVALIDATION_MODAL_MAX_HELD_PROB,
        invalidationMinDrop: cfg.WEATHER_FORECAST_INVALIDATION_MIN_DROP,
        invalidationMinCurrentHeldProb: cfg.WEATHER_FORECAST_INVALIDATION_MIN_CURRENT_HELD_PROB,
        // Invalidation scanner runs first in runWeatherScan and has already written
        // the streak this cycle. Read without re-advancing so the shadow row records
        // the true post-invalidation streak value.
        skipModalStreakAdvance: true,
      });

      const { state, reason } = classifyDriftState(
        result,
        { low: bracket.low, high: bracket.high },
        {
          watchDrop: cfg.WEATHER_DRIFT_WATCH_DROP,
          thesisWeakenedDrop: cfg.WEATHER_DRIFT_THESIS_WEAKENED_DROP,
          exactEnabled: cfg.WEATHER_DRIFT_EXACT_ENABLED,
          boundaryBuffer: cfg.WEATHER_DRIFT_EXACT_BOUNDARY_BUFFER,
        },
      );

      // Phase 2: all actions are shadow-only
      const action: WeatherDriftAction = 'none';

      const decision: WeatherDriftDecision = {
        positionId: pos.id,
        marketId: pos.marketId,
        direction: pos.direction,
        city,
        targetDate,
        bracketLabel,
        daysOut,
        isResolutionDay,
        state,
        action,
        reason,
        entryHeldProb: result.entryHeldProb,
        currentHeldProb: result.currentHeldProb,
        currentModelProb: result.currentModelProb,
        drop: result.drop,
        correctedForecastHigh: result.correctedForecastHigh,
        roundedForecast: result.roundedForecast,
        effectiveStdDev: result.effectiveStdDev,
        biasMode: result.biasMode,
        modalApplicable: result.modalApplicable,
        modalInversionRaw: result.modalInversionRaw,
        modalStreak: result.modalStreak,
        modalWasEverSupported: result.modalWasEverSupported,
        invalidated: result.invalidated,
        invalidationReason: result.invalidationReason,
        forecastSource: forecast.source,
      };

      decisions.push(decision);

      logger.info('[weather-drift] position evaluated', {
        positionId: pos.id,
        marketId: pos.marketId,
        direction: pos.direction,
        city,
        targetDate,
        bracketLabel,
        daysOut,
        state,
        reason,
        drop: +result.drop.toFixed(3),
        currentHeldProb: +result.currentHeldProb.toFixed(3),
        entryHeldProb: +result.entryHeldProb.toFixed(3),
        modalApplicable: result.modalApplicable,
        modalInversionRaw: result.modalInversionRaw,
        modalStreak: result.modalStreak,
        correctedForecastHigh: +result.correctedForecastHigh.toFixed(1),
        roundedForecast: result.roundedForecast,
      });

      void enqueueWrite('shadow_observations', {
        kind: 'weather_drift_decision',
        source: 'arb',
        marketId: pos.marketId,
        direction: pos.direction,
        wouldBlock: false,
        metricValue: result.drop,
        threshold: cfg.WEATHER_DRIFT_WATCH_DROP,
        payload: {
          positionId: pos.id,
          city,
          targetDate,
          bracketLabel,
          daysOut,
          isResolutionDay,
          state,
          action,
          reason,
          entryHeldProb: result.entryHeldProb,
          currentHeldProb: result.currentHeldProb,
          currentModelProb: result.currentModelProb,
          drop: result.drop,
          correctedForecastHigh: result.correctedForecastHigh,
          roundedForecast: result.roundedForecast,
          effectiveStdDev: result.effectiveStdDev,
          biasMode: result.biasMode,
          modalApplicable: result.modalApplicable,
          modalInversionRaw: result.modalInversionRaw,
          modalStreak: result.modalStreak,
          modalWasEverSupported: result.modalWasEverSupported,
          invalidated: result.invalidated,
          invalidationReason: result.invalidationReason,
          forecastSource: forecast.source,
          forecastHigh: forecast.forecastHigh,
          watchDrop: cfg.WEATHER_DRIFT_WATCH_DROP,
          thesisWeakenedDrop: cfg.WEATHER_DRIFT_THESIS_WEAKENED_DROP,
          exactEnabled: cfg.WEATHER_DRIFT_EXACT_ENABLED,
        },
      });
    } catch (err) {
      logger.warn('[weather-drift] unexpected error for position — continuing', {
        positionId: pos.id,
        marketId: pos.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (decisions.length > 0) {
    const stateCounts = decisions.reduce<Record<string, number>>((acc, d) => {
      acc[d.state] = (acc[d.state] ?? 0) + 1;
      return acc;
    }, {});
    logger.info('[weather-drift] scan complete', {
      positions: positions.length,
      evaluated: decisions.length,
      stateCounts,
    });
  }
}
