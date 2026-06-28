/**
 * Take-profit executor.
 *
 * When the evaluator decides to exit a position, this module:
 * 1. Routes to the CLOB for exit
 * 2. Removes the position from the Redis ledger
 * 3. Sends a Telegram take-profit notification
 *
 * Sell direction is always the same side as the entry direction:
 *   Entry YES → Sell YES shares
 *   Entry NO  → Sell NO shares
 */

import { logger } from '../shared/logger.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { extractTheme, removeNearZeroPosition } from '../shared/themeExtractor.js';
import {
  submitClobSell,
  submitClobLimitSell,
  getClobOrderBook,
  getClobOrder,
  cancelClobOrder,
  fetchClobTokenBalance,
  parseBalanceFromClobError,
  type ClobBalanceResult,
  type ClobTradeResult,
  CLOB_MIN_ORDER_USD,
} from '../shared/clob.js';
import type { TickSize } from '@polymarket/clob-client-v2';
import { getBookTouch } from '../shared/bookTouch.js';
import {
  closePosition,
  getPosition,
  recordPosition,
  markPositionSynthHedged,
  markPositionPendingSettlement,
  markPositionExitBlocked,
  isWeatherSourced,
  updatePositionShares,
} from '../execution/positionLedger.js';
import { notifyTakeProfitExecuted, notify } from '../execution/telegram.js';
import { creditProceeds } from '../shared/bankroll.js';
import { loadConfig } from '../shared/config.js';
import { recordPositionOutcome } from '../shared/positionOutcomeRecorder.js';
import { recordExecutionEvent } from '../shared/telemetry.js';
import { getHyperliquid, resolveHlSymbol } from '../shared/hyperliquid.js';
import type { Redis } from 'ioredis';
import type { Position } from '../execution/positionLedger.js';

import type { ExitReason } from './takeProfitEvaluator.js';

/**
 * Close a PM position from the ledger and, if a delta-hedge link exists,
 * also close the linked HL position. Called from all take-profit exit paths
 * so hedge positions are never orphaned.
 */
async function closePositionWithHedge(
  redis: Redis,
  marketId: string,
  direction: Position['direction'],
): Promise<void> {
  // Fetch before closing so we can read sourcedFrom/question for near-zero
  // theme set cleanup. closePosition() also calls getPosition() internally for
  // its PG emit — one extra round-trip on an infrequent exit path, acceptable
  // to avoid changing closePosition()'s return type or signature.
  const posRecord = await getPosition(redis, marketId, direction).catch(() => null);

  await closePosition(redis, marketId, direction);

  // Clean up near-zero-arb theme/global open sets on every exit path.
  if (posRecord?.sourcedFrom?.startsWith('near-zero-arb')) {
    const theme = extractTheme(posRecord.question ?? '');
    await removeNearZeroPosition(redis, theme, marketId, direction);
    // Block re-entry on the same market+direction for NEAR_ZERO_REENTRY_COOLDOWN_S.
    const cooldownTtl = loadConfig().NEAR_ZERO_REENTRY_COOLDOWN_S;
    const cooldownKey = `near_zero:reentry_cooldown:${marketId}:${direction}`;
    if (cooldownTtl <= 0) {
      // TTL=0 means "disable cooldown" — clear any existing key instead of SET EX 0 (which Redis rejects).
      await redis.del(cooldownKey).catch((e: unknown) => {
        logger.debug('[take-profit-executor] near-zero reentry cooldown del failed (non-fatal)', {
          marketId,
          direction,
          error: String(e),
        });
      });
    } else {
      await redis.set(cooldownKey, '1', 'EX', cooldownTtl).catch((e: unknown) => {
        logger.warn('[take-profit-executor] near-zero reentry cooldown set failed (non-fatal)', {
          marketId,
          direction,
          cooldownTtl,
          error: String(e),
        });
      });
    }
  }

  // Check for a linked HL hedge and close it if present.
  const hlSymbol = await redis.get(`hedge:link:${marketId}`).catch(() => null);
  if (hlSymbol) {
    try {
      const hl = getHyperliquid();
      const result = await hl.closePosition(hlSymbol);
      if (result.success) {
        logger.info('[take-profit-executor] closed linked HL hedge', { marketId, hlSymbol });
        // Only delete the key on success — a failed close leaves it alive so
        // futuresMonitor keeps the position exempt from max-hold and the open
        // HL leg remains visible for manual inspection or retry.
        await redis.del(`hedge:link:${marketId}`).catch((e: unknown) => {
          logger.debug('[take-profit-executor] hedge:link del failed (non-fatal)', {
            marketId, error: String(e),
          });
        });
      } else {
        logger.warn('[take-profit-executor] failed to close linked HL hedge', {
          marketId, hlSymbol, error: result.error,
        });
        void notify(
          `⚠️ HL hedge close failed — manual action needed\nPM market: ${marketId}\nHL symbol: ${hlSymbol}\nError: ${result.error ?? 'unknown'}`,
        ).catch(() => {});
      }
    } catch (err: unknown) {
      logger.warn('[take-profit-executor] error closing linked HL hedge', {
        marketId, hlSymbol, error: String(err),
      });
      void notify(
        `⚠️ HL hedge close error — manual action needed\nPM market: ${marketId}\nHL symbol: ${hlSymbol}\nError: ${String(err)}`,
      ).catch(() => {});
    }
  }
}

