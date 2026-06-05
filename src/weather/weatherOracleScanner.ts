/**
 * Weather Oracle Scanner
 *
 * After the reconciler writes WU daily high data for yesterday, scans active
 * weather markets for brackets whose outcome is now known but price hasn't
 * fully adjusted. Buys the winning side.
 *
 * Ships dark (WEATHER_ORACLE_ENABLED=false). Shadow-logs all opportunities
 * regardless of enabled state.
 *
 * Log marker: [weather-oracle]
 */

import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { getSql } from '../db/client.js';
import { getClobOrderBook } from '../shared/clob.js';
import { getBookTouchLevels } from '../shared/bookTouch.js';
import { fetchWeatherEvents, parseWeatherEvent } from './weatherScanner.js';
import { canonicalCityKey } from './noaaClient.js';
import { executeAndRecordSignal } from '../execution/executor.js';
import { getBankroll } from '../shared/bankroll.js';
import type { TradeSignal } from '../mapping/index.js';

interface GroundTruthRow {
  city: string;
  targetDate: string;
  actualHigh: number;
  unit: string;
}

async function fetchYesterdayGroundTruth(): Promise<GroundTruthRow[]> {
  const sql = getSql();
  return sql<GroundTruthRow[]>`
    SELECT
      city                                          AS city,
      target_date::text                             AS "targetDate",
      COALESCE(resolution_high, observed_high)::float8 AS "actualHigh",
      unit
    FROM weather_ground_truth
    WHERE target_date = CURRENT_DATE - 1
      AND (resolution_high IS NOT NULL OR observed_high IS NOT NULL)
    ORDER BY city ASC
  `;
}

/**
 * Determine whether YES or NO wins for a bracket given the actual observed high.
 * Returns 'YES', 'NO', or null when the bracket type is unrecognised.
 */
export function winningDirection(
  actualHigh: number,
  low: number | null,
  high: number | null,
): 'YES' | 'NO' {
  if (high === null) {
    // High-tail: "X°F or higher" — YES wins when actual >= low
    return actualHigh >= low! ? 'YES' : 'NO';
  }
  if (low === null) {
    // Low-tail: "X°F or below" — YES wins when actual <= high
    return actualHigh <= high ? 'YES' : 'NO';
  }
  // Interior bracket: YES wins when low <= actual <= high
  return actualHigh >= low && actualHigh <= high ? 'YES' : 'NO';
}

