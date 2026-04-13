/**
 * Order manager for rebate farming.
 *
 * Tracks resting GTC post-only limit orders in Redis. Each cron cycle:
 * 1) Reconciles tracked orders (detects fills, cancels stale)
 * 2) Places new orders on selected markets
 *
 * Filled orders are recorded in the position ledger so the monitor
 * handles TP/SL like any other position.
 */

import type { Redis } from 'ioredis';
import type { TickSize } from '@polymarket/clob-client';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import {
  submitClobLimitBuy,
  getClobOrder,
  cancelClobOrder,
} from '../shared/clob.js';
import { recordPosition } from '../execution/positionLedger.js';
import type { RestingOrder, RebateMarketCandidate } from './types.js';

const ORDERS_HASH_KEY = 'rebate:orders';
const MARKET_SET_PREFIX = 'rebate:orders:by_market:';
const STATS_KEY = 'rebate:stats';

// ─── Redis CRUD ──────────────────────────────────────────────────────────────

export async function loadRestingOrders(redis: Redis): Promise<Map<string, RestingOrder>> {
  const raw = await redis.hgetall(ORDERS_HASH_KEY);
  const orders = new Map<string, RestingOrder>();
  for (const [orderId, json] of Object.entries(raw)) {
    try {
      orders.set(orderId, JSON.parse(json) as RestingOrder);
    } catch {
      // Corrupt entry — remove it.
      await redis.hdel(ORDERS_HASH_KEY, orderId).catch(() => {});
    }
  }
  return orders;
}

async function saveRestingOrder(redis: Redis, order: RestingOrder): Promise<void> {
  await redis.hset(ORDERS_HASH_KEY, order.orderId, JSON.stringify(order));
  await redis.sadd(`${MARKET_SET_PREFIX}${order.marketId}`, order.orderId);
}

async function removeRestingOrder(redis: Redis, orderId: string, marketId: string): Promise<void> {
  await redis.hdel(ORDERS_HASH_KEY, orderId);
  await redis.srem(`${MARKET_SET_PREFIX}${marketId}`, orderId);
}

export async function hasRestingOrderForMarket(redis: Redis, marketId: string): Promise<boolean> {
  const count = await redis.scard(`${MARKET_SET_PREFIX}${marketId}`);
  return count > 0;
}

