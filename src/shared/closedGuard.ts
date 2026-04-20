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

// Per-market keys for markets confirmed resolved on-chain (distinct from our own TP/SL closes).
// Per-market keys give each entry its own TTL so old entries expire independently of new ones,
// unlike the shared-SET approach used by RECENTLY_CLOSED_KEY.
// Only this guard gates the sibling-position kill path in the redeemer, so a prior TP/SL on
// the same market does not incorrectly close a new position as "sibling resolved".
export const RECENTLY_RESOLVED_PREFIX = 'redeemer:resolved:';

export async function markRecentlyClosed(redis: Redis, marketId: string): Promise<void> {
  if (!marketId) return;
  await redis.sadd(RECENTLY_CLOSED_KEY, marketId);
  await redis.expire(RECENTLY_CLOSED_KEY, RECENTLY_CLOSED_TTL_S);
}

export async function isRecentlyClosed(redis: Redis, marketId: string): Promise<boolean> {
  if (!marketId) return false;
  return (await redis.sismember(RECENTLY_CLOSED_KEY, marketId)) === 1;
}

export async function markRecentlyResolved(redis: Redis, marketId: string): Promise<void> {
  if (!marketId) return;
  await redis.set(`${RECENTLY_RESOLVED_PREFIX}${marketId}`, '1', 'EX', RECENTLY_CLOSED_TTL_S);
}

export async function isRecentlyResolved(redis: Redis, marketId: string): Promise<boolean> {
  if (!marketId) return false;
  return (await redis.exists(`${RECENTLY_RESOLVED_PREFIX}${marketId}`)) === 1;
}
