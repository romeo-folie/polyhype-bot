/**
 * Position reconciliation — hourly log-only comparison of ledger vs venue state.
 *
 * Compares:
 * - Ledger positions (Redis) via getOpenPositions()
 * - Simmer active positions via getSimmerPositions({ status: 'active', venue: 'polymarket', source: 'sdk:polymarket-geopolitical-agent' })
 * - CLOB on-chain balances for ledger positions with executionVenue === 'clob' via fetchClobTokenBalance()
 *
 * Outputs:
 * - Orphan: position exists on Simmer but no matching ledger entry
 * - Ghost: position exists in ledger but not on Simmer (for executionVenue === 'simmer') or on-chain balance is zero (for executionVenue === 'clob')
 * - Mismatch: ledger vs venue shares differ beyond tolerance (absDiff > 0.01 or >1%)
 *
 * Limitations:
 * - Cannot discover unknown CLOB orphans without a universe of token IDs; logs only what we can compare from ledger positions.
 * - Skips positions with pendingSettlement === true
 *
 * No Telegram alerts — log-only.
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { getOpenPositions } from '../execution/positionLedger.js';
import { getSimmerPositions } from '../shared/simmer.js';
import { fetchClobTokenBalance } from '../shared/clob.js';

interface ReconciliationDetail {
  type: 'orphan' | 'ghost' | 'mismatch';
  marketId: string;
  direction?: string;
  ledgerShares?: number;
  venueShares?: number;
  venue?: string;
  reason?: string;
}

const RECONCILE_COUNTER_KEY = 'reconcile:counter';
const RECONCILE_INTERVAL = 12; // Run every 12 monitor cycles (hourly at 5-min intervals)

/**
 * Check if reconciliation should run this cycle (every 12 cycles).
 * Increments the counter and returns true if counter % 12 === 0.
 */
export async function shouldRunReconciliation(redis: Redis): Promise<boolean> {
  const count = await redis.incr(RECONCILE_COUNTER_KEY);
  return count % RECONCILE_INTERVAL === 0;
}

/**
 * Run position reconciliation — compare ledger vs venue state and log discrepancies.
 */
