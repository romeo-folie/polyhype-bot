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
import { recordPosition, getPosition } from '../execution/positionLedger.js';
import { notifyRebateFill } from '../execution/telegram.js';
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
  /** Held orders cancelled by the hold policy: past resolution or past the
   * lifetime backstop. NOT the old per-cycle age>TTL churn (now removed). */
  stale: RestingOrder[];
  /** Naked fresh legs cancelled by the orphan sweep (no held or resting opposite). */
  orphanCancels: RestingOrder[];
  errors: number;
}

/**
 * Cancel a tracked resting order on the CLOB and remove it from tracking.
 * Shared by the fresh-pair rollback (leg 2 failed after leg 1 placed) and the
 * orphan-leg sweep.
 *
 * Fail-closed accounting (PR #459 review):
 *   - 'cancelled'    — confirmed dead with ZERO fill; untracked.
 *   - 'filled'       — the order (partially) FILLED before/while we cancelled;
 *                      the fill is recorded into the position ledger + rebate
 *                      stats first, then untracked. Capital became inventory —
 *                      callers must NOT refund its budget.
 *   - 'kept_tracked' — anything uncertain: cancel unconfirmed AND the order
 *                      may still be live, or the post-cancel recheck failed
 *                      (getClobOrder returns null for transient errors too).
 *                      Tracking is kept so the next reconcile retries; never
 *                      drop visibility of an order that may be live or filled.
 */
export async function cancelRestingOrder(
  redis: Redis,
  order: RestingOrder,
  reason: 'rollback' | 'orphan',
): Promise<'cancelled' | 'filled' | 'kept_tracked'> {
  const cancelled = await cancelClobOrder(order.orderId);

  // ALWAYS recheck — even after a successful cancel the order can have
  // partially filled first, and that fill must reach the ledger.
  const recheck = await getClobOrder(order.orderId);
  if (recheck === null) {
    // Not-found and transient fetch errors are indistinguishable here.
    // Keep tracked; reconcile's age-based heuristic resolves truly-gone
    // orders, and a live/filled order gets processed normally next cycle.
    logger.warn('[rebate] cancel recheck unavailable — order remains tracked for next reconcile', {
      orderId: order.orderId,
      marketId: order.marketId,
      direction: order.direction,
      cancelAccepted: cancelled,
      reason,
    });
    return 'kept_tracked';
  }

  const matched = parseFloat(recheck.size_matched ?? '0');
  if (isFinite(matched) && matched > 0) {
    // Filled (fully or partially) before the cancel took hold. Record the
    // fill FIRST — losing it would leave invisible naked inventory, the
    // exact exposure this helper exists to contain.
    const original = parseFloat(recheck.original_size ?? String(order.size));
    await recordFilledOrder(redis, order, matched);
    await removeRestingOrder(redis, order.orderId, order.marketId);
    await recordLifetime(redis, order);
    await bumpStat(redis, order.marketId, matched >= original - 1e-9 ? 'fills' : 'partial_fills');
    logger.warn('[rebate] order filled during cancel — fill recorded, inventory now held', {
      orderId: order.orderId,
      marketId: order.marketId,
      direction: order.direction,
      sharesFilled: matched,
      reason,
    });
    return 'filled';
  }

  const recheckStatus = String(recheck.status ?? '').toLowerCase();
  const terminal = ['cancelled', 'canceled', 'expired'].includes(recheckStatus);
  if (!cancelled && !terminal) {
    logger.error('[rebate] cancel failed — order remains tracked for next reconcile', {
      orderId: order.orderId,
      marketId: order.marketId,
      direction: order.direction,
      recheckStatus,
      reason,
    });
    return 'kept_tracked';
  }

  // Confirmed dead with zero fill.
  await removeRestingOrder(redis, order.orderId, order.marketId);
  await recordLifetime(redis, order);
  await bumpStat(redis, order.marketId, reason === 'rollback' ? 'pair_rollbacks' : 'orphan_leg_cancels');
  return 'cancelled';
}

/**
 * Orphan-leg sweep: a tracked resting order with NO held opposite-side
 * position and NO tracked resting opposite-side order is a naked fresh leg —
 * the exact exposure the atomic-pair preflight exists to prevent (it can
 * still arise from a crash between legs, a manual cancel of one leg, or
 * pre-redesign state). Cancel it.
 *
 * Legitimate survivors: pair-completion state (held opposite exists) and
 * intact two-sided resting pairs (resting opposite exists).
 */
