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
import { dedup } from '../shared/redis.js';
import type { FetchFn } from './noaaClient.js';
import { getCityBias } from './cityBias.js';
import { cacheForecast, readCachedForecast } from './forecastCache.js';
import { cityLocalDate } from './resolutionTime.js';
import { getMarket, parseClobTokenIds } from '../mapping/gamma.js';
import { getClobOrderBook } from '../shared/clob.js';
import { getBookTouchLevels } from '../shared/bookTouch.js';
import { getPendingOrder } from '../execution/pendingMakerOrders.js';
import { notifyWeatherDrift } from '../execution/telegram.js';
import {
  fetchWeatherEvents,
  parseWeatherEvent,
  fetchForecast,
  daysUntil,
  cancelRestingWeatherOrder,
} from './weatherScanner.js';
import type { ParsedWeatherEvent, ParsedBracket } from './weatherScanner.js';
import {
  fetchOpenWeatherPositions,
  parseWeatherPositionMeta,
  evaluateWeatherPositionThesis,
} from './weatherThesis.js';
import type { OpenWeatherPosition, WeatherThesisResult } from './weatherThesis.js';
import { tryWeatherExit } from './weatherExit.js';

// ── Drift state types ────────────────────────────────────────────────────────

export type WeatherDriftState =
  | 'stable'
  | 'watch'
  | 'thesis_weakened'
  | 'modal_against'
  | 'market_against'      // Market price has moved strongly against us (independent of forecast)
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

// ── Redis key constants ───────────────────────────────────────────────────────

const MODAL_STREAK_KEY_PREFIX = 'weather:forecast_modal_streak:';
const MODAL_STREAK_TTL_S = 2 * 3600;
const MODAL_SUPPORTED_KEY_PREFIX = 'weather:forecast_modal_supported:';
const MODAL_SUPPORTED_TTL_S = 14 * 24 * 3600;

// Shared with the invalidation scanner — drift writes this same key so the
// existing size-up gate checks a single namespace regardless of which scanner set it.
const FORECAST_INVALIDATED_KEY_PREFIX = 'weather:forecast_invalidated:';
// Shared exited key — if either scanner already sold the position this fires idempotency.
const EXITED_KEY_PREFIX = 'weather:forecast_exited:';
const EXITED_TTL_S = 14 * 24 * 3600;
// Drift-specific cancel idempotency and exit cooldown keys.
const DRIFT_CANCELLED_RESTING_KEY_PREFIX = 'weather:drift_cancelled_resting:';
const DRIFT_CANCELLED_RESTING_TTL_S = 14 * 24 * 3600;
const DRIFT_EXIT_COOLDOWN_KEY_PREFIX = 'weather:drift_exit_cooldown:';
// Notification dedup — per position+state so state escalations re-notify.
const DRIFT_NOTIFY_KEY_PREFIX = 'weather:drift_notify:';

// ── Main scanner ─────────────────────────────────────────────────────────────

