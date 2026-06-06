/**
 * Order manager for rebate farming.
 *
 * Tracks resting GTC post-only limit orders in Redis. Each cron cycle:
 * 1) Reconciles tracked orders (detects fills, cancels stale)
 * 2) Places new orders on selected markets (one per market+direction)
 *
 * Filled orders are recorded in the position ledger so the monitor
 * handles TP/SL like any other position. Fill-time rebate accrual is
 * estimated as shares × feeRate × p(1−p) × rebateShare and tracked in
 * `rebate:stats` (global) and `rebate:stats:market:<id>` (per market) for
 * the daily est-vs-API summary.
 */

import type { Redis } from 'ioredis';
import type { TickSize } from '@polymarket/clob-client-v2';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import {
  submitClobLimitBuy,
  getClobOrder,
  cancelClobOrder,
  CLOB_MIN_ORDER_USD,
} from '../shared/clob.js';
import { recordPosition } from '../execution/positionLedger.js';
import { estimateFillRebateUsd } from './flowAnalyzer.js';
import { utcDateString } from './rebateChecker.js';
import type { RestingOrder, RebateMarketCandidate, RebateQuote } from './types.js';

const ORDERS_HASH_KEY = 'rebate:orders';
const MARKET_SET_PREFIX = 'rebate:orders:by_market:';
const STATS_KEY = 'rebate:stats';
const MARKET_STATS_PREFIX = 'rebate:stats:market:';
const DATE_STATS_PREFIX = 'rebate:stats:date:';
/** Per-market stat hashes expire after 30 idle days so dead markets don't leak keys. */
const MARKET_STATS_TTL_S = 30 * 24 * 3600;
/** Per-day stat hashes: the daily summary only needs yesterday; 7d aids debugging. */
const DATE_STATS_TTL_S = 7 * 24 * 3600;

// ─── Stats ───────────────────────────────────────────────────────────────────
//
// Every counter is written to three hashes in one pipeline: cumulative
// (rebate:stats), per-market (rebate:stats:market:<id>), and per-UTC-day
// (rebate:stats:date:<YYYY-MM-DD>). The date bucket exists so the daily
// summary can compare yesterday's API-reported rebates against estimates from
// the SAME period — cumulative counters next to a one-day API total would
// misread as Polymarket under/over-paying. Events are bucketed by detection
// time (reconcile run), so a fill detected just after UTC midnight lands in
// the new day while the API attributes the trade to the prior one — accepted
// skew for $-cents-scale estimates.

/** Increment an integer counter on the cumulative, per-market, and per-day stat hashes. */
async function bumpStat(redis: Redis, marketId: string, field: string, by = 1): Promise<void> {
  try {
    const marketKey = `${MARKET_STATS_PREFIX}${marketId}`;
    const dateKey = `${DATE_STATS_PREFIX}${utcDateString(0)}`;
    const pipeline = redis.multi();
    pipeline.hincrby(STATS_KEY, field, by);
    pipeline.hincrby(marketKey, field, by);
    pipeline.expire(marketKey, MARKET_STATS_TTL_S);
    pipeline.hincrby(dateKey, field, by);
    pipeline.expire(dateKey, DATE_STATS_TTL_S);
    await pipeline.exec();
  } catch {
    // Stats are best-effort — never fail order management on counter writes.
  }
}

/** Increment a float counter (USD amounts) on the cumulative, per-market, and per-day stat hashes. */
async function bumpStatFloat(redis: Redis, marketId: string, field: string, by: number): Promise<void> {
  if (!isFinite(by) || by === 0) return;
  try {
    const marketKey = `${MARKET_STATS_PREFIX}${marketId}`;
    const dateKey = `${DATE_STATS_PREFIX}${utcDateString(0)}`;
    const pipeline = redis.multi();
    pipeline.hincrbyfloat(STATS_KEY, field, by);
    pipeline.hincrbyfloat(marketKey, field, by);
    pipeline.expire(marketKey, MARKET_STATS_TTL_S);
    pipeline.hincrbyfloat(dateKey, field, by);
    pipeline.expire(dateKey, DATE_STATS_TTL_S);
    await pipeline.exec();
  } catch {
    // best-effort
  }
}

