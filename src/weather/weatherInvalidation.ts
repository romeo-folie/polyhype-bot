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
import type { FetchFn } from './noaaClient.js';
import { getCityBias } from './cityBias.js';
// Circular-safe: these are only called at runtime (inside async functions),
// never at module-initialisation time, so the live bindings are fully resolved
// before any function body executes.
import {
  fetchWeatherEvents,
  parseWeatherEvent,
  fetchForecast,
  daysUntil,
  computeBiasedProb,
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
      const [hedgeMarkerRaw, lockInMarkerRaw, cooldownMarkerRaw] = await redis
        .mget(hedgeKey, lockInKey, hedgeCooldownKey)
        .catch((): [null, null, null] => [null, null, null]);
      const alreadyHedged = !!(hedgeMarkerRaw || lockInMarkerRaw);
      // Skip if hedge partial-fill cooldown is active (C5 fix).
      if (cooldownMarkerRaw) continue;

      const daysOut = daysUntil(targetDate);

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
      const invalidated =
        drop >= cfg.WEATHER_FORECAST_INVALIDATION_MIN_DROP &&
        currentHeldProb <= cfg.WEATHER_FORECAST_INVALIDATION_MIN_CURRENT_HELD_PROB;

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
      try {
        const tokenIds = parseClobTokenIds(market.clobTokenIds);
        // tokenIds[0]=YES, tokenIds[1]=NO; buy the opposite of our held side.
        const idx = pos.direction === 'YES' ? 1 : 0;
        const id = tokenIds[idx];
        if (!id) {
          logger.warn('[weather-invalidation] opposite tokenId not found — skipping hedge', {
            positionId: pos.id,
            marketId: pos.marketId,
            direction: pos.direction,
          });
          continue;
        }
        oppositeTokenId = id;
      } catch (err) {
        logger.warn('[weather-invalidation] failed to parse clobTokenIds — skipping hedge', {
          positionId: pos.id,
          marketId: pos.marketId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const book = await getClobOrderBook(oppositeTokenId);
      if (!book || !book.asks || book.asks.length === 0) {
        logger.debug('[weather-invalidation] no asks on opposite side — skipping hedge', {
          positionId: pos.id,
          marketId: pos.marketId,
          direction: pos.direction,
        });
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

      if (!wouldHedge || alreadyHedged || !cfg.WEATHER_FORECAST_INVALIDATION_HEDGE_ENABLED) continue;

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