/** Run one drift-strategy scan cycle. */
export async function runWeatherDriftStrategy(redis: Redis, fetchFn?: FetchFn): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.WEATHER_DRIFT_SHADOW_ENABLED && !cfg.WEATHER_DRIFT_ENABLED) return;

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

      const { state: forecastState, reason } = classifyDriftState(
        result,
        { low: bracket.low, high: bracket.high },
        {
          watchDrop: cfg.WEATHER_DRIFT_WATCH_DROP,
          thesisWeakenedDrop: cfg.WEATHER_DRIFT_THESIS_WEAKENED_DROP,
          exactEnabled: cfg.WEATHER_DRIFT_EXACT_ENABLED,
          boundaryBuffer: cfg.WEATHER_DRIFT_EXACT_BOUNDARY_BUFFER,
        },
      );

      // ── Market-adverse detection ─────────────────────────────────────────────
      // Fetch the held-side CLOB bid once per position to detect cases where the
      // market has moved strongly against us even when the ensemble forecast hasn't
      // shifted (e.g. model stays at 99% but market prices the position at ~0%).
      //
      // Tier 1 (exit, res-day): marketDrop ≥ EXIT threshold AND model drop ≥ SEVERE_DROP.
      // Tier 2 (notify, any day): marketDrop ≥ NOTIFY threshold AND model-market gap ≥ DIVERGENCE.
      //
      // A non-null heldTokenId is needed for both market-adverse detection and the
      // Tier 1 exit, so we fetch it here and reuse it below.
      let heldTokenId: string | null = null;
      try {
        const market = await getMarket(pos.marketId);
        const tokenIds = parseClobTokenIds(market.clobTokenIds);
        heldTokenId = (pos.direction === 'YES' ? tokenIds[0] : tokenIds[1]) ?? null;
      } catch (err) {
        logger.warn('[weather-drift] market fetch failed — market-adverse check and exit skipped', {
          positionId: pos.id,
          marketId: pos.marketId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      let currentHeldBid: number | null = null;
      let marketDrop = 0;
      let modelMarketGap = 0;
      let marketAgainstTier: 1 | 2 | null = null;

      if (heldTokenId) {
        try {
          const book = await getClobOrderBook(heldTokenId);
          currentHeldBid = book ? (getBookTouchLevels(book).bestBid?.price ?? null) : null;
        } catch { /* CLOB unavailable — skip market-adverse check */ }

        if (currentHeldBid != null && pos.entryPrice > 0) {
          marketDrop = (pos.entryPrice - currentHeldBid) / pos.entryPrice;
          modelMarketGap = result.currentHeldProb - currentHeldBid;

          // DROP_EXIT < DROP_NOTIFY by design: tier1 compensates with the extra
          // model-drop gate. Do not raise DROP_EXIT above DROP_NOTIFY (see config comment).
          const tier1 =
            marketDrop >= cfg.WEATHER_DRIFT_MARKET_ADVERSE_DROP_EXIT &&
            result.drop >= cfg.WEATHER_DRIFT_SEVERE_DROP;
          // Tier 2 only fires when Tier 1 is not already met — avoids double-notify.
          const tier2 =
            !tier1 &&
            marketDrop >= cfg.WEATHER_DRIFT_MARKET_ADVERSE_DROP_NOTIFY &&
            modelMarketGap >= cfg.WEATHER_DRIFT_MARKET_DIVERGENCE_NOTIFY;

          if (tier1) marketAgainstTier = 1;
          else if (tier2) marketAgainstTier = 2;
        }
      }

      // Final state: market_against overrides the forecast-derived state when the
      // market signal is clear. forecastState is kept for forecast-specific gates
      // (e.g. cancel_resting requires modal_against from the forecast, not market).
      const state: WeatherDriftState = marketAgainstTier != null ? 'market_against' : forecastState;

      // ── Phase 3+4: live actions ──────────────────────────────────────────────
      // isActionable: stricter gate for high-impact actions (exit/cancel/notify).
      //   - modal_against: forecast has rounded against thesis for ≥ minRuns scans
      //   - thesis_weakened: held-prob dropped beyond the severe (not just watch) threshold
      //   - market_against: market bid has moved strongly against our held side
      // isBlockable: wider gate for block_size_up (any weakened/against state).
      //   Fires for thesis_weakened and modal_against — including first-scan modal_against
      //   and thesis_weakened with drop in [WEAKENED_DROP, SEVERE_DROP).
      // Notification always fires for the first occurrence per position+state
      // (deduped per WEATHER_DRIFT_NOTIFY_DEDUP_S) regardless of whether live
      // actions are enabled — the user is always kept in the loop.
      const isActionable =
        (forecastState === 'modal_against' &&
          result.modalStreak >= cfg.WEATHER_FORECAST_INVALIDATION_MODAL_MIN_RUNS) ||
        (forecastState === 'thesis_weakened' && result.drop >= cfg.WEATHER_DRIFT_SEVERE_DROP) ||
        state === 'market_against';
      const isBlockable =
        forecastState === 'thesis_weakened' || forecastState === 'modal_against' || state === 'market_against';
      const wouldBlock = isBlockable && !cfg.WEATHER_DRIFT_ENABLED;

      let action: WeatherDriftAction = 'none';
      // Hoisted so the notification (fired after block_size_up) sees the final action.
      let shouldNotify = false;

      if (isActionable) {
        // Dedup key per position+state — state escalations (e.g. thesis_weakened →
        // modal_against, or market_against tier2 → tier1) use different keys and
        // fire fresh notifications.
        const notifyDedupSuffix =
          state === 'market_against' ? `market_against:t${marketAgainstTier}` : state;
        const notifyDedupKey = `${DRIFT_NOTIFY_KEY_PREFIX}${pos.id}:${notifyDedupSuffix}`;
        shouldNotify = await dedup(notifyDedupKey, cfg.WEATHER_DRIFT_NOTIFY_DEDUP_S).catch(() => false);

        if (cfg.WEATHER_DRIFT_ENABLED) {
          // 1. Resolution-day exit (highest priority).
          // market_against: only Tier 1 (both market and model moved) triggers exit.
          // Tier 2 (model stuck, divergence only) is notify-only.
          const marketAgainstCanExit = state === 'market_against' && marketAgainstTier === 1;
          const forecastCanExit = state !== 'market_against';
          if (cfg.WEATHER_DRIFT_EXIT_ENABLED && isResolutionDay && (forecastCanExit || marketAgainstCanExit)) {
            if (heldTokenId) {
              // tryWeatherExit fetches the book again for an accurate exit price.
              // The earlier fetch was for tier classification only; a fresh fetch
              // ensures the exit floor check uses the current bid, not a stale one.
              const exited = await tryWeatherExit({
                redis,
                pos,
                city,
                targetDate,
                bracketLabel,
                heldTokenId,
                currentHeldProb: result.currentHeldProb,
                invalidationReason: result.invalidationReason ?? state,
                enabled: true,
                isResolutionDay,
                minExitPrice: cfg.WEATHER_DRIFT_EXIT_MIN_BID,
                maxExitSlippage: cfg.WEATHER_DRIFT_EXIT_MAX_SLIPPAGE,
                useMarketFloor: true,
                exitCooldownKey: `${DRIFT_EXIT_COOLDOWN_KEY_PREFIX}${pos.id}`,
                exitCooldownS: cfg.WEATHER_DRIFT_EXIT_COOLDOWN_S,
                exitedKey: `${EXITED_KEY_PREFIX}${pos.id}`,
                exitedTtlS: EXITED_TTL_S,
                exitReason: 'weather_drift',
                shadowKind: 'weather_drift_exit',
                logMarker: '[weather-drift]',
                minDepthRatio: cfg.WEATHER_DRIFT_EXIT_MIN_DEPTH_RATIO,
                extraContext: { driftState: state, marketAgainstTier },
              }).catch(() => false);
              if (exited) action = 'exit';
            }
          }

          // 2. Cancel resting maker order (forecast modal_against only — streak satisfied).
          // Not triggered by market_against alone since the forecast may still support the thesis.
          if (action === 'none' && forecastState === 'modal_against' && cfg.WEATHER_DRIFT_CANCEL_RESTING_ENABLED) {
            const cancelledKey = `${DRIFT_CANCELLED_RESTING_KEY_PREFIX}${pos.id}`;
            const alreadyCancelled = !!(await redis.get(cancelledKey).catch(() => null));
            if (!alreadyCancelled) {
              const pendingOrder = await getPendingOrder(redis, pos.marketId, pos.direction).catch(() => null);
              if (pendingOrder) {
                const cancelStatus = await cancelRestingWeatherOrder(
                  redis,
                  pos.marketId,
                  pos.direction,
                  pendingOrder,
                  { rule: 'drift_modal_against', positionId: pos.id, modalStreak: result.modalStreak },
                ).catch(() => 'retry' as const);
                // Write idempotency marker only on confirmed outcomes; 'retry' means
                // the order is still live on CLOB — suppress would prevent the next scan
                // from retrying the cancel.
                if (cancelStatus !== 'retry') {
                  await redis.set(cancelledKey, '1', 'EX', DRIFT_CANCELLED_RESTING_TTL_S).catch(() => {});
                }
                if (cancelStatus === 'cancelled') action = 'cancel_resting';
              }
            }
          }
        }
      }

      // 3. Write the shared size-up block key.
      // Gated by isBlockable (wider than isActionable) so any thesis_weakened or
      // modal_against position — including first-scan and drop in [weakened, severe) —
      // blocks size-ups while the position is held. Skipped after a successful exit
      // (position is sold; writing the key would be misleading).
      if (action !== 'exit' && isBlockable && cfg.WEATHER_DRIFT_ENABLED && cfg.WEATHER_DRIFT_BLOCK_SIZE_UP_ENABLED) {
        const invalidKey = `${FORECAST_INVALIDATED_KEY_PREFIX}${pos.marketId}:${pos.direction}`;
        await redis.set(
          invalidKey,
          JSON.stringify({
            city,
            targetDate,
            bracketLabel,
            entryHeldProb: result.entryHeldProb,
            currentHeldProb: result.currentHeldProb,
            drop: result.drop,
            driftState: state,
            observedAt: new Date().toISOString(),
          }),
          'EX',
          cfg.WEATHER_FORECAST_INVALIDATION_TTL_S,
        ).catch(() => {});
        logger.info('[weather-drift] size-up block key set', {
          positionId: pos.id,
          marketId: pos.marketId,
          direction: pos.direction,
          invalidKey,
          driftState: state,
        });
        if (action === 'none') action = 'block_size_up';
      }

      // 4. Notify fallback + notification fire (actionable positions only).
      // Runs after block_size_up so the notification shows the final action.
      if (isActionable && cfg.WEATHER_DRIFT_ENABLED && action === 'none') action = 'notify';
      if (shouldNotify) {
        await notifyWeatherDrift({
          positionId: pos.id,
          marketId: pos.marketId,
          city,
          targetDate,
          bracketLabel,
          direction: pos.direction,
          entryPrice: pos.entryPrice,
          sharesHeld: pos.sharesHeld,
          state,
          drop: result.drop,
          currentHeldProb: result.currentHeldProb,
          modalStreak: result.modalStreak,
          daysOut,
          isResolutionDay,
          action,
          ...(currentHeldBid != null && { currentHeldBid }),
          ...(marketAgainstTier != null && { marketDrop, marketAgainstTier }),
        }).catch((err: unknown) => {
          logger.warn('[weather-drift] notification failed', {
            positionId: pos.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

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
        ...(currentHeldBid != null && {
          currentHeldBid: +currentHeldBid.toFixed(4),
          marketDrop: +marketDrop.toFixed(3),
          modelMarketGap: +modelMarketGap.toFixed(3),
          marketAgainstTier,
        }),
      });

      void enqueueWrite('shadow_observations', {
        kind: 'weather_drift_decision',
        source: 'arb',
        marketId: pos.marketId,
        direction: pos.direction,
        wouldBlock,
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
          severeDrop: cfg.WEATHER_DRIFT_SEVERE_DROP,
          exactEnabled: cfg.WEATHER_DRIFT_EXACT_ENABLED,
          isActionable,
          wouldBlock,
          driftEnabled: cfg.WEATHER_DRIFT_ENABLED,
          currentHeldBid,
          marketDrop: currentHeldBid != null ? marketDrop : null,
          modelMarketGap: currentHeldBid != null ? modelMarketGap : null,
          marketAgainstTier,
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
