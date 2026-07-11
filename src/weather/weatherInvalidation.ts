/**
 * Weather Forecast Invalidation Scanner
 *
 * Revalidates open weather positions against the latest forecast. When the
 * held-side model probability drops materially below the entry thesis, the
 * scanner shadow-logs the degradation (always), blocks size-ups via a Redis
 * key (WEATHER_FORECAST_INVALIDATION_ENABLED), and optionally hedges by
 * buying the opposite token cheaply (WEATHER_FORECAST_INVALIDATION_HEDGE_ENABLED).
 *
 * Ships dark with shadow logging on by default.
 *
 * Redis keys:
 *   weather:forecast_invalidated:<marketId>:<direction>  TTL: WEATHER_FORECAST_INVALIDATION_TTL_S
 *   weather:forecast_hedged:<positionId>                  TTL: 14 days
 *
 * Log marker: [weather-invalidation]
 */

import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { getMarket, parseClobTokenIds } from '../mapping/gamma.js';
import { getClobOrderBook, submitClobBuy, CLOB_MIN_ORDER_USD } from '../shared/clob.js';
import { getBookTouchLevels } from '../shared/bookTouch.js';
import { deductStake } from '../shared/bankroll.js';
import { dedup } from '../shared/redis.js';
import type { FetchFn } from './noaaClient.js';
import { getCityBias } from './cityBias.js';
import { notifyWeatherInvalidationNoHedge } from '../execution/telegram.js';
import { cityLocalDate } from './resolutionTime.js';
import { cacheForecast, readCachedForecast } from './forecastCache.js';
// Circular-safe: these are only called at runtime (inside async functions),
// never at module-initialisation time, so the live bindings are fully resolved
// before any function body executes.
import {
  fetchWeatherEvents,
  parseWeatherEvent,
  fetchForecast,
  daysUntil,
} from './weatherScanner.js';
import {
  fetchOpenWeatherPositions,
  parseWeatherPositionMeta,
  evaluateWeatherPositionThesis,
} from './weatherThesis.js';
export { parseWeatherMetaFromQuestion } from './weatherThesis.js';
import type { OpenWeatherPosition } from './weatherThesis.js';
import { tryWeatherExit } from './weatherExit.js';

export const FORECAST_INVALIDATED_KEY_PREFIX = 'weather:forecast_invalidated:';
const HEDGE_KEY_PREFIX = 'weather:forecast_hedged:';
// Must match LOCK_KEY_PREFIX in weatherLockIn.ts — both scanners check both
// markers so a position is not double-hedged on the same opposite token.
const LOCK_IN_KEY_PREFIX = 'weather:locked:';
// Cooldown key set on partial hedge fill: suppresses retry for 30 min so
// the bankroll isn't decremented on every scan cycle for the same position.
const HEDGE_PARTIAL_COOLDOWN_KEY_PREFIX = 'weather:forecast_hedge_partial_cooldown:';
const HEDGE_PARTIAL_COOLDOWN_S = 30 * 60;
const HEDGE_TTL_S = 14 * 24 * 3600;

// CLOB rejects orders below CLOB_MIN_ORDER_USD, and a 1:1 hedge on a collapsed
// opposite side is often pennies (sharesHeld × ask). Same rule as the lock-in
// scanner (weatherLockIn.ts): bump to the minimum when the intended notional is
// at least this fraction of it (≤1.67× overshoot — the extra opposite shares
// are cents of exposure on the side the model now favors); below the fraction,
// skip rather than submit a doomed order. Duplicated, not shared via
// shared/clob.ts, because the weather test suites mock that module wholesale —
// a helper there would be mocked away under vi.mock factories.
const HEDGE_MIN_ORDER_BUMP_RATIO = 0.6;
// Idempotency marker for the Phase 5 resolution-day exit. Set once a held-side
// sell succeeds so a second scan (before the closed/pending position drops out of
// the SQL query) cannot re-enter the exit path. Mirrors the hedge marker's TTL.
const EXITED_KEY_PREFIX = 'weather:forecast_exited:';
const EXITED_TTL_S = 14 * 24 * 3600;
// Cooldown after a failed exit sell so a transient CLOB/RPC failure (which does not
// mark the position pendingSettlement) does not re-submit a taker market sell on
// every scan. Mirrors the hedge partial-fill cooldown; the position still notifies
// via the manual-action fallback while the sell is on cooldown.
const EXIT_FAIL_COOLDOWN_KEY_PREFIX = 'weather:forecast_exit_cooldown:';
const EXIT_FAIL_COOLDOWN_S = 30 * 60;
// Consecutive-run counter for the modal-inversion debounce. TTL spans several
// 30-min scan intervals so a single missed run doesn't reset a building streak,
// while a position that resolves or drifts away expires on its own.
const MODAL_STREAK_KEY_PREFIX = 'weather:forecast_modal_streak:';
const MODAL_STREAK_TTL_S = 2 * 3600;
// "Has the modal EVER supported our thesis since we started observing?" marker
// (guard B). A modal inversion only counts as a real thesis flip when the modal was
// on our side at some earlier scan — a position whose modal was never on our side (a
// sub-modal longshot YES on a narrow bracket, say) was never inverted, it was always
// this way. Set/refreshed on every supporting scan with a long TTL so it survives the
// whole holding window. Keyed by pos.id like the streak/hedge/exited markers.
const MODAL_SUPPORTED_KEY_PREFIX = 'weather:forecast_modal_supported:';
const MODAL_SUPPORTED_TTL_S = 14 * 24 * 3600;