async function sweepOrphanLegs(
  redis: Redis,
  orders: Map<string, RestingOrder>,
): Promise<{ orphanCancels: RestingOrder[]; errors: number }> {
  const orphanCancels: RestingOrder[] = [];
  let errors = 0;
  for (const order of orders.values()) {
    try {
      const oppositeDirection = order.direction === 'YES' ? 'NO' : 'YES';
      const heldOpposite = await getPosition(redis, order.marketId, oppositeDirection);
      if (heldOpposite) continue;
      if (findRestingOrder(orders, order.marketId, oppositeDirection)) continue;

      logger.warn('[rebate] orphaned fresh leg detected — cancelling', {
        orderId: order.orderId,
        marketId: order.marketId,
        direction: order.direction,
        price: order.price,
        sizeUsd: order.sizeUsd,
        question: order.question.slice(0, 60),
      });
      const outcome = await cancelRestingOrder(redis, order, 'orphan');
      if (outcome === 'cancelled') {
        orders.delete(order.orderId);
        orphanCancels.push(order);
      } else if (outcome === 'filled') {
        // Filled during the sweep — the fill is recorded and the order
        // untracked; it is held inventory now, not an orphan cancel.
        orders.delete(order.orderId);
      } else {
        errors++;
      }
    } catch (err: unknown) {
      errors++;
      logger.warn('[rebate] orphan sweep error for order', {
        orderId: order.orderId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { orphanCancels, errors };
}

/**
 * Reconcile all tracked resting orders against the CLOB.
 * Detects fills (→ recordPosition) and external cancels. Still-live orders are
 * HELD to preserve CLOB time-priority — cancelled only past their market's
 * resolution or past the long lifetime backstop (REBATE_MAX_ORDER_LIFETIME_S);
 * price drift is handled separately by the reprice pass. Sweeps orphan legs.
 */
export async function reconcileOrders(redis: Redis): Promise<ReconcileResult> {
  const cfg = loadConfig();
  const orders = await loadRestingOrders(redis);
  const result: ReconcileResult = {
    filled: [],
    partialFills: [],
    cancelled: [],
    stale: [],
    orphanCancels: [],
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
          await bumpStat(redis, order.marketId, 'assumed_gone');
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

      // Hold-policy cancel. A still-live, well-priced resting order is HELD
      // across cycles to preserve CLOB time-priority — the blanket
      // age>TTL cancel that used to fire here recycled ~99% of orders every
      // 5-min cycle, forfeiting queue position and crushing the fill rate
      // (mirrors the weather maker queue-priority fix, PR #465). Price drift
      // is handled by the reprice pass (cancelForReprice); a held order is
      // cancelled HERE only when:
      //   (a) it is past its market's resolution (endDate) — avoid adverse
      //       fills into resolution, mirroring weather's post-resolution sweep, or
      //   (b) it exceeds the long lifetime backstop — a stuck-order safety net.
      const ageMs = Date.now() - new Date(order.placedAt).getTime();
      const endMs = order.endDate ? Date.parse(order.endDate) : NaN;
      const pastResolution = isFinite(endMs) && Date.now() > endMs;
      const pastLifetimeCap = ageMs > cfg.REBATE_MAX_ORDER_LIFETIME_S * 1000;
      if (pastResolution || pastLifetimeCap) {
        const cancelled = await cancelClobOrder(orderId);
        // ALWAYS recheck, success included — the order can partially fill in
        // the race between the top-of-loop fetch and the cancel, and a
        // successful cancel of the REMAINDER must not drop that fill from
        // the ledger (PR #459 review).
        const recheck = await getClobOrder(orderId);
        if (!recheck) {
          // Recheck failed (transient?) — keep tracked, retry next cycle.
          logger.warn('[rebate] hold-cancel + recheck failed, will retry', { orderId });
          continue;
        }
        const recheckMatched = parseFloat(recheck.size_matched ?? '0');
        if (isFinite(recheckMatched) && recheckMatched > 0) {
          // Filled during the cancel window — keep TRACKED; the next cycle's
          // top-of-loop fill detection records the position + rebate stats
          // through the normal full/partial paths.
          logger.warn('[rebate] held order filled during cancel — leaving for fill detection', {
            orderId,
            sharesFilled: recheckMatched,
            cancelAccepted: cancelled,
          });
          continue;
        }
        const recheckStatus = String(recheck.status ?? '').toLowerCase();
        if (!cancelled && !['cancelled', 'canceled', 'expired'].includes(recheckStatus)) {
          logger.warn('[rebate] hold-cancel failed, will retry', { orderId });
          continue;
        }
        await removeRestingOrder(redis, orderId, order.marketId);
        await recordLifetime(redis, order);
        result.stale.push(order);
        await bumpStat(redis, order.marketId, pastResolution ? 'post_resolution_cancels' : 'lifetime_cap_cancels');
        logger.info('[rebate] held order cancelled', {
          orderId,
          marketId: order.marketId,
          direction: order.direction,
          reason: pastResolution ? 'past_resolution' : 'lifetime_cap',
          ageHours: +(ageMs / 3_600_000).toFixed(1),
        });
        continue;
      }

      // Order still live, still valid, not past resolution — HOLD it to keep
      // queue priority. The reprice pass cancels it only if its price drifts.
    } catch (err: unknown) {
      result.errors++;
      logger.warn('[rebate] reconciliation error for order', {
        orderId,
        marketId: order.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Orphan-leg sweep on the POST-reconcile state (the loop above removes
  // entries in Redis, not in the local map — reload for an accurate view).
  const postOrders = await loadRestingOrders(redis);
  const sweep = await sweepOrphanLegs(redis, postOrders);
  result.orphanCancels = sweep.orphanCancels;
  result.errors += sweep.errors;

  if (
    result.filled.length > 0 || result.partialFills.length > 0 ||
    result.stale.length > 0 || result.orphanCancels.length > 0
  ) {
    logger.info('[rebate] reconciliation complete', {
      filled: result.filled.length,
      partialFills: result.partialFills.length,
      cancelled: result.cancelled.length,
      stale: result.stale.length,
      orphanCancels: result.orphanCancels.length,
      errors: result.errors,
    });
  }

  return result;
}

/**
 * Classify a just-filled rebate leg's pairing status for the fill notification.
 * Pure — no I/O. `oppositeHeldPrice` is the entry price of an opposite leg
 * already held (→ paired/hedged); `oppositeRestingPrice` is the price of an
 * opposite order still resting (→ pair pending). Neither → naked directional leg.
 */
export function classifyRebatePairing(
  thisPrice: number,
  oppositeHeldPrice: number | null,
  oppositeRestingPrice: number | null,
): { status: 'paired' | 'pair_pending' | 'naked'; combinedCost: number | null } {
  if (oppositeHeldPrice != null) {
    return { status: 'paired', combinedCost: thisPrice + oppositeHeldPrice };
  }
  if (oppositeRestingPrice != null) {
    return { status: 'pair_pending', combinedCost: thisPrice + oppositeRestingPrice };
  }
  return { status: 'naked', combinedCost: null };
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
    // Preserve the market's fee-category share so a later pair-completion leg
    // built from this position inherits the correct rebate share (0.20 crypto /
    // 0.25 rest) instead of defaulting to 0.25 and overstating est_rebate_usd.
    ...(order.rebateShare !== undefined && { rebateShare: order.rebateShare }),
  });

  // Per-fill notification with pairing status: opposite leg held → PAIRED
  // (hedged); opposite still resting → pair pending; neither → naked directional
  // leg. Fire-and-forget so a Telegram hiccup never breaks reconciliation.
  if (cfg.REBATE_FILL_NOTIFY_ENABLED) {
    const oppositeDir = order.direction === 'YES' ? 'NO' : 'YES';
    const oppositePos = await getPosition(redis, order.marketId, oppositeDir).catch(() => null);
    let oppositeRestingPrice: number | null = null;
    if (!oppositePos) {
      const restingOrders = await loadRestingOrders(redis).catch(
        () => new Map<string, RestingOrder>(),
      );
      oppositeRestingPrice = findRestingOrder(restingOrders, order.marketId, oppositeDir)?.price ?? null;
    }
    const { status, combinedCost } = classifyRebatePairing(
      order.price,
      oppositePos?.entryPrice ?? null,
      oppositeRestingPrice,
    );
    void notifyRebateFill({
      question: order.question,
      direction: order.direction,
      price: order.price,
      shares: sharesFilled,
      usd: filledUsd,
      estRebateUsd,
      isPartial: sharesFilled < order.size - 1e-9,
      pairing: status,
      combinedCost,
      oppositeRestingPrice,
    }).catch((err: unknown) => {
      logger.warn('[rebate] fill notification failed', {
        marketId: order.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

// ─── Order placement ─────────────────────────────────────────────────────────

/**
 * A resting BUY bid is "stranded" when the live maker target has risen ABOVE
 * its resting price by more than `threshold` — the market moved up and away, so
 * a seller will never come down to our bid and it can't fill. Directional on
 * purpose: if `freshTarget <= restingPrice` the market came down TO our bid and
 * it's about to fill (or still in range) — NOT stranded. Do NOT use |abs| here:
 * the reprice pass can (it re-posts), but this drives a CANCEL that forfeits
 * queue priority, so it must only fire on the won't-fill direction.
 */
export function isRestingOrderStranded(
  restingPrice: number,
  freshTarget: number,
  threshold: number,
): boolean {
  return freshTarget - restingPrice > threshold;
}

/**
 * Cancel a resting order so it can be re-posted at a drifted target price (or
 * dropped entirely, for the de-selected revalidation pass — pass
 * `statField='stale_drift_cancels'`).
 * Returns true when the order is confirmed gone WITH ZERO FILL (safe to place
 * a replacement); false skips the replacement this cycle — either the
 * original stays tracked (unconfirmed) or it (partially) FILLED during the
 * cancel, in which case the fill is recorded first and re-posting the same
 * direction would stack onto fresh inventory.
 */
export async function cancelForReprice(
  redis: Redis,
  order: RestingOrder,
  statField = 'reprice_cancels',
): Promise<boolean> {
  const cancelled = await cancelClobOrder(order.orderId);

  // ALWAYS recheck — a successful cancel can follow a partial fill, and that
  // fill must reach the ledger (PR #459 review; same discipline as
  // cancelRestingOrder).
  const recheck = await getClobOrder(order.orderId);
  if (!recheck) {
    logger.warn('[rebate] reprice cancel recheck unavailable — keeping original tracked', {
      orderId: order.orderId,
      marketId: order.marketId,
      cancelAccepted: cancelled,
    });
    return false;
  }

  const matched = parseFloat(recheck.size_matched ?? '0');
  if (isFinite(matched) && matched > 0) {
    const original = parseFloat(recheck.original_size ?? String(order.size));
    await recordFilledOrder(redis, order, matched);
    await removeRestingOrder(redis, order.orderId, order.marketId);
    await recordLifetime(redis, order);
    await bumpStat(redis, order.marketId, matched >= original - 1e-9 ? 'fills' : 'partial_fills');
    logger.warn('[rebate] order filled during reprice cancel — fill recorded, no re-post', {
      orderId: order.orderId,
      marketId: order.marketId,
      direction: order.direction,
      sharesFilled: matched,
    });
    return false;
  }

  const recheckStatus = String(recheck.status ?? '').toLowerCase();
  if (!cancelled && !['cancelled', 'canceled', 'expired'].includes(recheckStatus)) {
    logger.warn('[rebate] reprice cancel unconfirmed — keeping original order', {
      orderId: order.orderId,
      marketId: order.marketId,
    });
    return false;
  }

  await removeRestingOrder(redis, order.orderId, order.marketId);
  await recordLifetime(redis, order);
  await bumpStat(redis, order.marketId, statField);
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
 *   2. a resting opposite-side order (match what's already on the book).
 *
 * Returns:
 *   - a PairTarget when there is something valid to pair against,
 *   - `null` (PAIRING BLOCKED) when held opposite inventory EXISTS but its
 *     entry price is unusable — falling through to a resting order would
 *     mis-size against the wrong inventory, and placing fresh would re-create
 *     the oversized-pair problem; the caller must skip the leg entirely,
 *   - `undefined` when nothing exists to pair against — the leg is fresh
 *     (fresh pairs are planned atomically by pairPlanner, never chained
 *     within a cycle).
 * (Pure — extracted so the priority order is directly testable.)
 */
export function resolvePairTarget(
  heldOpposite: { shares: number | null | undefined; price: number | null | undefined } | null,
  restingOpposite: { shares: number; price: number } | null,
): PairTarget | null | undefined {
  const valid = (v: unknown): v is number => typeof v === 'number' && isFinite(v) && v > 0;
  if (heldOpposite && valid(heldOpposite.shares)) {
    if (valid(heldOpposite.price)) {
      return { matchShares: heldOpposite.shares, partnerCost: heldOpposite.price };
    }
    // Held inventory with an unusable cost basis: the pair-cost ceiling
    // cannot be evaluated — fail closed.
    return null;
  }
  if (restingOpposite && valid(restingOpposite.shares) && valid(restingOpposite.price)) {
    return { matchShares: restingOpposite.shares, partnerCost: restingOpposite.price };
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
    endDate: candidate.endDate,
  };

  await saveRestingOrder(redis, order);
  await bumpStat(redis, candidate.marketId, 'orders_placed');

  return order;
}
