import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { getOpenPositions, closePosition, recordPosition, updatePositionShares, sizeUpPosition, type Position } from '../execution/positionLedger.js';
import { getHyperliquid } from '../shared/hyperliquid.js';
import { fetchClobTokenBalance, cancelClobOrder, resolveOrderFillPrice } from '../shared/clob.js';
import { loadConfig } from '../shared/config.js';
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
  const cfg = loadConfig();
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
        // Async size-up fill: the on-chain share count grew on a position already
        // in the ledger and a bot-posted maker order is linked. Route it through
        // proper top-up accounting + the size-up notification before falling back
        // to the generic share heal. The inline executor path can't notify here
        // because the maker order filled after it returned `maker_pending`.
        if (
          forceFix &&
          venueShares > ledgerShares &&
          (await tryReconcileSizeUpFill(redis, cfg, ledgerPos, tokenId, venueShares, ledgerShares))
        ) {
          healedCount++;
          details.push({
            type: 'healed',
            marketId: ledgerPos.marketId,
            direction: ledgerPos.direction,
            venue: venueName,
            ledgerShares,
            venueShares,
            reason: `async size-up fill reconciled: ${ledgerShares.toFixed(2)} → ${venueShares.toFixed(2)}`,
          });
          continue;
        }
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
    // direction is derived from the fill token index ('YES'/'NO'). pendingKey
    // normalises UP/DOWN→YES/NO so the lookup always hits the correct slot.
    const rawPending = await getPendingOrder(redis, market.id, direction);
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

    // Cost basis: the Data API's avgPrice (actual blended on-chain average).
    // When the API returns no usable avgPrice (0/NaN), substitute the best
    // available basis instead of writing a zero-basis row — zero entryPrice/
    // stakeUsd corrupts P&L, makes the size-up drift gate unmeasurable, and
    // leaves topUpStakeCap at the full path cap (observed: Ankara 2416074).
    // Preference: linked maker order's posted price (our actual limit, an
    // upper bound on cost) → Data API currentValue/shares (current market
    // price — a proxy, but a measurable basis).
    let basisPrice = pos.avgPrice;
    if (!(basisPrice > 0) || basisPrice >= 1) {
      const currentPrice = pos.currentValue > 0 && shares > 0 ? pos.currentValue / shares : 0;
      const substitute = pendingOrder?.price ?? currentPrice;
      basisPrice = substitute > 0 && substitute < 1 ? substitute : 0;
      logger.warn('[reconcile] CLOB orphan has no usable avgPrice — substituting cost basis', {
        marketId: market.id,
        direction,
        avgPrice: pos.avgPrice,
        substitutedBasis: basisPrice,
        substituteSource: pendingOrder?.price != null ? 'pending_order_price' : 'current_price',
      });
    }

    const newPos: Position = {
      marketId: market.id,
      conditionId: market.conditionId,
      clobTokenIds: market.clobTokenIds,
      question: market.question,
      direction,
      entryPrice: basisPrice,
      stakeUsd: shares * basisPrice,
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
        // Thread the executionId minted at post-time so the position links back to
        // the original execution_events row and the outcome pipeline can write returns.
        ...(pendingOrder.executionId && { executionId: pendingOrder.executionId }),
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
        outcomePrice: basisPrice,
        observedAt: new Date().toISOString(),
      });
      await redis.set(marketStateKey, marketState, 'EX', 48 * 60 * 60);
      logger.info('[reconcile] seeded weather market state for manual import', {
        marketId: market.id,
        direction,
        entryPrice: basisPrice,
      });
    }

    // Delete the pending order key only after the position is durably recorded.
    if (pendingOrder) {
      await deletePendingOrder(redis, market.id, direction);
      // Write the fill-confirmed execution_events row. The pending row written
      // at post-time has executionSucceeded: false (order resting, not yet filled).
      // This row is the authoritative "fill confirmed" record that the outcome
      // pipeline uses to link positions → returns. Only written when executionId
      // is available; positions imported without a pending order retain no link.
      if (pendingOrder.executionId) {
        void enqueueWrite('execution_events', {
          attemptId: randomUUID(),
          executionId: pendingOrder.executionId,
          // source is set on pending orders written after this fix. For legacy
          // keys written before it, derive from the sourcedFrom prefix (format
          // is always "<source>:<rest>" matching the SIGNAL_SOURCE enum).
          source: pendingOrder.source ?? pendingOrder.sourcedFrom?.split(':')[0] ?? 'weather',
          marketId: market.id,
          direction,
          finalExecutionPath: 'maker_fill',
          finalVenue: 'clob',
          finalOrderType: 'maker',
          executionSucceeded: true,
          sharesFilled: shares,
          stakeUsdExecuted: newPos.stakeUsd,
          entryPrice: basisPrice,
          makerAttempted: true,
          makerFillStatus: 'full',
          makerPostedPrice: pendingOrder.price,
          ...(pendingOrder.bestAskAtPosting && {
            counterfactualTakerPrice: pendingOrder.bestAskAtPosting,
            counterfactualTakerCost: shares * pendingOrder.bestAskAtPosting,
          }),
        });
      }
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
        outcomePrice: basisPrice,
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

/**
 * Reconcile an async size-up (top-up) maker fill detected during share-mismatch
 * healing: the on-chain share count for a position already in the ledger has
 * grown AND a bot-posted, size-up-eligible maker order is linked for this exact
 * token + direction.
 *
 * Applies proper top-up accounting (weighted-average entry + topUpCount via
 * sizeUpPosition) and emits the size-up Telegram notification that the inline
 * executor path could not send — on resolution day the scanner's per-day dedup
 * key blocks it from re-emitting the signal, so the executor never resume-polls
 * its own pending order and the fill only ever surfaces here.
 *
 * Returns true when handled, or false to fall through to the generic share heal
 * (no linked/eligible maker order, feature disabled, or any error — failing
 * closed so a transient fault can't abort the whole reconciliation cycle).
 */
async function tryReconcileSizeUpFill(
  redis: Redis,
  cfg: ReturnType<typeof loadConfig>,
  ledgerPos: Position,
  tokenId: string | undefined,
  venueShares: number,
  ledgerShares: number,
): Promise<boolean> {
  let committed = false;
  try {
    if (!tokenId || !cfg.SIZE_UP_ENABLED) return false;
    const additionalShares = venueShares - ledgerShares;
    if (additionalShares <= 0.01) return false;

    // Require a bot-posted maker order linked to this exact token + direction.
    // Without one, this is an unrelated mismatch and the generic heal should run.
    const ledgerDirNorm =
      ledgerPos.direction === 'UP' ? 'YES' : ledgerPos.direction === 'DOWN' ? 'NO' : ledgerPos.direction;
    const rawPending = await getPendingOrder(redis, ledgerPos.marketId, ledgerDirNorm);
    if (!rawPending) return false;
    const pendingDirNorm =
      rawPending.direction === 'UP' ? 'YES' : rawPending.direction === 'DOWN' ? 'NO' : rawPending.direction;
    if (rawPending.tokenId !== tokenId || pendingDirNorm !== ledgerDirNorm) return false;

    // Size-up is restricted to configured sources (weather). Mirror the executor's
    // SIZE_UP_ELIGIBLE_SOURCES gate so an unrelated strategy's maker fill on an
    // already-held position is never misclassified as a pyramid top-up.
    const eligibleSources = cfg.SIZE_UP_ELIGIBLE_SOURCES.split(',').map((s) => s.trim()).filter(Boolean);
    const src = rawPending.sourcedFrom ?? ledgerPos.sourcedFrom ?? '';
    if (!eligibleSources.some((s) => src.startsWith(s))) return false;

    // Price the top-up at the actual fill VWAP from CLOB trade records. The
    // posted limit price is only an upper bound: a GTC that crosses the book at
    // post time fills at the resting orders' (better) prices, and pricing the
    // heal at the posted limit inflates the position's cost basis — observed
    // healed entries at exactly the posted price (0.53) while on-chain fills
    // were cheaper, eating size-up headroom under the path stake cap.
    // Falls back to the posted price when fills can't be attributed.
    //
    // Best-effort marginal pricing: the VWAP spans ALL of this order's fills,
    // while additionalShares is only the delta since the last heal. When the
    // same order fills across multiple reconcile cycles (residual-cancel-
    // unconfirmed keeps the pending key), a later cycle prices its delta at the
    // order's running VWAP rather than the exact marginal price. For a pure
    // maker rest every fill is at one price so the two are identical; for the
    // rare multi-cycle taker cross the blend stays ≤ the posted price, i.e.
    // still strictly better than the pre-VWAP posted-price basis.
    const fillPrice = await resolveOrderFillPrice(
      rawPending.orderId,
      ledgerPos.conditionId,
      rawPending.tokenId,
      additionalShares,
      rawPending.price,
    );
    const additionalStake = additionalShares * fillPrice;
    // Defensive: a corrupt/zero stored price would write NaN/0 cost basis. Bail to
    // the generic heal (which has its own finite-stake guard) rather than corrupt.
    if (!(fillPrice > 0) || !Number.isFinite(additionalStake)) return false;

    // Partial fill: cancel the residual resting size so it can't keep filling
    // untracked on a later cycle (mirrors the executor's own resume path).
    const isPartial = additionalShares + 0.01 < rawPending.size;
    let residualResolved = true; // full fills have no residual to cancel
    if (isPartial) {
      residualResolved = await cancelClobOrder(rawPending.orderId).catch(() => false);
    }

    // Past this point the ledger is being mutated: if a later step throws we must
    // report handled (return true in the catch) so the caller does NOT run the
    // generic heal on top, which would clobber the weighted-average stake/entry
    // sizeUpPosition wrote and double-apply the top-up.
    committed = true;
    await sizeUpPosition(
      redis,
      ledgerPos.marketId,
      ledgerPos.direction,
      additionalShares,
      additionalStake,
      fillPrice,
    );
    // Only clear the pending record once the order is fully resolved: a full fill,
    // or a partial fill whose residual cancel was CONFIRMED. If the residual cancel
    // failed/was unconfirmed, keep the key so a later fill of the still-resting
    // residual is re-attributed as a size-up (sizeUpPosition) rather than clobbered
    // by the generic heal. The pending key's TTL is the backstop for cleanup.
    if (residualResolved) {
      await deletePendingOrder(redis, ledgerPos.marketId, rawPending.direction);
    } else {
      logger.warn('[reconcile] size-up residual cancel unconfirmed — keeping pending key for re-attribution', {
        marketId: ledgerPos.marketId,
        orderId: rawPending.orderId,
      });
    }

    logger.info('[reconcile] async size-up maker fill reconciled', {
      marketId: ledgerPos.marketId,
      direction: ledgerPos.direction,
      additionalShares: +additionalShares.toFixed(4),
      additionalStake: +additionalStake.toFixed(2),
      fillPrice: +fillPrice.toFixed(4),
      newTotalShares: +venueShares.toFixed(4),
    });

    const signalLike: TradeSignal = {
      marketId: ledgerPos.marketId,
      ...(ledgerPos.conditionId != null && { conditionId: ledgerPos.conditionId }),
      ...(ledgerPos.clobTokenIds != null && { clobTokenIds: ledgerPos.clobTokenIds }),
      question: ledgerPos.question,
      direction: ledgerPos.direction,
      stakeUsd: additionalStake,
      edgeMagnitude: rawPending.edgeMagnitude ?? ledgerPos.edgeMagnitude ?? 0,
      ...(rawPending.consensusP != null && { consensusProbability: rawPending.consensusP }),
      outcomePrice: fillPrice,
      sourcedFrom: rawPending.sourcedFrom ?? ledgerPos.sourcedFrom ?? 'reconciled:weather',
      reasoning: rawPending.reasoning ?? 'Async maker size-up fill reconciled from CLOB position snapshot.',
      _isSizeUp: true,
      _sizeUpExistingStake: ledgerPos.stakeUsd,
      _sizeUpTopUpNumber: (ledgerPos.topUpCount ?? 0) + 1,
    };
    void notifyTradeExecuted(signalLike, undefined, {
      venue: 'clob',
      sharesFilled: additionalShares,
      entryPrice: fillPrice,
    }).catch(() => {});

    return true;
  } catch (err) {
    logger.warn('[reconcile] size-up reconciliation failed (non-fatal)', {
      marketId: ledgerPos.marketId,
      direction: ledgerPos.direction,
      committed,
      error: err instanceof Error ? err.message : String(err),
    });
    // If the ledger mutation already started, report handled so the caller skips
    // the generic heal (avoids double-apply). A pre-commit failure falls through.
    return committed;
  }
}
