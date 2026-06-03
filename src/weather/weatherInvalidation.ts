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
import { getSql } from '../db/client.js';
import { getMarket, parseClobTokenIds } from '../mapping/gamma.js';
import { getClobOrderBook, submitClobBuy } from '../shared/clob.js';
import { deductStake } from '../shared/bankroll.js';
import { dedup } from '../shared/redis.js';
import type { FetchFn } from './noaaClient.js';
import { getCityBias } from './cityBias.js';
import { notifyWeatherInvalidationNoHedge } from '../execution/telegram.js';
import { getPosition } from '../execution/positionLedger.js';
import { executeTakeProfit } from '../monitor/takeProfitExecutor.js';
import { cityLocalDate } from './resolutionTime.js';
// Circular-safe: these are only called at runtime (inside async functions),
// never at module-initialisation time, so the live bindings are fully resolved
// before any function body executes.
import {
  fetchWeatherEvents,
  parseWeatherEvent,
  fetchForecast,
  daysUntil,
  computeBiasedProb,
  forecastRoundsIntoBracket,
} from './weatherScanner.js';

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

// Matches: weather:<city>:<YYYY-MM-DD>:<bracketLabel>
const SOURCED_FROM_RE = /^weather:(.+):(\d{4}-\d{2}-\d{2}):(.+)$/;

interface OpenWeatherPosition {
  id: string;
  marketId: string;
  direction: 'YES' | 'NO';
  entryPrice: number;
  sharesHeld: number;
  consensusProbability: number;
  sourcedFrom: string;
}

async function fetchOpenWeatherPositions(): Promise<OpenWeatherPosition[]> {
  const sql = getSql();
  return sql<OpenWeatherPosition[]>`
    SELECT
      id::text                      AS id,
      market_id                     AS "marketId",
      direction                     AS direction,
      entry_price::float8           AS "entryPrice",
      shares_held::float8           AS "sharesHeld",
      consensus_probability::float8 AS "consensusProbability",
      sourced_from                  AS "sourcedFrom"
    FROM positions
    WHERE sourced_from LIKE 'weather:%'
      AND pending_settlement = false
      AND closed_at IS NULL
      AND shares_held > 0
    ORDER BY opened_at DESC
  `;
}

interface ParsedSourcedFrom {
  city: string;
  targetDate: string;
  bracketLabel: string;
}

function parseWeatherSourcedFrom(sourcedFrom: string): ParsedSourcedFrom | null {
  const m = sourcedFrom.match(SOURCED_FROM_RE);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return { city: m[1], targetDate: m[2], bracketLabel: m[3] };
}

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
 * Resolution-day price-gated exit. Returns true only when the held side was actually
 * sold (executeTakeProfit succeeded); false in every other case so the caller
 * notifies instead.
 */
