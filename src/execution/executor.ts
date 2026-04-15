/**
 * Trade executor.
 *
 * Execution flow:
 * 1) Try Simmer first (primary venue)
 * 2) If market is unavailable in Simmer, fall back to direct Polymarket CLOB
 *
 * Shared controls:
 * - Stake floor check
 * - Idempotency guard via Redis (prevent double-firing same signal)
 * - Structured result logging
 */

import { createHash, randomUUID } from 'node:crypto';
import { logger } from '../shared/logger.js';
import { enqueueWrite } from '../db/writeQueue.js';
import {
  submitTrade,
  resolveSimmerMarketId,
  getMarketContext,
  SimmerError,
} from '../shared/simmer.js';
import {
  submitClobBuy,
  getClobOrderBook,
  submitClobLimitBuy,
  getClobOrder,
  cancelClobOrder,
} from '../shared/clob.js';
import { hasOpenPosition, recordPosition } from './positionLedger.js';
import { isStaleCooldownActive } from '../monitor/staleExit.js';
import { getHyperliquid, resolveHlSymbol } from '../shared/hyperliquid.js';
import { computeATR } from '../arb/indicators.js';
import { loadConfig } from '../shared/config.js';
import { getCalibrationStats, applyCalibrationCorrection } from '../shared/calibration.js';
import { inferCategory } from '../shared/outcomeRecorder.js';
import {
  recordArbLatency,
  recordExecutionMetric,
  recordExecutionTiming,
  recordExecutionEvent,
} from '../shared/telemetry.js';
import { notifyTradeError, notifyTradeExecuted, notifyHedgeOpened } from './telegram.js';
import { checkGlobalGovernor, recordGlobalTrade } from '../shared/governor.js';
import { getRedis } from '../shared/redis.js';
import type { SimmerTradeResult } from '../shared/simmer.js';
import type { OrderBookSummary, TickSize } from '@polymarket/clob-client';
import type { Redis } from 'ioredis';
import type { TradeSignal } from '../mapping/index.js';
import { getPendingOrder, setPendingOrder, deletePendingOrder } from './pendingMakerOrders.js';

const IDEMPOTENCY_TTL_SECONDS = 3600; // 1 hour
// MIN_STAKE_USD is loaded from config (MIN_BET_USD, default $5).
// Prevents dust positions that can't be redeemed and burn fees on tiny stakes.
const getMinStake = () => loadConfig().MIN_BET_USD;
const IDEMPOTENCY_KEY_PREFIX = 'trade:executed:';

export interface ExecutionResult {
  signal: TradeSignal;
  skipped: boolean;
  skipReason?: string;
  tradeResult?: SimmerTradeResult;
  error?: string;
  executionVenue?: 'simmer' | 'clob' | 'hyperliquid';
  modeConfigured?: 'hybrid' | 'maker' | 'taker';
  entryExecutionPath?: string;
  entryOrderType?: 'maker' | 'taker' | 'none';
  entryPrice?: number | null;
  sharesFilled?: number | null;
  decisionBenchmark?: DecisionBenchmark;
  fallbackReason?: string;
  /** True if a delta hedge was placed on HL for this trade. */
  hedgeDispatched?: boolean;
  /** ATR snapshot at futures entry — persisted to ledger for ATR-based SL/TP. */
  entryAtr?: number;
  entryAtrPct?: number;
}

interface DecisionBenchmark {
  decisionBestBid?: number | null;
  decisionBestAsk?: number | null;
  decisionMidPrice?: number | null;
  decisionSpreadBps?: number | null;
  counterfactualImmediateTakerPrice?: number | null;
  counterfactualImmediateTakerShares?: number | null;
  counterfactualImmediateTakerCostUsd?: number | null;
  makerPriceImprovementBps?: number | null;
  makerPriceImprovementUsd?: number | null;
}

function idempotencyKey(signal: TradeSignal): string {
  const canonical = `${signal.marketId}:${signal.direction}:${signal.stakeUsd.toFixed(2)}`;
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `${IDEMPOTENCY_KEY_PREFIX}${hash}`;
}

function clobTokenForSignal(signal: TradeSignal): string | null {
  if (signal.direction === 'YES' || signal.direction === 'UP') return signal.clobTokenIds?.[0] ?? null;
  return signal.clobTokenIds?.[1] ?? null;
}

/**
 * Maker-eligible signal subset.
 *
 * Maker fills bypass fees and improve average entry price, but they take time
 * (poll up to MAKER_MAX_WAIT_MS) and may not fill at all. We only attempt them
 * for signals where the alpha doesn't decay in seconds:
 *
 *   - 'osint'         — news-sentiment trades; edge persists for minutes
 *   - 'copytrade'     — whale conviction persists; our fill isn't time-critical
 *   - 'near-zero-arb' — illiquid markets at 3-10¢ don't reprice fast
 *
 * Excluded (latency-sensitive, must fill NOW):
 *   - 'crypto-arb' — Binance→PM lag arbitrage, edge gone in seconds
 *   - 'spot'       — spot momentum on PM markets, edge decays with the move
 *   - 'futures'    — bypasses this branch via the isFutures path
 *   - undefined    — unlabelled; default-deny for safety
 */
const MAKER_ELIGIBLE_SOURCES = new Set(['osint', 'copytrade', 'near-zero-arb', 'correlation-arb']);

function isMakerEligible(signal: TradeSignal): boolean {
  return MAKER_ELIGIBLE_SOURCES.has(signal.source ?? '');
}

/**
 * Compute net-of-fees edge for a signal on a fee-enabled market.
 * Used to gate the TAKER fallback path (maker fills bypass fees and don't need this gate).
 */
function netOfFeesEdge(
  grossEdge: number,
  feeBps: number | null | undefined,
  fallbackBps: number,
): number {
  const bps = feeBps != null && isFinite(feeBps) && feeBps > 0 ? feeBps : fallbackBps;
  return grossEdge - bps / 10_000;
}

function isMarketNotFoundMessage(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return /market\s+not\s+found/i.test(msg);
}

/**
 * Returns true for Simmer rejections that should fall through to CLOB.
 * "Order too small" = Simmer's 5-share minimum; CLOB has no share minimum.
 */
