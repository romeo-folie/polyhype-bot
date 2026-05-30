import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { getOpenPositions, closePosition, recordPosition, updatePositionShares, type Position } from '../execution/positionLedger.js';
import { getHyperliquid } from '../shared/hyperliquid.js';
import { fetchClobTokenBalance } from '../shared/clob.js';
import { fetchPolymarketPositions, type PolymarketPosition } from '../shared/polymarketData.js';
import { fetchMarketByConditionId, type GammaMarket } from '../shared/polymarketGamma.js';
import { isRecentlyClosed, isRecentlyResolved } from '../shared/closedGuard.js';
import { getPendingOrder, deletePendingOrder } from '../execution/pendingMakerOrders.js';
import { notifyTradeExecuted, notify } from '../execution/telegram.js';
import type { TradeSignal } from '../mapping/index.js';
import { weatherEndDateFromQuestion } from '../weather/resolutionTime.js';

async function closeGhostPositionWithHedge(
  redis: Redis,
  marketId: string,
  direction: Position['direction'],
): Promise<void> {
  try {
    await closePosition(redis, marketId, direction);
  } catch (err) {
    logger.warn('[reconcile] ledger close failed; skipping HL hedge close', {
      marketId, error: String(err),
    });
    return;
  }
  const hlSymbol = await redis.get(`hedge:link:${marketId}`).catch(() => null);
  if (hlSymbol) {
    try {
      const result = await getHyperliquid().closePosition(hlSymbol);
      if (result.success) {
        logger.info('[reconcile] closed linked HL hedge for ghost position', { marketId, hlSymbol });
        await redis.del(`hedge:link:${marketId}`).catch(() => {});
      } else {
        logger.warn('[reconcile] failed to close linked HL hedge for ghost position', {
          marketId, hlSymbol, error: result.error,
        });
        void notify(`⚠️ HL hedge close failed — manual action needed\nPM market: ${marketId}\nHL symbol: ${hlSymbol}\nError: ${result.error ?? 'unknown'}`).catch(() => {});
      }
    } catch (err) {
      logger.warn('[reconcile] error closing linked HL hedge for ghost position', {
        marketId, hlSymbol, error: String(err),
      });
      void notify(`⚠️ HL hedge close error — manual action needed\nPM market: ${marketId}\nHL symbol: ${hlSymbol}\nError: ${String(err)}`).catch(() => {});
    }
  }
}

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
    const clobPositions = await fetchPolymarketPositions();

    // Guard: If CLOB returns zero positions but ledger has entries,
    // this likely indicates an API outage — abort to prevent false ghost closures.
    if (activePositions.length > 0 && clobPositions.length === 0) {
      logger.warn('[reconcile] CLOB returned empty but ledger has positions — aborting to prevent false ghost closures', {
        ledgerCount: activePositions.length,
      });
      return;
    }

    logger.info('[reconcile] loaded data', {
      ledger: activePositions.length,
      clob: clobPositions.length,
    });

    const clobMap = new Map<string, PolymarketPosition>();
    for (const pos of clobPositions) {
      clobMap.set(pos.asset, pos);
    }

    // 4. Reconciliation and Healing loop
    const details: ReconciliationDetail[] = [];
    let healedCount = 0;
    let ghostsFixed = 0;
    let clobCount = 0;

    for (const ledgerPos of activePositions) {
      // Skip perp positions (LONG/SHORT) or explicit HL execution venues.
      // Note: UP/DOWN are Polymarket positions and should NOT be skipped here.
      if (ledgerPos.direction === 'LONG' || ledgerPos.direction === 'SHORT' || ledgerPos.executionVenue === 'hyperliquid') {
        continue;
      }

      let venueShares = 0;
      let foundOnVenue = false;
      const venueName = 'clob';

      // All PM positions reconcile against the CLOB
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
          await closeGhostPositionWithHedge(redis, ledgerPos.marketId, ledgerPos.direction);
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

    // 5. Handle Orphans (positions on CLOB but NOT in ledger)
    let importedCount = 0;

    // Handle CLOB Orphans
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

    const orphansRemaining = details.filter((d) => d.type === 'orphan').length;

    logger.info('[reconcile] cycle complete', {
      totalInput: activePositions.length,
      healed: healedCount,
      ghostsFixed,
      imported: importedCount,
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

    if (await isRecentlyClosed(redis, market.id) || await isRecentlyResolved(redis, market.id)) {
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

    const isWeatherMarket = /highest\s+temperature/i.test(market.question ?? '');

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
      sourcedFrom: pendingOrder?.sourcedFrom ?? (isWeatherMarket ? 'reconciled:weather' : 'reconciled:clob'),
      edgeMagnitude: pendingOrder?.edgeMagnitude ?? 0,
      // For weather markets use the city-local midnight as endDate rather than
      // Gamma's value, which is 24h late for UTC+ cities (e.g. Hong Kong).
      ...(() => {
        const rawEnd = isWeatherMarket
          ? (weatherEndDateFromQuestion(market.question ?? '', market.endDate ?? undefined) ?? market.endDate)
          : market.endDate;
        return rawEnd ? { endDate: rawEnd } : {};
      })(),
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

    // Seed the weather market-state key so the scanner can compute adverseMove and
    // winProbImprovement for size_up eligibility. winProbability is omitted so the
    // scanner treats it as null on the first post-import scan (probMove = Infinity →
    // disagreement gate passes leniently); subsequent scans overwrite with real values.
    if (isWeatherMarket && !pendingOrder) {
      const marketStateKey = `weather:market_state:${market.id}:${direction}`;
      const marketState = JSON.stringify({
        tradeSide: direction,
        outcomePrice: pos.avgPrice,
        observedAt: new Date().toISOString(),
      });
      await redis.set(marketStateKey, marketState, 'EX', 48 * 60 * 60);
      logger.info('[reconcile] seeded weather market state for manual import', {
        marketId: market.id,
        direction,
        entryPrice: pos.avgPrice,
      });
    }

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
