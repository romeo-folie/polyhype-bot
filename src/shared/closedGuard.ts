/**
 * Recently-closed guard.
 *
 * Tracks market IDs that were intentionally closed (by any path: redemption,
 * take-profit, stop-loss, manual, divergence, max-hold) so that the reconciler
 * will not re-import dust residuals as fresh positions.
 *
 * Without this, a TP-closed position leaving a tiny share remainder on Simmer
 * would get re-imported on the next reconciliation cycle as `sourcedFrom:
 * reconciled:simmer`, producing ghost ledger entries.
 */

import type { Redis } from 'ioredis';

export const RECENTLY_CLOSED_KEY = 'redeemer:recently-closed';
export const RECENTLY_CLOSED_TTL_S = 7 * 24 * 3600; // 7 days

export async function markRecentlyClosed(redis: Redis, marketId: string): Promise<void> {
  if (!marketId) return;
  await redis.sadd(RECENTLY_CLOSED_KEY, marketId);
  await redis.expire(RECENTLY_CLOSED_KEY, RECENTLY_CLOSED_TTL_S);
}

export async function isRecentlyClosed(redis: Redis, marketId: string): Promise<boolean> {
  if (!marketId) return false;
  return (await redis.sismember(RECENTLY_CLOSED_KEY, marketId)) === 1;
}