function shouldFallbackToClob(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return isMarketNotFoundMessage(msg) || /order too small/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundDownToTick(value: number, tick: number): number {
  if (!isFinite(value) || !isFinite(tick) || tick <= 0) return value;
  const rounded = Math.floor(value / tick) * tick;
  return parseFloat(rounded.toFixed(6));
}

function isTailPrice(price: number, threshold: number): boolean {
  if (!isFinite(price) || !isFinite(threshold)) return false;
  return price <= threshold || price >= 1 - threshold;
}

function buildDecisionBenchmark(
  signal: TradeSignal,
  book: { bids: { price: string }[]; asks: { price: string }[]; tick_size: string },
): DecisionBenchmark {
  const bestBid = parseFloat(book.bids[0]?.price ?? '0');
  const bestAsk = parseFloat(book.asks[0]?.price ?? '0');
  const hasBestBid = isFinite(bestBid) && bestBid > 0;
  const hasBestAsk = isFinite(bestAsk) && bestAsk > 0;
  const mid = hasBestBid && hasBestAsk ? (bestBid + bestAsk) / 2 : null;
  const spreadBps = hasBestBid && hasBestAsk && mid ? ((bestAsk - bestBid) / mid) * 10000 : null;
  const takerShares = hasBestAsk ? signal.stakeUsd / bestAsk : null;

  return {
    decisionBestBid: hasBestBid ? bestBid : null,
    decisionBestAsk: hasBestAsk ? bestAsk : null,
    decisionMidPrice: mid,
    decisionSpreadBps: spreadBps,
    counterfactualImmediateTakerPrice: hasBestAsk ? bestAsk : null,
    counterfactualImmediateTakerShares: takerShares,
    counterfactualImmediateTakerCostUsd: hasBestAsk && takerShares ? takerShares * bestAsk : null,
  };
}

async function captureDecisionBenchmark(signal: TradeSignal): Promise<DecisionBenchmark> {
  const tokenId = clobTokenForSignal(signal);
  if (!tokenId) return {};

  try {
    const book = await getClobOrderBook(tokenId);
    if (!book) return {};
    return buildDecisionBenchmark(signal, book);
  } catch {
    return {};
  }
}

/** Returns both the raw book and the derived benchmark so downstream callers
 * (the maker path) can reuse the single fetch instead of hitting CLOB twice. */
async function fetchBookAndBenchmark(
  signal: TradeSignal,
): Promise<{ book: OrderBookSummary | null; benchmark: DecisionBenchmark }> {
  const tokenId = clobTokenForSignal(signal);
  if (!tokenId) return { book: null, benchmark: {} };
  try {
    const book = await getClobOrderBook(tokenId);
    if (!book) return { book: null, benchmark: {} };
    return { book, benchmark: buildDecisionBenchmark(signal, book) };
  } catch {
    return { book: null, benchmark: {} };
  }
}

function calculateMakerPriceImprovement(
  takerPrice: number | null | undefined,
  makerPrice: number | null | undefined,
  sharesFilled: number | null | undefined,
): Pick<DecisionBenchmark, 'makerPriceImprovementBps' | 'makerPriceImprovementUsd'> {
  if (
    !takerPrice ||
    !makerPrice ||
    !sharesFilled ||
    takerPrice <= 0 ||
    makerPrice <= 0 ||
    sharesFilled <= 0
  ) {
    return {
      makerPriceImprovementBps: null,
      makerPriceImprovementUsd: null,
    };
  }

  return {
    makerPriceImprovementBps: ((takerPrice - makerPrice) / takerPrice) * 10000,
    makerPriceImprovementUsd: (takerPrice - makerPrice) * sharesFilled,
  };
}

function canExecuteTaker(
  signal: TradeSignal,
  cfg: ReturnType<typeof loadConfig>,
): { ok: true } | { ok: false; reason: string } {
  // Copytrade signals bypass the edge gate because the "edge" is the
  // conviction of the whale, not the distance-from-entry (slippage).
  if (signal.source === 'copytrade') return { ok: true };

  const edge = signal.edgeMagnitude ?? 0;
  const category = inferCategory(signal.question);
  const minEdge = cfg.TAKER_MIN_EDGE_CATEGORIES[category] ?? cfg.TAKER_MIN_EDGE;

  if (edge < minEdge) {
    logger.info('[executor] skipping — edge below threshold', {
      marketId: signal.marketId,
      category,
      edge: (edge * 100).toFixed(2) + '%',
      threshold: (minEdge * 100).toFixed(2) + '%',
      source: signal.source,
    });
    return { ok: false, reason: `taker_edge_below_min:${category}` };
  }

  if (cfg.TAIL_TAKER_BLOCK && isTailPrice(signal.outcomePrice, cfg.TAIL_PRICE_THRESHOLD)) {
    if (edge < cfg.TAIL_TAKER_OVERRIDE_EDGE) {
      return { ok: false, reason: 'taker_tail_blocked' };
    }
  }

  return { ok: true };
}

async function confirmMakerCancel(orderId: string): Promise<boolean> {
  const cancelled = await cancelClobOrder(orderId);
  if (cancelled) return true;

  // Retry briefly and confirm terminal state
  for (const delay of [250, 500, 750]) {
    await sleep(delay);
    const order = await getClobOrder(orderId);
    if (!order) return true;
    const status = String(order.status ?? '').toLowerCase();
    if (status && ['cancelled', 'canceled', 'filled'].includes(status)) return true;
  }

  return false;
}

function resolveMakerPrice(
  book: { bids: { price: string }[]; asks: { price: string }[]; tick_size: string },
  priceEdgeBps: number,
  fairValueOverride?: number | null,
): number | null {
  const tick = parseFloat(book.tick_size);
  if (!isFinite(tick) || tick <= 0) return null;

  const bestAsk = parseFloat(book.asks[0]?.price ?? '0');
  const improvement = priceEdgeBps / 10_000;

  // When a fair-value anchor is provided (empty-book mode), use it instead
  // of the CLOB best-bid, which is meaningless on a ghost book.
  let price: number;
  if (fairValueOverride != null && isFinite(fairValueOverride)) {
    price = fairValueOverride - improvement;
  } else {
    const bestBid = parseFloat(book.bids[0]?.price ?? '0');
    price = bestBid > 0 ? bestBid + improvement : 0;
    if (price <= 0 && bestAsk > 0) {
      price = bestAsk - tick;
    }
  }

  if (bestAsk > 0) {
    price = Math.min(price, bestAsk - tick);
  }

  price = Math.max(price, tick);
  price = Math.min(price, 1 - tick);
  price = roundDownToTick(price, tick);

  if (!isFinite(price) || price <= 0) return null;
  return price;
}

async function tryExecuteViaClobMaker(
  signal: TradeSignal,
  cfg: ReturnType<typeof loadConfig>,
  prefetchedBook?: OrderBookSummary | null,
  emptyBookMode?: boolean,
  redis?: Redis,
): Promise<{
  ok: boolean;
  tradeResult?: SimmerTradeResult;
  error?: string;
  filledStakeUsd?: number;
  waitMs: number;
  makerOrderId?: string;
  makerPostedPrice?: number;
  makerPostedSize?: number;
  makerBestBid?: number;
  makerBestAsk?: number;
  makerMidPrice?: number;
  makerSpreadBps?: number;
  makerFillStatus?: 'none' | 'partial' | 'full' | 'timeout' | 'rejected' | 'cancel_unconfirmed' | 'pending';
  makerSharesFilled?: number;
}> {
  const startedAt = Date.now();
  if (!cfg.CLOB_FALLBACK_ENABLED) {
    return { ok: false, error: 'clob_disabled', waitMs: Date.now() - startedAt };
  }

  // --- Empty-book pending order handling ---
  // On each cron cycle, resume polling an existing open order rather than re-posting.
  if (emptyBookMode && redis) {
    const pending = await getPendingOrder(redis, signal.marketId);
    if (pending) {
      if (Date.now() < pending.expiresAt) {
        // Active order from a previous cycle — poll it once and return.
        const order = await getClobOrder(pending.orderId);
        if (order) {
          const matched = parseFloat(order.size_matched ?? '0');
          const original = parseFloat(order.original_size ?? '0');
          if (matched > 0) {
            const isPartial = matched + 1e-9 < original;
            if (isPartial) {
              // Partial fill — cancel the residual open size so it doesn't
              // continue filling untracked on the next cron cycle.
              logger.info('[executor] partial fill on empty-book order — cancelling residual', {
                marketId: signal.marketId,
                orderId: pending.orderId,
                matched,
                original,
              });
              await confirmMakerCancel(pending.orderId);
            }
            await deletePendingOrder(redis, signal.marketId);
            const filledStakeUsd = matched * pending.price;
            return {
              ok: true,
              tradeResult: { success: true, shares_bought: matched },
              filledStakeUsd,
              waitMs: Date.now() - startedAt,
              makerOrderId: pending.orderId,
              makerPostedPrice: pending.price,
              makerPostedSize: pending.size,
              makerFillStatus: isPartial ? 'partial' : 'full',
              makerSharesFilled: matched,
            };
          }
        }
        // Still open — not filled yet on this cycle
        return {
          ok: false,
          error: 'maker_not_filled',
          waitMs: Date.now() - startedAt,
          makerOrderId: pending.orderId,
          makerPostedPrice: pending.price,
          makerPostedSize: pending.size,
          makerFillStatus: 'pending',
        };
      } else {
        // Expired — cancel and fall through to re-post
        logger.info('[executor] empty-book maker order expired — cancelling before re-post', {
          marketId: signal.marketId,
          orderId: pending.orderId,
        });
        await confirmMakerCancel(pending.orderId);
        await deletePendingOrder(redis, signal.marketId);
      }
    }
  }

  const tokenId = clobTokenForSignal(signal);
  if (!tokenId) {
    return {
      ok: false,
      error: 'maker_unavailable:missing_clob_token',
      waitMs: Date.now() - startedAt,
    };
  }

  // In empty-book mode always fetch a fresh YES-token book.
  // The ghost book (bid=0.01/ask=0.99) returned by the prefetched read is stale;
  // the matching engine may have real resting orders. For NO-direction signals the
  // CLOB internally converts BUY NO @ P → SELL YES @ (1-P), so crossing is checked
  // against the YES book regardless of which token we submit on.  Using the YES book
  // as pricing ground truth prevents "order crosses book" post-only rejections.
  const yesTokenId = emptyBookMode ? (signal.clobTokenIds?.[0] ?? tokenId) : tokenId;
  const book = emptyBookMode
    ? (await getClobOrderBook(yesTokenId))
    : (prefetchedBook ?? (await getClobOrderBook(tokenId)));
  if (!book) {
    return { ok: false, error: 'maker_no_orderbook', waitMs: Date.now() - startedAt };
  }

  const bestBid = parseFloat(book.bids[0]?.price ?? '0');
  const bestAsk = parseFloat(book.asks[0]?.price ?? '0');
  const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : null;
  const spreadBps = bestBid > 0 && bestAsk > 0 && mid ? ((bestAsk - bestBid) / mid) * 10000 : null;

  const edgeBps = emptyBookMode ? cfg.MAKER_EMPTY_BOOK_EDGE_BPS : cfg.MAKER_PRICE_EDGE_BPS;
  let fairValue: number | null =
    emptyBookMode && signal.consensusProbability != null
      ? signal.direction === 'YES' || signal.direction === 'UP'
        ? signal.consensusProbability
        : 1 - signal.consensusProbability
      : null;

  // Cap fair value so the submitted price can never cross resting YES-book orders.
  // For YES direction: we BUY YES, price must stay below bestAsk.
  // For NO direction: we BUY NO @ P → SELL YES @ (1-P); (1-P) must stay below
  //   bestBid (the best price someone will BUY YES, i.e., best available YES bid).
  //   Rearranged: P must stay above (1 - bestBid).  We cap from above using
  //   (1 - bestBid - tick) so the complement is just below the YES best bid.
  if (emptyBookMode && fairValue != null) {
    const tick = parseFloat(book.tick_size ?? '0.01');
    if (signal.direction === 'YES' || signal.direction === 'UP') {
      if (bestAsk > 0) fairValue = Math.min(fairValue, bestAsk - tick);
    } else {
      if (bestBid > 0) fairValue = Math.min(fairValue, 1 - bestBid - tick);
    }
  }

  const price = resolveMakerPrice(book, edgeBps, fairValue);
  if (price === null) {
    return {
      ok: false,
      error: 'maker_bad_price',
      waitMs: Date.now() - startedAt,
      makerBestBid: bestBid,
      makerBestAsk: bestAsk,
      ...(mid ? { makerMidPrice: mid } : {}),
      ...(spreadBps ? { makerSpreadBps: spreadBps } : {}),
      makerFillStatus: 'rejected',
    };
  }

  const size = signal.stakeUsd / price;
  const minOrderSize = parseFloat(book.min_order_size ?? '0');
  if (isFinite(minOrderSize) && minOrderSize > 0 && size < minOrderSize) {
    return {
      ok: false,
      error: 'maker_below_min_size',
      waitMs: Date.now() - startedAt,
      makerBestBid: bestBid,
      makerBestAsk: bestAsk,
      ...(mid ? { makerMidPrice: mid } : {}),
      ...(spreadBps ? { makerSpreadBps: spreadBps } : {}),
      makerFillStatus: 'rejected',
    };
  }

  logger.info('[executor] submitting maker order on CLOB', {
    marketId: signal.marketId,
    tokenId,
    price,
    size,
    stakeUsd: signal.stakeUsd,
  });

  const result = await submitClobLimitBuy({
    tokenId,
    price,
    size,
    tickSize: book.tick_size as TickSize,
    negRisk: book.neg_risk,
    orderType: 'GTC',
    postOnly: true,
  });

  if (!result.success || !result.order_id) {
    return {
      ok: false,
      error: result.error ?? 'maker_order_rejected',
      waitMs: Date.now() - startedAt,
      ...(result.order_id ? { makerOrderId: result.order_id } : {}),
      makerPostedPrice: price,
      makerPostedSize: size,
      makerBestBid: bestBid,
      makerBestAsk: bestAsk,
      ...(mid ? { makerMidPrice: mid } : {}),
      ...(spreadBps ? { makerSpreadBps: spreadBps } : {}),
      makerFillStatus: 'rejected',
    };
  }

  // Record trade in governor immediately upon order acceptance (limit orders consume budget)
  await recordGlobalTrade(getRedis(), 'polymarket');

  // In empty-book mode: persist the order and return immediately (non-blocking).
  // The next cron cycle resumes via the idempotency check at the top of this function.
  if (emptyBookMode && redis) {
    const expiresAt = startedAt + cfg.MAKER_EMPTY_BOOK_MAX_WAIT_MS;
    await setPendingOrder(
      redis,
      signal.marketId,
      {
        orderId: result.order_id,
        tokenId,
        price,
        size,
        postedAt: startedAt,
        expiresAt,
        consensusP: signal.consensusProbability ?? 0.5,
        direction: signal.direction,
      },
      Math.ceil(cfg.MAKER_EMPTY_BOOK_MAX_WAIT_MS / 1000) + 300,
    );
    logger.info('[executor] empty-book maker order posted — returning pending', {
      marketId: signal.marketId,
      orderId: result.order_id,
      price,
      expiresAt: new Date(expiresAt).toISOString(),
    });
    return {
      ok: false,
      error: 'maker_not_filled',
      waitMs: Date.now() - startedAt,
      makerOrderId: result.order_id,
      makerPostedPrice: price,
      makerPostedSize: size,
      makerBestBid: bestBid,
      makerBestAsk: bestAsk,
      ...(mid ? { makerMidPrice: mid } : {}),
      ...(spreadBps ? { makerSpreadBps: spreadBps } : {}),
      makerFillStatus: 'pending',
    };
  }

  const maxWaitMs = cfg.MAKER_MAX_WAIT_MS;
  const pollIntervalMs = cfg.MAKER_POLL_INTERVAL_MS;

  if (maxWaitMs <= 0) {
    const cancelled = await confirmMakerCancel(result.order_id);
    if (!cancelled) {
      return {
        ok: false,
        error: 'maker_cancel_unconfirmed',
        waitMs: Date.now() - startedAt,
        makerOrderId: result.order_id,
        makerPostedPrice: price,
        makerPostedSize: size,
        makerBestBid: bestBid,
        makerBestAsk: bestAsk,
        ...(mid ? { makerMidPrice: mid } : {}),
        ...(spreadBps ? { makerSpreadBps: spreadBps } : {}),
        makerFillStatus: 'cancel_unconfirmed',
      };
    }
    return {
      ok: false,
      error: 'maker_not_filled',
      waitMs: Date.now() - startedAt,
      makerOrderId: result.order_id,
      makerPostedPrice: price,
      makerPostedSize: size,
      makerBestBid: bestBid,
      makerBestAsk: bestAsk,
      ...(mid ? { makerMidPrice: mid } : {}),
      ...(spreadBps ? { makerSpreadBps: spreadBps } : {}),
      makerFillStatus: 'timeout',
    };
  }

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const order = await getClobOrder(result.order_id);
    if (!order) break;

    const matched = parseFloat(order.size_matched ?? '0');
    const original = parseFloat(order.original_size ?? '0');
    if (matched > 0) {
      if (isFinite(original) && matched + 1e-9 < original) {
        const cancelled = await confirmMakerCancel(result.order_id);
        if (!cancelled) {
          return {
            ok: false,
            error: 'maker_cancel_unconfirmed',
            waitMs: Date.now() - startedAt,
            makerOrderId: result.order_id,
            makerPostedPrice: price,
            makerPostedSize: size,
            makerBestBid: bestBid,
            makerBestAsk: bestAsk,
            ...(mid ? { makerMidPrice: mid } : {}),
            ...(spreadBps ? { makerSpreadBps: spreadBps } : {}),
            makerFillStatus: 'cancel_unconfirmed',
          };
        }
      }

      if (emptyBookMode && redis) await deletePendingOrder(redis, signal.marketId);
      const filledStakeUsd = matched * price;
      const tradeResult: SimmerTradeResult = {
        success: true,
        shares_bought: matched,
      };
      return {
        ok: true,
        tradeResult,
        filledStakeUsd,
        waitMs: Date.now() - startedAt,
        makerOrderId: result.order_id,
        makerPostedPrice: price,
        makerPostedSize: size,
        makerBestBid: bestBid,
        makerBestAsk: bestAsk,
        ...(mid ? { makerMidPrice: mid } : {}),
        ...(spreadBps ? { makerSpreadBps: spreadBps } : {}),
        makerFillStatus: matched + 1e-9 < original ? 'partial' : 'full',
        makerSharesFilled: matched,
      };
    }

    await sleep(pollIntervalMs);
  }

  if (emptyBookMode && redis) await deletePendingOrder(redis, signal.marketId);
  const cancelled = await confirmMakerCancel(result.order_id);
  if (!cancelled) {
    return {
      ok: false,
      error: 'maker_cancel_unconfirmed',
      waitMs: Date.now() - startedAt,
      makerOrderId: result.order_id,
      makerPostedPrice: price,
      makerPostedSize: size,
      makerBestBid: bestBid,
      makerBestAsk: bestAsk,
      ...(mid ? { makerMidPrice: mid } : {}),
      ...(spreadBps ? { makerSpreadBps: spreadBps } : {}),
      makerFillStatus: 'cancel_unconfirmed',
    };
  }
  return {
    ok: false,
    error: 'maker_not_filled',
    waitMs: Date.now() - startedAt,
    makerOrderId: result.order_id,
    makerPostedPrice: price,
    makerPostedSize: size,
    makerBestBid: bestBid,
    makerBestAsk: bestAsk,
    ...(mid ? { makerMidPrice: mid } : {}),
    ...(spreadBps ? { makerSpreadBps: spreadBps } : {}),
    makerFillStatus: 'timeout',
  };
}

