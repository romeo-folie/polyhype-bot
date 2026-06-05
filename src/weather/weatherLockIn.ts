/**
 * Weather Lock-In Scanner
 *
 * When a weather position is deeply in profit (the opposite side has dropped
 * to near zero), buys the opposite token cheaply to guarantee payout regardless
 * of outcome. This bypasses the executor's opposite-side gate by calling
 * submitClobBuy directly.
 *
 * Supports both YES and NO positions:
 *   - Held NO: buys YES when YES is cheap (≤ WEATHER_LOCK_IN_MAX_YES_PRICE).
 *   - Held YES: buys NO when NO is cheap (≤ WEATHER_LOCK_IN_MAX_YES_PRICE).
 *
 * Ships dark (WEATHER_LOCK_IN_ENABLED=false). Shadow-logs all opportunities
 * regardless of enabled state.
 *
 * Log marker: [weather-lock-in]
 * Redis key:  weather:locked:{positionId}  (TTL: 14 days)
 */

import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { getSql } from '../db/client.js';
import { getMarket, parseClobTokenIds } from '../mapping/gamma.js';
import { getClobOrderBook, submitClobBuy } from '../shared/clob.js';
import { getBookTouchLevels } from '../shared/bookTouch.js';
import { deductStake } from '../shared/bankroll.js';

const LOCK_IN_MIN_FILL_RATIO = 0.9;

const LOCK_KEY_PREFIX = 'weather:locked:';
// Must match HEDGE_KEY_PREFIX in weatherInvalidation.ts — both scanners check
// both markers so a position is not double-hedged on the same opposite token.
const INVALIDATION_HEDGE_KEY_PREFIX = 'weather:forecast_hedged:';
const LOCK_TTL_S = 14 * 24 * 3600;

interface OpenWeatherPosition {
  id: string;
  marketId: string;
  direction: 'YES' | 'NO';
  entryPrice: number;
  sharesHeld: number;
}

async function fetchOpenWeatherPositions(): Promise<OpenWeatherPosition[]> {
  const sql = getSql();
  return sql<OpenWeatherPosition[]>`
    SELECT
      id::text             AS id,
      market_id            AS "marketId",
      direction            AS direction,
      entry_price::float8  AS "entryPrice",
      shares_held::float8  AS "sharesHeld"
    FROM positions
    WHERE sourced_from LIKE 'weather:%'
      AND direction IN ('YES', 'NO')
      AND pending_settlement = false
      AND closed_at IS NULL
      AND shares_held > 0
    ORDER BY entry_price DESC
  `;
}

