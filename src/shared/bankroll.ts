/**
 * Live bankroll tracker — Simmer portfolio as source of truth.
 *
 * getBankroll() fetches the real USDC balance from Simmer's portfolio API.
 * deductStake() and creditProceeds() are no-ops — Simmer tracks the wallet.
 *
 * The Redis parameter is kept in signatures for backward compatibility with
 * existing callers but is not used.
 */
import type { Redis } from 'ioredis';
import { getPortfolio } from './simmer.js';
import { getClobBalance } from './clob.js';
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
 * Get the combined bankroll across all execution venues.
 *
 * - Simmer balance: USDC managed by Simmer's portfolio (primary execution path).
 * - CLOB balance:   On-chain USDC allowance/balance for direct Polymarket CLOB
 *   trades (fallback when Simmer doesn't know the market).
 *
 * Combined total is used for position sizing so Half-Kelly calculations reflect
 * the full capital available, regardless of which venue a trade routes through.
 *
 * Caches the result for CACHE_TTL_MS (15s) so rapid calls within a single
 * pipeline cycle (e.g. 30 market candidates all calling getBankroll()) reuse
 * the same value instead of issuing sequential API requests.
 */
export async function getBankroll(_redis?: Redis): Promise<number> {
  const now = Date.now();
  if (lastKnownBalance !== null && now - lastFetchTime < CACHE_TTL_MS) {
    return lastKnownBalance;
  }

  try {
    // Fetch Simmer and CLOB balances in parallel — neither blocks the other.
    const [portfolio, clobBalance] = await Promise.all([
      getPortfolio(),
      getClobBalance(),
    ]);

    const simmerBalance = portfolio.balance_usdc;
    const clob = clobBalance ?? 0;
    const total = simmerBalance + clob;

    lastKnownBalance = total;
    lastFetchTime = now;

    logger.info('[bankroll] combined live balance', {
      simmerUsdc: simmerBalance,
      clobUsdc: clob,
      totalUsdc: total,
    });

    if (total <= 0) {
      logger.error('[bankroll] total balance is zero or negative — all trades will be skipped', {
        totalUsdc: total,
      });
    } else if (total < LOW_BALANCE_WARN_USD) {
      logger.warn('[bankroll] total balance is suspiciously low', { totalUsdc: total });
    }

    return total;
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

/** No-op — Simmer credits wallet on redemption/exit. */
export async function creditProceeds(_redis: Redis, proceedsUsd: number): Promise<void> {
  logger.info('[bankroll] proceeds credited (tracked by Simmer)', { proceedsUsd });
}
