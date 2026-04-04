import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { getOpenPositions, closePosition, recordPosition, type Position } from '../execution/positionLedger.js';
import { getSimmerPositions, type SimmerPosition } from '../shared/simmer.js';
import { fetchClobTokenBalance } from '../shared/clob.js';
import { fetchPolymarketPositions, type PolymarketPosition } from '../shared/polymarketData.js';
import { fetchMarketByConditionId } from '../shared/polymarketGamma.js';

interface ReconciliationDetail {
  type: 'orphan' | 'ghost' | 'mismatch' | 'healed' | 'imported';
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

    // 2. Fetch Simmer & CLOB positions from Ground-Truth APIs
    const [simmerPositions, clobPositions] = await Promise.all([
      getSimmerPositions({
        status: 'active',
        venue: 'polymarket',
        source: 'sdk:polymarket-geopolitical-agent',
      }),
      fetchPolymarketPositions(),
    ]);

    logger.info('[reconcile] fetched venue positions', { 
      simmer: simmerPositions.length,
      clob: clobPositions.length
    });

    // 3. Build lookup maps
    const simmerMap = new Map<string, SimmerPosition>();
    for (const pos of simmerPositions) {
      const direction = pos.side.toUpperCase();
      simmerMap.set(`${pos.market_id}:${direction}`, pos);
    }

    const clobMap = new Map<string, PolymarketPosition>();
    for (const pos of clobPositions) {
      // Data API uses 'asset' as the unique tokenId.
      // We store by asset to correctly handle multiple outcomes (Yes/No) for the same market.
      clobMap.set(pos.asset, pos);
    }

    // 4. Reconciliation and Healing loop
    const details: ReconciliationDetail[] = [];
    let healedCount = 0;
    let ghostsFixed = 0;
    let clobCount = 0;