async function tryInvalidationExit(opts: ExitOrNotifyOpts): Promise<boolean> {
  const { redis, cfg, pos, heldTokenId, isResolutionDay, currentHeldProb, hedgeBarrier, invalidationReason } = opts;

  if (!cfg.WEATHER_FORECAST_INVALIDATION_EXIT_ENABLED) return false;
  // Only on resolution day — before then we let the position ride in case the
  // forecast migrates back into our bracket.
  if (!isResolutionDay) return false;

  // Defer if a prior sell failed recently — avoids re-submitting a taker market sell
  // every scan on a transient CLOB/RPC error (the fallback notify still fires).
  const exitCooldownKey = `${EXIT_FAIL_COOLDOWN_KEY_PREFIX}${pos.id}`;
  if (await redis.get(exitCooldownKey).catch(() => null)) {
    logger.debug('[weather-invalidation] exit on cooldown after a prior failed sell — deferring', {
      positionId: pos.id,
      marketId: pos.marketId,
    });
    return false;
  }

  // Held-side bid book: the side we SELL. Independent of the opposite-asks the hedge
  // checks, so a `no_book` barrier does not mean we cannot sell our own side.
  const heldBook = await getClobOrderBook(heldTokenId);
  const bestBid = parseFloat(String(heldBook?.bids?.[0]?.price ?? '0'));
  if (!isFinite(bestBid) || bestBid <= 0) {
    logger.info('[weather-invalidation] exit declined — no held-side bid', {
      positionId: pos.id,
      marketId: pos.marketId,
      hedgeBarrier,
    });
    return false;
  }

  const minExitPrice = cfg.WEATHER_FORECAST_INVALIDATION_MIN_EXIT_PRICE;
  const slippageFloor = currentHeldProb - cfg.WEATHER_FORECAST_INVALIDATION_MAX_EXIT_SLIPPAGE;
  // Floor anchoring. The continuous held-prob is systematically overconfident (the model
  // is a worse forecaster than the market — closed-bet calibration), so a slippage floor
  // anchored to it guards model-fantasy value: e.g. a held_prob_drop to 0.37 while the
  // market bid is 0.01. So we anchor the exit to the market (absolute MIN_EXIT_PRICE floor
  // only — sell at the best bid) rather than the model prob, gated per invalidation reason:
  // modal_inversion → MODAL_MARKET_FLOOR; held_prob_drop / both → DROP_MARKET_FLOOR. When a
  // gate is off, that reason falls back to the model-anchored slippage floor.
  const useMarketFloor =
    invalidationReason === 'modal_inversion'
      ? cfg.WEATHER_FORECAST_INVALIDATION_MODAL_MARKET_FLOOR
      : cfg.WEATHER_FORECAST_INVALIDATION_DROP_MARKET_FLOOR;
  const exitFloor = useMarketFloor ? minExitPrice : Math.max(minExitPrice, slippageFloor);
  if (bestBid < exitFloor) {
    logger.info('[weather-invalidation] exit declined — bid below floor', {
      positionId: pos.id,
      marketId: pos.marketId,
      hedgeBarrier,
      invalidationReason,
      floorMode: useMarketFloor ? 'market' : 'slippage',
      bestBid: +bestBid.toFixed(4),
      minExitPrice,
      slippageFloor: +slippageFloor.toFixed(4),
      exitFloor: +exitFloor.toFixed(4),
      currentHeldProb: +currentHeldProb.toFixed(4),
    });
    return false;
  }

  // Depth gate: executeTakeProfit submits a *market* sell, which walks down the book.
  // Top-of-book clearing the floor is not enough — require the cumulative bid size at
  // or above the floor to absorb the whole position, so the fill cannot sweep below
  // exitFloor. Without this, 10 shares can dump into a 1-share top bid above an air
  // pocket and realize far below the gate-passing price.
  let depthAtOrAboveFloor = 0;
  for (const level of heldBook?.bids ?? []) {
    const price = parseFloat(String(level?.price ?? '0'));
    const size = parseFloat(String(level?.size ?? '0'));
    if (isFinite(price) && isFinite(size) && price >= exitFloor) depthAtOrAboveFloor += size;
  }
  if (depthAtOrAboveFloor < pos.sharesHeld) {
    logger.info('[weather-invalidation] exit declined — insufficient bid depth above floor', {
      positionId: pos.id,
      marketId: pos.marketId,
      hedgeBarrier,
      sharesHeld: pos.sharesHeld,
      depthAtOrAboveFloor: +depthAtOrAboveFloor.toFixed(2),
      exitFloor: +exitFloor.toFixed(4),
      bestBid: +bestBid.toFixed(4),
    });
    return false;
  }

  // executeTakeProfit + closePosition operate on the Redis ledger, not the Postgres
  // snapshot the scan queried — load the canonical position.
  const ledgerPos = await getPosition(redis, pos.marketId, pos.direction);
  if (!ledgerPos) {
    logger.warn('[weather-invalidation] exit declined — no ledger position', {
      positionId: pos.id,
      marketId: pos.marketId,
      direction: pos.direction,
    });
    return false;
  }

  const returnPct =
    pos.entryPrice > 0 ? ((bestBid - pos.entryPrice) / pos.entryPrice) * 100 : 0;
  logger.info('[weather-invalidation] exiting invalidated position', {
    positionId: pos.id,
    marketId: pos.marketId,
    direction: pos.direction,
    hedgeBarrier,
    bestBid: +bestBid.toFixed(4),
    entryPrice: pos.entryPrice,
    returnPct: +returnPct.toFixed(2),
  });

  const result = await executeTakeProfit({
    position: ledgerPos,
    currentPrice: bestBid,
    returnPct,
    reason: 'weather_invalidation',
    redis,
  });

  if (!result.success) {
    logger.warn('[weather-invalidation] exit sell failed — cooling down, falling back to notify', {
      positionId: pos.id,
      marketId: pos.marketId,
      error: result.error,
    });
    // Suppress sell retries for a cooldown window; the fallback notify still alerts.
    await redis.set(exitCooldownKey, '1', 'EX', EXIT_FAIL_COOLDOWN_S).catch(() => {});
    return false;
  }

  // Idempotency marker so a follow-up scan can't re-enter before the close/pending
  // write drops the row out of the SQL snapshot.
  await redis.set(`${EXITED_KEY_PREFIX}${pos.id}`, '1', 'EX', EXITED_TTL_S).catch(() => {});

  void enqueueWrite('shadow_observations', {
    kind: 'weather_forecast_invalidation_exit',
    source: 'arb',
    marketId: pos.marketId,
    direction: pos.direction,
    wouldBlock: false,
    metricValue: bestBid,
    threshold: minExitPrice,
    payload: {
      positionId: pos.id,
      city: opts.city,
      targetDate: opts.targetDate,
      bracketLabel: opts.bracketLabel,
      hedgeBarrier,
      bestBid,
      entryPrice: pos.entryPrice,
      sharesHeld: pos.sharesHeld,
      currentHeldProb,
      returnPct,
      realizedReturnPct: result.returnPct,
      minExitPrice,
      maxExitSlippage: cfg.WEATHER_FORECAST_INVALIDATION_MAX_EXIT_SLIPPAGE,
      invalidationReason: opts.invalidationReason,
    },
  });

  logger.info('[weather-invalidation] exit executed', {
    positionId: pos.id,
    marketId: pos.marketId,
    direction: pos.direction,
    hedgeBarrier,
    bestBid: +bestBid.toFixed(4),
    realizedReturnPct: +result.returnPct.toFixed(2),
  });
  return true;
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

  // Fetch active events once and parse — reused across all positions.
  const rawEvents = await fetchWeatherEvents(cfg.WEATHER_MAX_EVENTS);
  const parsedEvents = rawEvents
    .map(parseWeatherEvent)
    .filter((e): e is NonNullable<typeof e> => e !== null);

  for (const pos of positions) {
    try {
      const parsed = parseWeatherSourcedFrom(pos.sourcedFrom);
      if (!parsed) {
        logger.debug('[weather-invalidation] unparseable sourcedFrom — skipping', {
          positionId: pos.id,
          sourcedFrom: pos.sourcedFrom,
        });
        continue;
      }

      const { city, targetDate, bracketLabel } = parsed;

      const event = parsedEvents.find((e) => e.city === city && e.targetDate === targetDate);
      if (!event) {
        logger.debug('[weather-invalidation] no active Gamma event found — skipping', {
          positionId: pos.id,
          city,
          targetDate,
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
      const exitedKey = `${EXITED_KEY_PREFIX}${pos.id}`;
      const [hedgeMarkerRaw, lockInMarkerRaw, cooldownMarkerRaw, modalStreakRaw, exitedMarkerRaw] = await redis
        .mget(hedgeKey, lockInKey, hedgeCooldownKey, modalStreakKey, exitedKey)
        .catch((): [null, null, null, null, null] => [null, null, null, null, null]);
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
        logger.debug('[weather-invalidation] forecast unavailable — skipping', {
          positionId: pos.id,
          city,
          targetDate,
        });
        continue;
      }

      const cityBias = cfg.WEATHER_BIAS_CORRECTION_ENABLED
        ? await getCityBias(redis, city)
        : null;

      // Use bracket.low/high directly — bracket was already parsed by parseWeatherEvent
      // so re-calling parseBracketLabel would be redundant (C4 fix).
      const { modelProbability: currentModelProb, effectiveStdDev, correctedForecastHigh, biasMode } =
        computeBiasedProb(bracket.low, bracket.high, daysOut, forecast, {
          stddevMultiplier: cfg.WEATHER_STDDEV_MULTIPLIER,
          cityBias,
          biasCorrectionEnabled: cfg.WEATHER_BIAS_CORRECTION_ENABLED,
          biasMinSamples: cfg.WEATHER_BIAS_MIN_SAMPLES,
          biasTrustedSamples: cfg.WEATHER_BIAS_TRUSTED_SAMPLES,
          weakBiasStddevMultiplier: cfg.WEATHER_WEAK_BIAS_STDDEV_MULTIPLIER,
        });

      // Entry held probability: P(our side) at time of entry
      const entryHeldProb =
        pos.direction === 'YES' ? pos.consensusProbability : 1 - pos.consensusProbability;

      // Current held probability: P(our side) now
      const currentHeldProb =
        pos.direction === 'YES' ? currentModelProb : 1 - currentModelProb;

      const drop = entryHeldProb - currentHeldProb;

      // Held-prob degradation: the whole distribution shifted away from our side.
      const dropInvalidated =
        drop >= cfg.WEATHER_FORECAST_INVALIDATION_MIN_DROP &&
        currentHeldProb <= cfg.WEATHER_FORECAST_INVALIDATION_MIN_CURRENT_HELD_PROB;

      // Modal inversion: the corrected forecast's central estimate has crossed the
      // rounding boundary relative to our bracket — the same predicate the entry
      // scanner uses to refuse interior-NO bets (weatherScanner interior guard). A
      // wide stddev can keep the continuous held-prob high even as the modal outcome
      // flips against us, so this catches inversions dropInvalidated misses. Only
      // bounded brackets carry the signal — tails have an open side the forecast
      // cannot "round out of".
      let modalInversionRaw = false;
      let roundedForecast: number | null = null;
      if (
        cfg.WEATHER_FORECAST_INVALIDATION_MODAL_ENABLED &&
        bracket.low !== null &&
        bracket.high !== null
      ) {
        roundedForecast = Math.round(correctedForecastHigh);
        const forecastInBracket = forecastRoundsIntoBracket(
          correctedForecastHigh,
          bracket.low,
          bracket.high,
        );
        // NO thesis = "high will NOT land in bracket": inverted when forecast rounds in.
        // YES thesis = "high WILL land in bracket": inverted when forecast rounds out.
        modalInversionRaw = pos.direction === 'NO' ? forecastInBracket : !forecastInBracket;
      }

      // Debounce: require the inversion to persist for MIN_RUNS consecutive scans
      // before it counts. Increment the streak on an inverting run, reset it (delete
      // the key) the moment the forecast rounds back to the supporting side.
      let modalStreak = 0;
      if (modalInversionRaw) {
        modalStreak = (parseInt(modalStreakRaw ?? '0', 10) || 0) + 1;
        await redis
          .set(modalStreakKey, String(modalStreak), 'EX', MODAL_STREAK_TTL_S)
          .catch(() => {});
      } else if (modalStreakRaw) {
        await redis.del(modalStreakKey).catch(() => {});
      }
      const modalInvalidated =
        modalInversionRaw && modalStreak >= cfg.WEATHER_FORECAST_INVALIDATION_MODAL_MIN_RUNS;

      const invalidated = dropInvalidated || modalInvalidated;
      const invalidationReason = !invalidated
        ? null
        : dropInvalidated && modalInvalidated
          ? 'both'
          : dropInvalidated
            ? 'held_prob_drop'
            : 'modal_inversion';

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
        modalStreak,
        modalMinRuns: cfg.WEATHER_FORECAST_INVALIDATION_MODAL_MIN_RUNS,
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
          modalStreak,
          modalMinRuns: cfg.WEATHER_FORECAST_INVALIDATION_MODAL_MIN_RUNS,
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

      const bestAsk = book.asks[0];
      if (!bestAsk) continue;
      const oppositeAsk = parseFloat(String(bestAsk.price));
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

      const amountUsd = pos.sharesHeld * oppositeAsk;
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
