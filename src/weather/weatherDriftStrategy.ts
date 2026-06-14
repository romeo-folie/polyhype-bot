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
import { lookupCity } from './noaaClient.js';
import type { FetchFn } from './noaaClient.js';
import { getCityBias } from './cityBias.js';
import { cacheForecast, readCachedForecast } from './forecastCache.js';
import { cityLocalDate } from './resolutionTime.js';
import { getMarket, parseClobTokenIds, parseOutcomePrices } from '../mapping/gamma.js';
import { getClobOrderBook } from '../shared/clob.js';
import { getBookTouchLevels } from '../shared/bookTouch.js';
import { getPendingOrder } from '../execution/pendingMakerOrders.js';
import { notifyWeatherDrift } from '../execution/telegram.js';
import {
  fetchWeatherEvents,
  parseWeatherEvent,
  parseBracketLabel,
  fetchForecast,
  daysUntil,
  cancelRestingWeatherOrder,
} from './weatherScanner.js';
import type { ParsedWeatherEvent, ParsedBracket, WeatherBracketOpportunity } from './weatherScanner.js';
import {
  fetchOpenWeatherPositions,
  parseWeatherPositionMeta,
  evaluateWeatherPositionThesis,
} from './weatherThesis.js';
import type { OpenWeatherPosition, WeatherThesisResult } from './weatherThesis.js';
import { tryWeatherExit } from './weatherExit.js';
import {
  fetchLiveObservation,
  classifyOracleState,
  classifyContradiction,
} from './liveObservation.js';
import type { ContradictionClass } from './liveObservation.js';
import {
  conditionalHeldProbability,
  loadClimoTable,
  loadClimoFallTable,
} from './conditionalOracle.js';
import type { ConditionalOracleResult } from './conditionalOracle.js';
import { fetchEnsembleHourly } from './openMeteoClient.js';
import type { EnsembleHourlyForecast } from './openMeteoClient.js';
import { classifyFlipCandidate, tryWeatherFlip } from './weatherFlip.js';
import type { FlipCandidateClass } from './weatherFlip.js';

/**
 * Slice ensemble member trajectories to hours strictly after observedAt.
 * Hours 0..observedAtLocalHour have already been observed; including them
 * would let past (possibly incorrect) model values dominate the final-max
 * distribution, breaking the conditioning on the running max.
 *
 * `hourlyData.hours` are Unix epoch seconds (from the unixtime API param) so
 * the comparison against a true-UTC observedAt is timezone-unambiguous.
 *
 * When all hours are past (late-day obs), returns one empty slice per member
 * so conditionalHeldProbability treats finalMax = observedMax for every member
 * — the correct deterministic answer rather than a climo fallback.
 */
export function sliceToRemainingHours(
  hourlyData: EnsembleHourlyForecast,
  observedAt: string,
): number[][] {
  const obsTimeS = new Date(observedAt).getTime() / 1000;
  const firstIdx = hourlyData.hours.findIndex((t) => t > obsTimeS);
  if (firstIdx === -1) return hourlyData.memberTemps.map(() => []);
  return hourlyData.memberTemps.map((member) => member.slice(firstIdx));
}

// ── Drift state types ────────────────────────────────────────────────────────

export type WeatherDriftState =
  | 'stable'
  | 'watch'
  | 'thesis_weakened'
  | 'modal_against'
  | 'market_against'            // Market price has moved strongly against us (independent of forecast)
  | 'oracle_impossible'         // Phase 5+: binary certainty — held side mathematically cannot win
  | 'oracle_confirmed'          // Phase 5+: binary certainty — held side has already won
  | 'oracle_likely_against'     // Phase A+: conditional oracle estimates bid > P + buffer (probabilistic)
  | 'exit_candidate'            // Phase 3+
  | 'hedge_candidate'           // Phase 4+
  | 'flip_candidate';           // Phase 6+

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
  // Phase 5: live observation
  observedMax: number | null;
  observedSource: string | null;
  liveObsConfidence: string | null;
  oracleState: 'oracle_impossible' | 'oracle_confirmed' | null;
  contradictionClass: ContradictionClass | null;
  // Phase 6: flip
  flipCandidateClass: FlipCandidateClass | null;
  // Bid velocity exit
  bidVelocityTrigger: boolean;
  bidVelocityDrop: number | null;
  // Conditional oracle (Phases A-C)
  conditionalHeldProb: number | null;
  conditionalEstimator: string | null;
  conditionalMembers: number | null;
  conditionalIsStale: boolean | null;
  conditionalClampedByClimo: boolean | null;
  conditionalEstimatorGap: number | null;
  // Phase B audit: did conditional oracle agree/disagree with #470 heuristic exits?
  condOracleAudit: {
    wouldConfirm: boolean | null;
    wouldVeto: boolean | null;
    gap: number | null;
  } | null;
  // Phase B hold guard
  holdGuardVetoed: boolean;
  holdGuardVetoReason: string | null;
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
// Bid velocity: stores the previous scan's bid for rate-of-change comparison.
const PREV_BID_KEY_PREFIX = 'weather:drift_prev_bid:';
const PREV_BID_TTL_S = 3600; // covers 2 scan cycles; auto-expires when position closes
// Conditional oracle result cache: written by drift strategy, read by revalidation pass.
export const COND_ORACLE_RESULT_KEY_PREFIX = 'weather:cond_oracle:';
// 35 min: shorter than one scan cycle (30 min) + execution window, so the read
// side never acts on a blob from a prior cycle. Also mitigates round-1 L1
// (isStale frozen at compute time).
const COND_ORACLE_RESULT_TTL_S = 2100;