    for (const ledgerPos of activePositions) {
      // Skip perp positions (LONG/SHORT) or explicit HL execution venues.
      if (ledgerPos.isFutures || ledgerPos.executionVenue === 'hyperliquid') {
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
          // Remove from map so we can find orphans later
          simmerMap.delete(key);
        }
      } else if (ledgerPos.executionVenue === 'clob') {
        venueName = 'clob';
        clobCount++;
        
        const tokenIds = ledgerPos.clobTokenIds ?? [];
        const tokenIndex = ledgerPos.direction === 'YES' ? 0 : 1;
        const tokenId = tokenIds[tokenIndex];

        // Use Data API result if available
        const clobMatch = tokenId ? clobMap.get(tokenId) : null;
        if (clobMatch) {
          foundOnVenue = true;
          venueShares = clobMatch.size ?? 0;
          // Remove from map so we can find orphans later
          clobMap.delete(tokenId!);
        } else if (tokenId) {
          // Fallback to direct on-chain balance fetch if Data API missed it
          const balanceResult = await fetchClobTokenBalance(tokenId);
          if (balanceResult.ok) {
            venueShares = balanceResult.balance;
            foundOnVenue = venueShares > 0.0001; // Allow for dust
          }
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

    // 5. Handle Orphans (positions on venue but NOT in ledger)
    let importedCount = 0;

    // A. Handle Simmer Orphans
    for (const [_key, simmerPos] of simmerMap.entries()) {
      if (opts.forceFix) {
        const imported = await importSimmerOrphan(redis, simmerPos);
        if (imported) {
          importedCount++;
          details.push({
            type: 'imported',
            marketId: simmerPos.market_id,
            direction: simmerPos.side.toUpperCase(),
            venue: 'simmer',
            reason: 'RESTORED ORPHAN FROM SIMMER',
          });
          continue;
        }
      }
      details.push({
        type: 'orphan',
        marketId: simmerPos.market_id,
        direction: simmerPos.side.toUpperCase(),
        venue: 'simmer',
        venueShares: simmerPos.shares ?? 0,
        reason: 'POSITION ON SIMMER BUT MISSING FROM LEDGER',
      });
    }

    // B. Handle CLOB Orphans
    for (const [_condId, clobPos] of clobMap.entries()) {
      if (opts.forceFix) {
        const imported = await importClobOrphan(redis, clobPos);
        if (imported) {
          importedCount++;
          details.push({
            type: 'imported',
            marketId: clobPos.conditionId, // temporary until resolved
            venue: 'clob',
            reason: 'RESTORED ORPHAN FROM CLOB',
          });
          continue;
        }
      }
      details.push({
        type: 'orphan',
        marketId: clobPos.conditionId,
        venue: 'clob',
        venueShares: clobPos.size ?? 0,
        reason: 'POSITION ON CLOB BUT MISSING FROM LEDGER',
      });
    }

    // Summary counts
    const orphans = details.filter((d) => d.type === 'orphan').length;

    logger.info('[reconcile] cycle complete', {
      totalInput: activePositions.length,
      healed: healedCount,
      ghostsFixed,
      imported: importedCount,
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

/**
 * Reconstruct a ledger entry from a Simmer position.
 */
async function importSimmerOrphan(redis: Redis, pos: SimmerPosition): Promise<boolean> {
  try {
    const direction = pos.side.toUpperCase() as 'YES' | 'NO';
    const shares = pos.shares ?? 0;
    const avgPrice = pos.average_price ?? (pos.value_usdc && shares > 0 ? pos.value_usdc / shares : 0);
    
    if (shares <= 0) return false;

    const newPos: Position = {
      marketId: pos.market_id,
      question: pos.question ?? 'Re-imported Position',
      direction,
      entryPrice: avgPrice,
      stakeUsd: shares * avgPrice,
      sharesHeld: shares,
      openedAt: new Date().toISOString(),
      executionVenue: 'simmer',
      sourcedFrom: 'reconciled:simmer',
      edgeMagnitude: 0,
      reconciliationStatus: `imported:${new Date().toISOString()}`
    };

    await recordPosition(redis, newPos);
    logger.info('[reconcile] imported Simmer orphan', { marketId: pos.market_id, direction, shares });
    return true;
  } catch (err) {
    logger.warn('[reconcile] failed to import Simmer orphan', { error: String(err) });
    return false;
  }
}

/**
 * Reconstruct a ledger entry from a CLOB position (Polymarket Data API).
 */
async function importClobOrphan(redis: Redis, pos: PolymarketPosition): Promise<boolean> {
  try {
    const shares = pos.size ?? 0;
    if (shares <= 0 || !pos.conditionId) return false;

    // Data API doesn't specify YES/NO directly in a clear way, 
    // but the token mapping should help.
    // However, Gamma API can give us the full market details.
    const market = await fetchMarketByConditionId(pos.conditionId);
    if (!market) {
      logger.warn('[reconcile] could not resolve Gamma market for CLOB orphan', { conditionId: pos.conditionId });
      return false;
    }

    // Determine direction by checking which token balance is held. 
    // Data API usually returns one row per token. 
    // If 'asset' matches clobTokenIds[0] it's YES, [1] it's NO.
    const direction: 'YES' | 'NO' = pos.asset === market.clobTokenIds[0] ? 'YES' : 'NO';

    const newPos: Position = {
      marketId: market.id,
      conditionId: market.conditionId,
      clobTokenIds: market.clobTokenIds,
      question: market.question,
      direction,
      entryPrice: pos.avgPrice,
      stakeUsd: shares * pos.avgPrice,
      sharesHeld: shares,
      openedAt: new Date().toISOString(),
      executionVenue: 'clob',
      sourcedFrom: 'reconciled:clob',
      edgeMagnitude: 0,
      reconciliationStatus: `imported:${new Date().toISOString()}`
    };

    await recordPosition(redis, newPos);
    logger.info('[reconcile] imported CLOB orphan', { marketId: market.id, direction, shares });
    return true;
  } catch (err) {
    logger.warn('[reconcile] failed to import CLOB orphan', { error: String(err) });
    return false;
  }
}
