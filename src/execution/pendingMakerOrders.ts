/**
 * Redis lifecycle helpers for empty-book maker orders.
 *
 * When the CLOB book is empty (bid ≈ 0.01 / ask ≈ 0.99), the executor posts
 * a limit order at fair-value and returns immediately (non-blocking). The
 * order is persisted here so successive cron cycles can resume polling the
 * same order rather than re-posting a duplicate.
 *
 * Key schema:
 *   maker:open:{marketId}:{direction}  →  JSON<PendingMakerOrder>
 *   TTL:  ceil(MAKER_EMPTY_BOOK_MAX_WAIT_MS / 1000) + 300  (5-min grace)
 *
 * Direction is normalised to 'YES' / 'NO' so oracle-lag signals ('UP'/'DOWN')
 * and weather signals ('YES'/'NO') share the same key space.  This allows two
 * simultaneous resting orders on a single market (bracket strategy) as long as
 * they are on different sides.
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';

const KEY_PREFIX = 'maker:open:';

function normalizeDirection(direction: string): 'YES' | 'NO' {
  return direction === 'YES' || direction === 'UP' ? 'YES' : 'NO';
}

function pendingKey(marketId: string, direction: string): string {
  return `${KEY_PREFIX}${marketId}:${normalizeDirection(direction)}`;
}

export interface PendingMakerOrder {
  orderId: string;
  tokenId: string;
  price: number;
  size: number;
  postedAt: number;
  expiresAt: number;
  consensusP: number;
  direction: string;
  // Signal benchmark fields — stored so the reconciler can enrich positions
  // that fill before the executor's next cron resume cycle.
  edgeMagnitude?: number;
  // bestAsk from the YES book at posting time — used as counterfactualImmediateTakerPrice
  // (what we would have paid as an immediate taker at the moment of order placement).
  bestAskAtPosting?: number;
  intendedStakeUsd?: number;
  sourcedFrom?: string;
  reasoning?: string;
  // Carried forward so the reconciler can link the async fill back to the
  // original execution attempt and write a confirmed execution_events row.
  executionId?: string;
  source?: string;
  // True when the order was posted via the rest-above-cap path (market price was
  // above the effective entry cap at post time; the post itself is clamped to the
  // cap). Used to bound the out-of-range pool (WEATHER_REST_ABOVE_CAP_MAX_NOTIONAL_USD)
  // and for cohort analysis of these fills.
  restAboveCap?: boolean;
  // True for bracket-strategy opposite legs. The revalidation pass must never
  // cancel these: they intentionally rest value-negative as the pairing leg.
  // Legacy blobs written before this field exist without it — consumers must
  // treat absence as "unknown, do not cancel" (edgeMagnitude===0 heuristic).
  isBracketOpposite?: boolean;
}

/** A pending maker order paired with the market/direction parsed from its key. */
export interface PendingMakerOrderEntry {
  marketId: string;
  direction: 'YES' | 'NO';
  order: PendingMakerOrder;
}

/**
 * Lists all pending maker orders via a cursor SCAN over `maker:open:*`.
 * Corrupt/unparseable blobs are skipped. Order of results is unspecified.
 */
export async function listPendingOrders(redis: Redis): Promise<PendingMakerOrderEntry[]> {
  const entries: PendingMakerOrderEntry[] = [];
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 100);
      cursor = next;
      if (keys.length === 0) continue;
      const values = await redis.mget(...keys);
      for (let i = 0; i < keys.length; i++) {
        const raw = values[i];
        if (!raw) continue;
        // Key layout: maker:open:{marketId}:{YES|NO} — marketId never contains ':'
        // (Gamma numeric ids), but split defensively from the right.
        const suffix = keys[i]!.slice(KEY_PREFIX.length);
        const sepIdx = suffix.lastIndexOf(':');
        if (sepIdx <= 0) continue;
        const marketId = suffix.slice(0, sepIdx);
        const direction = suffix.slice(sepIdx + 1);
        if (direction !== 'YES' && direction !== 'NO') continue;
        try {
          entries.push({ marketId, direction, order: JSON.parse(raw) as PendingMakerOrder });
        } catch {
          // corrupt blob — skip
        }
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.warn('[pendingMakerOrders] failed to list pending orders (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return entries;
}

/**
 * Sum of posted notional (price × size, USD) across unfilled rest-above-cap
 * maker orders. This is the "out-of-range pool" bounded by
 * WEATHER_REST_ABOVE_CAP_MAX_NOTIONAL_USD. Counts only blobs explicitly flagged
 * restAboveCap — in-range posts never count against the pool.
 */
export async function sumRestAboveCapNotional(redis: Redis): Promise<number> {
  const entries = await listPendingOrders(redis);
  let total = 0;
  for (const { order } of entries) {
    if (order.restAboveCap !== true) continue;
    const notional = (order.price ?? 0) * (order.size ?? 0);
    if (Number.isFinite(notional) && notional > 0) total += notional;
  }
  return total;
}

/**
 * Returns the pending maker order for a market+direction, or null if none
 * exists / key is missing / JSON is corrupt.
 */
export async function getPendingOrder(
  redis: Redis,
  marketId: string,
  direction: string,
): Promise<PendingMakerOrder | null> {
  try {
    const raw = await redis.get(pendingKey(marketId, direction));
    if (!raw) return null;
    return JSON.parse(raw) as PendingMakerOrder;
  } catch {
    return null;
  }
}

/**
 * Persists a pending maker order. TTL is set to `ttlSeconds` so Redis acts as
 * a backstop if the executor never cleans up (e.g. process crash mid-poll).
 */
export async function setPendingOrder(
  redis: Redis,
  marketId: string,
  direction: string,
  order: PendingMakerOrder,
  ttlSeconds: number,
): Promise<void> {
  try {
    await redis.set(pendingKey(marketId, direction), JSON.stringify(order), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn('[pendingMakerOrders] failed to persist pending order (non-fatal)', {
      marketId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Removes the pending order key for a market+direction. Called on fill,
 * cancel, or expiry cleanup. Safe to call even if the key doesn't exist.
 */
export async function deletePendingOrder(
  redis: Redis,
  marketId: string,
  direction: string,
): Promise<void> {
  try {
    await redis.del(pendingKey(marketId, direction));
  } catch (err) {
    logger.warn('[pendingMakerOrders] failed to delete pending order (non-fatal)', {
      marketId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