/**
 * Record order lifetime on terminal events (fill / partial / stale / external
 * cancel / reprice) — average lifetime = lifetime_ms_total / lifetime_count.
 */
async function recordLifetime(redis: Redis, order: RestingOrder): Promise<void> {
  const lifetimeMs = Date.now() - new Date(order.placedAt).getTime();
  if (!isFinite(lifetimeMs) || lifetimeMs < 0) return;
  try {
    const marketKey = `${MARKET_STATS_PREFIX}${order.marketId}`;
    const dateKey = `${DATE_STATS_PREFIX}${utcDateString(0)}`;
    const pipeline = redis.multi();
    pipeline.hincrby(STATS_KEY, 'lifetime_ms_total', Math.round(lifetimeMs));
    pipeline.hincrby(STATS_KEY, 'lifetime_count', 1);
    pipeline.hincrby(marketKey, 'lifetime_ms_total', Math.round(lifetimeMs));
    pipeline.hincrby(marketKey, 'lifetime_count', 1);
    pipeline.expire(marketKey, MARKET_STATS_TTL_S);
    pipeline.hincrby(dateKey, 'lifetime_ms_total', Math.round(lifetimeMs));
    pipeline.hincrby(dateKey, 'lifetime_count', 1);
    pipeline.expire(dateKey, DATE_STATS_TTL_S);
    await pipeline.exec();
  } catch {
    // best-effort
  }
}

// ─── Redis CRUD ──────────────────────────────────────────────────────────────

