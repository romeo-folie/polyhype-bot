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
 *
 * Per-market keys (redeemer:closed:<id>) give each entry its own 7-day TTL so
 * old entries expire independently. The legacy shared-SET (redeemer:recently-closed)
 * had a rolling global TTL that reset on every write, preventing old entries from
 * ever expiring while new positions continued to be closed.
 */

import type { Redis } from 'ioredis';

export const RECENTLY_CLOSED_TTL_S = 7 * 24 * 3600; // 7 days
export const RECENTLY_CLOSED_PREFIX = 'redeemer:closed:';

// Legacy key — kept only for backward-compat reads during migration
export const RECENTLY_CLOSED_KEY = 'redeemer:recently-closed';

// Per-market keys for markets confirmed resolved on-chain (distinct from our own TP/SL closes).
// Longer TTL than generic closed so scanners don't re-enter terminal markets after expiry.
export const RECENTLY_RESOLVED_TTL_S = 180 * 24 * 3600; // 180 days
export const RECENTLY_RESOLVED_PREFIX = 'redeemer:resolved:';

export async function markRecentlyClosed(redis: Redis, marketId: string): Promise<void> {
  if (!marketId) return;
  await redis.set(`${RECENTLY_CLOSED_PREFIX}${marketId}`, '1', 'EX', RECENTLY_CLOSED_TTL_S);
}

export async function isRecentlyClosed(redis: Redis, marketId: string): Promise<boolean> {
  if (!marketId) return false;
  // Check per-market key first, then fall back to legacy shared SET
  const perMarket = await redis.exists(`${RECENTLY_CLOSED_PREFIX}${marketId}`);
  if (perMarket === 1) return true;
  return (await redis.sismember(RECENTLY_CLOSED_KEY, marketId)) === 1;
}

export async function markRecentlyResolved(redis: Redis, marketId: string): Promise<void> {
  if (!marketId) return;
  await redis.set(`${RECENTLY_RESOLVED_PREFIX}${marketId}`, '1', 'EX', RECENTLY_RESOLVED_TTL_S);
}

export async function isRecentlyResolved(redis: Redis, marketId: string): Promise<boolean> {
  if (!marketId) return false;
  return (await redis.exists(`${RECENTLY_RESOLVED_PREFIX}${marketId}`)) === 1;
}