// Climo tables loaded once per process (file reads are cheap; content rarely
// changes). The rise table serves highest-temperature markets; the fall table
// serves lowest-temperature markets (P(runningMin − finalMin > delta)).
let _climoTable: ReturnType<typeof loadClimoTable> | undefined;
let _climoFallTable: ReturnType<typeof loadClimoFallTable> | undefined;
function getClimoTable(metric: 'high' | 'low' = 'high') {
  if (metric === 'low') {
    if (_climoFallTable === undefined) _climoFallTable = loadClimoFallTable();
    return _climoFallTable;
  }
  if (_climoTable === undefined) _climoTable = loadClimoTable();
  return _climoTable;
}

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

  const lowestTempActive =
    cfg.WEATHER_LOWEST_TEMP_ENABLED || cfg.WEATHER_LOWEST_TEMP_SHADOW_ENABLED;
  const [rawHighEvents, rawLowEvents] = await Promise.all([
    fetchWeatherEvents(cfg.WEATHER_MAX_EVENTS, 0, 'highest-temperature'),
    lowestTempActive
      ? fetchWeatherEvents(cfg.WEATHER_MAX_EVENTS, 0, 'lowest-temperature')
      : Promise.resolve([]),
  ]);
  const parsedEvents = [...rawHighEvents, ...rawLowEvents]
    .map(parseWeatherEvent)
    .filter((e): e is NonNullable<typeof e> => e !== null);

  const decisions: WeatherDriftDecision[] = [];

  // Phase 6: per-scan and per-city notional caps for flip buys.
  let scanFlipNotionalUsed = 0;
  const cityFlipNotionalUsed: Record<string, number> = {};

  // Per-scan ensemble hourly memo: one GFS fetch per (city, targetDate) regardless of how
  // many brackets for that city-date are held. Avoids N×11 identical API calls per scan.
  const ensembleHourlyMemo = new Map<string, import('./openMeteoClient.js').EnsembleHourlyForecast | null>();

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
      const { city, targetDate, bracketLabel, metric } = meta;

      const event = parsedEvents.find(
        (e) => e.city === city && e.targetDate === targetDate && e.metric === metric,
      );
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
        forecast = await readCachedForecast(redis, city, targetDate, metric).catch(() => null);
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
        ? await getCityBias(redis, city, metric)
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
      // The market object is also kept so its outcomePrices can serve as a fallback
      // bid price when the CLOB book has no resting bids (common for crashed positions).
      let heldTokenId: string | null = null;
      let oppositeTokenId: string | null = null;
      let gammaBidFallback: number | null = null;
      let gammaOppositeAsk: number | null = null;
      try {
        const market = await getMarket(pos.marketId);
        const tokenIds = parseClobTokenIds(market.clobTokenIds);
        heldTokenId = (pos.direction === 'YES' ? tokenIds[0] : tokenIds[1]) ?? null;
        oppositeTokenId = (pos.direction === 'YES' ? tokenIds[1] : tokenIds[0]) ?? null;
        // Parse Gamma's market-implied price for the held side. Index 0 = YES, 1 = NO.
        const prices = parseOutcomePrices(market.outcomePrices);
        const rawPrice = pos.direction === 'YES' ? prices[0] : prices[1];
        const rawOppositePrice = pos.direction === 'YES' ? prices[1] : prices[0];
        const parsed = rawPrice != null ? parseFloat(rawPrice) : NaN;
        const parsedOpp = rawOppositePrice != null ? parseFloat(rawOppositePrice) : NaN;
        // `parsed > 0` intentionally skips resolved markets: Gamma returns "0"
        // for the losing side once the market settles. Those are handled by the
        // reconciler, not the drift scanner.
        if (isFinite(parsed) && parsed > 0) gammaBidFallback = parsed;
        if (isFinite(parsedOpp) && parsedOpp > 0) gammaOppositeAsk = parsedOpp;
      } catch (err) {
        logger.warn('[weather-drift] market fetch failed — market-adverse check and exit skipped', {
          positionId: pos.id,
          marketId: pos.marketId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      let currentHeldBid: number | null = null;
      let bidSource: 'clob' | 'gamma' | null = null;
      let marketDrop = 0;
      let modelMarketGap = 0;
      let marketAgainstTier: 1 | 2 | null = null;

      if (heldTokenId) {
        try {
          const book = await getClobOrderBook(heldTokenId);
          const clobBid = book ? (getBookTouchLevels(book).bestBid?.price ?? null) : null;
          if (clobBid != null) {
            currentHeldBid = clobBid;
            bidSource = 'clob';
          } else if (gammaBidFallback != null) {
            // No resting CLOB bid — use Gamma's market-implied price as a proxy.
            // This fires for truly crashed positions (e.g. NO priced at 0.025 with
            // no one willing to post a resting bid at any meaningful price).
            currentHeldBid = gammaBidFallback;
            bidSource = 'gamma';
          }
        } catch {
          // CLOB unavailable — try Gamma fallback before giving up.
          if (gammaBidFallback != null) {
            currentHeldBid = gammaBidFallback;
            bidSource = 'gamma';
          }
        }

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

      // ── Bid velocity detection ───────────────────────────────────────────────
      // Compare the current bid to the previous scan's bid. A rapid collapse
      // (≥ BID_VELOCITY_THRESHOLD relative drop in one 30-min cycle) on resolution
      // day triggers an exit bypass regardless of the Tier classification.
      let bidVelocityTrigger = false;
      let bidVelocityDrop = 0;
      if (currentHeldBid != null && cfg.WEATHER_DRIFT_BID_VELOCITY_EXIT_ENABLED) {
        const prevBidKey = `${PREV_BID_KEY_PREFIX}${pos.id}`;
        const prevBidRaw = await redis.get(prevBidKey).catch(() => null);
        const prevBid = prevBidRaw != null ? parseFloat(prevBidRaw) : null;
        if (prevBid != null && prevBid > 0) {
          bidVelocityDrop = (prevBid - currentHeldBid) / prevBid;
          if (bidVelocityDrop >= cfg.WEATHER_DRIFT_BID_VELOCITY_THRESHOLD) {
            bidVelocityTrigger = true;
            logger.info('[weather-drift] bid velocity threshold breached', {
              positionId: pos.id,
              prevBid: +prevBid.toFixed(4),
              currentHeldBid: +currentHeldBid.toFixed(4),
              bidVelocityDrop: +bidVelocityDrop.toFixed(3),
              threshold: cfg.WEATHER_DRIFT_BID_VELOCITY_THRESHOLD,
              isResolutionDay,
            });
          }
        }
        await redis.set(prevBidKey, String(currentHeldBid), 'EX', PREV_BID_TTL_S).catch(() => {});
      }

      // ── Phase 5: live observation + oracle state ─────────────────────────────
      // Fetch intraday observed max for the city. Written as a shadow row even
      // when WEATHER_DRIFT_LIVE_OBS_ENABLED=false so data accumulates from day one.
      let liveObs: Awaited<ReturnType<typeof fetchLiveObservation>> | null = null;
      let oracleState: 'oracle_impossible' | 'oracle_confirmed' | null = null;

      const liveObsEnabled = cfg.WEATHER_DRIFT_LIVE_OBS_ENABLED;
      const shouldFetchObs =
        cfg.WEATHER_DRIFT_WU_LIVE_ENABLED ||
        cfg.WEATHER_DRIFT_METAR_LIVE_ENABLED ||
        cfg.WEATHER_DRIFT_HKO_LIVE_ENABLED;

      if (shouldFetchObs) {
        liveObs = await fetchLiveObservation(city, targetDate, redis, {
          wuEnabled: cfg.WEATHER_DRIFT_WU_LIVE_ENABLED,
          metarEnabled: cfg.WEATHER_DRIFT_METAR_LIVE_ENABLED,
          hkoEnabled: cfg.WEATHER_DRIFT_HKO_LIVE_ENABLED,
          maxAgeMin: cfg.WEATHER_DRIFT_LIVE_OBS_MAX_AGE_MIN,
          metric,
          ...(fetchFn != null && { fetchFn: fetchFn as typeof fetch }),
        }).catch((err: unknown) => {
          logger.warn('[weather-drift] live observation fetch failed', {
            positionId: pos.id,
            city,
            targetDate,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        });

        if (liveObs?.observedMax != null) {
          oracleState = classifyOracleState(
            liveObs.observedMax,
            pos.direction,
            { low: bracket.low, high: bracket.high },
            metric,
          );

          // Shadow-log the live observation for every position with a viable source.
          void enqueueWrite('shadow_observations', {
            kind: 'weather_live_observation',
            source: 'arb',
            marketId: pos.marketId,
            direction: pos.direction,
            wouldBlock: false,
            metricValue: liveObs.observedMax,
            payload: {
              positionId: pos.id,
              city,
              targetDate,
              bracketLabel,
              bracketLow: bracket.low,
              bracketHigh: bracket.high,
              direction: pos.direction,
              observedMax: liveObs.observedMax,
              source: liveObs.source,
              confidence: liveObs.confidence,
              observedAt: liveObs.observedAt,
              oracleState,
              isResolutionDay,
              liveObsEnabled,
            },
          });
        }
      }

      // ── Phase 5: market/oracle contradiction classifier ───────────────────────
      // Computes the relationship between forecast model, live oracle, and market price.
      // Shadow-logged when WEATHER_DRIFT_CONTRADICTION_AUDIT_ENABLED.
      const contradictionClass = cfg.WEATHER_DRIFT_CONTRADICTION_AUDIT_ENABLED
        ? classifyContradiction({
            currentHeldBid,
            entryPrice: pos.entryPrice,
            currentHeldProb: result.currentHeldProb,
            oracleState: liveObsEnabled ? oracleState : null,
            oracleConfidence: liveObsEnabled ? (liveObs?.confidence ?? 'none') : 'none',
            forecastState: forecastState as 'stable' | 'watch' | 'thesis_weakened' | 'modal_against',
            marketDeadBid: cfg.WEATHER_DRIFT_MARKET_DEAD_BID,
            contradictionMinModelMarketGap: cfg.WEATHER_DRIFT_CONTRADICTION_MIN_MODEL_MARKET_GAP,
          })
        : null;

      if (contradictionClass != null) {
        void enqueueWrite('shadow_observations', {
          kind: 'weather_market_oracle_contradiction',
          source: 'arb',
          marketId: pos.marketId,
          direction: pos.direction,
          wouldBlock: false,
          metricValue: currentHeldBid,
          payload: {
            positionId: pos.id,
            city,
            targetDate,
            bracketLabel,
            direction: pos.direction,
            contradictionClass,
            currentHeldBid,
            bidSource,
            currentHeldProb: result.currentHeldProb,
            correctedForecastHigh: result.correctedForecastHigh,
            roundedForecast: result.roundedForecast,
            forecastState,
            marketDrop: currentHeldBid != null ? marketDrop : null,
            modelMarketGap: currentHeldBid != null ? modelMarketGap : null,
            marketAgainstTier,
            observedMax: liveObs?.observedMax ?? null,
            liveObsSource: liveObs?.source ?? 'none',
            liveObsConfidence: liveObs?.confidence ?? 'none',
            oracleState,
            requiresOracleAudit: contradictionClass === 'market_contradicts_model',
          },
        });
      }

      // Final state: oracle states take priority over market_against which takes
      // priority over forecast-derived state. forecastState is kept separately for
      // forecast-specific gates (cancel_resting, etc.).
      const resolvedOracleState =
        liveObsEnabled && oracleState != null ? oracleState : null;

      // ── Conditional oracle (Phases A-C) ─────────────────────────────────────
      // Compute conditionalHeldProbability when:
      //   - WEATHER_COND_ORACLE_ENABLED is true
      //   - Binary oracle is inconclusive (resolvedOracleState === null)
      //   - We have a live observation with observedMax
      let condOracleResult: ConditionalOracleResult | null = null;
      if (
        cfg.WEATHER_COND_ORACLE_ENABLED &&
        resolvedOracleState === null &&
        liveObs?.observedMax != null &&
        liveObs.observedAt != null &&
        liveObs.confidence !== 'none'
      ) {
        // Fetch ensemble hourly trajectories on resolution day (or daysOut ≤ 1) only.
        // Memo-ised per (city, targetDate) — multiple brackets for the same event share one fetch.
        let remainingHourlyMembers: number[][] | null = null;
        if (isResolutionDay || daysOut <= 1) {
          try {
            const memoKey = `${city}:${targetDate}`;
            let hourlyData: import('./openMeteoClient.js').EnsembleHourlyForecast | null;
            if (ensembleHourlyMemo.has(memoKey)) {
              hourlyData = ensembleHourlyMemo.get(memoKey) ?? null;
            } else {
              hourlyData = await fetchEnsembleHourly(
                event.coords.lat,
                event.coords.lon,
                targetDate,
                event.coords.unit,
                fetchFn as import('./openMeteoClient.js').FetchFn | undefined,
                cfg.WEATHER_MODEL_ECMWF_ENABLED,
                cfg.WEATHER_FORECAST_RETRY_COUNT,
              ).catch(() => null);
              ensembleHourlyMemo.set(memoKey, hourlyData);
            }
            if (hourlyData && liveObs?.observedAt)
              remainingHourlyMembers = sliceToRemainingHours(hourlyData, liveObs.observedAt);
          } catch {
            // Non-fatal: fall back to climo-only
          }
        }

        try {
          condOracleResult = conditionalHeldProbability({
            city,
            direction: pos.direction,
            bracket: { low: bracket.low, high: bracket.high },
            observedMax: liveObs.observedMax,
            metric,
            observedAt: liveObs.observedAt,
            tz: event.coords.tz,
            remainingHourlyMembers,
            climoTable: cfg.WEATHER_COND_ORACLE_CLIMO_FALLBACK_ENABLED ? getClimoTable(metric) : null,
            biasCorrection: cityBias?.meanBias ?? 0,
            spreadInflation: cfg.WEATHER_COND_ORACLE_SPREAD_INFLATION,
            minMembers: cfg.WEATHER_COND_ORACLE_MIN_MEMBERS,
            maxObsAgeMin: cfg.WEATHER_COND_ORACLE_MAX_OBS_AGE_MIN,
            estimatorMaxGap: cfg.WEATHER_COND_ORACLE_ESTIMATOR_MAX_GAP,
          });
        } catch (err) {
          logger.warn('[weather-drift] conditional oracle error', {
            positionId: pos.id,
            city,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        if (condOracleResult) {
          // Cache result for the revalidation pass (reads it for fourth cancel rule).
          // Key on marketId (not city/date) to avoid cross-bracket contamination
          // when multiple brackets share the same city, date and direction.
          const condKey = `${COND_ORACLE_RESULT_KEY_PREFIX}${pos.marketId}:${pos.direction}`;
          void redis.set(
            condKey,
            JSON.stringify({
              heldProb: condOracleResult.heldProb,
              isStale: condOracleResult.isStale,
              estimator: condOracleResult.estimator,
              confidence: liveObs.confidence,
              computedAt: Date.now(),
            }),
            'EX',
            COND_ORACLE_RESULT_TTL_S,
          ).catch(() => {});

          // Shadow-log the conditional oracle evaluation.
          void enqueueWrite('shadow_observations', {
            kind: 'weather_cond_oracle',
            source: 'arb',
            marketId: pos.marketId,
            direction: pos.direction,
            wouldBlock: false,
            metricValue: condOracleResult.heldProb,
            payload: {
              positionId: pos.id,
              city,
              targetDate,
              bracketLabel,
              bracketLow: bracket.low,
              bracketHigh: bracket.high,
              direction: pos.direction,
              observedMax: liveObs.observedMax,
              observedAt: liveObs.observedAt,
              observedAtLocalHour: condOracleResult.observedAtLocalHour,
              isResolutionDay,
              heldProb: condOracleResult.heldProb,
              estimator: condOracleResult.estimator,
              members: condOracleResult.members,
              isStale: condOracleResult.isStale,
              clampedByClimo: condOracleResult.clampedByClimo,
              estimatorGap: condOracleResult.estimatorGap,
              climoHeldProb: condOracleResult.climoHeldProb,
              staticModelHeldProb: result.currentHeldProb,
              bestBid: currentHeldBid,
              bidSource,
              softExitEnabled: cfg.WEATHER_COND_ORACLE_SOFT_EXIT_ENABLED,
              wouldExitOnFairValue: currentHeldBid != null && !condOracleResult.isStale
                ? currentHeldBid > condOracleResult.heldProb + cfg.WEATHER_COND_ORACLE_EXIT_COST_BUFFER
                : null,
            },
          });
        }
      }

      // Compute oracle_likely_against state when soft exit is enabled.
      // Requires settlement_aligned obs so climo-only (no live obs) can't drive an exit.
      const condOracleLikelyAgainst =
        condOracleResult != null &&
        !condOracleResult.isStale &&
        liveObs?.confidence === 'settlement_aligned' &&
        currentHeldBid != null &&
        currentHeldBid > condOracleResult.heldProb + cfg.WEATHER_COND_ORACLE_EXIT_COST_BUFFER;

      const state: WeatherDriftState =
        resolvedOracleState ??
        (condOracleLikelyAgainst && cfg.WEATHER_COND_ORACLE_SOFT_EXIT_ENABLED
          ? 'oracle_likely_against'
          : marketAgainstTier != null
            ? 'market_against'
            : forecastState);

      // ── Phase B: hold guard ──────────────────────────────────────────────────
      // When conditionalP - bid ≥ HOLD_GUARD_GAP with fresh settlement-aligned obs,
      // veto res-day exits driven by bid-velocity OR forecast state (thesis_weakened /
      // modal_against). Does NOT veto binary oracle exits or market_against exits.
      let holdGuardVetoed = false;
      let holdGuardVetoReason: string | null = null;
      if (
        cfg.WEATHER_COND_ORACLE_HOLD_GUARD_ENABLED &&
        isResolutionDay &&
        (bidVelocityTrigger || forecastState === 'thesis_weakened' || forecastState === 'modal_against') &&
        condOracleResult != null &&
        !condOracleResult.isStale &&
        liveObs?.confidence === 'settlement_aligned' &&
        currentHeldBid != null
      ) {
        const pMinusBid = condOracleResult.heldProb - currentHeldBid;
        if (pMinusBid >= cfg.WEATHER_COND_ORACLE_HOLD_GUARD_GAP) {
          holdGuardVetoed = true;
          holdGuardVetoReason =
            bidVelocityTrigger && (forecastState === 'thesis_weakened' || forecastState === 'modal_against')
              ? 'bid_velocity+forecast_state'
              : bidVelocityTrigger
                ? 'bid_velocity'
                : 'forecast_state';
          logger.info('[weather-drift] hold guard vetoing exit', {
            positionId: pos.id,
            vetoReason: holdGuardVetoReason,
            conditionalP: +condOracleResult.heldProb.toFixed(3),
            currentHeldBid: +currentHeldBid.toFixed(4),
            pMinusBid: +pMinusBid.toFixed(3),
            gap: cfg.WEATHER_COND_ORACLE_HOLD_GUARD_GAP,
          });
        }
      }

      // Phase A audit: for each scan where a #470 heuristic would fire, record whether
      // the conditional oracle would have confirmed or vetoed (even while SOFT_EXIT is dark).
      let condOracleAudit: WeatherDriftDecision['condOracleAudit'] = null;
      if (
        cfg.WEATHER_COND_ORACLE_ENABLED &&
        condOracleResult != null &&
        (bidVelocityTrigger || marketAgainstTier === 2 ||
          forecastState === 'thesis_weakened' || forecastState === 'modal_against')
      ) {
        const wouldConfirm = condOracleResult.isStale
          ? null
          : currentHeldBid != null &&
            currentHeldBid > condOracleResult.heldProb + cfg.WEATHER_COND_ORACLE_EXIT_COST_BUFFER;
        // Compute wouldVeto independently of HOLD_GUARD_ENABLED so Phase A audit
        // data captures hypothetical vetoes while the guard knob is dark.
        // Covers both bid-velocity and forecast-state exits (not oracle_impossible).
        const wouldVeto = condOracleResult.isStale
          ? null
          : (bidVelocityTrigger || forecastState === 'thesis_weakened' || forecastState === 'modal_against') &&
            isResolutionDay &&
            state !== 'oracle_impossible' &&
            liveObs?.confidence === 'settlement_aligned' &&
            currentHeldBid != null &&
            condOracleResult.heldProb - currentHeldBid >= cfg.WEATHER_COND_ORACLE_HOLD_GUARD_GAP;
        condOracleAudit = {
          wouldConfirm,
          wouldVeto,
          gap: currentHeldBid != null ? condOracleResult.heldProb - currentHeldBid : null,
        };
      }

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
        state === 'market_against' ||
        // Oracle states always alert — the settlement outcome may be decided even on
        // non-resolution days (max only increases). Notification fires regardless of
        // whether exit is gated to resolution day.
        state === 'oracle_impossible' ||
        state === 'oracle_confirmed' ||
        state === 'oracle_likely_against' ||
        // Bid velocity: rapid collapse on resolution day warrants immediate notification + exit.
        (bidVelocityTrigger && isResolutionDay);
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
          // 1. Exit gate (highest priority).
          //
          // market_against Tier 1: both market and model moved — exit on resolution day.
          // market_against Tier 2: market moved but model can't update intraday.
          //   When TIER2_EXIT_ON_RES_DAY, exit anyway on resolution day (market IS the oracle).
          const marketAgainstCanExit =
            state === 'market_against' &&
            (marketAgainstTier === 1 ||
              (marketAgainstTier === 2 && isResolutionDay && cfg.WEATHER_DRIFT_TIER2_EXIT_ON_RES_DAY));
          // oracle_confirmed means our held side is the winner — never exit via drift.
          // Hold guard may veto thesis_weakened/modal_against on res-day when fresh
          // settlement-aligned oracle says P is still favorable (oracle_impossible is exempt).
          const forecastCanExit =
            state !== 'market_against' &&
            state !== 'oracle_confirmed' &&
            state !== 'oracle_likely_against' && // conditional oracle has its own gate below
            !(holdGuardVetoed && state !== 'oracle_impossible');
          // oracle_impossible is permanent (daily max only rises) — exit any day, not just res-day.
          const oracleImpossibleCanExit = state === 'oracle_impossible';
          // Bid velocity: rapid single-scan collapse on resolution day bypasses Tier logic.
          // Hold guard may veto when fresh conditional oracle says hold.
          const bidVelocityCanExit = bidVelocityTrigger && isResolutionDay && !holdGuardVetoed;
          // Conditional oracle soft exit (Phase B): bid > conditionalP + buffer on res-day.
          const conditionalOracleCanExit =
            cfg.WEATHER_COND_ORACLE_SOFT_EXIT_ENABLED &&
            state === 'oracle_likely_against' &&
            isResolutionDay;

          const shouldExit =
            oracleImpossibleCanExit ||
            bidVelocityCanExit ||
            conditionalOracleCanExit ||
            (isResolutionDay && (forecastCanExit || marketAgainstCanExit));

          if (cfg.WEATHER_DRIFT_EXIT_ENABLED && shouldExit && heldTokenId) {
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
              extraContext: {
                driftState: state, marketAgainstTier, bidSource,
                ...(bidVelocityTrigger && { bidVelocityTrigger, bidVelocityDrop: +bidVelocityDrop.toFixed(3) }),
              },
            }).catch(() => false);
            if (exited) action = 'exit';
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

      // 4. Phase 6: flip candidate classification + optional execution.
      // Classify unconditionally (even when block_size_up fired) so that:
      //  a. Shadow rows always capture flip candidate data.
      //  b. oracle_impossible positions that are ALSO thesis_weakened (isBlockable) are
      //     not silently skipped — block_size_up has no bearing on whether a flip is valid.
      // Execution is gated to action === 'none' | 'block_size_up': we don't flip after
      // an exit (position already sold) or after a cancel_resting (still re-evaluating).
      const flipCandidateClass: FlipCandidateClass | null = classifyFlipCandidate({
        state,
        oracleState: resolvedOracleState,
        oracleConfidence: liveObs?.confidence ?? 'none',
        contradictionClass,
        marketAgainstTier,
        currentHeldBid,
        marketDeadBid: cfg.WEATHER_DRIFT_MARKET_DEAD_BID,
        currentHeldProb: result.currentHeldProb,
        modalStreak: result.modalStreak,
        // Use the exact-bracket exit min runs as the flip confirmation threshold.
        modalMinRunsForFlip: cfg.WEATHER_DRIFT_EXACT_EXIT_MODAL_MIN_RUNS ?? 2,
      });

      if (
        flipCandidateClass != null &&
        (action === 'none' || action === 'block_size_up') &&
        cfg.WEATHER_DRIFT_ENABLED &&
        cfg.WEATHER_DRIFT_FLIP_ENABLED &&
        heldTokenId &&
        oppositeTokenId
      ) {
        const oppositeDirection = pos.direction === 'YES' ? 'NO' : 'YES';
        // confirmed_flip: the oracle has settlement-proven the opposite side wins.
        // The forecast model may still believe the held side is ~0.99 likely, which
        // would yield ~0.01 fair value for the opposite and fail the edge gate.
        // Use 1.0 for oracle-confirmed cases; conditional oracle (Phase C) when
        // available and fresh; static model-derived value otherwise.
        const oppositeModelFairValue =
          flipCandidateClass === 'confirmed_flip'
            ? 1.0
            : cfg.WEATHER_COND_ORACLE_FLIP_FAIR_VALUE_ENABLED &&
              condOracleResult != null &&
              !condOracleResult.isStale
              ? Math.max(0, 1 - condOracleResult.heldProb)
              : Math.max(0, 1 - result.currentHeldProb);

        const cityFlipUsed = cityFlipNotionalUsed[city] ?? 0;
        const remainingCityNotional = cfg.WEATHER_DRIFT_FLIP_MAX_CITY_NOTIONAL - cityFlipUsed;
        const remainingScanNotional = cfg.WEATHER_DRIFT_FLIP_MAX_SCAN_NOTIONAL - scanFlipNotionalUsed;

        const flipResult = await tryWeatherFlip({
          redis,
          pos,
          city,
          targetDate,
          bracketLabel,
          heldTokenId,
          oppositeTokenId,
          oppositeDirection,
          currentHeldProb: result.currentHeldProb,
          oppositeModelFairValue,
          flipCandidateClass,
          isResolutionDay,
          confirmedOnly: cfg.WEATHER_DRIFT_FLIP_CONFIRMED_ONLY,
          minEdgeBps: cfg.WEATHER_DRIFT_FLIP_MIN_EDGE_BPS,
          maxOppositePrice: cfg.WEATHER_DRIFT_FLIP_MAX_OPPOSITE_PRICE,
          remainingScanNotional,
          remainingCityNotional,
          exitCooldownKey: `${DRIFT_EXIT_COOLDOWN_KEY_PREFIX}${pos.id}`,
          exitCooldownS: cfg.WEATHER_DRIFT_EXIT_COOLDOWN_S,
          exitedKey: `${EXITED_KEY_PREFIX}${pos.id}`,
          exitedTtlS: EXITED_TTL_S,
          flipCooldownS: cfg.WEATHER_DRIFT_EXIT_COOLDOWN_S,
          extraContext: { driftState: state, oracleState: resolvedOracleState, contradictionClass, bidSource },
        }).catch((err: unknown) => {
          logger.warn('[weather-drift] flip error', {
            positionId: pos.id,
            error: err instanceof Error ? err.message : String(err),
          });
          return { executed: false, amountUsd: 0, reason: 'unexpected_error' } as const;
        });

        if (flipResult.executed) {
          action = 'flip';
          scanFlipNotionalUsed += flipResult.amountUsd;
          cityFlipNotionalUsed[city] = (cityFlipNotionalUsed[city] ?? 0) + flipResult.amountUsd;
        }
      }

      // 5. Notify fallback + notification fire (actionable positions only).
      // Runs after block_size_up and flip so the notification shows the final action.
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
        observedMax: liveObs?.observedMax ?? null,
        observedSource: liveObs?.source ?? null,
        liveObsConfidence: liveObs?.confidence ?? null,
        oracleState: resolvedOracleState,
        contradictionClass,
        flipCandidateClass,
        bidVelocityTrigger,
        bidVelocityDrop: cfg.WEATHER_DRIFT_BID_VELOCITY_EXIT_ENABLED ? bidVelocityDrop : null,
        conditionalHeldProb: condOracleResult?.heldProb ?? null,
        conditionalEstimator: condOracleResult?.estimator ?? null,
        conditionalMembers: condOracleResult?.members ?? null,
        conditionalIsStale: condOracleResult?.isStale ?? null,
        conditionalClampedByClimo: condOracleResult?.clampedByClimo ?? null,
        conditionalEstimatorGap: condOracleResult?.estimatorGap ?? null,
        condOracleAudit,
        holdGuardVetoed,
        holdGuardVetoReason,
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
          bidSource,
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
          bidSource,
          marketDrop: currentHeldBid != null ? marketDrop : null,
          modelMarketGap: currentHeldBid != null ? modelMarketGap : null,
          marketAgainstTier,
          observedMax: liveObs?.observedMax ?? null,
          observedSource: liveObs?.source ?? null,
          liveObsConfidence: liveObs?.confidence ?? null,
          oracleState: resolvedOracleState,
          contradictionClass,
          flipCandidateClass,
          bidVelocityTrigger,
          bidVelocityDrop: cfg.WEATHER_DRIFT_BID_VELOCITY_EXIT_ENABLED && currentHeldBid != null
            ? bidVelocityDrop
            : null,
          conditionalHeldProb: condOracleResult?.heldProb ?? null,
          conditionalEstimator: condOracleResult?.estimator ?? null,
          conditionalMembers: condOracleResult?.members ?? null,
          conditionalIsStale: condOracleResult?.isStale ?? null,
          conditionalClampedByClimo: condOracleResult?.clampedByClimo ?? null,
          conditionalEstimatorGap: condOracleResult?.estimatorGap ?? null,
          condOracleAudit,
          holdGuardVetoed,
          holdGuardVetoReason,
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

/**
 * Nowcast entry scan (Phase C shadow / Phase D live).
 *
 * For each resolution-day opportunity without a size-up flag, computes the
 * conditional oracle P(trade side wins | current observed max) and writes a
 * `weather_nowcast_entry` shadow row. Live execution is deferred to Phase D
 * (backtesting first) — even when `WEATHER_COND_ORACLE_NOWCAST_ENTRY_ENABLED`
 * is true, the current implementation logs the signal but does not place an order.
 *
 * Gated on `WEATHER_COND_ORACLE_ENABLED`. Safe to call when there are no
 * res-day opportunities — returns immediately.
 *
 * Log marker: [weather-nowcast]
 */
export async function runWeatherNowcastScan(
  redis: Redis,
  opportunities: WeatherBracketOpportunity[],
  fetchFn?: FetchFn,
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.WEATHER_COND_ORACLE_ENABLED) return;

  const resDayOpps = opportunities.filter((o) => o.isResolutionDay === true && !o.sizeUpScanOnly);
  if (resDayOpps.length === 0) return;

  // Memo-ised ensemble hourly per (city, targetDate) — multiple brackets for the same
  // event would otherwise each trigger an identical GFS fetch.
  const ensembleHourlyMemo = new Map<string, import('./openMeteoClient.js').EnsembleHourlyForecast | null>();

  for (const opp of resDayOpps) {
    try {
      const cityCoords = lookupCity(opp.city);
      if (!cityCoords) continue;

      const bracket = parseBracketLabel(opp.bracketLabel);
      if (!bracket) continue;

      const liveObs = await fetchLiveObservation(opp.city, opp.targetDate, redis, {
        wuEnabled: cfg.WEATHER_DRIFT_WU_LIVE_ENABLED,
        metarEnabled: cfg.WEATHER_DRIFT_METAR_LIVE_ENABLED,
        hkoEnabled: cfg.WEATHER_DRIFT_HKO_LIVE_ENABLED,
        maxAgeMin: cfg.WEATHER_COND_ORACLE_MAX_OBS_AGE_MIN,
        metric: opp.metric,
        ...(fetchFn != null && { fetchFn: fetchFn as typeof fetch }),
      }).catch((): null => null);

      if (!liveObs || liveObs.observedMax == null || liveObs.observedAt == null || liveObs.confidence === 'none') continue;

      const nowcastMemoKey = `${opp.city}:${opp.targetDate}`;
      let ensembleHourly: import('./openMeteoClient.js').EnsembleHourlyForecast | null;
      if (ensembleHourlyMemo.has(nowcastMemoKey)) {
        ensembleHourly = ensembleHourlyMemo.get(nowcastMemoKey) ?? null;
      } else {
        ensembleHourly = await fetchEnsembleHourly(
          cityCoords.lat, cityCoords.lon, opp.targetDate, opp.unit, fetchFn,
          cfg.WEATHER_MODEL_ECMWF_ENABLED, cfg.WEATHER_FORECAST_RETRY_COUNT,
        ).catch((): null => null);
        ensembleHourlyMemo.set(nowcastMemoKey, ensembleHourly);
      }

      const bias = await getCityBias(redis, opp.city, opp.metric).catch((): null => null);

      const remainingMembers = ensembleHourly
        ? sliceToRemainingHours(ensembleHourly, liveObs.observedAt)
        : null;

      const condResult = conditionalHeldProbability({
        city: opp.city,
        direction: opp.tradeSide,
        bracket: { low: bracket.low, high: bracket.high },
        observedMax: liveObs.observedMax,
        metric: opp.metric,
        observedAt: liveObs.observedAt,
        tz: cityCoords.tz,
        remainingHourlyMembers: remainingMembers,
        climoTable: getClimoTable(opp.metric),
        biasCorrection: bias?.meanBias ?? 0,
        spreadInflation: cfg.WEATHER_COND_ORACLE_SPREAD_INFLATION,
        minMembers: cfg.WEATHER_COND_ORACLE_MIN_MEMBERS,
        maxObsAgeMin: cfg.WEATHER_COND_ORACLE_MAX_OBS_AGE_MIN,
        estimatorMaxGap: cfg.WEATHER_COND_ORACLE_ESTIMATOR_MAX_GAP,
      });

      if (condResult == null) continue;

      // Write the cache so the fourth revalidation cancel rule can protect resting
      // orders without held positions (unfilled scenario). Key on marketId (not
      // city/date) to avoid cross-bracket contamination between multiple brackets
      // sharing the same city, date and direction. No NX: nowcast runs first in
      // the scan order (before revalidation), so it establishes the base value;
      // the drift loop may overwrite with a held-position computation later in
      // the same cycle — both use the same market so the overwrite is coherent.
      const nowcastCacheKey = `${COND_ORACLE_RESULT_KEY_PREFIX}${opp.marketId}:${opp.tradeSide}`;
      void redis.set(
        nowcastCacheKey,
        JSON.stringify({
          heldProb: condResult.heldProb,
          isStale: condResult.isStale,
          estimator: condResult.estimator,
          confidence: liveObs.confidence,
          computedAt: Date.now(),
        }),
        'EX',
        COND_ORACLE_RESULT_TTL_S,
      ).catch(() => {});

      // Edge vs the executable CLOB ask, not just Gamma's outcomePrice (a mid/last
      // proxy). Gamma mids overstate entry edge on thin books — the doc's Phase C
      // gate requires realized-EV measured against asks at signal time. Fall back
      // to outcomePrice when the book has no resting ask (edgeBasis records which).
      let bestAsk: number | null = null;
      const sideTokenId = (opp.tradeSide === 'YES' ? opp.clobTokenIds?.[0] : opp.clobTokenIds?.[1]) ?? null;
      if (sideTokenId) {
        try {
          const book = await getClobOrderBook(sideTokenId);
          bestAsk = book ? (getBookTouchLevels(book).bestAsk?.price ?? null) : null;
        } catch {
          bestAsk = null;
        }
      }

      const edgeVsMid = condResult.heldProb - opp.outcomePrice;
      const edgeVsAsk = bestAsk != null ? condResult.heldProb - bestAsk : null;
      const edgeBasis: 'ask' | 'mid' = edgeVsAsk != null ? 'ask' : 'mid';
      const edge = edgeVsAsk ?? edgeVsMid;
      const meetsEdge = !condResult.isStale && edge >= cfg.WEATHER_COND_ORACLE_NOWCAST_MIN_EDGE;

      void enqueueWrite('shadow_observations', {
        kind: 'weather_nowcast_entry',
        source: 'arb',
        marketId: opp.marketId,
        direction: opp.tradeSide,
        wouldBlock: false,
        metricValue: condResult.heldProb,
        payload: {
          city: opp.city,
          targetDate: opp.targetDate,
          bracketLabel: opp.bracketLabel,
          bracketLow: bracket.low,
          bracketHigh: bracket.high,
          direction: opp.tradeSide,
          observedMax: liveObs.observedMax,
          observedAt: liveObs.observedAt,
          observedAtLocalHour: condResult.observedAtLocalHour,
          liveObsConfidence: liveObs.confidence,
          conditionalHeldProb: condResult.heldProb,
          estimator: condResult.estimator,
          members: condResult.members,
          isStale: condResult.isStale,
          clampedByClimo: condResult.clampedByClimo,
          estimatorGap: condResult.estimatorGap,
          climoHeldProb: condResult.climoHeldProb,
          outcomePrice: opp.outcomePrice,
          bestAsk,
          edgeBasis,
          edgeVsMid: +edgeVsMid.toFixed(4),
          edgeVsAsk: edgeVsAsk != null ? +edgeVsAsk.toFixed(4) : null,
          edge: +edge.toFixed(4),
          minEdge: cfg.WEATHER_COND_ORACLE_NOWCAST_MIN_EDGE,
          meetsEdge,
          nowcastEnabled: cfg.WEATHER_COND_ORACLE_NOWCAST_ENTRY_ENABLED,
        },
      });

      if (meetsEdge && cfg.WEATHER_COND_ORACLE_NOWCAST_ENTRY_ENABLED) {
        logger.info('[weather-nowcast] entry signal (Phase D execution deferred)', {
          city: opp.city,
          marketId: opp.marketId,
          direction: opp.tradeSide,
          conditionalHeldProb: +condResult.heldProb.toFixed(3),
          outcomePrice: +opp.outcomePrice.toFixed(3),
          bestAsk,
          edgeBasis,
          edge: +edge.toFixed(3),
          estimator: condResult.estimator,
          liveObsConfidence: liveObs.confidence,
        });
      }
    } catch (err) {
      logger.warn('[weather-nowcast] error evaluating opportunity (non-fatal)', {
        marketId: opp.marketId,
        city: opp.city,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