export async function loadRestingOrders(redis: Redis): Promise<Map<string, RestingOrder>> {
  const raw = await redis.hgetall(ORDERS_HASH_KEY);
  const orders = new Map<string, RestingOrder>();
  let hadCorruption = false;
  for (const [orderId, json] of Object.entries(raw)) {
    try {
      const parsed = JSON.parse(json) as RestingOrder;
      orders.set(orderId, parsed);
    } catch {
      await redis.hdel(ORDERS_HASH_KEY, orderId).catch(() => {});
      logger.warn('[rebate] removed corrupt order entry from tracking', { orderId });
      hadCorruption = true;
    }
  }

  // Rebuild by-market sets from valid entries to prevent orphaned set members
  // from blocking future placements. Only runs when corruption was detected.
  // Avoids KEYS (O(N) blocking) — rebuilds only sets for known valid marketIds.
  if (hadCorruption) {
    const marketToOrderIds = new Map<string, string[]>();
    for (const [orderId, order] of orders) {
      const ids = marketToOrderIds.get(order.marketId);
      if (ids) ids.push(orderId);
      else marketToOrderIds.set(order.marketId, [orderId]);
    }
    const pipeline = redis.multi();
    // Delete and rebuild each known market's set from valid orders.
    for (const [marketId, orderIds] of marketToOrderIds) {
      pipeline.del(`${MARKET_SET_PREFIX}${marketId}`);
      pipeline.sadd(`${MARKET_SET_PREFIX}${marketId}`, ...orderIds);
    }
    await pipeline.exec().catch(() => {});
    logger.info('[rebate] rebuilt by-market sets after corruption cleanup');
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

/** Find the resting order for a (market, direction) pair in a loaded order map. */
export function findRestingOrder(
  orders: Map<string, RestingOrder>,
  marketId: string,
  direction: 'YES' | 'NO',
): RestingOrder | null {
  for (const order of orders.values()) {
    if (order.marketId === marketId && order.direction === direction) return order;
  }
  return null;
}

/** Total USD across a loaded order map. */
export function deployedUsd(orders: Map<string, RestingOrder>): number {
  let total = 0;
  for (const order of orders.values()) total += order.sizeUsd;
  return total;
}

/** USD deployed to one market across a loaded order map. */
export function deployedUsdForMarket(orders: Map<string, RestingOrder>, marketId: string): number {
  let total = 0;
  for (const order of orders.values()) {
    if (order.marketId === marketId) total += order.sizeUsd;
  }
  return total;
}

export async function getDeployedUsd(redis: Redis): Promise<number> {
  return deployedUsd(await loadRestingOrders(redis));
}

export async function getDeployedUsdForMarket(redis: Redis, marketId: string): Promise<number> {
  return deployedUsdForMarket(await loadRestingOrders(redis), marketId);
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
        // getClobOrder returns null for both "not found" and "fetch error".
        // Don't remove tracking on what might be a transient API failure —
        // skip this cycle. If the order is truly gone, staleness TTL will
        // clean it up eventually.
        const ageMs = Date.now() - new Date(order.placedAt).getTime();
        if (ageMs > cfg.REBATE_ORDER_TTL_S * 2 * 1000) {
          // Well past TTL — safe to assume the order is genuinely gone.
          await removeRestingOrder(redis, orderId, order.marketId);
          await recordLifetime(redis, order);
          result.cancelled.push(order);
        } else {
          logger.debug('[rebate] getClobOrder returned null, skipping (may be transient)', { orderId });
          result.errors++;
        }
        continue;
      }

      const matched = parseFloat(clobOrder.size_matched ?? '0');
      const original = parseFloat(clobOrder.original_size ?? String(order.size));
      const status = String(clobOrder.status ?? '').toLowerCase();

      // Check if fully filled.
      if (matched >= original - 1e-9 && matched > 0) {
        await recordFilledOrder(redis, order, matched);
        await removeRestingOrder(redis, orderId, order.marketId);
        await recordLifetime(redis, order);
        result.filled.push(order);
        await bumpStat(redis, order.marketId, 'fills');
        continue;
      }

      // Check if partially filled.
      if (matched > 0) {
        // Cancel remainder, record partial fill as position.
        const cancelled = await cancelClobOrder(orderId);
        if (!cancelled) {
          // Cancel failed — re-check status before removing from tracking.
          const recheck = await getClobOrder(orderId);
          if (!recheck) {
            // Recheck also failed (transient?) — retry next cycle.
            logger.warn('[rebate] partial fill cancel + recheck failed, will retry', { orderId });
            continue;
          }
          const recheckStatus = String(recheck.status ?? '').toLowerCase();
          if (!['cancelled', 'canceled', 'expired', 'matched'].includes(recheckStatus)) {
            // Still live and cancel failed — skip this cycle, retry next time.
            logger.warn('[rebate] partial fill cancel failed, will retry', { orderId });
            continue;
          }
        }
        await recordFilledOrder(redis, order, matched);
        await removeRestingOrder(redis, orderId, order.marketId);
        await recordLifetime(redis, order);
        result.partialFills.push(order);
        await bumpStat(redis, order.marketId, 'partial_fills');
        continue;
      }

      // Check if already cancelled/expired.
      if (['cancelled', 'canceled', 'expired'].includes(status)) {
        await removeRestingOrder(redis, orderId, order.marketId);
        await recordLifetime(redis, order);
        result.cancelled.push(order);
        continue;
      }

      // Check staleness — cancel orders older than TTL.
      const ageMs = Date.now() - new Date(order.placedAt).getTime();
      if (ageMs > cfg.REBATE_ORDER_TTL_S * 1000) {
        const cancelled = await cancelClobOrder(orderId);
        if (!cancelled) {
          const recheck = await getClobOrder(orderId);
          if (!recheck) {
            // Recheck also failed (transient?) — retry next cycle.
            logger.warn('[rebate] stale cancel + recheck failed, will retry', { orderId });
            continue;
          }
          const recheckStatus = String(recheck.status ?? '').toLowerCase();
          if (!['cancelled', 'canceled', 'expired', 'matched'].includes(recheckStatus)) {
            logger.warn('[rebate] stale cancel failed, will retry', { orderId });
            continue;
          }
        }
        await removeRestingOrder(redis, orderId, order.marketId);
        await recordLifetime(redis, order);
        result.stale.push(order);
        await bumpStat(redis, order.marketId, 'stale_cancels');
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
  const cfg = loadConfig();
  const filledUsd = sharesFilled * order.price;

  // Estimated rebate accrual for this fill. Orders persisted before the
  // 2026-06-05 rework lack fee fields — fall back to config defaults.
  const estRebateUsd = estimateFillRebateUsd(
    sharesFilled,
    order.price,
    order.feeRateBps ?? cfg.REBATE_FEE_RATE_BPS,
    order.rebateShare ?? 0.25,
  );
  await bumpStatFloat(redis, order.marketId, 'est_rebate_usd', estRebateUsd);

  logger.info('[rebate] resting order filled — recording position', {
    marketId: order.marketId,
    direction: order.direction,
    price: order.price,
    shares: sharesFilled.toFixed(6),
    usd: filledUsd.toFixed(2),
    estRebateUsd: estRebateUsd.toFixed(4),
  });

  await recordPosition(redis, {
    marketId: order.marketId,
    conditionId: order.conditionId,
    clobTokenIds: order.clobTokenIds,
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

/**
 * Cancel a resting order so it can be re-posted at a drifted target price.
 * Returns true when the order is confirmed gone (safe to place a replacement);
 * false leaves the original tracked and skips the replacement this cycle.
 */
export async function cancelForReprice(redis: Redis, order: RestingOrder): Promise<boolean> {
  const cancelled = await cancelClobOrder(order.orderId);
  if (!cancelled) {
    const recheck = await getClobOrder(order.orderId);
    const recheckStatus = String(recheck?.status ?? '').toLowerCase();
    if (!recheck || !['cancelled', 'canceled', 'expired'].includes(recheckStatus)) {
      logger.warn('[rebate] reprice cancel unconfirmed — keeping original order', {
        orderId: order.orderId,
        marketId: order.marketId,
      });
      return false;
    }
  }
  await removeRestingOrder(redis, order.orderId, order.marketId);
  await recordLifetime(redis, order);
  await bumpStat(redis, order.marketId, 'reprice_cancels');
  return true;
}

export interface PairTarget {
  /** Share count of the leg being paired against. */
  matchShares: number;
  /**
   * Entry price (held inventory) or posted price (resting order) of the leg
   * being paired against — the input to the pair-cost ceiling. A pair is
   * riskless only when combined cost < $1; completing one above that LOCKS a
   * loss (live failure 2026-06-06: held YES@0.61 pair-completed at NO@0.65 →
   * 1.26 combined → guaranteed −$2 — the market had moved and the second leg
   * chased it).
   */
  partnerCost: number;
}

/**
 * Pair-matching target for a quote, by priority:
 *   1. held opposite-side inventory (a prior fill waiting to be paired),
 *   2. a resting opposite-side order (match what's already on the book),
 *   3. the first leg placed for this market in the current cycle.
 * Returns undefined when nothing exists to pair against — the leg is fresh.
 * (Pure — extracted so the priority order is directly testable.)
 */
export function resolvePairTarget(
  heldOpposite: { shares: number | null | undefined; price: number | null | undefined } | null,
  restingOpposite: { shares: number; price: number } | null,
  cycleLeg: { shares: number; price: number } | null,
): PairTarget | undefined {
  for (const c of [heldOpposite, restingOpposite, cycleLeg]) {
    if (!c) continue;
    const { shares, price } = c;
    if (
      typeof shares === 'number' && isFinite(shares) && shares > 0 &&
      typeof price === 'number' && isFinite(price) && price > 0
    ) {
      return { matchShares: shares, partnerCost: price };
    }
  }
  return undefined;
}

export interface RestingOrderSizing {
  /** USD ceiling for this leg (min of REBATE_ORDER_SIZE_USD and remaining budget). */
  maxUsd: number;
  /**
   * Share count to match (pairing leg). A YES+NO pair is riskless only for
   * min(sharesYes, sharesNo) — equal-USD legs at different prices leave the
   * excess shares directional (the weather-bracket oversizing shape, PR #442).
   * When set, the leg is sized to min(matchShares, maxUsd/price).
   */
  matchShares?: number | undefined;
  /**
   * Partner leg's cost (see PairTarget.partnerCost). When set together with
   * matchShares, the leg is REJECTED unless
   * quote.price + partnerCost ≤ 1 − REBATE_MIN_COMBINED_EDGE — completing a
   * pair above that locks a guaranteed loss.
   */
  partnerCost?: number | undefined;
}

/**
 * Place one resting GTC post-only limit buy from a selector quote. The quote
 * price is already anchored to the effective mid and clamped against the
 * physical book; post-only is the final safety — a crossing order is rejected
 * by the exchange, never taker-filled.
 */
export async function placeRestingOrder(
  redis: Redis,
  candidate: RebateMarketCandidate,
  quote: RebateQuote,
  sizing: RestingOrderSizing,
): Promise<RestingOrder | null> {
  const cfg = loadConfig();
  const price = quote.price;
  if (!isFinite(price) || price <= 0 || price >= 1) return null;

  // Pair-cost ceiling: never complete a pair whose combined cost locks a
  // loss. The selector's combined guard only covers fresh two-sided quotes in
  // ONE snapshot — legs filled/repriced across cycles chase a moved market,
  // which is how 8 of the first 12 live pairs combined above $1.00.
  if (sizing.matchShares != null && sizing.partnerCost != null) {
    const ceiling = 1 - cfg.REBATE_MIN_COMBINED_EDGE;
    if (price + sizing.partnerCost > ceiling + 1e-9) {
      logger.info('[rebate] pair leg skipped — combined cost above ceiling', {
        marketId: candidate.marketId,
        direction: quote.direction,
        quotePrice: price,
        partnerCost: sizing.partnerCost,
        combined: +(price + sizing.partnerCost).toFixed(4),
        ceiling: +ceiling.toFixed(4),
      });
      await bumpStat(redis, candidate.marketId, 'pair_cost_skips');
      return null;
    }
  }

  let size = sizing.maxUsd / price;
  if (sizing.matchShares != null) size = Math.min(size, sizing.matchShares);
  const sizeUsd = size * price;
  if (size <= 0) return null;
  // Below the exchange minimum — typically a pair-completion leg whose match
  // target is tiny. Skip rather than fall back to fresh sizing (which would
  // recreate the oversized-pair problem this sizing exists to prevent).
  if (sizeUsd < CLOB_MIN_ORDER_USD) {
    logger.debug('[rebate] leg below CLOB minimum — skipping', {
      marketId: candidate.marketId,
      direction: quote.direction,
      sizeUsd: sizeUsd.toFixed(2),
      matchShares: sizing.matchShares,
    });
    return null;
  }

  logger.info('[rebate] placing resting order', {
    marketId: candidate.marketId,
    direction: quote.direction,
    tokenId: quote.tokenId,
    price,
    size: size.toFixed(4),
    sizeUsd: sizeUsd.toFixed(2),
    yesMid: candidate.yesMid.toFixed(3),
    spreadBps: candidate.spreadBps.toFixed(0),
    feeEquivUsdPerHour: candidate.flow.feeEquivalentUsdPerHour.toFixed(3),
  });

  const result = await submitClobLimitBuy({
    tokenId: quote.tokenId,
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
      direction: quote.direction,
      error: result.error,
    });
    await bumpStat(redis, candidate.marketId, 'place_failures');
    return null;
  }

  const order: RestingOrder = {
    orderId: result.order_id,
    marketId: candidate.marketId,
    conditionId: candidate.conditionId,
    tokenId: quote.tokenId,
    clobTokenIds: candidate.clobTokenIds,
    direction: quote.direction,
    price,
    size,
    sizeUsd,
    placedAt: new Date().toISOString(),
    tickSize: candidate.tickSize,
    negRisk: candidate.negRisk,
    question: candidate.question,
    feeRateBps: cfg.REBATE_FEE_RATE_BPS,
    rebateShare: candidate.rebateShare,
  };

  await saveRestingOrder(redis, order);
  await bumpStat(redis, candidate.marketId, 'orders_placed');

  return order;
}