async function tryExecuteViaClob(signal: TradeSignal): Promise<{
  ok: boolean;
  tradeResult?: SimmerTradeResult;
  error?: string;
}> {
  const tokenId = clobTokenForSignal(signal);
  if (!tokenId) {
    return { ok: false, error: 'CLOB fallback unavailable: missing clobTokenIds' };
  }

  logger.info('[executor] attempting CLOB fallback', {
    marketId: signal.marketId,
    tokenId,
    direction: signal.direction,
    stakeUsd: signal.stakeUsd,
  });

  const clobResult = await submitClobBuy({
    tokenId,
    amountUsd: signal.stakeUsd,
  });

  const tradeResult: SimmerTradeResult = {
    success: clobResult.success,
    tx_hash: clobResult.tx_hash,
    shares_bought: clobResult.shares_bought,
    price: clobResult.price,
    cost: clobResult.cost,
    error: clobResult.error,
    raw: clobResult.raw,
  };

  if (clobResult.success) return { ok: true, tradeResult };
  return { ok: false, tradeResult, error: clobResult.error ?? 'CLOB trade failed' };
}

async function executeHyperliquidSignal(
  signal: TradeSignal,
  redis: Redis,
  knownSessionExposureUsd = 0,
): Promise<ExecutionResult> {
  const cfg = loadConfig();
  const hl = getHyperliquid();

  try {
    // 1. Margin & Equity Check — single API call.
    // getOpenPositions() can accept a pre-fetched state to avoid a second round-trip.
    const state = await hl.getClearinghouseState();
    const positions = await hl.getOpenPositions(state);
    if (!state?.marginSummary) {
      logger.warn('[executor] marginSummary missing from clearinghouse state', {
        rawState: JSON.stringify(state).slice(0, 500),
      });
    }
    const accountValue = parseFloat(state?.marginSummary?.accountValue || '0');
    if (accountValue === 0) {
      logger.warn('[executor] account equity resolved to $0 — may indicate API shape change', {
        marginSummary: state?.marginSummary ?? null,
      });
    }

    // Solvency check: basic safety to avoid sending orders that will definitely fail.
    // Real-time margin checks happen on the HL side.
    // Equity floor: require at least FUTURES_MAX_PER_TRADE_USD.
    // $0.01 was effectively meaningless; use a floor that guarantees one trade can execute.
    const equityFloor = cfg.FUTURES_MAX_PER_TRADE_USD;
    if (accountValue < equityFloor) {
      logger.warn('[executor] skipping — account equity below floor', {
        accountValue: accountValue.toFixed(2),
        floor: equityFloor.toFixed(2),
      });
      return { signal, skipped: true, skipReason: 'insufficient_equity' };
    }

    // Check if we're already at the global margin cap.
    // Three-layer accounting prevents double-counting across cron cycles during HL settlement lag:
    //   1. totalCurrentMargin  — live positions confirmed by HL
    //   2. knownSessionExposureUsd — within-batch in-flight orders (passed by caller)
    //   3. pendingMarginUsd — cross-cycle in-flight orders, tracked as a Redis float counter
    //      (INCRBYFLOAT is atomic — concurrent trades add correctly rather than overwriting).
    //      TTL = 30s; once HL reflects the trade, the counter expires naturally.
    const totalCurrentMargin = positions.reduce(
      (sum, p) => sum + parseFloat(p.position.marginUsed || '0'),
      0,
    );
    let pendingMarginUsd = 0;
    try {
      const pendingRaw = await redis.get('hl:pending_margin_usd');
      pendingMarginUsd = pendingRaw ? Math.max(0, parseFloat(pendingRaw)) : 0;
    } catch {
      /* treat as zero on error */
    }

    if (
      totalCurrentMargin + knownSessionExposureUsd + pendingMarginUsd + signal.stakeUsd >
      cfg.FUTURES_GLOBAL_MAX_MARGIN_USD
    ) {
      logger.warn(
        '[executor] skipping — global margin cap exceeded (including pending/session exposure)',
        {
          current: totalCurrentMargin.toFixed(2),
          pending: pendingMarginUsd.toFixed(2),
          session: knownSessionExposureUsd.toFixed(2),
          requested: signal.stakeUsd.toFixed(2),
          cap: cfg.FUTURES_GLOBAL_MAX_MARGIN_USD,
        },
      );
      return { signal, skipped: true, skipReason: 'global_margin_cap' };
    }

    // 1b. Funding-rate gate (Change 4). Shadow-logs skips when disabled.
    try {
      const ctx = await hl.getAssetContext(signal.marketId);
      const hourlyBps = ctx.fundingRate * 10000;
      const signedBps = signal.direction === 'LONG' ? hourlyBps : -hourlyBps;
      if (signedBps > cfg.HL_MAX_ADVERSE_FUNDING_BPS) {
        if (cfg.HL_FUNDING_GATE_ENABLED) {
          logger.info('[hl-funding] funding_adverse block', {
            symbol: signal.marketId,
            direction: signal.direction,
            hourlyBps: hourlyBps.toFixed(4),
            signedBps: signedBps.toFixed(4),
            max: cfg.HL_MAX_ADVERSE_FUNDING_BPS,
          });
          return {
            signal,
            skipped: true,
            skipReason: `funding_adverse:hourlyBps=${hourlyBps.toFixed(4)},dir=${signal.direction}`,
          };
        } else {
          logger.info('[hl-funding] shadow skip', {
            symbol: signal.marketId,
            direction: signal.direction,
            hourlyBps: hourlyBps.toFixed(4),
            signedBps: signedBps.toFixed(4),
            max: cfg.HL_MAX_ADVERSE_FUNDING_BPS,
          });
          void enqueueWrite('shadow_observations', {
            kind: 'hl_funding', source: 'futures',
            symbol: signal.marketId, direction: signal.direction,
            wouldBlock: true, metricValue: Math.abs(signedBps), threshold: cfg.HL_MAX_ADVERSE_FUNDING_BPS,
            payload: { hourlyBps, signedBps, marketId: signal.marketId },
          });
        }
      }
    } catch (err) {
      logger.warn('[hl-funding] ctx fetch failed — proceeding without gate', {
        symbol: signal.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. Submit Order
    logger.info('[executor] submitting Hyperliquid trade', {
      symbol: signal.marketId,
      direction: signal.direction,
      stakeUsd: signal.stakeUsd,
      leverage: signal.leverage || cfg.FUTURES_DEFAULT_LEVERAGE,
    });

    const tradeResult = await hl.placeMarketOrder({
      symbol: signal.marketId,
      isBuy: signal.direction === 'LONG',
      sizeUsd: signal.stakeUsd,
      leverage: signal.leverage || cfg.FUTURES_DEFAULT_LEVERAGE,
    });

    if (tradeResult.success) {
      // Atomically add this trade's stake to the pending counter.
      // INCRBYFLOAT is atomic — concurrent trades accumulate correctly rather than overwriting.
      // TTL is refreshed to 30s; expires naturally once HL reflects the positions.
      try {
        await redis.incrbyfloat('hl:pending_margin_usd', signal.stakeUsd);
        await redis.expire('hl:pending_margin_usd', 30);
      } catch (e: unknown) {
        logger.debug('[executor] failed to record pending margin (non-fatal)', {
          error: String(e),
        });
      }

      // Capture ATR snapshot at entry — drives ATR-based SL/TP in futuresMonitor.
      // Best-effort: if candles aren't available yet, leave undefined and the
      // monitor will fall back to fixed-percent thresholds for this position.
      let entryAtr: number | undefined;
      let entryAtrPct: number | undefined;
      try {
        const atr = await computeATR(signal.marketId, redis);
        if (atr) {
          entryAtr = atr.atr;
          entryAtrPct = atr.atrPct;
          logger.info('[executor] futures entryAtrPct captured', {
            symbol: signal.marketId,
            entryAtrPct: entryAtrPct.toFixed(3),
            wouldBeSlPct: (entryAtrPct * cfg.FUTURES_ATR_SL_MULT).toFixed(3),
            wouldBeTpPct: (entryAtrPct * cfg.FUTURES_ATR_TP_MULT).toFixed(3),
          });
        } else {
          logger.warn('[executor] ATR unavailable at entry — monitor will use fixed SL/TP', {
            symbol: signal.marketId,
          });
        }
      } catch (e: unknown) {
        logger.warn('[executor] ATR computation failed at entry (non-fatal)', {
          symbol: signal.marketId,
          error: e instanceof Error ? e.message : String(e),
        });
      }

      const result: ExecutionResult = {
        signal,
        skipped: false,
        tradeResult: { success: true, tx_hash: tradeResult.txHash, shares_bought: 0 },
        executionVenue: 'hyperliquid',
        modeConfigured: cfg.EXECUTION_MODE,
        entryExecutionPath: 'hyperliquid_fill',
        entryOrderType: 'taker',
        entryPrice: tradeResult.price ?? null,
      };
      if (entryAtr !== undefined) result.entryAtr = entryAtr;
      if (entryAtrPct !== undefined) result.entryAtrPct = entryAtrPct;

      void notifyTradeExecuted(signal, tradeResult.txHash, { venue: 'hyperliquid' }).catch(() => {});

      return result;
    }

    // Treat "too small" as a skip (not an error) — don't send noisy notifications
    // for expected low-stake rejections from Half-Kelly sizing.
    const errMsg = tradeResult.error || 'Hyperliquid order failed';
    if (errMsg.includes('too small for HL minimum') || errMsg.includes('minimum value of')) {
      return { signal, skipped: true, skipReason: 'stake_below_hl_minimum' };
    }

    return {
      signal,
      skipped: false,
      error: errMsg,
      executionVenue: 'hyperliquid',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      signal,
      skipped: false,
      error: `Hyperliquid execution error: ${message}`,
      executionVenue: 'hyperliquid',
    };
  }
}

/**
 * Automatically open an offsetting Short position on HL after a PM YES buy.
 * Only triggers if the signal is NOT already a futures signal.
 */
/** Returns true if the hedge was placed successfully. */
async function triggerDeltaHedge(
  pmSignal: TradeSignal,
  redis: Redis,
  knownSessionExposureUsd = 0,
): Promise<boolean> {
  const cfg = loadConfig();
  if (!cfg.FUTURES_ENABLED || pmSignal.isFutures) return false;

  const hl = getHyperliquid();

  // 1. Margin Check (Added guard)
  try {
    const positions = await hl.getOpenPositions();
    const totalCurrentMargin = positions.reduce(
      (sum, p) => sum + parseFloat(p.position.marginUsed || '0'),
      0,
    );

    // Safety: Account for session exposure to prevent overshooting cap during multi-signal cycles
    if (
      totalCurrentMargin + knownSessionExposureUsd + pmSignal.stakeUsd >
      cfg.FUTURES_GLOBAL_MAX_MARGIN_USD
    ) {
      logger.warn(
        '[executor] skipping delta hedge — global margin cap reached (including session exposure)',
        {
          current: totalCurrentMargin.toFixed(2),
          session: knownSessionExposureUsd.toFixed(2),
          hedge: pmSignal.stakeUsd.toFixed(2),
          cap: cfg.FUTURES_GLOBAL_MAX_MARGIN_USD,
        },
      );
      return false;
    }
  } catch (err) {
    logger.error('[executor] margin check failed for hedge', {
      error: err instanceof Error ? err.message : '[non-Error thrown]',
    });
    return false; // Safety first
  }

  // 2. Identify the correlated asset symbol using shared logic
  const hlSymbol = resolveHlSymbol(pmSignal.question);

  if (!hlSymbol) {
    logger.debug('[executor] no correlated HL asset found for hedge', {
      pmMarketId: pmSignal.marketId,
    });
    return false;
  }

  // 3. Execute 1:1 Delta Hedge — direction opposes the PM position's market exposure.
  //    PM YES on a bullish market → hedge SHORT (protect against drop).
  //    PM NO  on a bullish market → hedge LONG  (protect against rip).
  const isBuyHedge = pmSignal.direction === 'NO';
  const hedgeDirection: 'LONG' | 'SHORT' = isBuyHedge ? 'LONG' : 'SHORT';
  const hedgeStakeUsd = pmSignal.stakeUsd;

  // HL rejects orders below ~$10 notional with HTTP 422. Skip hedge if stake is too small
  // rather than burning an API call that will fail.
  const HL_MIN_ORDER_USD = 10;
  if (hedgeStakeUsd < HL_MIN_ORDER_USD) {
    logger.info('[executor] skipping delta hedge — stake below HL minimum notional', {
      stakeUsd: hedgeStakeUsd,
      minUsd: HL_MIN_ORDER_USD,
    });
    return false;
  }

  logger.info('[executor] opening delta hedge on Hyperliquid', {
    pmMarketId: pmSignal.marketId,
    hlSymbol,
    hedgeDirection,
    stakeUsd: hedgeStakeUsd,
  });

  const result = await hl.placeMarketOrder({
    symbol: hlSymbol,
    isBuy: isBuyHedge,
    sizeUsd: hedgeStakeUsd,
    leverage: 1, // Hedge positions use 1x leverage to maximize safety
  });

  if (result.success) {
    logger.info('[executor] delta hedge successful', { hlSymbol, hedgeDirection, txHash: result.txHash });
    void enqueueWrite('hedge_events', {
      hedgeAction: 'opened',
      hlSymbol,
      hlSize: hedgeStakeUsd,
      raw: { pmMarketId: pmSignal.marketId, txHash: result.txHash ?? null },
    });

    // Record in position ledger so the futures monitor doesn't need to backfill
    await recordPosition(redis, {
      marketId: hlSymbol,
      question: `${hlSymbol} hedge for PM:${pmSignal.marketId}`,
      direction: hedgeDirection,
      entryPrice: result.price ?? 0,
      stakeUsd: hedgeStakeUsd,
      edgeMagnitude: 0,
      sourcedFrom: `hedge:pm:${pmSignal.marketId}`,
      openedAt: new Date().toISOString(),
      txHash: result.txHash,
      executionVenue: 'hyperliquid',
      isFutures: true,
      symbol: hlSymbol,
      synthHedged: true,
    });

    // Notify so the hedge entry is visible alongside the PM trade notification
    void notifyHedgeOpened({
      pmMarketId: pmSignal.marketId,
      pmQuestion: pmSignal.question,
      hlSymbol,
      direction: hedgeDirection,
      stakeUsd: hedgeStakeUsd,
      ...(result.txHash ? { txHash: result.txHash } : {}),
    }).catch(() => { /* best-effort */ });

    // Link the hedge in Redis for tracking
    await redis.set(`hedge:link:${pmSignal.marketId}`, hlSymbol, 'EX', 7 * 24 * 3600);
    return true;
  } else {
    const errMsg = result.error ?? 'unknown error';
    logger.warn('[executor] delta hedge failed', { hlSymbol, error: errMsg });
    void notifyTradeError(
      {
        marketId: pmSignal.marketId,
        question: pmSignal.question,
        direction: pmSignal.direction,
        stakeUsd: pmSignal.stakeUsd,
      } as TradeSignal,
      `Delta hedge failed for ${hlSymbol}: ${errMsg}`,
      { venue: 'hyperliquid' },
    ).catch(() => {
      /* best-effort notification */
    });
    return false;
  }
}

export async function executeSignal(
  signal: TradeSignal,
  redis: Redis,
  knownSessionExposureUsd = 0,
): Promise<ExecutionResult> {
  const cfg = loadConfig();

  // 1. Global Rate Limit Governor (Polymarket only)
  const platform = signal.isFutures ? 'hyperliquid' : 'polymarket';
  const gov = await checkGlobalGovernor(redis, platform);
  if (!gov.ok) {
    logger.info(
      '[executor] skipping — global governor throttle (account-level rate limit safety)',
      {
        marketId: signal.marketId,
        elapsedMs: gov.elapsedMs,
        minIntervalMs: gov.minIntervalMs,
      },
    );
    return { signal, skipped: true, skipReason: 'global_governor' };
  }

  const executionId = createHash('sha256')
    .update(`${signal.marketId}:${signal.direction}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 16);
  const attemptId = randomUUID();
  signal = { ...signal, executionId };
  const decisionStartedAt = Date.now();

  // Latency instrumentation: log end-to-end (event → executor entry) when origin ts is present.
  if (signal.eventTs && Number.isFinite(signal.eventTs) && signal.eventTs > 0) {
    const latencyMs = decisionStartedAt - signal.eventTs;
    if (latencyMs >= 0) {
      logger.info('[executor] arb latency entry', {
        executionId,
        marketId: signal.marketId,
        source: signal.source,
        latencyMs,
      });
      void recordArbLatency(redis, 'executor_entry', latencyMs, {
        executionId,
        source: signal.source,
        isFutures: signal.isFutures ?? false,
      }).catch(() => {});
      void enqueueWrite('arb_latency_samples', {
        stage: 'executor_entry',
        latencyMs: Math.round(latencyMs),
        context: { executionId, source: signal.source, isFutures: signal.isFutures ?? false },
      });
    }
  }
  let makerTelemetry: Record<string, unknown> = {};
  const safeRecordExecutionMetric = (metric: string, label = 'count') => {
    void recordExecutionMetric(redis, metric, label).catch(() => {});
  };
  const safeRecordExecutionTiming = (metric: string, ms: number) => {
    void recordExecutionTiming(redis, metric, ms).catch(() => {});
  };
  const emitExecutionEvent = (payload: Record<string, unknown>) => {
    void recordExecutionEvent(redis, 'execution_attempt', payload).catch(() => {
      safeRecordExecutionMetric('errors', 'telemetry_emit_failed');
    });
  };
  safeRecordExecutionMetric('mode', cfg.EXECUTION_MODE);
  const buildBaseEvent = () => ({
    executionId,
    outcomeLinkId: executionId,
    timestamp: new Date().toISOString(),
    marketId: signal.marketId,
    question: signal.question,
    direction: signal.direction,
    modeConfigured: cfg.EXECUTION_MODE,
    edgeMagnitude: signal.edgeMagnitude,
    consensusProbability: signal.consensusProbability,
    marketProbability: signal.outcomePrice,
    stakeUsdRequested: signal.stakeUsd,
    feesEnabled: signal.feesEnabled ?? false,
    isFutures: signal.isFutures ?? false,
    priceZone: signal.priceZone,
    isTailPrice: isTailPrice(signal.outcomePrice, cfg.TAIL_PRICE_THRESHOLD),
    tailThreshold: cfg.TAIL_PRICE_THRESHOLD,
    takerMinEdge: cfg.TAKER_MIN_EDGE,
    makerMaxWaitMs: cfg.MAKER_MAX_WAIT_MS,
    makerPriceEdgeBps: cfg.MAKER_PRICE_EDGE_BPS,
    makerPollIntervalMs: cfg.MAKER_POLL_INTERVAL_MS,
  });
  const finalizeAttempt = (payload: {
    finalExecutionPath: string;
    finalVenue: 'simmer' | 'clob' | 'hyperliquid' | 'none';
    finalOrderType: 'maker' | 'taker' | 'none';
    executionSucceeded: boolean;
    executionPath?: string;
    skipReason?: string;
    errorClass?: string;
    errorMessage?: string;
    finalSharesFilled?: number | null;
    finalStakeUsdExecuted?: number | null;
    hedgeTriggered?: boolean;
    extra?: Record<string, unknown>;
  }) => {
    const elapsedMs = Date.now() - decisionStartedAt;
    safeRecordExecutionTiming('attempt_total_ms', elapsedMs);
    safeRecordExecutionMetric('final_path', payload.finalExecutionPath);
    emitExecutionEvent({
      ...buildBaseEvent(),
      ...makerTelemetry,
      completedAt: new Date().toISOString(),
      elapsedMs,
      executionPath: payload.executionPath ?? payload.finalExecutionPath,
      finalExecutionPath: payload.finalExecutionPath,
      finalVenue: payload.finalVenue,
      finalOrderType: payload.finalOrderType,
      finalSharesFilled: payload.finalSharesFilled ?? null,
      finalStakeUsdExecuted: payload.finalStakeUsdExecuted ?? null,
      executionSucceeded: payload.executionSucceeded,
      hedgeTriggered: payload.hedgeTriggered ?? false,
      ...(payload.skipReason ? { skipReason: payload.skipReason } : {}),
      ...(payload.errorClass ? { errorClass: payload.errorClass } : {}),
      ...(payload.errorMessage ? { errorMessage: payload.errorMessage } : {}),
      ...(payload.extra ?? {}),
    });
    void enqueueWrite('execution_events', {
      attemptId,
      executionId,
      decisionId: signal.decisionId,
      source: signal.source ?? 'osint',
      marketId: signal.marketId,
      direction: signal.direction,
      finalExecutionPath: payload.finalExecutionPath,
      finalVenue: payload.finalVenue,
      finalOrderType: payload.finalOrderType,
      executionSucceeded: payload.executionSucceeded,
      skipReason: payload.skipReason,
      errorClass: payload.errorClass,
      errorMessage: payload.errorMessage,
      sharesFilled: payload.finalSharesFilled ?? undefined,
      stakeUsdExecuted: payload.finalStakeUsdExecuted ?? undefined,
      elapsedMs: Math.round(elapsedMs),
      ...makerTelemetry,
    });
  };

  // 1) Idempotency check (Moved up to cover all platforms, executes before baseEvent setup)
  const key = idempotencyKey(signal);
  const alreadyFired = await redis.get(key);
  if (alreadyFired) {
    logger.info('[executor] skipping — idempotency key already set', {
      marketId: signal.marketId,
      key,
    });
    safeRecordExecutionMetric('skipped', 'already_executed');
    finalizeAttempt({
      finalExecutionPath: 'skipped',
      finalVenue: 'none',
      finalOrderType: 'none',
      executionSucceeded: false,
      skipReason: 'already_executed',
    });
    return { signal, skipped: true, skipReason: 'already_executed' };
  }

  // 1b) Calibration correction (Phase 8b) — adjust edge before sizing
  const recordSkip = (
    reason: string,
    finalExecutionPath = 'skipped',
    extra?: Record<string, unknown>,
    finalVenue: 'simmer' | 'clob' | 'hyperliquid' | 'none' = 'none',
    finalOrderType: 'maker' | 'taker' | 'none' = 'none',
  ) => {
    safeRecordExecutionMetric('skipped', reason);
    finalizeAttempt({
      finalExecutionPath,
      finalVenue,
      finalOrderType,
      executionSucceeded: false,
      skipReason: reason,
      ...(extra ? { extra } : {}),
    });
    return { signal, skipped: true, skipReason: reason };
  };
  if (cfg.CALIBRATION_ENABLED && !signal.isFutures) {
    try {
      const category = inferCategory(signal.question);
      const cal = await getCalibrationStats(redis, category);
      const correctedEdge = applyCalibrationCorrection(
        signal.edgeMagnitude ?? 0,
        cal,
        cfg.CALIBRATION_MIN_SAMPLES,
      );
      if (cal && correctedEdge !== signal.edgeMagnitude) {
        // Scale stakeUsd proportionally so the correction actually changes trade size.
        const correctionFactor = cal.edgeCorrectionFactor;
        const correctedStake = Math.max(0, signal.stakeUsd * correctionFactor);
        logger.info('[executor] calibration correction applied', {
          category,
          originalEdge: signal.edgeMagnitude,
          correctedEdge,
          originalStake: signal.stakeUsd,
          correctedStake,
          factor: correctionFactor,
        });
        signal = { ...signal, edgeMagnitude: correctedEdge, stakeUsd: correctedStake };
      }
    } catch (err: unknown) {
      logger.warn('[executor] calibration lookup failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2) Route Futures signals to specialized handler
  if (signal.isFutures) {
    // Futures-specific idempotency: key on marketId+direction only (no stakeUsd).
    // The general key hashes stakeUsd so duplicate headlines with slightly different
    // stake would bypass it. Futures dedup window = 1 hour, same as general TTL.
    const futuresDedup = `${IDEMPOTENCY_KEY_PREFIX}futures:${signal.marketId}:${signal.direction}`;
    const alreadyFired = await redis.get(futuresDedup);
    if (alreadyFired) {
      logger.info('[executor] skipping futures — idempotency dedup', {
        marketId: signal.marketId,
        direction: signal.direction,
      });
      return recordSkip('already_executed');
    }

    // Open position check for futures — prevent stacking from multiple signal sources.
    const alreadyHoldingFutures = await hasOpenPosition(redis, signal.marketId, signal.direction);
    if (alreadyHoldingFutures) {
      logger.info('[executor] skipping futures — already holding position', {
        marketId: signal.marketId,
        direction: signal.direction,
      });
      return recordSkip('position_already_open');
    }
    const result = await executeHyperliquidSignal(signal, redis, knownSessionExposureUsd);
    if (result.tradeResult?.success) {
      await redis.set(futuresDedup, '1', 'EX', IDEMPOTENCY_TTL_SECONDS);
      finalizeAttempt({
        finalExecutionPath: 'hyperliquid_fill',
        finalVenue: 'hyperliquid',
        finalOrderType: 'taker',
        executionSucceeded: true,
        finalSharesFilled: result.tradeResult.shares_bought ?? null,
        finalStakeUsdExecuted: signal.stakeUsd,
      });
      return { ...result, entryPrice: result.entryPrice ?? signal.outcomePrice };
    } else if (result.skipped) {
      finalizeAttempt({
        finalExecutionPath: 'skipped',
        finalVenue: 'hyperliquid',
        finalOrderType: 'none',
        executionSucceeded: false,
        ...(result.skipReason ? { skipReason: result.skipReason } : {}),
      });
    } else if (result.error) {
      safeRecordExecutionMetric('errors', 'hyperliquid_execution_failed');
      finalizeAttempt({
        finalExecutionPath: 'error',
        finalVenue: 'hyperliquid',
        finalOrderType: 'taker',
        executionSucceeded: false,
        errorClass: 'hyperliquid_execution_failed',
        errorMessage: result.error,
      });
    }
    return result;
  }

  // 3) Stake floor check (MIN_BET_USD, default $5)
  //    If Kelly suggests a stake ≥ 60% of the floor, bump up to the floor
  //    instead of skipping — the edge exists but sizing is just below minimum.
  const minStake = getMinStake();
  const bumpThreshold = minStake * 0.6;
  if (signal.stakeUsd < bumpThreshold) {
    logger.info('[executor] skipping — stake below floor', {
      marketId: signal.marketId,
      stakeUsd: signal.stakeUsd,
      minBetUsd: minStake,
    });
    return recordSkip('stake_below_floor');
  }
  if (signal.stakeUsd < minStake) {
    logger.info('[executor] bumping stake to floor', {
      marketId: signal.marketId,
      originalStake: signal.stakeUsd,
      minBetUsd: minStake,
    });
    signal.stakeUsd = minStake;
  }

  // 4) Open position check — don't stack into a market we already hold
  const alreadyHolding = await hasOpenPosition(redis, signal.marketId, signal.direction);
  if (alreadyHolding) {
    logger.info('[executor] skipping — already holding position in this market', {
      marketId: signal.marketId,
      direction: signal.direction,
    });
    return recordSkip('position_already_open');
  }

  // 4b) Stale-exit re-entry cooldown — block re-entry into a market we recently
  // exited for staleness. Prevents immediate round-trip after a stale exit.
  // Applies to PM-style signals only; futures skip this path.
  if (!signal.isFutures) {
    const staleCooldown = await isStaleCooldownActive(redis, signal.marketId).catch(
      () => false,
    );
    if (staleCooldown) {
      logger.info('[executor] skipping — stale-exit re-entry cooldown active', {
        marketId: signal.marketId,
        direction: signal.direction,
      });
      return recordSkip('stale_exit_cooldown');
    }
  }

  // 4c) Clean up any expired empty-book pending maker orders for this market.
  // Must run before the spread gate so we don't accidentally try to resume
  // an order whose expiresAt window has already passed.
  {
    const expiredPending = await getPendingOrder(redis, signal.marketId);
    if (expiredPending && Date.now() >= expiredPending.expiresAt) {
      logger.info('[executor] cleaning up expired empty-book maker order before cycle', {
        marketId: signal.marketId,
        orderId: expiredPending.orderId,
        postedAt: expiredPending.postedAt,
        expiresAt: expiredPending.expiresAt,
      });
      try {
        await confirmMakerCancel(expiredPending.orderId);
      } catch {
        // Non-fatal — order may already be cancelled or filled
      }
      await deletePendingOrder(redis, signal.marketId);
    }
  }

  const executionMode = cfg.EXECUTION_MODE;
  const simmerId =
    signal.source === 'crypto-arb' || !cfg.SIMMER_VENUE_ENABLED
      ? null
      : await resolveSimmerMarketId(signal.question);

  // Tracks fee-market state across the routing pipeline. Set when Simmer context
  // reports fees > 0, or inferred from signal.feesEnabled. Used to:
  //   1) skip the Simmer/CLOB taker submit if net-of-fee edge is below threshold
  //   2) preserve maker reachability — maker fills bypass fees and SHOULD be tried
  let feeMarketBpsObserved: number | null = null;

  if (simmerId) {
    // Context safeguard check — flip-flop detection, resolution criteria, market status
    const ctx = await getMarketContext(simmerId, signal.consensusProbability ?? 0.5);
    if (ctx) {
      // Gate 1: market already resolved or closed
      if (ctx.market.status === 'resolved' || ctx.market.status === 'closed') {
        logger.info('[executor] skipping — market already resolved/closed', {
          marketId: signal.marketId,
          status: ctx.market.status,
        });
        return recordSkip(`market_${ctx.market.status}`);
      }

      // Gate 2: Simmer already knows we have a position on this side
      if (ctx.position.has_position && ctx.position.side === signal.direction.toLowerCase()) {
        logger.info('[executor] skipping — Simmer reports existing position', {
          marketId: signal.marketId,
          side: ctx.position.side,
        });
        return recordSkip('simmer_position_exists');
      }

      // Gate 3: severe flip-flop warning — we've been reversing too much on this market
      if (ctx.discipline.warning_level === 'severe') {
        logger.warn('[executor] skipping — severe flip-flop warning from Simmer', {
          marketId: signal.marketId,
          flipFlopWarning: ctx.discipline.flip_flop_warning,
          directionChanges24h: ctx.discipline.direction_changes_24h,
        });
        return recordSkip('flip_flop_severe');
      }

      // Gate 4: detect fee market — DO NOT skip here. Maker fills bypass fees,
      // so we still want to attempt the maker path on fee markets. The fee gate
      // is now applied later, only against the taker fallback (see below).
      if (ctx.market.fee_rate_bps > 0) {
        feeMarketBpsObserved = ctx.market.fee_rate_bps;
        logger.info('[executor] fee market detected — maker still eligible', {
          marketId: signal.marketId,
          feeRateBps: ctx.market.fee_rate_bps,
        });
      }

      logger.info('[executor] context check passed', {
        marketId: signal.marketId,
        warnings: ctx.warnings,
        flipFlopLevel: ctx.discipline.warning_level,
        resolutionCriteria: ctx.market.resolution_criteria?.slice(0, 80),
      });
    } else {
      logger.warn('[executor] context check unavailable — proceeding without safeguards', {
        marketId: signal.marketId,
        simmerId,
      });
    }
  }

  let makerAttempted = false;
  let makerFilled = false;
  let takerPath: 'taker_direct' | 'hybrid_taker_fallback' | null = null;
  let decisionSubmitted = false;
  let clobFallbackReason: string | null = null;
  let takerDecisionBenchmarkPromise: Promise<DecisionBenchmark> | null = null;
  // Prefetched CLOB book: populated by the entry spread guardrail below when
  // active, then handed to the maker path so we don't double-fetch the book.
  let prefetchedClobBook: OrderBookSummary | null = null;
  let emptyBookMakerRoute = false;

  // Entry spread guardrail. Catches degenerate books where "edge" is an artifact
  // of thin liquidity rather than a real mispricing — both wide two-sided books
  // (e.g. $0.01 bid / $0.99 ask → 19600 bps) and one-sided books (missing the
  // bid or ask side, making spread unknowable but execution still dangerous).
  // Runs pre-maker so it short-circuits the maker path too. Copytrade bypasses
  // because the whale already priced the degenerate book.
  // oracle-lag can override via ORACLE_LAG_MAX_ENTRY_SPREAD_BPS (-1 = use global).
  const effectiveSpreadCeiling =
    signal.source === 'oracle-lag' && cfg.ORACLE_LAG_MAX_ENTRY_SPREAD_BPS >= 0
      ? cfg.ORACLE_LAG_MAX_ENTRY_SPREAD_BPS
      : cfg.MAX_ENTRY_SPREAD_BPS;
  if (effectiveSpreadCeiling > 0 && signal.source !== 'copytrade') {
    const { book, benchmark } = await fetchBookAndBenchmark(signal);
    prefetchedClobBook = book;
    takerDecisionBenchmarkPromise = Promise.resolve(benchmark);
    const spreadBps = benchmark.decisionSpreadBps;
    // `=== null` distinguishes "book fetched, side missing" (null) from "book
    // not fetched at all" (undefined — e.g. no CLOB token); only the former
    // should trigger the gate.
    const oneSidedBook =
      benchmark.decisionBestBid === null || benchmark.decisionBestAsk === null;
    const spreadTooWide = spreadBps != null && spreadBps > effectiveSpreadCeiling;
    const guardrailDiagnostic = {
      spreadBps: spreadBps != null ? Math.round(spreadBps) : null,
      threshold: effectiveSpreadCeiling,
      bestBid: benchmark.decisionBestBid,
      bestAsk: benchmark.decisionBestAsk,
    };
    // Benchmark fields (decisionBest*) are schema columns in signal_decisions
    // but not in execution_events, where Zod would strip them. Guardrail
    // diagnostic fields have no schema column at all, so they go under `raw`
    // — the catch-all z.record(z.unknown()) column that survives validation.
    const existingRaw =
      (makerTelemetry.raw as Record<string, unknown> | undefined) ?? {};
    makerTelemetry = {
      ...makerTelemetry,
      ...benchmark,
      raw: { ...existingRaw, entrySpreadGuardrail: guardrailDiagnostic },
    };
    // Detect ghost books: both sides technically present but at wall prices.
    // bid ≈ 0.01 / ask ≈ 0.99 means no real market maker is resting on the book.
    const emptyBook =
      !oneSidedBook &&
      (benchmark.decisionBestBid ?? 1) < cfg.EMPTY_BOOK_BID_THRESHOLD &&
      (benchmark.decisionBestAsk ?? 0) > cfg.EMPTY_BOOK_ASK_THRESHOLD;

    const canEmptyBookMaker =
      emptyBook &&
      executionMode !== 'taker' &&
      !signal.isFutures &&
      isMakerEligible(signal);

    if (oneSidedBook) {
      logger.info('[executor] skipping — entry spread unknown due to one-sided book', {
        marketId: signal.marketId,
        ...guardrailDiagnostic,
      });
      return recordSkip('one_sided_book', 'skipped', guardrailDiagnostic);
    }
    if (emptyBook && !canEmptyBookMaker) {
      // Ghost book but can't use maker (taker mode or ineligible source)
      logger.info('[executor] skipping — empty CLOB book, cannot route to maker', {
        marketId: signal.marketId,
        ...guardrailDiagnostic,
      });
      return recordSkip('no_clob_book', 'skipped', guardrailDiagnostic);
    }
    if (!emptyBook && spreadTooWide) {
      logger.info('[executor] skipping — entry spread too wide', {
        marketId: signal.marketId,
        ...guardrailDiagnostic,
      });
      return recordSkip('spread_too_wide', 'skipped', guardrailDiagnostic);
    }
    if (canEmptyBookMaker) {
      emptyBookMakerRoute = true;
      logger.info('[executor] empty book — routing to fair-value maker', {
        marketId: signal.marketId,
        consensusP: signal.consensusProbability,
        direction: signal.direction,
        ...guardrailDiagnostic,
      });
    }
  }

  // Maker eligibility: subset of signals where alpha doesn't decay in seconds.
  // Fee markets ARE eligible — maker fills bypass fees entirely, so attempting
  // maker on a fee market is strictly better than the previous behavior of
  // skipping the trade outright.
  const makerEligible =
    (executionMode !== 'taker' && !signal.isFutures && isMakerEligible(signal))
    || emptyBookMakerRoute;
  if (executionMode !== 'taker' && !signal.isFutures && !makerEligible) {
    logger.info('[executor] maker skipped — signal source not maker-eligible', {
      marketId: signal.marketId,
      source: signal.source ?? 'undefined',
    });
  }
  if (makerEligible) {
    makerAttempted = true;
    if (!decisionSubmitted) {
      decisionSubmitted = true;
      safeRecordExecutionTiming('decision_to_submit_ms', Date.now() - decisionStartedAt);
    }
    safeRecordExecutionMetric('maker_attempted');
    logger.info('[executor] maker attempt', {
      marketId: signal.marketId,
      source: signal.source,
      edgeMagnitude: signal.edgeMagnitude,
      stakeUsd: signal.stakeUsd,
      emptyBook: emptyBookMakerRoute,
      ...(emptyBookMakerRoute
        ? { maxWaitMs: cfg.MAKER_EMPTY_BOOK_MAX_WAIT_MS, edgeBps: cfg.MAKER_EMPTY_BOOK_EDGE_BPS }
        : { maxWaitMs: cfg.MAKER_MAX_WAIT_MS, priceEdgeBps: cfg.MAKER_PRICE_EDGE_BPS }),
      feeMarket: feeMarketBpsObserved != null || signal.feesEnabled === true,
    });
    const makerAttempt = await tryExecuteViaClobMaker(
      signal,
      cfg,
      prefetchedClobBook,
      emptyBookMakerRoute,
      redis,
    );
    safeRecordExecutionTiming('maker_wait_ms', makerAttempt.waitMs);
    const makerBenchmark: DecisionBenchmark = {
      decisionBestBid: makerAttempt.makerBestBid ?? null,
      decisionBestAsk: makerAttempt.makerBestAsk ?? null,
      decisionMidPrice: makerAttempt.makerMidPrice ?? null,
      decisionSpreadBps: makerAttempt.makerSpreadBps ?? null,
      counterfactualImmediateTakerPrice: makerAttempt.makerBestAsk ?? null,
      counterfactualImmediateTakerShares: makerAttempt.makerBestAsk
        ? signal.stakeUsd / makerAttempt.makerBestAsk
        : null,
      counterfactualImmediateTakerCostUsd: makerAttempt.makerBestAsk ? signal.stakeUsd : null,
    };
    makerTelemetry = {
      makerAttempted: true,
      makerOrderId: makerAttempt.makerOrderId ?? null,
      makerPostedPrice: makerAttempt.makerPostedPrice ?? null,
      makerPostedSize: makerAttempt.makerPostedSize ?? null,
      makerOrderAccepted: makerAttempt.ok && makerAttempt.tradeResult?.success === true,
      makerWaitMs: makerAttempt.waitMs,
      makerFillStatus: makerAttempt.makerFillStatus ?? 'none',
      makerSharesFilled: makerAttempt.makerSharesFilled ?? null,
      makerFilledStakeUsd: makerAttempt.filledStakeUsd ?? null,
      makerCancelConfirmed: makerAttempt.makerFillStatus === 'cancel_unconfirmed' ? false : null,
      ...makerBenchmark,
    };
    // Empty-book order posted — not filled yet. Return non-skip so the idempotency
    // key is NOT set (we want to resume on the next cron cycle).
    if (makerAttempt.makerFillStatus === 'pending') {
      logger.info('[executor] empty-book maker order pending — will resume on next cycle', {
        marketId: signal.marketId,
        orderId: makerAttempt.makerOrderId,
        postedPrice: makerAttempt.makerPostedPrice,
      });
      finalizeAttempt({
        executionPath: 'maker_pending',
        finalExecutionPath: 'maker_pending',
        finalVenue: 'clob',
        finalOrderType: 'maker',
        finalSharesFilled: null,
        finalStakeUsdExecuted: null,
        executionSucceeded: false,
        hedgeTriggered: false,
      });
      return {
        signal,
        skipped: false,
        executionVenue: 'clob',
        modeConfigured: cfg.EXECUTION_MODE,
        entryExecutionPath: 'maker_pending',
        entryOrderType: 'maker',
        entryPrice: makerAttempt.makerPostedPrice ?? null,
        sharesFilled: null,
        decisionBenchmark: makerTelemetry as DecisionBenchmark,
        hedgeDispatched: false,
      };
    }

    if (makerAttempt.ok && makerAttempt.tradeResult?.success) {
      if (
        makerAttempt.filledStakeUsd &&
        makerAttempt.filledStakeUsd > 0 &&
        makerAttempt.filledStakeUsd !== signal.stakeUsd
      ) {
        signal = { ...signal, stakeUsd: makerAttempt.filledStakeUsd };
      }

      makerFilled = true;
      Object.assign(
        makerTelemetry,
        calculateMakerPriceImprovement(
          makerBenchmark.counterfactualImmediateTakerPrice,
          makerAttempt.makerPostedPrice,
          makerAttempt.tradeResult.shares_bought ?? makerAttempt.makerSharesFilled ?? null,
        ),
      );
      safeRecordExecutionMetric('maker_filled');
      await redis.set(key, '1', 'EX', IDEMPOTENCY_TTL_SECONDS);
      if (makerTelemetry.makerFillStatus === 'partial') {
        safeRecordExecutionMetric('maker_partial_fill');
      } else {
        safeRecordExecutionMetric('maker_full_fill');
      }
      logger.info('[executor] maker fill', {
        marketId: signal.marketId,
        stakeUsd: signal.stakeUsd,
        sharesFilled: makerAttempt.tradeResult.shares_bought,
        postedPrice: makerAttempt.makerPostedPrice,
        priceImprovementBps: makerTelemetry.makerPriceImprovementBps ?? null,
        priceImprovementUsd: makerTelemetry.makerPriceImprovementUsd ?? null,
        waitMs: makerAttempt.waitMs,
        fillStatus: makerTelemetry.makerFillStatus,
      });
      void notifyTradeExecuted(signal, undefined, {
        venue: 'clob',
        ...(makerAttempt.tradeResult.shares_bought != null && {
          sharesFilled: makerAttempt.tradeResult.shares_bought,
        }),
      }).catch(() => {});

      void triggerDeltaHedge(signal, redis, knownSessionExposureUsd).catch((err) => {
        logger.warn('[executor] delta hedge async error (non-fatal)', {
          marketId: signal.marketId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      void enqueueWrite('maker_telemetry', {
        attemptId,
        executionId,
        marketId: signal.marketId,
        direction: signal.direction,
        side: 'entry',
        makerAttempted: true,
        makerOrderId: makerTelemetry.makerOrderId ?? null,
        makerPostedPrice: makerTelemetry.makerPostedPrice ?? null,
        makerPostedSize: makerTelemetry.makerPostedSize ?? null,
        makerWaitMs: makerTelemetry.makerWaitMs,
        makerFillStatus: makerTelemetry.makerFillStatus,
        makerCancelConfirmed: makerTelemetry.makerCancelConfirmed ?? null,
        makerPriceImprovementBps: makerTelemetry.makerPriceImprovementBps ?? null,
        makerPriceImprovementUsd: makerTelemetry.makerPriceImprovementUsd ?? null,
        raw: {
          makerSharesFilled: makerTelemetry.makerSharesFilled ?? null,
          makerFilledStakeUsd: makerTelemetry.makerFilledStakeUsd ?? null,
        },
      });

      finalizeAttempt({
        executionPath: 'maker_fill',
        finalExecutionPath:
          makerTelemetry.makerFillStatus === 'partial' ? 'maker_partial_fill' : 'maker_fill',
        finalVenue: 'clob',
        finalOrderType: 'maker',
        finalSharesFilled: makerAttempt.tradeResult.shares_bought ?? null,
        finalStakeUsdExecuted: signal.stakeUsd,
        executionSucceeded: true,
        hedgeTriggered: true,
      });
      return {
        signal,
        skipped: false,
        tradeResult: makerAttempt.tradeResult,
        executionVenue: 'clob',
        modeConfigured: cfg.EXECUTION_MODE,
        entryExecutionPath:
          makerTelemetry.makerFillStatus === 'partial' ? 'maker_partial_fill' : 'maker_fill',
        entryOrderType: 'maker',
        entryPrice: makerAttempt.makerPostedPrice ?? null,
        sharesFilled: makerAttempt.makerSharesFilled ?? null,
        decisionBenchmark: makerTelemetry as DecisionBenchmark,
        hedgeDispatched: true,
      };
    }

    // Maker did not fill — emit telemetry for the failed attempt
    void enqueueWrite('maker_telemetry', {
      attemptId,
      executionId,
      marketId: signal.marketId,
      direction: signal.direction,
      side: 'entry',
      makerAttempted: true,
      makerOrderId: makerTelemetry.makerOrderId ?? null,
      makerPostedPrice: makerTelemetry.makerPostedPrice ?? null,
      makerPostedSize: makerTelemetry.makerPostedSize ?? null,
      makerWaitMs: makerTelemetry.makerWaitMs,
      makerFillStatus: makerTelemetry.makerFillStatus,
      makerCancelConfirmed: makerTelemetry.makerCancelConfirmed ?? null,
      makerPriceImprovementBps: null,
      makerPriceImprovementUsd: null,
      raw: { makerSharesFilled: null, makerFilledStakeUsd: null },
    });

    if (makerAttempt.makerFillStatus === 'timeout') {
      safeRecordExecutionMetric('maker_timeout');
    } else if (makerAttempt.makerFillStatus === 'rejected') {
      safeRecordExecutionMetric('maker_rejected');
    } else if (makerAttempt.makerFillStatus === 'cancel_unconfirmed') {
      safeRecordExecutionMetric('maker_cancel_uncertain');
    }

    // Empty-book orders that timeout have no taker path — the book is still empty.
    if (emptyBookMakerRoute) {
      logger.info('[executor] empty-book maker timed out — no taker fallback (book still empty)', {
        marketId: signal.marketId,
        fillStatus: makerAttempt.makerFillStatus,
      });
      return recordSkip('no_clob_book', 'maker_timeout', makerTelemetry, 'clob', 'maker');
    }

    if (executionMode === 'hybrid') {
      logger.info('[executor] maker did not fill — taker fallback', {
        marketId: signal.marketId,
        fillStatus: makerAttempt.makerFillStatus ?? 'none',
        reason: makerAttempt.error ?? 'maker_not_filled',
        waitMs: makerAttempt.waitMs,
      });
    }

    if (executionMode === 'maker') {
      logger.info('[executor] maker mode — no taker fallback', {
        marketId: signal.marketId,
        reason: makerAttempt.error ?? 'maker_not_filled',
      });
      const finalExecutionPath =
        makerAttempt.makerFillStatus === 'timeout'
          ? 'maker_timeout'
          : makerAttempt.makerFillStatus === 'rejected'
            ? 'maker_rejected'
            : makerAttempt.makerFillStatus === 'cancel_unconfirmed'
              ? 'maker_cancel_uncertain'
              : 'maker_error';
      return recordSkip(
        makerAttempt.error ?? 'maker_not_filled',
        finalExecutionPath,
        makerTelemetry,
        'clob',
        'maker',
      );
    }
  }

  // Net-of-fees gate for the TAKER fallback path. Maker bypasses fees, so this
  // gate only fires AFTER the maker attempt has been skipped or has failed.
  // We skip taker entirely if the post-fee edge wouldn't justify the trade.
  const isFeeMarket = feeMarketBpsObserved != null || signal.feesEnabled === true;
  if (isFeeMarket && (executionMode === 'hybrid' || executionMode === 'taker')) {
    const grossEdge = signal.edgeMagnitude ?? 0;
    const netEdge = netOfFeesEdge(grossEdge, feeMarketBpsObserved, cfg.FEE_MARKET_DEFAULT_BPS);
    if (netEdge < cfg.FEE_MARKET_MIN_NET_EDGE) {
      logger.info('[executor] skipping taker on fee market — net edge below threshold', {
        marketId: signal.marketId,
        grossEdge,
        netEdge,
        feeBps: feeMarketBpsObserved ?? cfg.FEE_MARKET_DEFAULT_BPS,
        threshold: cfg.FEE_MARKET_MIN_NET_EDGE,
        makerAttempted,
      });
      return recordSkip('fee_market_net_edge_below_threshold');
    }
  }

  if (executionMode === 'hybrid' || executionMode === 'taker') {
    const takerGate = canExecuteTaker(signal, cfg);
    if (!takerGate.ok) {
      logger.info('[executor] skipping — taker gate blocked', {
        marketId: signal.marketId,
        reason: takerGate.reason,
      });
      return recordSkip(takerGate.reason);
    }
  }

  // 5) Try Simmer first (gated by SIMMER_VENUE_ENABLED — when off, simmerId is
  // null upstream so we route directly to CLOB below)

  if (simmerId) {
    takerPath =
      executionMode === 'taker'
        ? 'taker_direct'
        : makerAttempted && !makerFilled
          ? 'hybrid_taker_fallback'
          : 'taker_direct';
    takerDecisionBenchmarkPromise ??= captureDecisionBenchmark(signal);
    if (takerPath === 'taker_direct') {
      safeRecordExecutionMetric('taker_direct');
    } else {
      safeRecordExecutionMetric('taker_fallback');
    }
    logger.info('[executor] submitting trade via Simmer', {
      marketId: signal.marketId,
      simmerId,
      direction: signal.direction,
      stakeUsd: signal.stakeUsd,
      edgeMagnitude: signal.edgeMagnitude,
      consensusP: signal.consensusProbability,
    });

    if (!decisionSubmitted) {
      decisionSubmitted = true;
      safeRecordExecutionTiming('decision_to_submit_ms', Date.now() - decisionStartedAt);
    }
    try {
      const tradeResult = await submitTrade({
        market_id: simmerId,
        side: signal.direction === 'YES' || signal.direction === 'UP' ? 'yes' : 'no',
        amount: signal.stakeUsd,
        reasoning: `OSINT signal: "${signal.sourcedFrom}" — consensus P=${signal.consensusProbability?.toFixed(2) ?? 'N/A'}, market P=${signal.outcomePrice.toFixed(2)}, edge=${signal.edgeMagnitude.toFixed(2)}. ${signal.reasoning}`,
      });

      if (tradeResult.success) {
        // Record trade in governor (Polymarket order bucket)
        await recordGlobalTrade(redis, 'polymarket');
        makerTelemetry = { ...makerTelemetry, ...(await takerDecisionBenchmarkPromise) };
        await redis.set(key, '1', 'EX', IDEMPOTENCY_TTL_SECONDS);
        finalizeAttempt({
          executionPath: takerPath ?? 'taker_direct',
          finalExecutionPath: takerPath ?? 'taker_direct',
          finalVenue: 'simmer',
          finalOrderType: 'taker',
          finalSharesFilled: tradeResult.shares_bought ?? null,
          finalStakeUsdExecuted: signal.stakeUsd,
          executionSucceeded: true,
          hedgeTriggered: true,
        });
        logger.info('[executor] trade submitted successfully via Simmer', {
          marketId: signal.marketId,
          txHash: tradeResult.tx_hash,
        });
        void notifyTradeExecuted(signal, tradeResult.tx_hash, {
          venue: 'simmer',
          ...(tradeResult.shares_bought != null && { sharesFilled: tradeResult.shares_bought }),
        }).catch(() => {});

        // Fire-and-forget the delta hedge — do not block PM trade confirmation on HL latency.
        // hedgeDispatched is reported as true optimistically; errors are logged inside triggerDeltaHedge.
        void triggerDeltaHedge(signal, redis, knownSessionExposureUsd).catch((err: unknown) => {
          logger.warn('[executor] delta hedge async error (non-fatal)', {
            marketId: signal.marketId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        const exeResult: ExecutionResult = {
          signal,
          skipped: false,
          tradeResult,
          executionVenue: 'simmer',
          modeConfigured: cfg.EXECUTION_MODE,
          entryExecutionPath: takerPath ?? 'taker_direct',
          entryOrderType: 'taker',
          entryPrice: tradeResult.price ?? signal.outcomePrice,
          sharesFilled: tradeResult.shares_bought ?? null,
          decisionBenchmark: makerTelemetry as DecisionBenchmark,
          hedgeDispatched: true,
        };
        return exeResult;
      }

      // Simmer returned success=false — fall back to CLOB for recoverable rejections
      // (market not found, order too small for Simmer's 5-share minimum)
      if (!shouldFallbackToClob(tradeResult.error)) {
        makerTelemetry = { ...makerTelemetry, ...(await takerDecisionBenchmarkPromise) };
        logger.warn('[executor] Simmer trade returned success=false', {
          marketId: signal.marketId,
          error: tradeResult.error,
        });
        safeRecordExecutionMetric('errors', 'simmer_trade_failed');
        finalizeAttempt({
          executionPath: takerPath ?? 'taker_direct',
          finalExecutionPath: 'error',
          finalVenue: 'simmer',
          finalOrderType: 'taker',
          executionSucceeded: false,
          errorClass: 'simmer_trade_failed',
          errorMessage: tradeResult.error ?? 'Simmer trade failed',
        });
        return {
          signal,
          skipped: false,
          tradeResult,
          executionVenue: 'simmer',
          modeConfigured: cfg.EXECUTION_MODE,
          entryExecutionPath: takerPath ?? 'taker_direct',
          entryOrderType: 'taker',
          decisionBenchmark: makerTelemetry as DecisionBenchmark,
        };
      }

      logger.warn('[executor] Simmer rejected — attempting CLOB fallback', {
        marketId: signal.marketId,
        error: tradeResult.error,
      });
      clobFallbackReason = isMarketNotFoundMessage(tradeResult.error)
        ? 'simmer_market_not_found'
        : 'simmer_order_too_small';
    } catch (err: unknown) {
      const message =
        err instanceof SimmerError
          ? `HTTP ${err.statusCode.toString()}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);

      // Only fall back on recoverable Simmer failures
      if (!shouldFallbackToClob(message)) {
        makerTelemetry = { ...makerTelemetry, ...(await takerDecisionBenchmarkPromise) };
        logger.error('[executor] Simmer submission failed', {
          marketId: signal.marketId,
          error: message,
        });
        safeRecordExecutionMetric('errors', 'simmer_submit_failed');
        finalizeAttempt({
          executionPath: takerPath ?? 'taker_direct',
          finalExecutionPath: 'error',
          finalVenue: 'simmer',
          finalOrderType: 'taker',
          executionSucceeded: false,
          errorClass: 'simmer_submit_failed',
          errorMessage: message,
        });
        return {
          signal,
          skipped: false,
          error: message,
          executionVenue: 'simmer',
          modeConfigured: cfg.EXECUTION_MODE,
          entryExecutionPath: takerPath ?? 'taker_direct',
          entryOrderType: 'taker',
          decisionBenchmark: makerTelemetry as DecisionBenchmark,
        };
      }

      logger.warn('[executor] Simmer market unavailable (exception); attempting CLOB fallback', {
        marketId: signal.marketId,
        error: message,
      });
      clobFallbackReason = isMarketNotFoundMessage(message)
        ? 'simmer_market_not_found'
        : 'simmer_order_too_small';
    }
  } else if (!cfg.SIMMER_VENUE_ENABLED && signal.source !== 'crypto-arb') {
    logger.info('[executor] SIMMER_VENUE_ENABLED=false; routing direct to CLOB', {
      marketId: signal.marketId,
    });
    safeRecordExecutionMetric('venue_skipped', 'simmer_disabled');
    clobFallbackReason = 'simmer_disabled';
  } else {
    logger.info('[executor] market not in Simmer catalogue; attempting CLOB fallback', {
      marketId: signal.marketId,
      question: signal.question,
    });
    clobFallbackReason = 'simmer_market_missing';
  }

  // 6) Fee gate for CLOB fallback — already enforced by the earlier net-edge
  // gate when feeMarketBpsObserved was set via Simmer context. This check covers
  // the case where the signal carries `feesEnabled=true` but Simmer context was
  // unavailable (so feeMarketBpsObserved is null and the earlier gate didn't fire).
  if (signal.feesEnabled === true && feeMarketBpsObserved == null) {
    const grossEdge = signal.edgeMagnitude ?? 0;
    const netEdge = netOfFeesEdge(grossEdge, null, cfg.FEE_MARKET_DEFAULT_BPS);
    if (netEdge < cfg.FEE_MARKET_MIN_NET_EDGE) {
      logger.info('[executor] skipping CLOB — fee market net edge below threshold', {
        marketId: signal.marketId,
        grossEdge,
        netEdge,
        threshold: cfg.FEE_MARKET_MIN_NET_EDGE,
      });
      return recordSkip('fee_market_net_edge_below_threshold', 'skipped', undefined, 'clob', 'taker');
    }
  }

  // 7) CLOB fallback
  if (!decisionSubmitted) {
    decisionSubmitted = true;
    safeRecordExecutionTiming('decision_to_submit_ms', Date.now() - decisionStartedAt);
  }
  takerDecisionBenchmarkPromise ??= captureDecisionBenchmark(signal);
  if (clobFallbackReason) {
    safeRecordExecutionMetric('clob_fallback', clobFallbackReason);
  }
  const clob = await tryExecuteViaClob(signal);
  makerTelemetry = { ...makerTelemetry, ...(await takerDecisionBenchmarkPromise) };
  if (clob.ok && clob.tradeResult?.success) {
    const tradeResult = clob.tradeResult;
    // Record trade in governor (Polymarket order bucket)
    await recordGlobalTrade(redis, 'polymarket');
    await redis.set(key, '1', 'EX', IDEMPOTENCY_TTL_SECONDS);
    safeRecordExecutionMetric('clob_fallback_success', clobFallbackReason ?? 'direct');
    finalizeAttempt({
      executionPath: clobFallbackReason ? 'clob_fallback' : 'clob_direct',
      finalExecutionPath: 'clob_fallback',
      finalVenue: 'clob',
      finalOrderType: 'taker',
      finalSharesFilled: tradeResult.shares_bought ?? null,
      finalStakeUsdExecuted: signal.stakeUsd,
      executionSucceeded: true,
      hedgeTriggered: true,
      ...(clobFallbackReason ? { extra: { fallbackReason: clobFallbackReason } } : {}),
    });
    logger.info('[executor] trade submitted successfully via CLOB fallback', {
      marketId: signal.marketId,
      txHash: tradeResult.tx_hash,
    });
    void notifyTradeExecuted(signal, tradeResult.tx_hash).catch(() => {});
    // Fire-and-forget the delta hedge — do not block CLOB trade confirmation on HL latency.
    void triggerDeltaHedge(signal, redis, knownSessionExposureUsd).catch((err: unknown) => {
      logger.warn('[executor] delta hedge async error (non-fatal)', {
        marketId: signal.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return {
      signal,
      skipped: false,
      tradeResult,
      executionVenue: 'clob',
      modeConfigured: cfg.EXECUTION_MODE,
      entryExecutionPath: clobFallbackReason ? 'clob_fallback' : 'clob_direct',
      entryOrderType: 'taker',
      decisionBenchmark: makerTelemetry as DecisionBenchmark,
      fallbackReason: clobFallbackReason ?? null,
      hedgeDispatched: true,
      entryPrice: tradeResult.price ?? signal.outcomePrice,
      sharesFilled: tradeResult.shares_bought ?? null,
    };
  }

  const fallbackError = clob.error ?? 'CLOB fallback failed';
  safeRecordExecutionMetric('errors', 'clob_fallback_failed');
  finalizeAttempt({
    executionPath: clobFallbackReason ? 'clob_fallback' : 'clob_direct',
    finalExecutionPath: 'error',
    finalVenue: 'clob',
    finalOrderType: 'taker',
    executionSucceeded: false,
    errorClass: 'clob_fallback_failed',
    errorMessage: fallbackError,
    ...(clobFallbackReason ? { extra: { fallbackReason: clobFallbackReason } } : {}),
  });
  logger.error('[executor] CLOB fallback failed', {
    marketId: signal.marketId,
    error: fallbackError,
  });

  return {
    signal,
    skipped: false,
    ...(clob.tradeResult ? { tradeResult: clob.tradeResult } : {}),
    error: fallbackError,
    executionVenue: 'clob',
    modeConfigured: cfg.EXECUTION_MODE,
    entryExecutionPath: clobFallbackReason ? 'clob_fallback' : 'clob_direct',
    entryOrderType: 'taker',
    decisionBenchmark: makerTelemetry as DecisionBenchmark,
    fallbackReason: clobFallbackReason ?? undefined,
  };
}

export async function executeSignals(
  signals: TradeSignal[],
  redis: Redis,
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];
  let sessionExposureUsd = 0;

  for (const signal of signals) {
    const result = await executeSignal(signal, redis, sessionExposureUsd);

    // If trade succeeded on HL, track margin so subsequent margin checks account for API lag.
    // Do NOT add hedgeDispatched to session exposure — the hedge is fire-and-forget and may
    // not have executed; adding it optimistically would cause false margin-cap rejections.
    // The hedge's margin will appear in the next cycle's live positions from HL.
    if (result.tradeResult?.success && result.executionVenue === 'hyperliquid') {
      sessionExposureUsd += result.signal.stakeUsd;
    }

    results.push(result);
  }
  return results;
}