/** Run one lock-in scan cycle. */
export async function runWeatherLockInScan(redis: Redis): Promise<void> {
  const cfg = loadConfig();

  let positions: OpenWeatherPosition[];
  try {
    positions = await fetchOpenWeatherPositions();
  } catch (err) {
    logger.warn('[weather-lock-in] DB query failed — aborting scan', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (positions.length === 0) return;

  for (const pos of positions) {
    try {
      const lockKey = `${LOCK_KEY_PREFIX}${pos.id}`;
      const invalidationHedgeKey = `${INVALIDATION_HEDGE_KEY_PREFIX}${pos.id}`;
      // Check both markers in one round-trip: skip if locked by either scanner.
      const [lockedMarkerRaw, hedgedMarkerRaw] = await redis
        .mget(lockKey, invalidationHedgeKey)
        .catch((): [null, null] => [null, null]);
      if (lockedMarkerRaw || hedgedMarkerRaw) continue;

      let market;
      try {
        market = await getMarket(pos.marketId);
      } catch (err) {
        logger.warn('[weather-lock-in] Gamma market fetch failed — skipping position', {
          positionId: pos.id,
          marketId: pos.marketId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // tokenIds[0]=YES, tokenIds[1]=NO; buy the opposite of our held side.
      let oppositeTokenId: string;
      try {
        const tokenIds = parseClobTokenIds(market.clobTokenIds);
        const idx = pos.direction === 'YES' ? 1 : 0;
        const id = tokenIds[idx];
        if (!id) {
          logger.warn('[weather-lock-in] opposite tokenId not found — skipping', {
            marketId: pos.marketId,
            direction: pos.direction,
          });
          continue;
        }
        oppositeTokenId = id;
      } catch (err) {
        logger.warn('[weather-lock-in] failed to parse clobTokenIds — skipping', {
          marketId: pos.marketId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const oppositeDirection = pos.direction === 'YES' ? 'NO' : 'YES';
      const book = await getClobOrderBook(oppositeTokenId);
      if (!book || !book.asks || book.asks.length === 0) {
        logger.debug('[weather-lock-in] no asks on opposite side — skipping', {
          marketId: pos.marketId,
          direction: pos.direction,
        });
        continue;
      }

      // Order-agnostic touch: asks[0] on a REST book is the WORST ask
      // (best-at-the-END ordering) — reading it inflated lock-in cost and
      // suppressed viable hedges. See shared/bookTouch.ts.
      const oppositeAsk = getBookTouchLevels(book).bestAsk?.price ?? 0;
      if (!isFinite(oppositeAsk) || oppositeAsk <= 0) continue;

      const costTotal = pos.entryPrice + oppositeAsk;
      const meetsOppositePrice = oppositeAsk <= cfg.WEATHER_LOCK_IN_MAX_YES_PRICE;
      const meetsCostCeiling = costTotal <= cfg.WEATHER_LOCK_IN_COST_CEILING;
      const wouldLockIn = meetsOppositePrice && meetsCostCeiling;

      logger.info('[weather-lock-in] opportunity evaluated', {
        positionId: pos.id,
        marketId: pos.marketId,
        direction: pos.direction,
        oppositeDirection,
        entryPrice: pos.entryPrice,
        sharesHeld: pos.sharesHeld,
        oppositeAsk,
        costTotal: costTotal.toFixed(4),
        meetsOppositePrice,
        meetsCostCeiling,
        wouldLockIn,
        enabled: cfg.WEATHER_LOCK_IN_ENABLED,
      });

      void enqueueWrite('shadow_observations', {
        kind: 'weather_lock_in',
        source: 'arb',
        marketId: pos.marketId,
        direction: oppositeDirection,
        wouldBlock: !wouldLockIn || !cfg.WEATHER_LOCK_IN_ENABLED,
        metricValue: oppositeAsk,
        threshold: cfg.WEATHER_LOCK_IN_MAX_YES_PRICE,
        payload: {
          positionId: pos.id,
          direction: pos.direction,
          oppositeDirection,
          entryPrice: pos.entryPrice,
          sharesHeld: pos.sharesHeld,
          oppositeAsk,
          costTotal,
          meetsOppositePrice,
          meetsCostCeiling,
          maxOppositePrice: cfg.WEATHER_LOCK_IN_MAX_YES_PRICE,
          costCeiling: cfg.WEATHER_LOCK_IN_COST_CEILING,
          enabled: cfg.WEATHER_LOCK_IN_ENABLED,
        },
      });

      if (!wouldLockIn || !cfg.WEATHER_LOCK_IN_ENABLED) continue;

      const amountUsd = pos.sharesHeld * oppositeAsk;
      const result = await submitClobBuy({ tokenId: oppositeTokenId, amountUsd, orderType: 'FAK' });

      if (result.success) {
        const sharesBought = result.shares_bought ?? 0;
        const fillRatio = pos.sharesHeld > 0 ? sharesBought / pos.sharesHeld : 0;
        if (fillRatio < LOCK_IN_MIN_FILL_RATIO) {
          logger.warn('[weather-lock-in] partial fill below threshold — lock not set, will retry', {
            positionId: pos.id,
            marketId: pos.marketId,
            sharesNeeded: pos.sharesHeld,
            sharesBought,
            fillRatio: fillRatio.toFixed(3),
            minFillRatio: LOCK_IN_MIN_FILL_RATIO,
          });
          await deductStake(redis, result.cost ?? amountUsd * fillRatio);
          continue;
        }
        await redis.set(lockKey, '1', 'EX', LOCK_TTL_S);
        await deductStake(redis, result.cost ?? amountUsd);
        logger.info('[weather-lock-in] lock-in executed', {
          positionId: pos.id,
          marketId: pos.marketId,
          direction: pos.direction,
          oppositeDirection,
          oppositeAsk,
          amountUsd: amountUsd.toFixed(2),
          sharesBought,
          cost: result.cost,
        });
      } else {
        logger.warn('[weather-lock-in] CLOB buy failed', {
          positionId: pos.id,
          marketId: pos.marketId,
          direction: pos.direction,
          oppositeAsk,
          error: result.error,
        });
      }
    } catch (err) {
      logger.warn('[weather-lock-in] unexpected error for position — continuing', {
        positionId: pos.id,
        marketId: pos.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
