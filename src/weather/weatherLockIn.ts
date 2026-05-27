/**
 * Weather Lock-In Scanner
 *
 * When a weather NO position is deeply in profit (YES has dropped to near zero),
 * buys YES at a cheap price to guarantee payout regardless of outcome. This
 * bypasses the executor's opposite-side gate by calling submitClobBuy directly.
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
import { deductStake } from '../shared/bankroll.js';

const LOCK_IN_MIN_FILL_RATIO = 0.9;

const LOCK_KEY_PREFIX = 'weather:locked:';
const LOCK_TTL_S = 14 * 24 * 3600;

interface OpenWeatherNoPosition {
  id: string;
  marketId: string;
  entryPrice: number;
  sharesHeld: number;
}

async function fetchOpenWeatherNoPositions(): Promise<OpenWeatherNoPosition[]> {
  const sql = getSql();
  return sql<OpenWeatherNoPosition[]>`
    SELECT
      id::text             AS id,
      market_id            AS "marketId",
      entry_price::float8  AS "entryPrice",
      shares_held::float8  AS "sharesHeld"
    FROM positions
    WHERE sourced_from = 'weather'
      AND direction = 'NO'
      AND pending_settlement = false
      AND closed_at IS NULL
      AND shares_held > 0
    ORDER BY entry_price DESC
  `;
}

/** Run one lock-in scan cycle. */
export async function runWeatherLockInScan(redis: Redis): Promise<void> {
  const cfg = loadConfig();

  let positions: OpenWeatherNoPosition[];
  try {
    positions = await fetchOpenWeatherNoPositions();
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
      const alreadyLocked = await redis.exists(lockKey);
      if (alreadyLocked) continue;

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

      let yesTokenId: string;
      try {
        const tokenIds = parseClobTokenIds(market.clobTokenIds);
        const id = tokenIds[0];
        if (!id) {
          logger.warn('[weather-lock-in] no YES tokenId found — skipping', { marketId: pos.marketId });
          continue;
        }
        yesTokenId = id;
      } catch (err) {
        logger.warn('[weather-lock-in] failed to parse clobTokenIds — skipping', {
          marketId: pos.marketId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const book = await getClobOrderBook(yesTokenId);
      if (!book || !book.asks || book.asks.length === 0) {
        logger.debug('[weather-lock-in] no asks on YES side — skipping', { marketId: pos.marketId });
        continue;
      }

      const bestAsk = book.asks[0];
      if (!bestAsk) continue;
      const yesAsk = parseFloat(String(bestAsk.price));
      if (!isFinite(yesAsk) || yesAsk <= 0) continue;

      const costTotal = pos.entryPrice + yesAsk;
      const meetsYesPrice = yesAsk <= cfg.WEATHER_LOCK_IN_MAX_YES_PRICE;
      const meetsCostCeiling = costTotal <= cfg.WEATHER_LOCK_IN_COST_CEILING;
      const wouldLockIn = meetsYesPrice && meetsCostCeiling;

      logger.info('[weather-lock-in] opportunity evaluated', {
        positionId: pos.id,
        marketId: pos.marketId,
        entryPrice: pos.entryPrice,
        sharesHeld: pos.sharesHeld,
        yesAsk,
        costTotal: costTotal.toFixed(4),
        meetsYesPrice,
        meetsCostCeiling,
        wouldLockIn,
        enabled: cfg.WEATHER_LOCK_IN_ENABLED,
      });

      void enqueueWrite('shadow_observations', {
        kind: 'weather_lock_in',
        source: 'arb',
        marketId: pos.marketId,
        direction: 'YES',
        wouldBlock: !wouldLockIn || !cfg.WEATHER_LOCK_IN_ENABLED,
        metricValue: yesAsk,
        threshold: cfg.WEATHER_LOCK_IN_MAX_YES_PRICE,
        payload: {
          positionId: pos.id,
          entryPrice: pos.entryPrice,
          sharesHeld: pos.sharesHeld,
          yesAsk,
          costTotal,
          meetsYesPrice,
          meetsCostCeiling,
          maxYesPrice: cfg.WEATHER_LOCK_IN_MAX_YES_PRICE,
          costCeiling: cfg.WEATHER_LOCK_IN_COST_CEILING,
          enabled: cfg.WEATHER_LOCK_IN_ENABLED,
        },
      });

      if (!wouldLockIn || !cfg.WEATHER_LOCK_IN_ENABLED) continue;

      const amountUsd = pos.sharesHeld * yesAsk;
      const result = await submitClobBuy({ tokenId: yesTokenId, amountUsd, orderType: 'FAK' });

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
          // Still deduct what was spent to keep bankroll cache accurate.
          await deductStake(redis, result.cost ?? amountUsd * fillRatio);
          continue;
        }
        await redis.set(lockKey, '1', 'EX', LOCK_TTL_S);
        await deductStake(redis, result.cost ?? amountUsd);
        logger.info('[weather-lock-in] YES lock-in executed', {
          positionId: pos.id,
          marketId: pos.marketId,
          yesAsk,
          amountUsd: amountUsd.toFixed(2),
          sharesBought,
          cost: result.cost,
        });
      } else {
        logger.warn('[weather-lock-in] CLOB buy failed', {
          positionId: pos.id,
          marketId: pos.marketId,
          yesAsk,
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
