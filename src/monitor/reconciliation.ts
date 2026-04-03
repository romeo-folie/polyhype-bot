import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { getOpenPositions, closePosition } from '../execution/positionLedger.js';
import { getSimmerPositions } from '../shared/simmer.js';
import { fetchClobTokenBalance } from '../shared/clob.js';

interface ReconciliationDetail {
  type: 'orphan' | 'ghost' | 'mismatch' | 'healed';
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
 * Run position reconciliation — compare ledger vs venue state and HEAL discrepancies.
 */
export async function runReconciliation(redis: Redis, opts: { forceFix?: boolean } = {}): Promise<void> {
  logger.info('[reconcile] starting reconciliation pass', { forceFix: opts.forceFix });

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

    // 3. Build lookup map for Simmer
    const simmerMap = new Map<string, typeof simmerPositions[0]>();
    for (const pos of simmerPositions) {
      const direction = pos.side.toUpperCase();
      simmerMap.set(`${pos.market_id}:${direction}`, pos);
    }

    // 4. Reconciliation and Healing loop
    const details: ReconciliationDetail[] = [];
    let healedCount = 0;
    let ghostsFixed = 0;
    let clobCount = 0;

    for (const ledgerPos of activePositions) {
      // Skip perp positions (LONG/SHORT) or explicit HL execution venues.
      if (ledgerPos.executionVenue === 'hyperliquid' || ledgerPos.direction === 'LONG' || ledgerPos.direction === 'SHORT') {
        continue;
      }

      const key = `${ledgerPos.marketId}:${ledgerPos.direction}`;
      let venueShares = 0;
      let foundOnVenue = false;
      let venueName = '';

      if (ledgerPos.executionVenue === 'simmer') {
        venueName = 'simmer';
        const simmerPos = simmerMap.get(key);
        if (simmerPos) {
          foundOnVenue = true;
          venueShares = simmerPos.shares ?? 0;
        }
        simmerMap.delete(key); // Mark as processed for orphan check
      } else {
        venueName = 'clob';
        clobCount++;
        const tokenIds = ledgerPos.clobTokenIds ?? [];
        const tokenIndex = ledgerPos.direction === 'YES' ? 0 : 1;
        const tokenId = tokenIds[tokenIndex];

        if (!tokenId) {
          logger.warn('[reconcile] CLOB tokenId missing or invalid — unable to verify position, skipping heal', {
            marketId: ledgerPos.marketId,
            direction: ledgerPos.direction,
          });
          continue;
        }

        const balanceResult = await fetchClobTokenBalance(tokenId);
        if (balanceResult.ok) {
          venueShares = balanceResult.balance;
          foundOnVenue = venueShares > 0.0001; // Allow for dust
        } else {
          logger.warn('[reconcile] CLOB balance fetch failed — skipping heal', { marketId: ledgerPos.marketId, tokenId });
          continue;
        }
      }

      const ledgerShares = ledgerPos.sharesHeld ?? 0;

      // -- CHECK FOR GHOSTS --
      if (!foundOnVenue) {
        logger.error('[reconcile] ghost detected — closing stale ledger entry', {
          marketId: ledgerPos.marketId,
          direction: ledgerPos.direction,
          venue: venueName,
          ledgerShares,
        });
        
        if (opts.forceFix) {
          await closePosition(redis, ledgerPos.marketId, ledgerPos.direction);
          ghostsFixed++;
        }
        details.push({
          type: 'ghost',
          marketId: ledgerPos.marketId,
          direction: ledgerPos.direction,
          venue: venueName,
          ledgerShares,
          reason: 'closed stale ledger entry (ghost)',
        });
        continue;
      }

      // -- CHECK FOR SHARE/PRICE MISMATCHES --
      const absDiff = Math.abs(ledgerShares - venueShares);
      const relDiff = ledgerShares > 0 ? absDiff / ledgerShares : 0;

      // Threshold: 1% mismatch or significant absolute difference
      if (absDiff > 0.01 && relDiff > 0.01) {
        const actualEntryPrice = ledgerPos.stakeUsd > 0 && venueShares > 0 
          ? ledgerPos.stakeUsd / venueShares 
          : ledgerPos.entryPrice;

        logger.info('[reconcile] mismatch detected — healing cost basis and shares', {
          marketId: ledgerPos.marketId,
          direction: ledgerPos.direction,
          venue: venueName,
          ledgerShares: ledgerShares.toFixed(4),
          venueShares: venueShares.toFixed(4),
          oldPrice: ledgerPos.entryPrice.toFixed(4),
          newPrice: actualEntryPrice.toFixed(4),
        });

        // Write healer: update both shares and entry price in Redis
        if (opts.forceFix) {
          await redis.hset(`position:${ledgerPos.marketId}:${ledgerPos.direction}`, 
            'sharesHeld', String(venueShares),
            'entryPrice', String(actualEntryPrice.toFixed(6)),
            'reconciliationStatus', `healed_mismatch:${new Date().toISOString()}`
          );
          healedCount++;
        }

        details.push({
          type: 'healed',
          marketId: ledgerPos.marketId,
          direction: ledgerPos.direction,
          venue: venueName,
          ledgerShares,
          venueShares,
          reason: `healed mismatch: derived price ${actualEntryPrice.toFixed(4)} from ${venueShares.toFixed(2)} shares`,
        });
      }
    }

    // 5. Handle Orphans (positions on Simmer but not in ledger)
    for (const [key, simmerPos] of simmerMap.entries()) {
      details.push({
        type: 'orphan',
        marketId: simmerPos.market_id,
        direction: simmerPos.side.toUpperCase(),
        venue: 'simmer',
        venueShares: simmerPos.shares ?? 0,
        reason: 'POSITION ON VENUE BUT MISSING FROM LEDGER (RE-IMPORT MANUALLY IF NEEDED)',
      });
    }

    // Summary counts
    const orphans = details.filter((d) => d.type === 'orphan').length;

    logger.info('[reconcile] cycle complete', {
      totalInput: activePositions.length,
      healedCount: healedCount,
      ghostsFixed: ghostsFixed,
      orphansRemaining: orphans,
      clobChecked: clobCount,
    });

    if (details.length === 0) {
      logger.info('[reconcile] all positions reconciled — ledger is healthy');
    }
  } catch (err) {
    logger.error('[reconcile] reconciliation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