interface ExitOrNotifyOpts {
  redis: Redis;
  cfg: ReturnType<typeof loadConfig>;
  pos: OpenWeatherPosition;
  city: string;
  targetDate: string;
  bracketLabel: string;
  invalidationReason: string;
  drop: number;
  currentHeldProb: number;
  isResolutionDay: boolean;
  heldTokenId: string;
  hedgeBarrier: 'no_book' | 'price_too_high' | 'cost_ceiling';
  /** Hedge-book context — present only for the price/cost barriers, forwarded to the notify. */
  oppositeAsk?: number;
  maxHedgePrice?: number;
  maxTotalCost?: number;
  costTotal?: number;
}

/**
 * Attempt a resolution-day, price-gated exit of an invalidated position; fall back
 * to the manual-action notification when the exit is disabled, off resolution day,
 * or the held-side bid fails the floor.
 *
 * The exit SELLS the held token (needs held-side *bids*) — a different book from the
 * opposite-token *asks* the hedge checks. So a `no_book` hedge barrier (no opposite
 * asks) does not imply we cannot sell; we fetch the held book independently.
 */
async function exitOrNotifyOnInvalidation(opts: ExitOrNotifyOpts): Promise<void> {
  const exited = await tryInvalidationExit(opts).catch((err: unknown) => {
    logger.warn('[weather-invalidation] exit attempt threw — falling back to notify', {
      positionId: opts.pos.id,
      marketId: opts.pos.marketId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  });
  if (exited) return;

  const { cfg, pos, hedgeBarrier } = opts;
  const isFirst = await dedup(
    `weather:forecast_invalidation_alert:${pos.id}:${hedgeBarrier}`,
    cfg.WEATHER_FORECAST_INVALIDATION_TTL_S,
  ).catch(() => false);
  if (!isFirst) return;

  await notifyWeatherInvalidationNoHedge({
    positionId: pos.id,
    marketId: pos.marketId,
    city: opts.city,
    targetDate: opts.targetDate,
    bracketLabel: opts.bracketLabel,
    direction: pos.direction,
    entryPrice: pos.entryPrice,
    sharesHeld: pos.sharesHeld,
    invalidationReason: opts.invalidationReason,
    drop: opts.drop,
    currentHeldProb: opts.currentHeldProb,
    hedgeBarrier,
    ...(opts.oppositeAsk !== undefined ? { oppositeAsk: opts.oppositeAsk } : {}),
    ...(opts.maxHedgePrice !== undefined ? { maxHedgePrice: opts.maxHedgePrice } : {}),
    ...(opts.maxTotalCost !== undefined ? { maxTotalCost: opts.maxTotalCost } : {}),
    ...(opts.costTotal !== undefined ? { costTotal: opts.costTotal } : {}),
  }).catch((err: unknown) => {
    logger.warn('[weather-invalidation] alert notification failed', {
      positionId: pos.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Resolution-day price-gated exit. Thin wrapper over the shared tryWeatherExit
 * helper — supplies invalidation-specific keys and config values.
 */
async function tryInvalidationExit(opts: ExitOrNotifyOpts): Promise<boolean> {
  const { redis, cfg, pos, heldTokenId, isResolutionDay, currentHeldProb, hedgeBarrier, invalidationReason } = opts;
  // Floor anchoring per reason: modal_inversion → market floor (model is overconfident);
  // held_prob_drop/both → also market floor when configured, else slippage-anchored.
  const useMarketFloor =
    invalidationReason === 'modal_inversion'
      ? cfg.WEATHER_FORECAST_INVALIDATION_MODAL_MARKET_FLOOR
      : cfg.WEATHER_FORECAST_INVALIDATION_DROP_MARKET_FLOOR;
  return tryWeatherExit({
    redis,
    pos,
    city: opts.city,
    targetDate: opts.targetDate,
    bracketLabel: opts.bracketLabel,
    heldTokenId,
    currentHeldProb,
    invalidationReason,
    enabled: cfg.WEATHER_FORECAST_INVALIDATION_EXIT_ENABLED,
    isResolutionDay,
    minExitPrice: cfg.WEATHER_FORECAST_INVALIDATION_MIN_EXIT_PRICE,
    maxExitSlippage: cfg.WEATHER_FORECAST_INVALIDATION_MAX_EXIT_SLIPPAGE,
    useMarketFloor,
    exitCooldownKey: `${EXIT_FAIL_COOLDOWN_KEY_PREFIX}${pos.id}`,
    exitCooldownS: EXIT_FAIL_COOLDOWN_S,
    exitedKey: `${EXITED_KEY_PREFIX}${pos.id}`,
    exitedTtlS: EXITED_TTL_S,
    exitReason: 'weather_invalidation',
    shadowKind: 'weather_forecast_invalidation_exit',
    logMarker: '[weather-invalidation]',
    extraContext: { hedgeBarrier },
  });
}

/** Run one forecast-invalidation scan cycle. */
export async function runWeatherInvalidationScan(redis: Redis, fetchFn?: FetchFn): Promise<void> {
  const cfg = loadConfig();

  if (!cfg.WEATHER_FORECAST_INVALIDATION_SHADOW_ENABLED && !cfg.WEATHER_FORECAST_INVALIDATION_ENABLED) {
    return;
  }

  let positions: OpenWeatherPosition[];
  try {
    positions = await fetchOpenWeatherPositions();
  } catch (err) {
    logger.warn('[weather-invalidation] DB query failed — aborting scan', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (positions.length === 0) return;

  // Fetch active events once and parse — reused across all positions. Include
  // lowest-temperature events when that feature is active so held low positions
  // can find their Gamma event.
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

  for (const pos of positions) {
    try {
      const parsed = parseWeatherPositionMeta(pos.sourcedFrom, pos.question);
      if (!parsed) {
        logger.debug('[weather-invalidation] unparseable sourcedFrom — skipping', {
          positionId: pos.id,
          sourcedFrom: pos.sourcedFrom,
        });
        continue;
      }

      const { city, targetDate, bracketLabel, metric } = parsed;

      // Match on metric too: a city runs both a highest- and lowest-temperature
      // event on the same day, so city+date alone is ambiguous.
      const event = parsedEvents.find(
        (e) => e.city === city && e.targetDate === targetDate && e.metric === metric,
      );
      if (!event) {
        logger.debug('[weather-invalidation] no active Gamma event found — skipping', {
          positionId: pos.id,
          city,
          targetDate,
          metric,
        });
        continue;
      }

      const bracket = event.brackets.find((b) => b.label === bracketLabel);
      if (!bracket) {
        logger.debug('[weather-invalidation] bracket not found in event — skipping', {
          positionId: pos.id,
          city,
          bracketLabel,
        });
        continue;
      }

      // Check both hedge markers in one round-trip: the invalidation-hedge marker
      // and the lock-in marker (set by weatherLockIn). Neither scanner should
      // submit a second opposite-side buy when the other has already done so.
      const hedgeKey = `${HEDGE_KEY_PREFIX}${pos.id}`;
      const lockInKey = `${LOCK_IN_KEY_PREFIX}${pos.id}`;
      const hedgeCooldownKey = `${HEDGE_PARTIAL_COOLDOWN_KEY_PREFIX}${pos.id}`;
      // Modal-inversion streak: consecutive runs the corrected forecast has been on
      // the inverting side of the bracket boundary. Debounces half-degree flapping
      // (e.g. 75.45→76.0) so a single boundary-straddling run can't trip the trigger.
      // Keyed by pos.id (like the hedge/cooldown markers) so two open rows on the same
      // market+direction can't double-increment one shared counter within a scan.
      const modalStreakKey = `${MODAL_STREAK_KEY_PREFIX}${pos.id}`;
      const modalSupportedKey = `${MODAL_SUPPORTED_KEY_PREFIX}${pos.id}`;
      const exitedKey = `${EXITED_KEY_PREFIX}${pos.id}`;
      const [
        hedgeMarkerRaw,
        lockInMarkerRaw,
        cooldownMarkerRaw,
        modalStreakRaw,
        modalSupportedMarkerRaw,
        exitedMarkerRaw,
      ] = await redis
        .mget(hedgeKey, lockInKey, hedgeCooldownKey, modalStreakKey, modalSupportedKey, exitedKey)
        .catch((): [null, null, null, null, null, null] => [null, null, null, null, null, null]);
      const alreadyHedged = !!(hedgeMarkerRaw || lockInMarkerRaw);
      // Skip if hedge partial-fill cooldown is active (C5 fix).
      if (cooldownMarkerRaw) continue;
      // Skip if we already sold this position out on a prior resolution-day scan —
      // the close/pending write may not have propagated to the SQL snapshot yet.
      if (exitedMarkerRaw) continue;

      const daysOut = daysUntil(targetDate);
      // Resolution day = the target date equals the current local date in the
      // city's timezone — the exact predicate the entry/size-up/bracket logic uses
      // (weatherScanner). NOT the same as daysOut === 0 (which is UTC-based and can
      // be true a few hours before the city's local resolution day). The Phase 5
      // exit only fires on resolution day so a pre-resolution invalidation still
      // lets the position ride in case the forecast swings back.
      const isResolutionDay = event.targetDate === cityLocalDate(event.coords.tz);

      // Use the same forecast stack as the main scanner so the probability we
      // compare against the entry thesis is derived from identical model inputs.
      // In particular, HRRR must be enabled for same-day US markets when
      // WEATHER_HRRR_ENABLED=true, otherwise the invalidation guard would use a
      // different (and weaker) deterministic base than the entry/size-up scanner.
      // Monitoring may use the ensemble-only fallback (allowEnsembleOnly): when
      // all deterministic sources fail but the ensemble endpoint is up, the
      // ensemble mean keeps invalidation coverage alive through provider
      // outages. Fresh ENTRIES never get this fallback.
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
        // Persist for the next outage window (best-effort). Only live fetches
        // are written — cache-sourced results below never re-write, so the TTL
        // reflects true data age.
        void cacheForecast(redis, city, targetDate, forecast).catch(() => {});
      } else {
        // Last resort: the most recent successful forecast (≤ cache TTL old).
        // On a 30-min monitoring cadence a slightly stale forecast beats a
        // blind skip (2026-06-04 outage blinded the whole sweep).
        forecast = await readCachedForecast(redis, city, targetDate, metric).catch(() => null);
        if (!forecast) {
          logger.debug('[weather-invalidation] forecast unavailable and no cache — skipping', {
            positionId: pos.id,
            city,
            targetDate,
          });
          continue;
        }
        logger.info('[weather-invalidation] live forecast unavailable — using cached forecast', {
          positionId: pos.id,
          city,
          targetDate,
          source: forecast.source,
        });
      }

      const cityBias = cfg.WEATHER_BIAS_CORRECTION_ENABLED
        ? await getCityBias(redis, city, metric)
        : null;

      const thesisResult = evaluateWeatherPositionThesis({
        pos,
        bracketSemantics: event.coords.bracketSemantics === 'floor' ? 'floor' : 'round',
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
      });

      // Apply Redis write signals from the shared evaluator.
      if (thesisResult.shouldWriteModalStreak) {
        await redis
          .set(modalStreakKey, String(thesisResult.modalStreak), 'EX', MODAL_STREAK_TTL_S)
          .catch(() => {});
      } else if (thesisResult.shouldDeleteModalStreak) {
        await redis.del(modalStreakKey).catch(() => {});
      }
      if (thesisResult.shouldRefreshSupportedMarker) {
        await redis
          .set(modalSupportedKey, '1', 'EX', MODAL_SUPPORTED_TTL_S)
          .catch(() => {});
      }

      const {
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
        modalWasEverSupported,
        modalStreak,
        dropInvalidated,
        modalInvalidated,
        invalidated,
        invalidationReason,
      } = thesisResult;

      const invalidKey = `${FORECAST_INVALIDATED_KEY_PREFIX}${pos.marketId}:${pos.direction}`;

      logger.info('[weather-invalidation] position evaluated', {
        positionId: pos.id,
        marketId: pos.marketId,
        direction: pos.direction,
        city,
        targetDate,
        bracketLabel,
        daysOut,
        entryHeldProb: +entryHeldProb.toFixed(3),
        currentModelProb: +currentModelProb.toFixed(3),
        currentHeldProb: +currentHeldProb.toFixed(3),
        drop: +drop.toFixed(3),
        invalidated,
        invalidationReason,
        modalInvalidated,
        modalInversionRaw,
        modalSupportsThesis,
        modalWasEverSupported,
        modalStreak,
        modalMinRuns: cfg.WEATHER_FORECAST_INVALIDATION_MODAL_MIN_RUNS,
        modalMaxHeldProb: cfg.WEATHER_FORECAST_INVALIDATION_MODAL_MAX_HELD_PROB,
        roundedForecast,
        invalidationEnabled: cfg.WEATHER_FORECAST_INVALIDATION_ENABLED,
        minDrop: cfg.WEATHER_FORECAST_INVALIDATION_MIN_DROP,
        minCurrentHeldProb: cfg.WEATHER_FORECAST_INVALIDATION_MIN_CURRENT_HELD_PROB,
        biasMode,
        forecastHigh: correctedForecastHigh.toFixed(1),
        effectiveStdDev: effectiveStdDev.toFixed(2),
      });

      void enqueueWrite('shadow_observations', {
        kind: 'weather_forecast_invalidation',
        source: 'arb',
        marketId: pos.marketId,
        direction: pos.direction,
        wouldBlock: !invalidated || !cfg.WEATHER_FORECAST_INVALIDATION_ENABLED,
        metricValue: drop,
        threshold: cfg.WEATHER_FORECAST_INVALIDATION_MIN_DROP,
        payload: {
          positionId: pos.id,
          city,
          targetDate,
          bracketLabel,
          daysOut,
          entryHeldProb,
          currentModelProb,
          currentHeldProb,
          drop,
          invalidated,
          invalidationReason,
          modalInvalidated,
          modalInversionRaw,
          modalSupportsThesis,
          modalWasEverSupported,
          modalStreak,
          modalMinRuns: cfg.WEATHER_FORECAST_INVALIDATION_MODAL_MIN_RUNS,
          modalMaxHeldProb: cfg.WEATHER_FORECAST_INVALIDATION_MODAL_MAX_HELD_PROB,
          roundedForecast,
          forecastHigh: forecast.forecastHigh,
          correctedForecastHigh,
          effectiveStdDev,
          biasMode,
          forecastSource: forecast.source,
          ensembleMembers: forecast.ensembleMembers,
          minDrop: cfg.WEATHER_FORECAST_INVALIDATION_MIN_DROP,
          minCurrentHeldProb: cfg.WEATHER_FORECAST_INVALIDATION_MIN_CURRENT_HELD_PROB,
          invalidationEnabled: cfg.WEATHER_FORECAST_INVALIDATION_ENABLED,
        },
      });

      if (invalidated && cfg.WEATHER_FORECAST_INVALIDATION_ENABLED) {
        await redis
          .set(
            invalidKey,
            JSON.stringify({
              city,
              targetDate,
              bracketLabel,
              entryHeldProb,
              currentHeldProb,
              drop,
              observedAt: new Date().toISOString(),
            }),
            'EX',
            cfg.WEATHER_FORECAST_INVALIDATION_TTL_S,
          )
          .catch(() => {});
        logger.info('[weather-invalidation] size-up block key set', {
          positionId: pos.id,
          marketId: pos.marketId,
          direction: pos.direction,
          invalidKey,
          ttlS: cfg.WEATHER_FORECAST_INVALIDATION_TTL_S,
        });
      }

      // Phase 4: evaluate hedge opportunity for invalidated positions.
      // Shadow-logs regardless of HEDGE_ENABLED so operators can preview candidates
      // before enabling (C1 fix). Execution is gated on alreadyHedged + HEDGE_ENABLED.
      if (!invalidated) continue;

      let market;
      try {
        market = await getMarket(pos.marketId);
      } catch (err) {
        logger.warn('[weather-invalidation] Gamma market fetch failed — skipping hedge', {
          positionId: pos.id,
          marketId: pos.marketId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      let oppositeTokenId: string;
      let heldTokenId: string;
      try {
        const tokenIds = parseClobTokenIds(market.clobTokenIds);
        // tokenIds[0]=YES, tokenIds[1]=NO. Buy the opposite of our held side to
        // hedge; sell the held side itself to exit.
        const oppositeIdx = pos.direction === 'YES' ? 1 : 0;
        const heldIdx = pos.direction === 'YES' ? 0 : 1;
        const oppId = tokenIds[oppositeIdx];
        const heldId = tokenIds[heldIdx];
        if (!oppId || !heldId) {
          logger.warn('[weather-invalidation] tokenId not found — skipping hedge', {
            positionId: pos.id,
            marketId: pos.marketId,
            direction: pos.direction,
          });
          continue;
        }
        oppositeTokenId = oppId;
        heldTokenId = heldId;
      } catch (err) {
        logger.warn('[weather-invalidation] failed to parse clobTokenIds — skipping hedge', {
          positionId: pos.id,
          marketId: pos.marketId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const book = await getClobOrderBook(oppositeTokenId);
      if (!book?.asks || book.asks.length === 0) {
        logger.debug('[weather-invalidation] no asks on opposite side — skipping hedge', {
          positionId: pos.id,
          marketId: pos.marketId,
          direction: pos.direction,
        });
        if (!alreadyHedged) {
          await exitOrNotifyOnInvalidation({
            redis,
            cfg,
            pos,
            city,
            targetDate,
            bracketLabel,
            invalidationReason: invalidationReason!,
            drop,
            currentHeldProb,
            isResolutionDay,
            heldTokenId,
            hedgeBarrier: 'no_book',
          });
        }
        continue;
      }

      // Order-agnostic touch: asks[0] on a REST book is the WORST ask —
      // reading it inflated hedge cost into price_too_high/cost_ceiling skips.
      const oppositeAsk = getBookTouchLevels(book).bestAsk?.price ?? 0;
      if (!isFinite(oppositeAsk) || oppositeAsk <= 0) continue;

      const costTotal = pos.entryPrice + oppositeAsk;
      const meetsHedgePrice = oppositeAsk <= cfg.WEATHER_FORECAST_INVALIDATION_MAX_HEDGE_PRICE;
      const meetsCostCeiling = costTotal <= cfg.WEATHER_FORECAST_INVALIDATION_MAX_TOTAL_COST;
      const wouldHedge = meetsHedgePrice && meetsCostCeiling;
      const hedgeDirection = pos.direction === 'YES' ? 'NO' : 'YES';

      logger.info('[weather-invalidation] hedge evaluated', {
        positionId: pos.id,
        marketId: pos.marketId,
        direction: pos.direction,
        hedgeDirection,
        entryPrice: pos.entryPrice,
        oppositeAsk,
        costTotal: +costTotal.toFixed(4),
        meetsHedgePrice,
        meetsCostCeiling,
        wouldHedge,
        enabled: cfg.WEATHER_FORECAST_INVALIDATION_HEDGE_ENABLED,
      });

      void enqueueWrite('shadow_observations', {
        kind: 'weather_forecast_invalidation_hedge',
        source: 'arb',
        marketId: pos.marketId,
        direction: hedgeDirection,
        wouldBlock: !wouldHedge || alreadyHedged || !cfg.WEATHER_FORECAST_INVALIDATION_HEDGE_ENABLED,
        metricValue: oppositeAsk,
        threshold: cfg.WEATHER_FORECAST_INVALIDATION_MAX_HEDGE_PRICE,
        payload: {
          positionId: pos.id,
          direction: pos.direction,
          hedgeDirection,
          entryPrice: pos.entryPrice,
          sharesHeld: pos.sharesHeld,
          oppositeAsk,
          costTotal,
          meetsHedgePrice,
          meetsCostCeiling,
          alreadyHedged,
          hedgeEnabled: cfg.WEATHER_FORECAST_INVALIDATION_HEDGE_ENABLED,
          maxHedgePrice: cfg.WEATHER_FORECAST_INVALIDATION_MAX_HEDGE_PRICE,
          maxTotalCost: cfg.WEATHER_FORECAST_INVALIDATION_MAX_TOTAL_COST,
        },
      });

      if (alreadyHedged) continue;
      if (!wouldHedge || !cfg.WEATHER_FORECAST_INVALIDATION_HEDGE_ENABLED) {
        // Only alert for market-condition barriers (price too high / cost ceiling),
        // not when the feature is intentionally disabled.
        if (!wouldHedge) {
          const barrier = !meetsHedgePrice ? 'price_too_high' : 'cost_ceiling';
          await exitOrNotifyOnInvalidation({
            redis,
            cfg,
            pos,
            city,
            targetDate,
            bracketLabel,
            invalidationReason: invalidationReason!,
            drop,
            currentHeldProb,
            isResolutionDay,
            heldTokenId,
            hedgeBarrier: barrier,
            oppositeAsk,
            maxHedgePrice: cfg.WEATHER_FORECAST_INVALIDATION_MAX_HEDGE_PRICE,
            maxTotalCost: cfg.WEATHER_FORECAST_INVALIDATION_MAX_TOTAL_COST,
            costTotal,
          });
        }
        continue;
      }

      const intendedUsd = pos.sharesHeld * oppositeAsk;
      if (intendedUsd < CLOB_MIN_ORDER_USD * HEDGE_MIN_ORDER_BUMP_RATIO) {
        // Too far below the exchange minimum to bump 1:1-ish. Deliberately a
        // plain skip rather than the exitOrNotify path: an ask this cheap on a
        // ≥MIN_BET-sized position means the held side is effectively winning
        // (the hedge would be near-free if it were buyable), and dust slivers
        // aren't worth forcing exits over. Re-evaluated next scan.
        logger.info('[weather-invalidation] hedge notional too far below CLOB minimum — skipping', {
          positionId: pos.id,
          marketId: pos.marketId,
          direction: pos.direction,
          oppositeAsk,
          intendedUsd: Number(intendedUsd.toFixed(4)),
          minOrderUsd: CLOB_MIN_ORDER_USD,
          bumpRatio: HEDGE_MIN_ORDER_BUMP_RATIO,
        });
        continue;
      }
      const amountUsd = Math.max(intendedUsd, CLOB_MIN_ORDER_USD);
      if (amountUsd > intendedUsd) {
        logger.info('[weather-invalidation] bumping hedge order to CLOB minimum', {
          positionId: pos.id,
          marketId: pos.marketId,
          direction: pos.direction,
          intendedUsd: Number(intendedUsd.toFixed(4)),
          amountUsd,
        });
      }
      const result = await submitClobBuy({ tokenId: oppositeTokenId, amountUsd, orderType: 'FAK' });

      if (result.success) {
        const sharesBought = result.shares_bought ?? 0;
        const fillRatio = pos.sharesHeld > 0 ? sharesBought / pos.sharesHeld : 0;
        if (fillRatio < cfg.WEATHER_FORECAST_INVALIDATION_MIN_FILL_RATIO) {
          logger.warn('[weather-invalidation] partial hedge fill below threshold — marker not set, will retry', {
            positionId: pos.id,
            sharesNeeded: pos.sharesHeld,
            sharesBought,
            fillRatio: +fillRatio.toFixed(3),
            minFillRatio: cfg.WEATHER_FORECAST_INVALIDATION_MIN_FILL_RATIO,
          });
          await deductStake(redis, result.cost ?? amountUsd * fillRatio);
          // Cooldown: suppress retry for 30 min so bankroll isn't decremented every
          // scan cycle on a persistently thin book (C5 fix).
          await redis
            .set(hedgeCooldownKey, '1', 'EX', HEDGE_PARTIAL_COOLDOWN_S)
            .catch(() => {});
          continue;
        }
        await redis.set(hedgeKey, '1', 'EX', HEDGE_TTL_S);
        await deductStake(redis, result.cost ?? amountUsd);
        logger.info('[weather-invalidation] hedge executed', {
          positionId: pos.id,
          marketId: pos.marketId,
          direction: pos.direction,
          hedgeDirection,
          oppositeAsk,
          amountUsd: +amountUsd.toFixed(2),
          sharesBought,
          cost: result.cost,
        });
      } else {
        logger.warn('[weather-invalidation] CLOB buy failed for hedge', {
          positionId: pos.id,
          marketId: pos.marketId,
          hedgeDirection,
          error: result.error,
        });
      }
    } catch (err) {
      logger.warn('[weather-invalidation] unexpected error for position — continuing', {
        positionId: pos.id,
        marketId: pos.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