export async function getDeployedUsd(redis: Redis): Promise<number> {
  const orders = await loadRestingOrders(redis);
  let total = 0;
  for (const order of orders.values()) {
    total += order.sizeUsd;
  }
  return total;
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

export interface ReconcileResult {
  filled: RestingOrder[];
  partialFills: RestingOrder[];
  cancelled: RestingOrder[];
  stale: RestingOrder[];
  errors: number;
}

/**
 * Reconcile all tracked resting orders against the CLOB.
 * Detects fills (→ recordPosition), cancels stale orders, cleans up.
 */
export async function reconcileOrders(redis: Redis): Promise<ReconcileResult> {
  const cfg = loadConfig();
  const orders = await loadRestingOrders(redis);
  const result: ReconcileResult = {
    filled: [],
    partialFills: [],
    cancelled: [],
    stale: [],
    errors: 0,
  };

  for (const [orderId, order] of orders) {
    try {
      const clobOrder = await getClobOrder(orderId);

      if (!clobOrder) {
        // Order gone from CLOB — likely cancelled externally or expired.
        await removeRestingOrder(redis, orderId, order.marketId);
        result.cancelled.push(order);
        continue;
      }

      const matched = parseFloat(clobOrder.size_matched ?? '0');
      const original = parseFloat(clobOrder.original_size ?? String(order.size));
      const status = String(clobOrder.status ?? '').toLowerCase();

      // Check if fully filled.
      if (matched >= original - 1e-9 && matched > 0) {
        await recordFilledOrder(redis, order, matched);
        await removeRestingOrder(redis, orderId, order.marketId);
        result.filled.push(order);
        await redis.hincrby(STATS_KEY, 'fills', 1).catch(() => {});
        continue;
      }

      // Check if partially filled.
      if (matched > 0) {
        // Cancel remainder, record partial fill as position.
        await cancelClobOrder(orderId);
        await recordFilledOrder(redis, order, matched);
        await removeRestingOrder(redis, orderId, order.marketId);
        result.partialFills.push(order);
        await redis.hincrby(STATS_KEY, 'partial_fills', 1).catch(() => {});
        continue;
      }

      // Check if already cancelled/expired.
      if (['cancelled', 'canceled', 'expired'].includes(status)) {
        await removeRestingOrder(redis, orderId, order.marketId);
        result.cancelled.push(order);
        continue;
      }

      // Check staleness — cancel orders older than TTL.
      const ageMs = Date.now() - new Date(order.placedAt).getTime();
      if (ageMs > cfg.REBATE_ORDER_TTL_S * 1000) {
        await cancelClobOrder(orderId);
        await removeRestingOrder(redis, orderId, order.marketId);
        result.stale.push(order);
        await redis.hincrby(STATS_KEY, 'stale_cancels', 1).catch(() => {});
        continue;
      }

      // Order still live and within TTL — leave it.
    } catch (err: unknown) {
      result.errors++;
      logger.warn('[rebate] reconciliation error for order', {
        orderId,
        marketId: order.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.filled.length > 0 || result.partialFills.length > 0 || result.stale.length > 0) {
    logger.info('[rebate] reconciliation complete', {
      filled: result.filled.length,
      partialFills: result.partialFills.length,
      cancelled: result.cancelled.length,
      stale: result.stale.length,
      errors: result.errors,
    });
  }

  return result;
}

async function recordFilledOrder(
  redis: Redis,
  order: RestingOrder,
  sharesFilled: number,
): Promise<void> {
  const filledUsd = sharesFilled * order.price;

  logger.info('[rebate] resting order filled — recording position', {
    marketId: order.marketId,
    direction: order.direction,
    price: order.price,
    shares: sharesFilled.toFixed(6),
    usd: filledUsd.toFixed(2),
  });

  await recordPosition(redis, {
    marketId: order.marketId,
    conditionId: order.conditionId,
    clobTokenIds: [order.tokenId, ''], // Only the traded token matters.
    question: order.question,
    direction: order.direction,
    entryPrice: order.price,
    stakeUsd: filledUsd,
    edgeMagnitude: 0, // No directional edge claim.
    sourcedFrom: 'rebate-farming',
    openedAt: new Date().toISOString(),
    sharesHeld: sharesFilled,
    executionVenue: 'clob',
    entryOrderType: 'maker',
    entryExecutionPath: 'rebate_maker_fill',
  });
}

// ─── Order placement ─────────────────────────────────────────────────────────

function roundDownToTick(value: number, tick: number): number {
  if (!isFinite(value) || !isFinite(tick) || tick <= 0) return value;
  const rounded = Math.floor(value / tick) * tick;
  return parseFloat(rounded.toFixed(6));
}

/**
 * Place a resting GTC post-only limit buy on the CLOB.
 *
 * Price is set at `bestBid + 1 tick`, capped below the bestAsk so the
 * order rests passively without crossing. Returns the RestingOrder on
 * success, or null on failure.
 */
export async function placeRestingOrder(
  redis: Redis,
  candidate: RebateMarketCandidate,
  sizeUsd: number,
): Promise<RestingOrder | null> {
  const tick = parseFloat(candidate.tickSize);
  if (!isFinite(tick) || tick <= 0) return null;

  // Rest at bestBid + 1 tick — improves on passive bids, stays below ask.
  let price = candidate.bestBid + tick;
  price = Math.min(price, candidate.bestAsk - tick); // Never cross.
  price = Math.max(price, tick);
  price = Math.min(price, 1 - tick);
  price = roundDownToTick(price, tick);

  if (price <= 0 || price >= candidate.bestAsk) return null;

  const size = sizeUsd / price;
  if (size <= 0) return null;

  logger.info('[rebate] placing resting order', {
    marketId: candidate.marketId,
    direction: candidate.direction,
    tokenId: candidate.tokenId,
    price,
    size: size.toFixed(4),
    sizeUsd: sizeUsd.toFixed(2),
    spreadBps: candidate.spreadBps.toFixed(0),
  });

  const result = await submitClobLimitBuy({
    tokenId: candidate.tokenId,
    price,
    size,
    tickSize: candidate.tickSize as TickSize,
    negRisk: candidate.negRisk,
    orderType: 'GTC',
    postOnly: true,
  });

  if (!result.success || !result.order_id) {
    logger.warn('[rebate] order placement failed', {
      marketId: candidate.marketId,
      error: result.error,
    });
    return null;
  }

  const order: RestingOrder = {
    orderId: result.order_id,
    marketId: candidate.marketId,
    conditionId: candidate.conditionId,
    tokenId: candidate.tokenId,
    direction: candidate.direction,
    price,
    size,
    sizeUsd,
    placedAt: new Date().toISOString(),
    tickSize: candidate.tickSize,
    negRisk: candidate.negRisk,
    question: candidate.question,
  };

  await saveRestingOrder(redis, order);
  await redis.hincrby(STATS_KEY, 'orders_placed', 1).catch(() => {});

  return order;
}
