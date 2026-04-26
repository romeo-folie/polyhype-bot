import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { getOpenPositions, closePosition, recordPosition, updatePositionShares, type Position } from '../execution/positionLedger.js';
import { getSimmerPositions, type SimmerPosition } from '../shared/simmer.js';
import { fetchClobTokenBalance } from '../shared/clob.js';
import { fetchPolymarketPositions, type PolymarketPosition } from '../shared/polymarketData.js';
import { fetchMarketByConditionId, fetchMarketByQuestion, type GammaMarket } from '../shared/polymarketGamma.js';

import { recordRedemptionOutcome } from '../shared/positionOutcomeRecorder.js';
import { creditProceeds } from '../shared/bankroll.js';
import { isRecentlyClosed } from '../shared/closedGuard.js';
import { getPendingOrder, deletePendingOrder } from '../execution/pendingMakerOrders.js';
import { notifyTradeExecuted } from '../execution/telegram.js';
import type { TradeSignal } from '../mapping/index.js';

interface ReconciliationDetail {
  type: 'orphan' | 'ghost' | 'mismatch' | 'healed' | 'imported' | 'upgraded' | 'recovered_outcome';
  marketId: string;
  direction?: string;
  ledgerShares?: number;
  venueShares?: number;
  venue?: string;
  reason?: string;
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

    // Guard: If both venues return zero positions but ledger has entries,
    // this likely indicates an API outage — abort to prevent false ghost closures.
    if (activePositions.length > 0 && simmerPositions.length === 0 && clobPositions.length === 0) {
      logger.warn('[reconcile] both venues returned empty but ledger has positions — aborting to prevent false ghost closures', {
        ledgerCount: activePositions.length,
      });
      return;
    }

    // 2. Build Correlation Matrix (Bridge Simmer questions to Gamma numeric IDs)
    // We use the Data API list as the source-of-truth for conditionIds/IDs.
    const questionToMetadata = new Map<string, GammaMarket>();
    const conditionToMetadata = new Map<string, GammaMarket>();
    const normalize = (q: string) => q?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';