/** Run one oracle scan cycle. */
export async function runWeatherOracleScan(redis: Redis): Promise<void> {
  const cfg = loadConfig();

  let groundTruth: GroundTruthRow[];
  try {
    groundTruth = await fetchYesterdayGroundTruth();
  } catch (err) {
    logger.warn('[weather-oracle] DB query failed — aborting scan', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (groundTruth.length === 0) {
    logger.debug('[weather-oracle] no ground-truth rows for yesterday');
    return;
  }

  // Index by canonical city key for fast lookup
  const truthByCity = new Map<string, GroundTruthRow>();
  for (const row of groundTruth) {
    const key = canonicalCityKey(row.city) ?? row.city;
    truthByCity.set(key, row);
  }

  const rawEvents = await fetchWeatherEvents(200);
  if (rawEvents.length === 0) {
    logger.debug('[weather-oracle] no active weather events from Gamma');
    return;
  }

  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  let bankrollUsd: number | null = null;

  for (const rawEvent of rawEvents) {
    const event = parseWeatherEvent(rawEvent);
    if (!event) continue;
    if (event.targetDate !== yesterdayStr) continue;

    const truth = truthByCity.get(event.city);
    if (!truth) continue;

    // Unit mismatch — skip to avoid bad comparisons
    if (truth.unit !== event.unit) {
      logger.debug('[weather-oracle] unit mismatch — skipping event', {
        city: event.city,
        groundTruthUnit: truth.unit,
        eventUnit: event.unit,
      });
      continue;
    }

    const actualHigh = truth.actualHigh;

    for (const bracket of event.brackets) {
      try {
        const direction = winningDirection(actualHigh, bracket.low, bracket.high);
        // winning token: YES = index 0, NO = index 1
        const winningTokenId = direction === 'YES'
          ? bracket.clobTokenIds[0]
          : bracket.clobTokenIds[1];

        if (!winningTokenId) {
          logger.debug('[weather-oracle] missing winning tokenId — skipping bracket', {
            marketId: bracket.marketId,
            direction,
          });
          continue;
        }

        const book = await getClobOrderBook(winningTokenId);
        if (!book || !book.asks || book.asks.length === 0) {
          logger.debug('[weather-oracle] no asks on winning side — skipping', {
            marketId: bracket.marketId,
            direction,
          });
          continue;
        }

        // Order-agnostic touch: asks[0] on a REST book is the WORST ask —
        // reading ~0.99 made every bracket's discount look like zero and
        // suppressed oracle entries on populated books. See shared/bookTouch.ts.
        const winningAsk = getBookTouchLevels(book).bestAsk?.price ?? 0;
        if (!isFinite(winningAsk) || winningAsk <= 0) continue;

        const discount = 1.0 - winningAsk;
        const meetsPrice = winningAsk <= cfg.WEATHER_ORACLE_MAX_BUY_PRICE;
        const meetsDiscount = discount >= cfg.WEATHER_ORACLE_MIN_DISCOUNT;
        const wouldTrade = meetsPrice && meetsDiscount;

        logger.info('[weather-oracle] bracket opportunity', {
          city: event.city,
          targetDate: event.targetDate,
          bracket: bracket.label,
          actualHigh,
          direction,
          winningAsk,
          discount: discount.toFixed(4),
          meetsPrice,
          meetsDiscount,
          wouldTrade,
          enabled: cfg.WEATHER_ORACLE_ENABLED,
        });

        void enqueueWrite('shadow_observations', {
          kind: 'weather_oracle',
          source: 'arb',
          marketId: bracket.marketId,
          direction,
          wouldBlock: !wouldTrade || !cfg.WEATHER_ORACLE_ENABLED,
          metricValue: winningAsk,
          threshold: cfg.WEATHER_ORACLE_MAX_BUY_PRICE,
          payload: {
            city: event.city,
            targetDate: event.targetDate,
            bracket: bracket.label,
            actualHigh,
            direction,
            winningAsk,
            discount,
            meetsPrice,
            meetsDiscount,
            maxBuyPrice: cfg.WEATHER_ORACLE_MAX_BUY_PRICE,
            minDiscount: cfg.WEATHER_ORACLE_MIN_DISCOUNT,
            enabled: cfg.WEATHER_ORACLE_ENABLED,
          },
        });

        if (!wouldTrade || !cfg.WEATHER_ORACLE_ENABLED) continue;

        // Lazy-load bankroll once per scan cycle, only when we have tradable signals
        if (bankrollUsd === null) {
          bankrollUsd = await getBankroll(redis);
        }
        if (bankrollUsd <= 0) {
          logger.warn('[weather-oracle] bankroll is zero — skipping execution', { bankrollUsd });
          return;
        }

        const stakeUsd = Math.min(cfg.WEATHER_ORACLE_MAX_STAKE_USD, bankrollUsd * 0.05);
        const signal: TradeSignal = {
          marketId: bracket.marketId,
          conditionId: bracket.conditionId,
          clobTokenIds: bracket.clobTokenIds,
          direction,
          stakeUsd,
          edgeMagnitude: discount,
          consensusProbability: direction === 'YES' ? 0.97 : 0.03,
          outcomePrice: winningAsk,
          question: bracket.question,
          source: 'weather',
          sourcedFrom: `weather-oracle:${event.city}:${event.targetDate}:${bracket.label}`,
          reasoning: `Known outcome: actual_high=${actualHigh.toFixed(1)} ${event.unit}; bracket "${bracket.label}" resolves ${direction}; winningAsk=${winningAsk.toFixed(3)}`,
          // Oracle signals always target a resolved (yesterday's) market — treat as
          // resolution-day so the executor applies WEATHER_MAX_ENTRY_PRICE, not the
          // stricter WEATHER_EARLY_ENTRY_MAX_PRICE reserved for pre-res-day entries.
          _isResolutionDay: true,
        };

        try {
          const result = await executeAndRecordSignal(signal, redis);
          logger.info('[weather-oracle] execution result', {
            marketId: bracket.marketId,
            city: event.city,
            bracket: bracket.label,
            direction,
            winningAsk,
            stakeUsd: result.signal.stakeUsd.toFixed(2),
            skipped: result.skipped,
            skipReason: result.skipReason,
            executionVenue: result.executionVenue,
          });
        } catch (err) {
          logger.warn('[weather-oracle] execution threw — continuing', {
            marketId: bracket.marketId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } catch (err) {
        logger.warn('[weather-oracle] unexpected error for bracket — continuing', {
          marketId: bracket.marketId,
          city: event.city,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
