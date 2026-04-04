import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { getOpenPositions, closePosition, recordPosition, type Position } from '../execution/positionLedger.js';
import { getSimmerPositions, type SimmerPosition } from '../shared/simmer.js';
import { fetchClobTokenBalance } from '../shared/clob.js';
import { fetchPolymarketPositions, type PolymarketPosition } from '../shared/polymarketData.js';
import { fetchMarketByConditionId, fetchMarketByQuestion, type GammaMarket } from '../shared/polymarketGamma.js';

import { recordOutcome, inferCategory } from '../shared/outcomeRecorder.js';
import { creditProceeds } from '../shared/bankroll.js';

interface ReconciliationDetail {
  type: 'orphan' | 'ghost' | 'mismatch' | 'healed' | 'imported' | 'upgraded' | 'recovered_outcome';
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
 * Main reconciliation entrypoint.
 * Scans venues vs ledger and heals mismatches.
 */
export async function runReconciliation(
  redis: Redis,
  opts: { forceFix?: boolean } = {},
): Promise<void> {
  const forceFix = opts.forceFix === true;
  logger.info('[reconcile] starting reconciliation pass', { forceFix });

  try {
    // 1. Fetch all data sources
    const activePositions = await getOpenPositions(redis);
    const simmerPositions = await getSimmerPositions({ status: 'active' });
    const clobPositions = await fetchPolymarketPositions();

    // 2. Build Correlation Matrix (Bridge Simmer questions to Gamma numeric IDs)
    // We use the Data API list as the source-of-truth for conditionIds/IDs.
    const questionToMetadata = new Map<string, GammaMarket>();
    const normalize = (q: string) => q?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';

    for (const cp of clobPositions) {
      if (cp.conditionId) {
        const market = await fetchMarketByConditionId(cp.conditionId);
        if (market) {
          questionToMetadata.set(normalize(market.question), market);
        }
      }
    }

    logger.info('[reconcile] loaded data', {
      ledger: activePositions.length,
      simmer: simmerPositions.length,
      clob: clobPositions.length,
      matrixReady: questionToMetadata.size,
    });

    // 3. Build lookup maps
    const simmerMap = new Map<string, SimmerPosition>();
    for (const pos of simmerPositions) {
      const direction = pos.side.toUpperCase();
      simmerMap.set(`${pos.market_id}:${direction}`, pos);
    }

    const clobMap = new Map<string, PolymarketPosition>();
    for (const pos of clobPositions) {
      clobMap.set(pos.asset, pos);
    }

    // 4. Reconciliation and Healing loop
    const details: ReconciliationDetail[] = [];
    let healedCount = 0;
    let ghostsFixed = 0;
    let upgradesCount = 0;
    let clobCount = 0;

    for (const ledgerPos of activePositions) {
      // 4a. Self-Healing ID Upgrade: Detect UUID marketIds from legacy Simmer imports
      const isUuid = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(ledgerPos.marketId);
      if (isUuid && ledgerPos.executionVenue === 'simmer') {
        const normQ = normalize(ledgerPos.question);
        let metadata = questionToMetadata.get(normQ);
        
        // Fallback: If Data API matrix failed (lag), search Gamma directly by question
        if (!metadata) {
          logger.info('[reconcile] Data API lag detected, attempting fuzzy question match', { question: ledgerPos.question });
          metadata = await fetchMarketByQuestion(ledgerPos.question) || undefined;
        }

        if (metadata) {
          logger.info('[reconcile] upgrading legacy UUID marketId to numeric ID', {
            uuid: ledgerPos.marketId,
            numericId: metadata.id,
            method: questionToMetadata.has(normQ) ? 'matrix' : 'fuzzy-search'
          });
          if (forceFix) {
            await closePosition(redis, ledgerPos.marketId, ledgerPos.direction);
            const upgradedPos: Position = {
              ...ledgerPos,
              marketId: metadata.id,
              conditionId: metadata.conditionId,
              clobTokenIds: metadata.clobTokenIds,
              reconciliationStatus: `upgraded:${new Date().toISOString()}`
            };
            await recordPosition(redis, upgradedPos);

            // Important: Remove from venue maps so the orphan loop doesn't re-import it
            const sideKey = `${ledgerPos.marketId}:${ledgerPos.direction}`;
            simmerMap.delete(sideKey);
            if (metadata.clobTokenIds) {
              const tokenId = ledgerPos.direction === 'YES' ? metadata.clobTokenIds[0] : metadata.clobTokenIds[1];
              if (tokenId) clobMap.delete(tokenId);
            }

            upgradesCount++;
            details.push({
              marketId: ledgerPos.marketId,
              direction: ledgerPos.direction,
              venue: 'simmer',
              type: 'upgraded',
              reason: `upgraded UUID ${ledgerPos.marketId} to numeric ${metadata.id}`
            });
            continue; 
          }
        }
      }

      // Skip perp positions (LONG/SHORT) or explicit HL execution venues.
      if (ledgerPos.direction === 'LONG' || ledgerPos.direction === 'SHORT' || ledgerPos.executionVenue === 'hyperliquid') {
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
          simmerMap.delete(key);
        }
      } else if (ledgerPos.executionVenue === 'clob') {
        venueName = 'clob';
        clobCount++;
        
        const tokenIds = ledgerPos.clobTokenIds ?? [];
        const tokenIndex = ledgerPos.direction === 'YES' ? 0 : 1;
        const tokenId = tokenIds[tokenIndex];

        const clobMatch = tokenId ? clobMap.get(tokenId) : null;
        if (clobMatch) {
          foundOnVenue = true;
          venueShares = clobMatch.size ?? 0;
          clobMap.delete(tokenId!);
        } else if (tokenId) {
          const balanceResult = await fetchClobTokenBalance(tokenId);
          if (balanceResult.ok) {
            venueShares = balanceResult.balance;
            foundOnVenue = venueShares > 0.0001;
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
        
        if (forceFix) {
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

        if (forceFix) {
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
      const normQ = normalize(simmerPos.question || '');
      let metadata = questionToMetadata.get(normQ);

      // Check if Simmer's market_id is actually a Polymarket condition ID
      if (!metadata && simmerPos.market_id) {
        metadata = (await fetchMarketByConditionId(simmerPos.market_id)) || undefined;
      }

      // Fallback fuzzy match for orphans
      if (!metadata && simmerPos.question) {
        metadata = (await fetchMarketByQuestion(simmerPos.question)) || undefined;
      }

      if (forceFix) {
        const imported = await importSimmerOrphan(redis, simmerPos, clobMap, metadata);
        if (imported) {
          importedCount++;
          details.push({
            type: 'imported',
            marketId: metadata?.id || simmerPos.market_id,
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
    for (const [_tokenId, clobPos] of clobMap.entries()) {
      if (forceFix) {
        const imported = await importClobOrphan(redis, clobPos);
        if (imported) {
          importedCount++;
          details.push({
            type: 'imported',
            marketId: clobPos.conditionId,
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

    // 6. Recover missing historical Simmer wins (Force Fix Only)
    let recoveredCount = 0;
    if (forceFix) {
      try {
        const closedSimmer = await getSimmerPositions({ status: 'closed' });
        // Fetch all recent outcomes to avoid double-crediting
        const existingOutcomes = await redis.zrange('outcomes:all', 0, -1);
        const existingQuestions = new Set<string>();
        for (const id of existingOutcomes) {
          const q = await redis.hget(`outcome:${id}`, 'question');
          if (q) existingQuestions.add(normalize(q));
        }

        for (const closedPos of closedSimmer) {
          // We only backfill if it was a winner AND wasn't recorded
          if (closedPos.value_usdc && closedPos.value_usdc > 0 && closedPos.shares && closedPos.shares > 0) {
            const normQ = normalize(closedPos.question || closedPos.market_id);
            if (!existingQuestions.has(normQ)) {
              logger.info('[reconcile] recovering dropped Simmer win', {
                marketId: closedPos.market_id,
                valueUsdc: closedPos.value_usdc,
              });

              // Credit Proceeds
              await creditProceeds(redis, closedPos.value_usdc);

              // Record Outcome
              const direction = closedPos.side.toUpperCase() as 'YES' | 'NO';
              const stakeUsd = closedPos.shares * (closedPos.average_price ?? 0);
              await recordOutcome(redis, {
                source: 'osint',
                category: inferCategory(closedPos.question || closedPos.market_id),
                question: (closedPos.question || closedPos.market_id).slice(0, 200),
                direction: direction,
                consensusProbability: 0.5,
                divergence: 0,
                result: 'won',
                returnPct: stakeUsd > 0 ? ((closedPos.value_usdc - stakeUsd) / stakeUsd) * 100 : 0,
                holdingHours: 0,
                executionVenue: 'simmer',
              });

              existingQuestions.add(normQ);
              recoveredCount++;
              details.push({
                type: 'recovered_outcome',
                marketId: closedPos.market_id,
                direction,
                venue: 'simmer',
                venueShares: closedPos.shares,
                reason: 'recovered historical auto-redeemed win missing from ledger',
              });
            }
          }
        }
      } catch (e) {
        logger.warn('[reconcile] failed to run recovery phase', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const orphansRemaining = details.filter((d) => d.type === 'orphan').length;

    logger.info('[reconcile] cycle complete', {
      totalInput: activePositions.length,
      healed: healedCount,
      ghostsFixed,
      upgradedCount: upgradesCount,
      imported: importedCount,
      recovered: recoveredCount,
      orphansRemaining,
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
async function importSimmerOrphan(
  redis: Redis,
  pos: SimmerPosition,
  clobMap: Map<string, PolymarketPosition>,
  metadata?: GammaMarket,
): Promise<boolean> {
  try {
    if (!metadata) {
      logger.warn('[reconcile] skipping Simmer orphan — no Polymarket metadata (UUID fallback blocked)', {
        marketId: pos.market_id,
        question: pos.question,
      });
      return false;
    }

    const direction = pos.side.toUpperCase() as 'YES' | 'NO';
    const shares = pos.shares ?? 0;
    if (shares <= 0) return false;

    // Authoritative Price Derivation:
    // 1. Try to find the exact fill price from Polymarket Data API (clobMap)
    // 2. Fall back to Simmer's recorded average_price
    // 3. Last resort: inferred current price (results in 0% PnL)
    let avgPrice = 0;
    const clobTokenIds = Array.isArray(metadata.clobTokenIds)
      ? metadata.clobTokenIds
      : JSON.parse(metadata.clobTokenIds as string) as string[];

    const tokenId = direction === 'YES' ? clobTokenIds[0] : clobTokenIds[1];
    const clobMatch = tokenId ? clobMap.get(tokenId) : null;

    if (clobMatch && clobMatch.avgPrice > 0) {
      avgPrice = clobMatch.avgPrice;
      logger.info('[reconcile] used authoritative CLOB price for Simmer orphan', {
        marketId: metadata.id,
        price: avgPrice,
      });
    } else {
      avgPrice = pos.average_price ?? (pos.value_usdc && shares > 0 ? pos.value_usdc / shares : 0);
    }

    const newPos: Position = {
      marketId: metadata.id,
      conditionId: metadata.conditionId,
      clobTokenIds: metadata.clobTokenIds,
      question: pos.question || metadata.question || 'Re-imported Position',
      direction,
      entryPrice: avgPrice,
      stakeUsd: shares * avgPrice,
      sharesHeld: shares,
      openedAt: new Date().toISOString(),
      executionVenue: 'simmer',
      sourcedFrom: 'reconciled:simmer',
      edgeMagnitude: 0,
      reconciliationStatus: `imported:${new Date().toISOString()}`,
    };

    await recordPosition(redis, newPos);
    logger.info('[reconcile] imported Simmer orphan', {
      marketId: newPos.marketId,
      direction,
      shares,
    });
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

    const market = await fetchMarketByConditionId(pos.conditionId);
    if (!market) {
      logger.warn('[reconcile] could not resolve Gamma market for CLOB orphan', { conditionId: pos.conditionId });
      return false;
    }

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
