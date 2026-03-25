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
import { logger } from './logger.js';

/** Warn when live balance drops below this threshold. */
const LOW_BALANCE_WARN_USD = 1.0;

/** In-memory fallback: last successfully fetched balance. */
let lastKnownBalance: number | null = null;

/** Get current bankroll from Simmer's live portfolio balance. */
export async function getBankroll(_redis?: Redis): Promise<number> {
  try {
    const portfolio = await getPortfolio();
    lastKnownBalance = portfolio.balance_usdc;

    if (portfolio.balance_usdc <= 0) {
      logger.error('[bankroll] live balance is zero or negative — all trades will be skipped', {
        balanceUsdc: portfolio.balance_usdc,
      });
    } else if (portfolio.balance_usdc < LOW_BALANCE_WARN_USD) {
      logger.warn('[bankroll] live balance is suspiciously low', {
        balanceUsdc: portfolio.balance_usdc,
      });
    } else {
      logger.info('[bankroll] live balance from Simmer', { balanceUsdc: portfolio.balance_usdc });
    }

    return portfolio.balance_usdc;
  } catch (err) {
    if (lastKnownBalance !== null) {
      logger.warn('[bankroll] Simmer API failed — using last known balance', {
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

/** No-op — Simmer deducts from wallet on trade execution. */
export async function deductStake(_redis: Redis, stakeUsd: number): Promise<number> {
  logger.info('[bankroll] stake deducted (tracked by Simmer)', { stakeUsd });
  return 0;
}

/** No-op — Simmer credits wallet on redemption/exit. */
export async function creditProceeds(_redis: Redis, proceedsUsd: number): Promise<number> {
  logger.info('[bankroll] proceeds credited (tracked by Simmer)', { proceedsUsd });
  return 0;
}