    const MATRIX_CONCURRENCY = 5;
    const conditionEntries = clobPositions.filter(cp => cp.conditionId);
    for (let i = 0; i < conditionEntries.length; i += MATRIX_CONCURRENCY) {
      const chunk = conditionEntries.slice(i, i + MATRIX_CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map(cp => fetchMarketByConditionId(cp.conditionId)),
      );
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          questionToMetadata.set(normalize(result.value.question), result.value);
          conditionToMetadata.set(result.value.conditionId, result.value);
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
    const rawSimmerMap = new Map<string, SimmerPosition>();
    for (const pos of simmerPositions) {
      const direction = pos.side.toUpperCase();
      rawSimmerMap.set(`${pos.market_id}:${direction}`, pos);
    }

    // 3b. Re-index simmerMap: Simmer UUID keys → Polymarket numeric ID keys
    // Simmer's market_id is a Simmer-internal UUID, but the ledger stores Polymarket
    // numeric IDs. Without this bridge, every Simmer position appears as a ghost.
    const reindexedSimmerMap = new Map<string, SimmerPosition>();
    const simmerMetadataMap = new Map<string, GammaMarket>();
    let bridgeApiCalls = 0;
    const BRIDGE_API_BUDGET = 50;

    for (const [originalKey, pos] of rawSimmerMap.entries()) {
      const direction = pos.side.toUpperCase();
      let metadata: GammaMarket | undefined;

      // Step 1: condition_id → conditionToMetadata (free)
      if (pos.condition_id) {
        metadata = conditionToMetadata.get(pos.condition_id);
      }

      // Step 2: normalized question → questionToMetadata (free)
      if (!metadata && pos.question) {
        metadata = questionToMetadata.get(normalize(pos.question));
      }

      // Step 3: API fallback — fetchMarketByConditionId(condition_id)
      if (!metadata && pos.condition_id && bridgeApiCalls < BRIDGE_API_BUDGET) {
        metadata = (await fetchMarketByConditionId(pos.condition_id)) || undefined;
        bridgeApiCalls++;
        if (metadata) {
          conditionToMetadata.set(metadata.conditionId, metadata);
          questionToMetadata.set(normalize(metadata.question), metadata);
        }
      }

      // Step 4: API fallback — market_id might be a Polymarket condition ID
      if (!metadata && pos.market_id && bridgeApiCalls < BRIDGE_API_BUDGET) {
        metadata = (await fetchMarketByConditionId(pos.market_id)) || undefined;
        bridgeApiCalls++;
        if (metadata) {
          conditionToMetadata.set(metadata.conditionId, metadata);
          questionToMetadata.set(normalize(metadata.question), metadata);
        }
      }

      // Step 5: API fallback — question search (last resort)
      if (!metadata && pos.question && bridgeApiCalls < BRIDGE_API_BUDGET) {
        metadata = (await fetchMarketByQuestion(pos.question)) || undefined;
        bridgeApiCalls++;
        if (metadata) {
          conditionToMetadata.set(metadata.conditionId, metadata);
          questionToMetadata.set(normalize(metadata.question), metadata);
        }
      }

      if (metadata) {
        const newKey = `${metadata.id}:${direction}`;
        reindexedSimmerMap.set(newKey, pos);
        simmerMetadataMap.set(newKey, metadata);
      } else {
        // Unresolved — keep original key; will flow to orphan handling
        logger.warn('[reconcile] could not resolve Simmer UUID to numeric ID — will treat as orphan', {
          marketId: pos.market_id,
          question: pos.question?.slice(0, 80),
        });
        reindexedSimmerMap.set(originalKey, pos);
      }
    }

    const simmerMap = reindexedSimmerMap;

    logger.info('[reconcile] re-indexed simmerMap', {
      total: rawSimmerMap.size,
      resolved: simmerMetadataMap.size,
      unresolved: rawSimmerMap.size - simmerMetadataMap.size,
      bridgeApiCalls,
    });

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
            // After re-indexing, simmerMap keys are numeric IDs, but try both UUID and numeric
            simmerMap.delete(`${ledgerPos.marketId}:${ledgerPos.direction}`);
            simmerMap.delete(`${metadata.id}:${ledgerPos.direction}`);
            if (metadata.clobTokenIds) {
              const tokenId = (ledgerPos.direction === 'YES' || ledgerPos.direction === 'UP') ? metadata.clobTokenIds[0] : metadata.clobTokenIds[1];
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
      // Note: UP/DOWN are Polymarket positions and should NOT be skipped here.
      if (ledgerPos.direction === 'LONG' || ledgerPos.direction === 'SHORT' || ledgerPos.executionVenue === 'hyperliquid') {
        continue;
      }

      const key = `${ledgerPos.marketId}:${ledgerPos.direction}`;
      let venueShares = 0;
      let foundOnVenue = false;
      let venueName = '';

      if (ledgerPos.executionVenue === 'simmer') {
        venueName = 'simmer';
        let simmerPos = simmerMap.get(key);
        let matchedKey = key;

        // Fallback: if primary key missed, scan by conditionId
        if (!simmerPos && ledgerPos.conditionId) {
          for (const [sKey, sPos] of simmerMap.entries()) {
            if (sPos.condition_id === ledgerPos.conditionId && sPos.side.toUpperCase() === ledgerPos.direction) {
              simmerPos = sPos;
              matchedKey = sKey;
              break;
            }
          }
        }

        if (simmerPos) {
          foundOnVenue = true;
          venueShares = simmerPos.shares ?? 0;
          simmerMap.delete(matchedKey);
        }
      } else if (ledgerPos.executionVenue === 'clob') {
        venueName = 'clob';
        clobCount++;
        
        const tokenIds = ledgerPos.clobTokenIds ?? [];
        const tokenIndex = (ledgerPos.direction === 'YES' || ledgerPos.direction === 'UP') ? 0 : 1;
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
          logger.info('[reconcile] mismatch detected — healing shares (preserving entryPrice)', {
          marketId: ledgerPos.marketId,
          direction: ledgerPos.direction,
          venue: venueName,
          ledgerShares: ledgerShares.toFixed(4),
          venueShares: venueShares.toFixed(4),
          entryPrice: ledgerPos.entryPrice.toFixed(4),
        });

        if (forceFix) {
          const healedStakeUsd = venueShares * ledgerPos.entryPrice;
          const validStakeUsd = Number.isFinite(healedStakeUsd) && healedStakeUsd >= 0
            ? healedStakeUsd
            : undefined;
          if (!validStakeUsd) {
            logger.warn('[reconcile] skipping healed stakeUsd — invalid entryPrice', {
              marketId: ledgerPos.marketId,
              direction: ledgerPos.direction,
              entryPrice: ledgerPos.entryPrice,
              healedStakeUsd,
            });
          }
          await updatePositionShares(
            redis,
            ledgerPos.marketId,
            ledgerPos.direction,
            venueShares,
            `healed_mismatch:${new Date().toISOString()}`,
            validStakeUsd,
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
          reason: `healed share mismatch: ${ledgerShares.toFixed(2)} → ${venueShares.toFixed(2)} (entryPrice preserved)`,
        });
      }
    }

    // 5. Handle Orphans (positions on venue but NOT in ledger)
    let importedCount = 0;

    // A. Handle Simmer Orphans
    // Metadata was pre-resolved during the re-indexing pass (simmerMetadataMap).
    // Unresolved positions already exhausted all resolution strategies — no point retrying.
    for (const [key, simmerPos] of simmerMap.entries()) {
      if (forceFix) {
        const metadata = simmerMetadataMap.get(key);
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
              await recordRedemptionOutcome(redis, null, closedPos as unknown as Record<string, unknown>, {
                marketId: closedPos.market_id,
                direction,
                question: closedPos.question || closedPos.market_id,
                result: 'won',
                returnPct: stakeUsd > 0 ? ((closedPos.value_usdc - stakeUsd) / stakeUsd) * 100 : 0,
                executionVenue: 'simmer',
                exitReason: 'recovered_auto_redeemed',
                sourcedFromOverride: 'reconciled:simmer',
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
    // Guard: skip positions that were recently redeemed/ghost-closed.
    // Check both the Simmer UUID and the resolved numeric ID — ghost-close marks the
    // numeric ID, but the orphan importer sees the UUID, so one check alone misses it.
    if (await isRecentlyClosed(redis, pos.market_id)) {
      logger.info('[reconcile] skipping recently-closed Simmer orphan', {
        marketId: pos.market_id,
      });
      return false;
    }

    if (!metadata) {
      logger.warn('[reconcile] skipping Simmer orphan — no Polymarket metadata (UUID fallback blocked)', {
        marketId: pos.market_id,
        question: pos.question,
      });
      return false;
    }

    // Secondary guard: ghost-close marks the numeric ID; check it too so a ghost→orphan
    // reimport loop can't occur when the UUID and numeric ID differ.
    if (await isRecentlyClosed(redis, metadata.id)) {
      logger.info('[reconcile] skipping recently-closed Simmer orphan (numeric ID match)', {
        simmerUuid: pos.market_id,
        numericId: metadata.id,
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

    if (clobMatch && tokenId) {
      // Remove from clobMap so the CLOB orphan loop doesn't re-import this position.
      clobMap.delete(tokenId);
    }

    if (clobMatch && clobMatch.avgPrice > 0) {
      avgPrice = clobMatch.avgPrice;
      logger.info('[reconcile] used authoritative CLOB price for Simmer orphan', {
        marketId: metadata.id,
        price: avgPrice,
      });
    } else if (pos.average_price && pos.average_price > 0) {
      avgPrice = pos.average_price;
      logger.info('[reconcile] used Simmer average_price for orphan', {
        marketId: metadata.id,
        price: avgPrice,
      });
    } else {
      // No reliable entry price available. value_usdc / shares is the CURRENT market
      // price, not the historical entry price — using it would produce wildly incorrect
      // P&L figures. Import with entryPrice = 0 and let the dashboard flag it.
      avgPrice = 0;
      logger.warn('[reconcile] no reliable entry price for Simmer orphan — importing with entryPrice=0', {
        marketId: metadata.id,
        question: pos.question?.slice(0, 80),
        value_usdc: pos.value_usdc,
        average_price: pos.average_price,
      });
    }

    // Dust guard removed: the isRecentlyClosed checks above already block
    // reimport of residuals from recently-closed positions. Applying a notional
    // floor to first-time orphans silently dropped legitimate small positions
    // (most sub-$1 positions are genuine holds, not dust). If residual-fraction
    // reimport becomes an issue after a recently-closed TTL expires, extend
    // closedGuard's TTL rather than re-adding a universal notional floor.

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

    if (await isRecentlyClosed(redis, market.id)) {
      logger.debug('[reconcile] skipping recently-closed CLOB orphan', {
        marketId: market.id,
        conditionId: pos.conditionId,
      });
      return false;
    }

    const direction: 'YES' | 'NO' = pos.asset === market.clobTokenIds[0] ? 'YES' : 'NO';

    // Check whether this fill came from a bot-posted GTC maker order.
    // Validate tokenId and direction before enriching to avoid false attribution
    // from a stale key or a concurrent fill in a different direction on the same
    // market. Key is deleted AFTER recordPosition() succeeds so a transient write
    // failure can't permanently lose the benchmark metadata.
    const rawPending = await getPendingOrder(redis, market.id);
    // Oracle-lag signals store direction as 'UP'/'DOWN' on the pending order,
    // but reconciler derives 'YES'/'NO' from token index. Normalize the
    // pending direction for the equivalence check (UP↔YES, DOWN↔NO) so
    // oracle-lag fills link correctly and get enriched metadata + notification.
    const pendingDirNormalized =
      rawPending?.direction === 'UP'
        ? 'YES'
        : rawPending?.direction === 'DOWN'
          ? 'NO'
          : rawPending?.direction;
    const pendingOrder =
      rawPending?.tokenId === pos.asset && pendingDirNormalized === direction
        ? rawPending
        : null;
    if (rawPending && !pendingOrder) {
      logger.warn('[reconcile] pending maker order token/direction mismatch — not enriching', {
        marketId: market.id,
        pendingTokenId: rawPending.tokenId,
        pendingDirection: rawPending.direction,
        fillTokenId: pos.asset,
        fillDirection: direction,
      });
    }
    if (pendingOrder) {
      logger.info('[reconcile] linked CLOB orphan to pending maker order', {
        marketId: market.id,
        orderId: pendingOrder.orderId,
        sourcedFrom: pendingOrder.sourcedFrom,
      });
    }

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
      sourcedFrom: pendingOrder?.sourcedFrom ?? 'reconciled:clob',
      edgeMagnitude: pendingOrder?.edgeMagnitude ?? 0,
      ...(market.endDate && { endDate: market.endDate }),
      ...(pendingOrder?.consensusP != null && { consensusProbability: pendingOrder.consensusP }),
      ...(pendingOrder != null && {
        entryExecutionPath: 'maker_fill',
        entryOrderType: 'maker' as const,
        // bestAskAtPosting is the live taker price at the moment the GTC order was
        // placed — the correct counterfactual for "what would an immediate taker fill
        // have cost?" (consistent with buildDecisionBenchmark() in executor.ts).
        counterfactualImmediateTakerPrice: pendingOrder.bestAskAtPosting,
      }),
      reconciliationStatus: `imported:${new Date().toISOString()}`
    };

    await recordPosition(redis, newPos);
    // Delete the pending order key only after the position is durably recorded.
    if (pendingOrder) {
      await deletePendingOrder(redis, market.id);
      // Bot-originated maker fill (async path). Emit the one-and-only Telegram
      // notification for this trade — we intentionally don't notify at post time
      // so the user only sees confirmed entries.
      const signalLike: TradeSignal = {
        marketId: market.id,
        conditionId: market.conditionId,
        clobTokenIds: market.clobTokenIds,
        question: market.question,
        direction,
        stakeUsd: newPos.stakeUsd,
        edgeMagnitude: pendingOrder.edgeMagnitude ?? 0,
        ...(pendingOrder.consensusP != null && { consensusProbability: pendingOrder.consensusP }),
        outcomePrice: pos.avgPrice,
        sourcedFrom: pendingOrder.sourcedFrom ?? 'reconciled:clob',
        reasoning: pendingOrder.reasoning ?? 'Async maker fill reconciled from CLOB position snapshot.',
      };
      void notifyTradeExecuted(signalLike, undefined, {
        venue: 'clob',
        sharesFilled: shares,
      }).catch(() => {});
    }
    logger.info('[reconcile] imported CLOB orphan', { marketId: market.id, direction, shares, linkedMakerOrder: pendingOrder != null });
    return true;
  } catch (err) {
    logger.warn('[reconcile] failed to import CLOB orphan', { error: String(err) });
    return false;
  }
}