function emitExecutionOutcome(
  redis: Redis,
  position: Position,
  returnPct: number,
  exitPrice: number,
  reason: ExitReason,
): void {
  if (!position.executionId) return;
  const realizedPnlUsd = position.stakeUsd * (returnPct / 100);
  void recordExecutionEvent(redis, 'execution_outcome', {
    executionId: position.executionId,
    marketId: position.marketId,
    direction: position.direction,
    finalExecutionPath: 'take_profit',
    entryPrice: position.entryPrice,
    exitPrice: exitPrice,
    entryTimestamp: position.openedAt,
    exitTimestamp: new Date().toISOString(),
    realizedPnlUsd: realizedPnlUsd,
    realizedRoi: returnPct / 100,
    executionVenue: position.executionVenue,
    modeConfigured: position.modeConfigured ?? loadConfig().EXECUTION_MODE,
    entryExecutionPath: position.entryExecutionPath ?? null,
    entryOrderType: position.entryOrderType ?? null,
    fallbackReason: position.fallbackReason ?? null,
    decisionSpreadBps: position.decisionSpreadBps ?? null,
    makerPriceImprovementBps: position.makerPriceImprovementBps ?? null,
    makerPriceImprovementUsd: position.makerPriceImprovementUsd ?? null,
    closedReason: reason,
  }).catch(() => {
    /* ignore telemetry errors */
  });
}

export interface TakeProfitResult {
  marketId: string;
  success: boolean;
  txHash?: string | undefined;
  error?: string | undefined;
  returnPct: number;
  reason: ExitReason;
}

/**
 * Execute a take-profit exit for a single position.
 *
 * Routes to CLOB for exit.
 * Never throws — all errors are captured in result.error.
 */
export async function executeTakeProfit(opts: {
  position: Position;
  currentPrice: number;
  returnPct: number;
  reason: ExitReason;
  redis: Redis;
}): Promise<TakeProfitResult> {
  const { position, currentPrice, returnPct, reason, redis } = opts;
  // Sell the same side we bought (sell YES shares to exit a YES position)
  // UP maps to 'yes' side (token[0]), DOWN maps to 'no' side (token[1])
  const sellSide = (position.direction === 'YES' || position.direction === 'UP') ? 'yes' as const : 'no' as const;

  // Use tracked shares if available; fall back to estimating from stake/entry price.
  // Truncate to 6 decimal places to avoid rounding overshoot vs actual CLOB balance.
  // Use truncation (floor toward zero), not rounding — rounding up could exceed fill size.
  // Avoid truncating values smaller than 1e-6 to zero (which would trip the <= 0 guard below).
  const rawShares = position.sharesHeld ?? position.stakeUsd / position.entryPrice;
  const sharesToSell =
    rawShares >= 1e-6 ? Math.floor(rawShares * 1_000_000) / 1_000_000 : rawShares; // sub-micro values: keep as-is; the <= 0 / NaN guard handles truly invalid values

  // Guard against legacy Redis positions with entryPrice=0 or NaN sharesHeld
  if (!isFinite(sharesToSell) || sharesToSell <= 0) {
    const error = `terminal_no_balance: invalid sharesToSell (${sharesToSell.toString()}) — entryPrice=${position.entryPrice.toString()}, sharesHeld=${(position.sharesHeld ?? 0).toString()}`;
    logger.error('[take-profit-executor] aborting sell — invalid share count', {
      marketId: position.marketId,
      sharesToSell,
      entryPrice: position.entryPrice,
      sharesHeld: position.sharesHeld,
    });
    // Durable-flag position so monitor loop does not retry
    await updatePositionShares(
      redis,
      position.marketId,
      position.direction,
      0,
      'terminal_no_balance',
    ).catch(() => {
      /* ignore update errors */
    });
    return { marketId: position.marketId, success: false, error, returnPct, reason };
  }

  logger.info('[take-profit-executor] exiting position', {
    marketId: position.marketId,
    direction: position.direction,
    sellSide,
    sharesToSell: sharesToSell.toFixed(4),
    returnPct: returnPct.toFixed(2),
    reason,
    venue: position.executionVenue ?? 'clob',
  });

  // All positions exit via CLOB. Maker-exit attempt when eligible.
  const cfg = loadConfig();
  const makerEligible =
    cfg.MAKER_EXIT_ENABLED &&
    position.clobTokenIds &&
    position.clobTokenIds.length > 0 &&
    cfg.MAKER_EXIT_ELIGIBLE_REASONS.includes(reason);
  if (makerEligible) {
    const makerResult = await tryExecuteViaClobMakerExit({
      position,
      returnPct,
      reason,
      redis,
      sharesToSell,
    });
    if (makerResult.ok) return makerResult.result;
    logger.info('[exit] maker_exit_fallback_taker', {
      marketId: position.marketId,
      reason,
      fallbackReason: makerResult.fallbackReason,
    });
  }
  return executeClobExit({ position, currentPrice, returnPct, reason, redis, sharesToSell });
}


/**
 * Resell residual shares left on CLOB after a partial FAK fill.
 *
 * Queries the on-chain ERC-1155 balance directly (ground truth), then submits
 * follow-up market sells for whatever remains up to RESIDUAL_SWEEP_MAX_ATTEMPTS.
 */
