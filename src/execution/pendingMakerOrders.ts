/**
 * Redis lifecycle helpers for empty-book maker orders.
 *
 * When the CLOB book is empty (bid ≈ 0.01 / ask ≈ 0.99), the executor posts
 * a limit order at fair-value and returns immediately (non-blocking). The
 * order is persisted here so successive cron cycles can resume polling the
 * same order rather than re-posting a duplicate.
 *
 * Key schema:
 *   maker:open:{marketId}  →  JSON<PendingMakerOrder>
 *   TTL:  ceil(MAKER_EMPTY_BOOK_MAX_WAIT_MS / 1000) + 300  (5-min grace)
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';

const KEY_PREFIX = 'maker:open:';

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
}

function pendingKey(marketId: string): string {
  return `${KEY_PREFIX}${marketId}`;
}

/**
 * Returns the pending maker order for a market, or null if none exists / key
 * is missing / JSON is corrupt.
 */
export async function getPendingOrder(
  redis: Redis,
  marketId: string,
): Promise<PendingMakerOrder | null> {
  try {
    const raw = await redis.get(pendingKey(marketId));
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
  order: PendingMakerOrder,
  ttlSeconds: number,
): Promise<void> {
  try {
    await redis.set(pendingKey(marketId), JSON.stringify(order), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn('[pendingMakerOrders] failed to persist pending order (non-fatal)', {
      marketId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Removes the pending order key for a market. Called on fill, cancel, or
 * expiry cleanup. Safe to call even if the key doesn't exist.
 */
export async function deletePendingOrder(
  redis: Redis,
  marketId: string,
): Promise<void> {
  try {
    await redis.del(pendingKey(marketId));
  } catch (err) {
    logger.warn('[pendingMakerOrders] failed to delete pending order (non-fatal)', {
      marketId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
