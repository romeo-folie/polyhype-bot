/**
 * Live bankroll tracker — Simmer portfolio as source of truth.
 *
 * getBankroll() fetches the real USDC balance from Simmer's portfolio API.
 * CLOB balance is NOT included — CLOB capital is validated at order time
 * via the allowance preflight in submitClobBuy().
 *
 * deductStake() immediately adjusts the in-memory cache so consecutive
 * signals in the same cycle size against the post-trade balance.
 * creditProceeds() adds back to the cache for CLOB exits (Simmer tracks
 * its own wallet; CLOB proceeds are on-chain and not visible to Simmer).
 *
 * The Redis parameter is kept in signatures for backward compatibility with
 * existing callers but is not used.
 */
import type { Redis } from 'ioredis';
import { getPortfolio } from './simmer.js';
import { logger } from './logger.js';

/** Warn when live balance drops below this threshold. */
const LOW_BALANCE_WARN_USD = 1.0;

/** TTL for the in-process balance cache — avoids hammering Simmer on every position-sizing call. */
const CACHE_TTL_MS = 15_000;

/** In-memory fallback: last successfully fetched balance. */
let lastKnownBalance: number | null = null;
let lastFetchTime = 0;

/** Reset cache state. Exported for test use only — do not call in production code. */
export function _resetCacheForTests(): void {
  lastKnownBalance = null;
  lastFetchTime = 0;
}

/**
 * Get the current bankroll (Simmer portfolio balance only).
 *
 * Caches the result for CACHE_TTL_MS (15s) so rapid calls within a single
 * pipeline cycle reuse the same value instead of issuing sequential API requests.
 */
export async function getBankroll(_redis?: Redis): Promise<number> {
  const now = Date.now();
  if (lastKnownBalance !== null && now - lastFetchTime < CACHE_TTL_MS) {
    return lastKnownBalance;
  }

  try {
    const portfolio = await getPortfolio();
    const simmerBalance = portfolio.balance_usdc;

    lastKnownBalance = simmerBalance;
    lastFetchTime = now;

    logger.info('[bankroll] simmer live balance', {
      simmerUsdc: simmerBalance,
    });

    if (simmerBalance <= 0) {
      logger.error('[bankroll] total balance is zero or negative — all trades will be skipped', {
        totalUsdc: simmerBalance,
      });
    } else if (simmerBalance < LOW_BALANCE_WARN_USD) {
      logger.warn('[bankroll] total balance is suspiciously low', { totalUsdc: simmerBalance });
    }

    return simmerBalance;
  } catch (err) {
    if (lastKnownBalance !== null) {
      logger.warn('[bankroll] balance fetch failed — using last known balance', {
        lastKnownBalance,
        error: err instanceof Error ? err.message : String(err),
      });
      return lastKnownBalance;
    }
    throw err;
  }
}

/** @deprecated No-op — Simmer tracks the wallet balance directly. */
export async function setBankroll(_redis: Redis, _amount: number): Promise<void> {
  logger.info('[bankroll] setBankroll is deprecated — Simmer tracks the wallet balance');
}

/**
 * Deduct a stake from the in-memory bankroll cache.
 *
 * Simmer deducts from the actual wallet on execution, but the in-process
 * cache needs updating immediately — otherwise the next signal in the same
 * cycle sizes against the full pre-trade balance and Simmer rejects it for
 * insufficient funds.
 */
export async function deductStake(_redis: Redis, stakeUsd: number): Promise<void> {
  if (lastKnownBalance !== null) {
    lastKnownBalance = Math.max(0, lastKnownBalance - stakeUsd);
  }
  logger.info('[bankroll] stake deducted from cache', { stakeUsd, remainingCached: lastKnownBalance });
}

/**
 * Credit proceeds back to the in-memory bankroll cache.
 *
 * For Simmer positions, Simmer tracks the wallet directly. For CLOB positions,
 * proceeds are on-chain — updating the cache here keeps position sizing accurate
 * until the next Simmer portfolio refresh.
 */
export async function creditProceeds(_redis: Redis, proceedsUsd: number): Promise<void> {
  if (lastKnownBalance !== null) {
    lastKnownBalance += proceedsUsd;
  }
  logger.info('[bankroll] proceeds credited', { proceedsUsd, cachedBalance: lastKnownBalance });
}