async function sweepClobResidual(opts: {
  position: Position;
  tokenId: string;
  currentPrice: number;
}): Promise<{ additionalSharesSold: number; additionalProceedsUsd: number; residualRemainsOnVenue: boolean }> {
  const { position, tokenId, currentPrice } = opts;
  const cfg = loadConfig();
  let totalExtraShares = 0;
  let totalExtraProceeds = 0;

  for (let attempt = 1; attempt <= cfg.RESIDUAL_SWEEP_MAX_ATTEMPTS; attempt++) {
    try {
      const bal = await fetchClobTokenBalance(tokenId);
      if (!bal.ok) {
        logger.warn('[take-profit-executor] clob sweep balance fetch failed', {
          marketId: position.marketId,
          attempt,
          error: bal.error,
        });
        return { additionalSharesSold: totalExtraShares, additionalProceedsUsd: totalExtraProceeds, residualRemainsOnVenue: true };
      }
      const residual = bal.balance;
      if (residual <= 1e-6) {
        return { additionalSharesSold: totalExtraShares, additionalProceedsUsd: totalExtraProceeds, residualRemainsOnVenue: false };
      }

      const residualNotional = residual * currentPrice;
      if (residualNotional < Math.max(cfg.RESIDUAL_SWEEP_MIN_NOTIONAL_USD, CLOB_MIN_ORDER_USD)) {
        logger.info('[take-profit-executor] clob residual below sweep min — leaving for pending settlement', {
          marketId: position.marketId,
          residual: residual.toFixed(6),
          notional: residualNotional.toFixed(4),
          attempt,
        });
        return { additionalSharesSold: totalExtraShares, additionalProceedsUsd: totalExtraProceeds, residualRemainsOnVenue: true };
      }

      const sellShares = Math.floor(residual * 1_000_000) / 1_000_000;
      logger.info('[take-profit-executor] sweeping clob residual', {
        marketId: position.marketId,
        residual: sellShares.toFixed(6),
        attempt,
      });
      const result = await submitClobSell({
        tokenId,
        shares: sellShares,
        orderType: cfg.CLOB_ORDER_TYPE,
      });

      if (!result.success) {
        logger.warn('[take-profit-executor] clob sweep submit failed', {
          marketId: position.marketId,
          attempt,
          error: result.error,
        });
        return { additionalSharesSold: totalExtraShares, additionalProceedsUsd: totalExtraProceeds, residualRemainsOnVenue: true };
      }

      const fillThisRound =
        typeof result.shares_bought === 'number' && result.shares_bought > 0 ? result.shares_bought : sellShares;
      totalExtraShares += fillThisRound;
      totalExtraProceeds += fillThisRound * currentPrice;
    } catch (err) {
      logger.warn('[take-profit-executor] clob sweep iteration threw', {
        marketId: position.marketId,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      return { additionalSharesSold: totalExtraShares, additionalProceedsUsd: totalExtraProceeds, residualRemainsOnVenue: true };
    }
  }
  return { additionalSharesSold: totalExtraShares, additionalProceedsUsd: totalExtraProceeds, residualRemainsOnVenue: true };
}


/**
 * Extract the venue-reported fill price from a CLOB sell response, or
 * `undefined` if the SDK didn't populate enough fields to compute one.
 * Prefers the explicit `price`, falls back to `cost / shares_bought`.
 */
function deriveClobFillPrice(result: ClobTradeResult): number | undefined {
  if (typeof result.price === 'number' && Number.isFinite(result.price) && result.price > 0) {
    return result.price;
  }
  if (
    typeof result.cost === 'number' &&
    Number.isFinite(result.cost) &&
    result.cost > 0 &&
    typeof result.shares_bought === 'number' &&
    Number.isFinite(result.shares_bought) &&
    result.shares_bought > 0
  ) {
    const derived = result.cost / result.shares_bought;
    if (Number.isFinite(derived) && derived > 0) return derived;
  }
  return undefined;
}

/**
 * Post-sell cleanup for CLOB: close position, credit proceeds, record outcome, notify.
 *
 * Uses the venue-reported actual filled amount (`shares_bought` from the CLOB
 * response, which maps to `takingAmount` for market sells) when available. A
 * partial fill on FAK leaves a residual on-chain that Change 2 (sweep) handles.
 */
async function finalizeClobExit(
  redis: Redis,
  position: Position,
  sharesRequested: number,
  actualSharesSold: number,
  currentPrice: number,
  returnPct: number,
  reason: ExitReason,
  txHash?: string | null | undefined,
  sweepCtx?: { tokenId: string },
  /**
   * Venue-reported fill price for the primary sell, when known (e.g. the
   * maker-exit path passes the posted price — post-only matches at the
   * posted price by construction). When omitted, we fall back to
   * `currentPrice` for the proceeds estimate and treat the resulting return
   * as a QUOTE-TIME estimate, not realized.
   */
  primaryFillPrice?: number | undefined,
): Promise<TakeProfitResult> {
  const cfg = loadConfig();
  const primaryFill = actualSharesSold > 0 ? actualSharesSold : sharesRequested;
  // Prefer venue-reported fill price over quote-time `currentPrice`. For the
  // maker-exit path these are equal, but for the taker path `currentPrice`
  // is the quote at signal time and the real fill can differ.
  const priceForProceeds =
    typeof primaryFillPrice === 'number' && Number.isFinite(primaryFillPrice) && primaryFillPrice > 0
      ? primaryFillPrice
      : currentPrice;
  const hasVenueFillPrice =
    typeof primaryFillPrice === 'number' && Number.isFinite(primaryFillPrice) && primaryFillPrice > 0;
  let totalSharesSold = primaryFill;
  let totalProceedsUsd = primaryFill * priceForProceeds;
  let pendingDueToResidual = false;

  if (primaryFill < sharesRequested - 1e-6) {
    logger.warn('[take-profit-executor] clob partial fill detected', {
      marketId: position.marketId,
      requested: sharesRequested,
      filled: primaryFill,
    });
    if (cfg.RESIDUAL_SWEEP_ENABLED && sweepCtx) {
      const sweepResult = await sweepClobResidual({
        position,
        tokenId: sweepCtx.tokenId,
        currentPrice,
      });
      totalSharesSold += sweepResult.additionalSharesSold;
      totalProceedsUsd += sweepResult.additionalProceedsUsd;
      pendingDueToResidual = sweepResult.residualRemainsOnVenue;
    }
  }

  // Realized return from actual proceeds. The trigger `returnPct` is what
  // the evaluator saw at decision time (possibly off a stale WS cache); the
  // fill can be materially different — a stale $0.30 signal can still
  // lucky-fill a post-only maker sell at the real $0.78 ask because the
  // maker-exit path re-reads the book. Recording the trigger value instead
  // of realized was the 2026-04-24 chain that logged a +54% ETH Up-or-Down
  // trade as −40% lost.
  //
  // We only LABEL the result "realized" when `primaryFillPrice` was
  // provided by the caller (i.e., the venue reported an actual fill price
  // rather than our quote-time estimate). Otherwise the proceeds are still
  // `currentPrice * shares`, which may under/overstate the realized P&L on
  // taker FAK fills, so we keep the trigger returnPct — better to under-
  // correct than to publish a confidently-wrong number labelled "realized".
  const stakeUsd = position.stakeUsd;
  const stakeIsReal =
    typeof stakeUsd === 'number' && Number.isFinite(stakeUsd) && stakeUsd > 0;
  const proceedsUsable = Number.isFinite(totalProceedsUsd) && totalProceedsUsd >= 0;
  const canUseRealized = stakeIsReal && proceedsUsable && hasVenueFillPrice;
  const realizedReturnPct = canUseRealized
    ? ((totalProceedsUsd - stakeUsd) / stakeUsd) * 100
    : returnPct;

  if (stakeIsReal && !hasVenueFillPrice) {
    logger.warn(
      '[take-profit-executor] realized return fallback: no venue fill price',
      {
        marketId: position.marketId,
        reason,
        triggerReturnPct: +returnPct.toFixed(2),
        currentPrice: +currentPrice.toFixed(6),
        estimatedProceedsUsd: +totalProceedsUsd.toFixed(6),
        totalSharesSold: +totalSharesSold.toFixed(6),
      },
    );
  } else if (canUseRealized && Math.abs(realizedReturnPct - returnPct) >= 5) {
    logger.warn('[take-profit-executor] trigger vs realized returnPct divergence', {
      marketId: position.marketId,
      reason,
      triggerReturnPct: +returnPct.toFixed(2),
      realizedReturnPct: +realizedReturnPct.toFixed(2),
      stakeUsd,
      totalProceedsUsd: +totalProceedsUsd.toFixed(6),
      totalSharesSold: +totalSharesSold.toFixed(6),
    });
  }

  if (pendingDueToResidual) {
    // Reconcile the ledger sharesHeld down to the residual BEFORE flagging
    // pendingSettlement. Otherwise the next reconciler cycle compares ledger
    // shares (still at original) vs on-chain (just sold) and "heals" via the
    // mismatch path — which later triggers `expired_dust` and a duplicate
    // -100% outcome row. Root cause of the second outcome row in the
    // 2026-04-24 incident.
    const originalShares =
      typeof position.sharesHeld === 'number' && Number.isFinite(position.sharesHeld)
        ? position.sharesHeld
        : totalSharesSold;
    const residualShares = Math.max(0, originalShares - totalSharesSold);
    await updatePositionShares(
      redis,
      position.marketId,
      position.direction,
      residualShares,
      `partial_exit:${new Date().toISOString()}`,
    );
    await markPositionPendingSettlement(redis, position.marketId, position.direction);
    logger.info('[take-profit-executor] clob exit partial — marked pendingSettlement', {
      marketId: position.marketId,
      totalSharesSold: totalSharesSold.toFixed(6),
      residualShares: residualShares.toFixed(6),
    });
  } else {
    await closePositionWithHedge(redis, position.marketId, position.direction);
  }
  await creditProceeds(redis, totalProceedsUsd);
  await recordPositionOutcome(redis, position, {
    result: realizedReturnPct >= 0 ? 'won' : 'lost',
    returnPct: realizedReturnPct,
    executionVenueOverride: 'clob',
    exitReason: reason,
  });
  await notifyTakeProfitExecuted({ position, currentPrice, returnPct: realizedReturnPct, reason });

  const result: TakeProfitResult = {
    marketId: position.marketId,
    success: true,
    returnPct: realizedReturnPct,
    reason,
  };
  if (txHash) result.txHash = txHash;
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundDownToTick(value: number, tick: number): number {
  if (!isFinite(value) || !isFinite(tick) || tick <= 0) return value;
  const rounded = Math.floor(value / tick) * tick;
  return parseFloat(rounded.toFixed(6));
}

async function confirmMakerExitCancel(orderId: string): Promise<boolean> {
  const cancelled = await cancelClobOrder(orderId);
  if (cancelled) return true;
  for (const delay of [250, 500, 750]) {
    await sleep(delay);
    const order = await getClobOrder(orderId);
    if (!order) return true;
    const status = String(order.status ?? '').toLowerCase();
    if (status && ['cancelled', 'canceled', 'filled'].includes(status)) return true;
  }
  return false;
}

/**
 * Resolve a resting sell price inside the spread.
 *
 * Mirror of `resolveMakerPrice()` in executor.ts but for sells: we want to
 * rest *below* the best ask by `priceEdgeBps`. Clamped to tick and to a
 * floor strictly above the best bid so post-only doesn't cross.
 */
// Exported for unit tests (same pattern as bookDepthCheck.simulateFill) —
// the raw-REST-ordering regression needs to drive this directly.
export function resolveMakerExitPrice(
  book: { bids: { price: string }[]; asks: { price: string }[]; tick_size: string },
  priceEdgeBps: number,
): number | null {
  const tick = parseFloat(book.tick_size);
  if (!isFinite(tick) || tick <= 0) return null;

  // Order-agnostic touch — REST books are best-at-the-END; asks[0] is the
  // WORST ask, which would rest exit sells near 0.99. See shared/bookTouch.ts.
  const { bestBid, bestAsk } = getBookTouch(book);
  const improvement = priceEdgeBps / 10_000;

  // Rest below the ask by `improvement`, capturing spread vs taker who would hit the bid.
  let price = bestAsk > 0 ? bestAsk - improvement : 0;
  if (price <= 0 && bestBid > 0) {
    price = bestBid + tick;
  }

  // Post-only safety: must be strictly above best bid so we don't cross as a taker.
  if (bestBid > 0) {
    price = Math.max(price, bestBid + tick);
  }

  price = Math.max(price, tick);
  price = Math.min(price, 1 - tick);
  price = roundDownToTick(price, tick);

  if (!isFinite(price) || price <= 0) return null;
  return price;
}

/**
 * Try to exit a CLOB-entered PM position via a post-only maker sell.
 *
 * Preconditions (caller should have checked executionVenue === 'clob' + clobTokenIds):
 *   - MAKER_EXIT_ENABLED=true
 *   - reason ∈ MAKER_EXIT_ELIGIBLE_REASONS
 *
 * Returns `{ ok: true, result }` on a successful finalize (full or partial-with-sweep).
 * Returns `{ ok: false }` on timeout / rejection / zero-fill so the caller falls
 * through to the existing taker CLOB exit path unchanged.
 */
async function tryExecuteViaClobMakerExit(opts: {
  position: Position;
  returnPct: number;
  reason: ExitReason;
  redis: Redis;
  sharesToSell: number;
}): Promise<{ ok: true; result: TakeProfitResult } | { ok: false; fallbackReason: string }> {
  const { position, returnPct, reason, redis, sharesToSell } = opts;
  const cfg = loadConfig();

  const tokenId =
    position.direction === 'YES' || position.direction === 'UP'
      ? position.clobTokenIds?.[0]
      : position.clobTokenIds?.[1];
  if (!tokenId) return { ok: false, fallbackReason: 'missing_token' };

  void redis.incr('execution:metric:maker_exit_attempted').catch(() => undefined);
  logger.info('[exit] maker_exit_attempt', {
    marketId: position.marketId,
    direction: position.direction,
    reason,
    sharesToSell: sharesToSell.toFixed(6),
  });

  const book = await getClobOrderBook(tokenId);
  if (!book) {
    void redis.incr('execution:metric:maker_exit_fallback').catch(() => undefined);
    return { ok: false, fallbackReason: 'no_orderbook' };
  }

  const price = resolveMakerExitPrice(book, cfg.MAKER_EXIT_PRICE_EDGE_BPS);
  if (price === null) {
    void redis.incr('execution:metric:maker_exit_fallback').catch(() => undefined);
    return { ok: false, fallbackReason: 'bad_price' };
  }

  // Pre-flight balance check — cap size at on-chain balance, bail to taker on fetch error.
  const balRes = await fetchClobTokenBalance(tokenId);
  if (!balRes.ok) {
    void redis.incr('execution:metric:maker_exit_fallback').catch(() => undefined);
    return { ok: false, fallbackReason: 'balance_fetch_failed' };
  }
  const safeShares = Math.min(sharesToSell, balRes.balance);
  if (safeShares <= 0 || safeShares * price < CLOB_MIN_ORDER_USD) {
    void redis.incr('execution:metric:maker_exit_fallback').catch(() => undefined);
    return { ok: false, fallbackReason: 'below_min_notional' };
  }
  const truncatedShares = Math.floor(safeShares * 1_000_000) / 1_000_000;

  const submitResult = await submitClobLimitSell({
    tokenId,
    price,
    size: truncatedShares,
    tickSize: book.tick_size as TickSize,
    negRisk: book.neg_risk,
    orderType: 'GTC',
    postOnly: true,
  });

  if (!submitResult.success || !submitResult.order_id) {
    void redis.incr('execution:metric:maker_exit_fallback').catch(() => undefined);
    logger.warn('[exit] maker_exit_fallback_taker', {
      marketId: position.marketId,
      reason,
      error: submitResult.error,
    });
    return { ok: false, fallbackReason: submitResult.error ?? 'order_rejected' };
  }

  const orderId = submitResult.order_id;
  const deadline = Date.now() + cfg.MAKER_EXIT_MAX_WAIT_MS;
  let matched = 0;
  let original = truncatedShares;

  while (Date.now() < deadline) {
    const order = await getClobOrder(orderId);
    if (!order) break;
    matched = parseFloat(order.size_matched ?? '0');
    original = parseFloat(order.original_size ?? String(truncatedShares));
    if (matched >= original - 1e-9) break;
    await sleep(cfg.MAKER_POLL_INTERVAL_MS);
  }

  const isFull = matched >= original - 1e-9 && matched > 0;
  const isPartial = matched > 0 && !isFull;

  // Cancel remainder on partial or timeout so on-chain balance is freed for sweep/taker retry.
  if (!isFull) {
    const cancelled = await confirmMakerExitCancel(orderId);
    if (!cancelled) {
      logger.warn('[exit] maker_exit_cancel_unconfirmed', {
        marketId: position.marketId,
        orderId,
      });
      // Still fall through — sweep/taker path will resync against on-chain balance.
    }
  }

  if (matched <= 0) {
    void redis.incr('execution:metric:maker_exit_timeout').catch(() => undefined);
    void redis.incr('execution:metric:maker_exit_fallback').catch(() => undefined);
    logger.info('[exit] maker_exit_timeout', {
      marketId: position.marketId,
      reason,
      orderId,
      waitedMs: cfg.MAKER_EXIT_MAX_WAIT_MS,
    });
    return { ok: false, fallbackReason: 'timeout_no_fill' };
  }

  // Full or partial fill — finalize via existing CLOB finalize path.
  // Partial fills forward the residual to sweepClobResidual inside finalizeClobExit.
  if (isFull) {
    void redis.incr('execution:metric:maker_exit_filled').catch(() => undefined);
    logger.info('[exit] maker_exit_filled', {
      marketId: position.marketId,
      reason,
      price,
      shares: matched.toFixed(6),
    });
  } else {
    void redis.incr('execution:metric:maker_exit_partial').catch(() => undefined);
    logger.info('[exit] maker_exit_partial', {
      marketId: position.marketId,
      reason,
      price,
      matched: matched.toFixed(6),
      original: original.toFixed(6),
    });
  }

  // Post-only maker fills match AT the posted price by construction, so
  // `price` is the venue-reported fill price for this path. Forward it as
  // `primaryFillPrice` so finalizeClobExit can compute a true realized
  // returnPct rather than fall back to the trigger value.
  const result = await finalizeClobExit(
    redis,
    position,
    isPartial ? original : matched,
    matched,
    price,
    returnPct,
    reason,
    undefined,
    { tokenId },
    price,
  );
  return { ok: true, result };
}

/**
 * Route a CLOB sell whose notional is below the $1 CLOB minimum.
 *
 * A FULL live weather position (shares ≥ RECONCILE_MIN_HEAL_SHARES) is recorded
 * as exit-blocked (non-terminal) so the weather scanners keep evaluating it and
 * can retry once the bid recovers, instead of being hidden as pendingSettlement.
 * Genuine dust and non-weather positions keep the existing pendingSettlement
 * behaviour. Gated on WEATHER_EXIT_BLOCKED_ENABLED. Always returns a failure result.
 */
async function handleSubMinNotional(
  redis: Redis,
  position: Position,
  shares: number,
  currentPrice: number,
  notionalUsd: number,
  returnPct: number,
  reason: ExitReason,
  stage: 'pre_sync' | 'post_sync',
): Promise<TakeProfitResult> {
  const cfg = loadConfig();
  const weatherFullPosition =
    cfg.WEATHER_EXIT_BLOCKED_ENABLED &&
    isWeatherSourced(position.sourcedFrom) &&
    shares >= cfg.RECONCILE_MIN_HEAL_SHARES;

  if (weatherFullPosition) {
    logger.warn('[take-profit-executor] weather sell below min notional — exit-blocked (kept live)', {
      marketId: position.marketId,
      direction: position.direction,
      stage,
      shares,
      currentPrice,
      notionalUsd: notionalUsd.toFixed(4),
      minUsd: CLOB_MIN_ORDER_USD,
    });
    await markPositionExitBlocked(redis, position.marketId, position.direction, 'min_notional');
    void enqueueWrite('shadow_observations', {
      kind: 'weather_exit_blocked',
      source: 'monitor',
      marketId: position.marketId,
      direction: position.direction,
      // The CLOB sell is NOT submitted (sub-$1) — the exit IS blocked. Matches the
      // repo convention where wouldBlock=true means "this path blocked the action".
      wouldBlock: true,
      metricValue: notionalUsd,
      threshold: CLOB_MIN_ORDER_USD,
      payload: {
        stage,
        sharesHeld: shares,
        currentPrice,
        notionalAtBid: notionalUsd,
        reason: 'min_notional',
        sourcedFrom: position.sourcedFrom,
        exitReason: reason,
      },
    });
    return {
      marketId: position.marketId,
      success: false,
      error: `exit_blocked_min_notional: $${notionalUsd.toFixed(4)} < $${CLOB_MIN_ORDER_USD.toString()}`,
      returnPct,
      reason,
    };
  }

  logger.warn('[take-profit-executor] CLOB sell below minimum notional — marking pendingSettlement', {
    marketId: position.marketId,
    direction: position.direction,
    stage,
    shares,
    currentPrice,
    notionalUsd: notionalUsd.toFixed(4),
    minUsd: CLOB_MIN_ORDER_USD,
  });
  await markPositionPendingSettlement(redis, position.marketId, position.direction);
  return {
    marketId: position.marketId,
    success: false,
    error: `CLOB sell below minimum: $${notionalUsd.toFixed(4)} < $${CLOB_MIN_ORDER_USD.toString()}`,
    returnPct,
    reason,
  };
}

async function executeClobExit(opts: {
  position: Position;
  currentPrice: number;
  returnPct: number;
  reason: ExitReason;
  redis: Redis;
  sharesToSell: number;
}): Promise<TakeProfitResult> {
  const { position, currentPrice, returnPct, reason, redis, sharesToSell } = opts;

  // 1. Venue Guard: Ensure we don't attempt CLOB token extraction for HL positions
  if (position.executionVenue === 'hyperliquid') {
    return {
      success: false,
      marketId: position.marketId,
      error: 'Hyperliquid exit not yet implemented via CLOB route',
      returnPct,
      reason,
    };
  }

  // 2. Extract token ID
  const tokenId = (position.direction === 'YES' || position.direction === 'UP')
    ? position.clobTokenIds?.[0] : position.clobTokenIds?.[1];

  if (!tokenId) {
    const error = 'CLOB exit failed: missing token ID for direction ' + position.direction;
    logger.error('[take-profit-executor] ' + error, { marketId: position.marketId });
    return { marketId: position.marketId, success: false, error, returnPct, reason };
  }

  // Polymarket CLOB rejects orders below $1.00 notional (shares × currentPrice).
  // Positions this small are better left for the resolution redeemer (which pays $1/share at settlement).
  const notionalUsd = sharesToSell * currentPrice;
  if (notionalUsd < CLOB_MIN_ORDER_USD) {
    return handleSubMinNotional(
      redis, position, sharesToSell, currentPrice, notionalUsd, returnPct, reason, 'pre_sync',
    );
  }

  // Fetch actual on-chain balance with one retry to handle transient RPC failures.
  // Uses discriminated result so genuine zero balance is handled differently from fetch errors.
  let balanceResult: ClobBalanceResult = await fetchClobTokenBalance(tokenId);
  if (!balanceResult.ok) {
    // Retry once before falling back.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    balanceResult = await fetchClobTokenBalance(tokenId);
  }

  let actualBalance: number;
  if (!balanceResult.ok) {
    // Both attempts failed — use 98% of Redis value as conservative approximation.
    // (Previously 99.99%, which still overshot due to FAK partial fills.)
    logger.warn('[take-profit-executor] balance fetch failed after retry — using 98% fallback', {
      marketId: position.marketId,
      tokenId,
      sharesToSell,
      error: balanceResult.error,
    });
    actualBalance = sharesToSell * 0.98;
  } else {
    actualBalance = balanceResult.balance;
  }

  // Ghost position cleanup — genuine zero balance (not a fetch error) means stale ledger entry.
  if (balanceResult.ok && actualBalance < 0.001) {
    logger.error('[take-profit-executor] on-chain balance near-zero — closing stale ledger entry', {
      marketId: position.marketId,
      tokenId,
      actualBalance,
      redisShares: sharesToSell,
    });
    await updatePositionShares(
      redis,
      position.marketId,
      position.direction,
      0,
      'terminal_no_balance',
    ).catch(() => {
      /* ignore update errors */
    });
    await closePositionWithHedge(redis, position.marketId, position.direction);
    return {
      marketId: position.marketId,
      success: false,
      error: 'terminal_no_balance',
      returnPct,
      reason,
    };
  }

  // Use the minimum of (tracked shares, actual balance) to prevent overshoot.
  const safeShares = Math.min(sharesToSell, actualBalance);

  // Re-check notional after balance sync — actual balance may be too small to sell
  const postSyncNotional = safeShares * currentPrice;
  if (postSyncNotional < CLOB_MIN_ORDER_USD) {
    return handleSubMinNotional(
      redis, position, safeShares, currentPrice, postSyncNotional, returnPct, reason, 'post_sync',
    );
  }

  // Log drift when actual balance is less than Redis-tracked shares.
  if (actualBalance < sharesToSell) {
    logger.info('[take-profit-executor] CLOB balance sync: using actual balance', {
      marketId: position.marketId,
      sharesToSell,
      actualBalance,
      diff: sharesToSell - actualBalance,
    });
  }

  if (safeShares <= 0) {
    logger.warn('[take-profit-executor] safe shares <= 0 after balance sync — skipping sell', {
      marketId: position.marketId,
      sharesToSell,
      actualBalance,
      safeShares,
    });
    await updatePositionShares(
      redis,
      position.marketId,
      position.direction,
      0,
      'terminal_no_balance',
    ).catch(() => {
      /* ignore update errors */
    });
    await closePositionWithHedge(redis, position.marketId, position.direction);
    return {
      marketId: position.marketId,
      success: false,
      error: 'terminal_no_balance',
      returnPct,
      reason,
    };
  }

  try {
    const clobResult = await submitClobSell({
      tokenId,
      shares: safeShares,
      orderType: loadConfig().CLOB_ORDER_TYPE,
    });

    if (clobResult.success) {
      logger.info('[take-profit-executor] exit successful (clob)', {
        marketId: position.marketId,
        txHash: clobResult.tx_hash,
        shares: safeShares,
      });
      // Taker path: prefer the venue's reported fill price when the SDK
      // populates it (cost/shares_bought or explicit `price`). A FAK fill
      // can land materially away from the quote-time `currentPrice` on
      // fast-moving or thin books. If neither the explicit price nor a
      // usable cost field is set, we pass undefined and finalizeClobExit
      // keeps the trigger returnPct rather than publish a lie labelled
      // "realized".
      const venueFillPrice = deriveClobFillPrice(clobResult);
      return finalizeClobExit(
        redis,
        position,
        safeShares,
        clobResult.shares_bought ?? safeShares,
        currentPrice,
        returnPct,
        reason,
        clobResult.tx_hash,
        { tokenId },
        venueFillPrice,
      );
    }

    // ── Auto-retry: parse actual balance from CLOB error and retry once ─────
    const error = clobResult.error ?? 'CLOB sell failed';
    if (error.toLowerCase().includes('not enough balance')) {
      const parsedBalance = parseBalanceFromClobError(error);
      if (parsedBalance !== null && parsedBalance > 0 && parsedBalance < safeShares) {
        logger.info('[take-profit-executor] retrying with CLOB-reported balance', {
          marketId: position.marketId,
          previousShares: safeShares,
          clobBalance: parsedBalance,
        });

        const retryShares = Math.floor(parsedBalance * 1_000_000) / 1_000_000;
        const retryNotional = retryShares * currentPrice;
        if (retryShares > 0 && retryNotional >= CLOB_MIN_ORDER_USD) {
          const retryResult = await submitClobSell({
            tokenId,
            shares: retryShares,
            orderType: loadConfig().CLOB_ORDER_TYPE,
          });

          if (retryResult.success) {
            logger.info('[take-profit-executor] exit successful after balance retry (clob)', {
              marketId: position.marketId,
              txHash: retryResult.tx_hash,
              shares: retryShares,
            });
            const retryFillPrice = deriveClobFillPrice(retryResult);
            return finalizeClobExit(
              redis,
              position,
              retryShares,
              retryResult.shares_bought ?? retryShares,
              currentPrice,
              returnPct,
              reason,
              retryResult.tx_hash,
              { tokenId },
              retryFillPrice,
            );
          }
        }
      }
    }

    // Dead market: no buyers at any price — mark pendingSettlement
    if (error.toLowerCase().includes('no match')) {
      logger.warn(
        '[take-profit-executor] CLOB sell has no matching buyers — marking pendingSettlement',
        {
          marketId: position.marketId,
        },
      );
      await markPositionPendingSettlement(redis, position.marketId, position.direction);
    }

    logger.warn('[take-profit-executor] CLOB sell returned success=false', {
      marketId: position.marketId,
      error,
    });
    return { marketId: position.marketId, success: false, error, returnPct, reason };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[take-profit-executor] CLOB exit trade failed', {
      marketId: position.marketId,
      error: message,
    });
    return { marketId: position.marketId, success: false, error: message, returnPct, reason };
  }
}

/**
 * If the primary venue fails, "close" the risk by opening an offsetting perp on Hyperliquid.
 */
async function attemptSyntheticExit(opts: {
  position: Position;
  currentPrice: number;
  returnPct: number;
  reason: ExitReason;
  redis: Redis;
}): Promise<TakeProfitResult> {
  const { position, currentPrice, returnPct, reason, redis } = opts;
  const cfg = loadConfig();

  if (!cfg.FUTURES_ENABLED) {
    return {
      success: false,
      marketId: position.marketId,
      returnPct,
      reason,
      error: 'Futures disabled',
    };
  }

  // 1. Identify correlated asset — use resolveHlSymbol (word-boundary safe).
  const hlSymbol = resolveHlSymbol(position.question);
  if (!hlSymbol)
    return {
      success: false,
      marketId: position.marketId,
      returnPct,
      reason,
      error: 'No correlated asset found',
    };

  // 2. Open Synthetic Exit (Hedge)
  const isBuy = position.direction === 'NO'; // If we were long NO, we buy the asset to hedge. If YES, we short.
  const hl = getHyperliquid();
  const hedgeStakeUsd = position.stakeUsd;

  // Margin cap check — synthetic exit opens a new HL position; must respect global cap.
  try {
    const state = await hl.getClearinghouseState();
    const positions = await hl.getOpenPositions(state);
    const totalCurrentMargin = positions.reduce(
      (sum, p) => sum + parseFloat(p.position.marginUsed || '0'),
      0,
    );
    if (totalCurrentMargin + hedgeStakeUsd > cfg.FUTURES_GLOBAL_MAX_MARGIN_USD) {
      logger.warn('[take-profit-executor] skipping synthetic exit — global margin cap reached', {
        current: totalCurrentMargin.toFixed(2),
        hedge: hedgeStakeUsd.toFixed(2),
        cap: cfg.FUTURES_GLOBAL_MAX_MARGIN_USD,
      });
      return {
        success: false,
        marketId: position.marketId,
        returnPct,
        reason,
        error: 'global_margin_cap',
      };
    }
  } catch (err) {
    logger.error('[take-profit-executor] margin check failed — aborting synthetic exit', {
      error: String(err),
    });
    return {
      success: false,
      marketId: position.marketId,
      returnPct,
      reason,
      error: 'margin_check_failed',
    };
  }

  logger.info('[take-profit-executor] attempting synthetic exit on HL', {
    symbol: hlSymbol,
    isBuy,
    reason,
  });

  const result = await hl.placeMarketOrder({
    symbol: hlSymbol,
    isBuy,
    sizeUsd: hedgeStakeUsd,
    leverage: 1,
  });

  if (result.success) {
    // Persist the hedge link so the redeemer can find and close the HL leg at settlement.
    await redis.set(`hedge:link:${position.marketId}`, hlSymbol, 'EX', 90 * 24 * 3600);
    logger.info('[take-profit-executor] synthetic exit: hedge link persisted', {
      marketId: position.marketId,
      hlSymbol,
    });

    // Write a futures ledger row with sourcedFrom='hedge:pm:...' so the futures
    // monitor's isActiveHedge check can exempt this position from max-hold and
    // TA-fade. Without this the backfill path overwrites sourcedFrom with
    // 'backfill:futures-monitor' and the exemption is silently lost.
    await recordPosition(redis, {
      marketId: hlSymbol,
      question: `${hlSymbol} synthetic-exit hedge for PM:${position.marketId}`,
      direction: isBuy ? 'LONG' : 'SHORT',
      entryPrice: result.price ?? 0,
      stakeUsd: hedgeStakeUsd,
      edgeMagnitude: 0,
      sourcedFrom: `hedge:pm:${position.marketId}`,
      openedAt: new Date().toISOString(),
      txHash: result.txHash,
      executionVenue: 'hyperliquid',
      isFutures: true,
      symbol: hlSymbol,
      synthHedged: true,
    }).catch((err: unknown) => {
      logger.error(
        '[take-profit-executor] failed to record synthetic-exit hedge in ledger — max-hold exemption will not apply',
        { marketId: position.marketId, hlSymbol, error: String(err) },
      );
    });

    // Mark the PM position as synthetically hedged rather than removing it.
    // The PM shares are still held on-chain — removing the ledger entry would make them
    // invisible to the redeemer and orphan them permanently. The redeemer handles final
    // settlement when the market resolves.
    try {
      await markPositionSynthHedged(redis, position.marketId, position.direction);
    } catch (markErr) {
      logger.error(
        '[take-profit-executor] CRITICAL: failed to mark PM position as synthHedged — rolling back HL',
        {
          marketId: position.marketId,
          hlSymbol,
          error: markErr instanceof Error ? markErr.message : String(markErr),
        },
      );
      // Attempt to close the HL position to restore a clean state.
      const rollback = await hl
        .closePosition(hlSymbol)
        .catch((e: unknown) => ({ success: false, error: String(e) }));
      if (!rollback.success) {
        logger.error('[take-profit-executor] HL rollback failed — manual intervention required', {
          marketId: position.marketId,
          hlSymbol,
          rollbackError: rollback.error,
        });
      }
      await redis.del(`hedge:link:${position.marketId}`).catch((e: unknown) => {
        logger.debug('[take-profit-executor] hedge:link del failed (non-fatal)', {
          marketId: position.marketId,
          error: String(e),
        });
      });
      return {
        success: false,
        marketId: position.marketId,
        returnPct,
        reason,
        error: 'synth_hedge_mark_failed_rolled_back',
      };
    }

    await notifyTakeProfitExecuted({
      position,
      currentPrice,
      returnPct,
      reason: 'synthetic',
      mechanismDetail: reason,
    });

    return {
      marketId: position.marketId,
      success: true,
      returnPct,
      reason,
      txHash: result.txHash,
    };
  }

  return {
    success: false,
    marketId: position.marketId,
    returnPct,
    reason,
    error: result.error || 'Synthetic exit failed',
  };
}