export async function runReconciliation(redis: Redis): Promise<void> {
  logger.info('[reconcile] starting hourly reconciliation pass');

  try {
    // 1. Fetch ledger positions
    const ledgerPositions = await getOpenPositions(redis);

    // Filter out pendingSettlement positions from reconciliation checks
    const activePositions = ledgerPositions.filter((p) => !p.pendingSettlement);

    logger.info('[reconcile] loaded positions', {
      total: ledgerPositions.length,
      active: activePositions.length,
      pendingSettlement: ledgerPositions.length - activePositions.length,
    });

    // 2. Fetch Simmer positions
    const simmerPositions = await getSimmerPositions({
      status: 'active',
      venue: 'polymarket',
      source: 'sdk:polymarket-geopolitical-agent',
    });

    logger.info('[reconcile] fetched Simmer positions', { count: simmerPositions.length });

    // 3. Build lookup maps
    const ledgerMap = new Map<string, typeof activePositions[0]>();
    for (const pos of activePositions) {
      // Key: marketId:direction (uppercase direction in ledger)
      ledgerMap.set(`${pos.marketId}:${pos.direction}`, pos);
    }

    const simmerMap = new Map<string, typeof simmerPositions[0]>();
    for (const pos of simmerPositions) {
      // Normalize Simmer side (lowercase 'yes'/'no') to uppercase for comparison
      const direction = pos.side.toUpperCase();
      simmerMap.set(`${pos.market_id}:${direction}`, pos);
    }

    // 4. Reconciliation checks
    const details: ReconciliationDetail[] = [];
    let clobCount = 0;

    // Check ledger positions against venues
    for (const ledgerPos of activePositions) {
      const key = `${ledgerPos.marketId}:${ledgerPos.direction}`;

      if (ledgerPos.executionVenue === 'simmer') {
        // Check against Simmer
        const simmerPos = simmerMap.get(key);

        if (!simmerPos) {
          // Ghost: in ledger but not on Simmer
          details.push({
            type: 'ghost',
            marketId: ledgerPos.marketId,
            direction: ledgerPos.direction,
            venue: 'simmer',
            ledgerShares: ledgerPos.sharesHeld ?? 0,
            reason: 'position in ledger but not found on Simmer',
          });
        } else {
          // Check for share mismatch
          const ledgerShares = ledgerPos.sharesHeld ?? 0;
          const simmerShares = simmerPos.shares ?? 0;
          const absDiff = Math.abs(ledgerShares - simmerShares);
          const relDiff = ledgerShares > 0 ? absDiff / ledgerShares : 0;

          if (absDiff > 0.01 && relDiff > 0.01) {
            details.push({
              type: 'mismatch',
              marketId: ledgerPos.marketId,
              direction: ledgerPos.direction,
              venue: 'simmer',
              ledgerShares,
              venueShares: simmerShares,
              reason: `shares differ: ledger=${ledgerShares.toFixed(2)}, simmer=${simmerShares.toFixed(2)} (diff=${absDiff.toFixed(2)}, ${(relDiff * 100).toFixed(1)}%)`,
            });
          }
        }

        // Remove from map so we can find orphans later
        simmerMap.delete(key);

      } else if (ledgerPos.executionVenue === 'clob') {
        // Check on-chain balance for each CLOB token
        clobCount++;
        const tokenIds = ledgerPos.clobTokenIds ?? [];

        if (tokenIds.length === 0) {
          logger.warn('[reconcile] CLOB position has no tokenIds', {
            marketId: ledgerPos.marketId,
            direction: ledgerPos.direction,
          });
          continue;
        }

        // For binary markets, we expect one token ID per direction
        // Fetch the primary token balance (tokenIds[0] for YES, tokenIds[1] for NO typically)
        const tokenIndex = ledgerPos.direction === 'YES' ? 0 : 1;
        const tokenId = tokenIds[tokenIndex];

        if (!tokenId) {
          logger.warn('[reconcile] CLOB position missing tokenId for direction', {
            marketId: ledgerPos.marketId,
            direction: ledgerPos.direction,
            tokenIndex,
          });
          continue;
        }

        const balanceResult = await fetchClobTokenBalance(tokenId);

        if (!balanceResult.ok) {
          logger.warn('[reconcile] failed to fetch CLOB balance — skipping', {
            marketId: ledgerPos.marketId,
            direction: ledgerPos.direction,
            tokenId,
            error: balanceResult.error,
          });
          continue;
        }

        const onChainShares = balanceResult.balance;
        const ledgerShares = ledgerPos.sharesHeld ?? 0;

        if (onChainShares === 0) {
          // Ghost: in ledger but zero on-chain balance
          details.push({
            type: 'ghost',
            marketId: ledgerPos.marketId,
            direction: ledgerPos.direction,
            venue: 'clob',
            ledgerShares,
            venueShares: onChainShares,
            reason: 'position in ledger but on-chain balance is zero',
          });
        } else {
          // Check for share mismatch
          const absDiff = Math.abs(ledgerShares - onChainShares);
          const relDiff = ledgerShares > 0 ? absDiff / ledgerShares : 0;

          if (absDiff > 0.01 && relDiff > 0.01) {
            details.push({
              type: 'mismatch',
              marketId: ledgerPos.marketId,
              direction: ledgerPos.direction,
              venue: 'clob',
              ledgerShares,
              venueShares: onChainShares,
              reason: `shares differ: ledger=${ledgerShares.toFixed(2)}, on-chain=${onChainShares.toFixed(2)} (diff=${absDiff.toFixed(2)}, ${(relDiff * 100).toFixed(1)}%)`,
            });
          }
        }
      }
    }

    // Find orphans: positions on Simmer but not in ledger
    for (const [key, simmerPos] of simmerMap.entries()) {
      details.push({
        type: 'orphan',
        marketId: simmerPos.market_id,
        direction: simmerPos.side.toUpperCase(),
        venue: 'simmer',
        venueShares: simmerPos.shares ?? 0,
        reason: 'position exists on Simmer but no matching ledger entry',
      });
    }

    // Summary counts
    const orphans = details.filter((d) => d.type === 'orphan').length;
    const ghosts = details.filter((d) => d.type === 'ghost').length;
    const mismatches = details.filter((d) => d.type === 'mismatch').length;

    logger.info('[reconcile] summary', {
      ledgerCount: activePositions.length,
      simmerCount: simmerPositions.length,
      clobCount,
      orphans,
      ghosts,
      mismatches,
      details: details.length > 0 ? details : undefined,
    });

    if (details.length === 0) {
      logger.info('[reconcile] all positions reconciled — no discrepancies found');
    }
  } catch (err) {
    logger.error('[reconcile] reconciliation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
