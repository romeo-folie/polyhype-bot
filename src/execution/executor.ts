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

import { createHash } from 'node:crypto';
import { logger } from '../shared/logger.js';
import { submitTrade, resolveSimmerMarketId, getMarketContext, SimmerError } from '../shared/simmer.js';
import { submitClobBuy, getClobOrderBook, submitClobLimitBuy, getClobOrder, cancelClobOrder } from '../shared/clob.js';
import { hasOpenPosition } from './positionLedger.js';
import { getHyperliquid, resolveHlSymbol } from '../shared/hyperliquid.js';
import { loadConfig } from '../shared/config.js';
import { getCalibrationStats, applyCalibrationCorrection } from '../shared/calibration.js';
import { inferCategory } from '../shared/outcomeRecorder.js';
import { recordExecutionMetric, recordExecutionTiming, recordExecutionEvent } from '../shared/telemetry.js';
import { notifyTradeError, notifyTradeExecuted } from './telegram.js';
import type { SimmerTradeResult } from '../shared/simmer.js';
import type { TickSize } from '@polymarket/clob-client';
import type { Redis } from 'ioredis';
import type { TradeSignal } from '../mapping/index.js';

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
  /** True if a delta hedge was placed on HL for this trade. */
  hedgeDispatched?: boolean;
}

function idempotencyKey(signal: TradeSignal): string {
  const canonical = `${signal.marketId}:${signal.direction}:${signal.stakeUsd.toFixed(2)}`;
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `${IDEMPOTENCY_KEY_PREFIX}${hash}`;
}

function clobTokenForSignal(signal: TradeSignal): string | null {
  if (signal.direction === 'YES') return signal.clobTokenIds?.[0] ?? null;
  return signal.clobTokenIds?.[1] ?? null;
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

function canExecuteTaker(
  signal: TradeSignal,
  cfg: ReturnType<typeof loadConfig>,
): { ok: true } | { ok: false; reason: string } {
  const edge = signal.edgeMagnitude ?? 0;
  if (edge < cfg.TAKER_MIN_EDGE) {
    return { ok: false, reason: 'taker_edge_below_min' };
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

function resolveMakerPrice(book: { bids: Array<{ price: string }>; asks: Array<{ price: string }>; tick_size: string }, priceEdgeBps: number): number | null {
  const tick = parseFloat(book.tick_size);
  if (!isFinite(tick) || tick <= 0) return null;

  const bestBid = parseFloat(book.bids?.[0]?.price ?? '0');
  const bestAsk = parseFloat(book.asks?.[0]?.price ?? '0');
  const improvement = priceEdgeBps / 10_000;

  let price = bestBid > 0 ? bestBid + improvement : 0;
  if (price <= 0 && bestAsk > 0) {
    price = bestAsk - tick;
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
): Promise<{ ok: boolean; tradeResult?: SimmerTradeResult; error?: string; filledStakeUsd?: number; waitMs: number; makerOrderId?: string; makerPostedPrice?: number; makerPostedSize?: number; makerBestBid?: number; makerBestAsk?: number; makerMidPrice?: number; makerSpreadBps?: number; makerFillStatus?: 'none' | 'partial' | 'full' | 'timeout' | 'rejected' | 'cancel_unconfirmed'; makerSharesFilled?: number }> {
  const startedAt = Date.now();
  if (!cfg.CLOB_FALLBACK_ENABLED) {
    return { ok: false, error: 'clob_disabled', waitMs: Date.now() - startedAt };
  }

  const tokenId = clobTokenForSignal(signal);
  if (!tokenId) {
    return { ok: false, error: 'maker_unavailable:missing_clob_token', waitMs: Date.now() - startedAt };
  }

  const book = await getClobOrderBook(tokenId);
  if (!book) {
    return { ok: false, error: 'maker_no_orderbook', waitMs: Date.now() - startedAt };
  }

  const bestBid = parseFloat(book.bids?.[0]?.price ?? '0');
  const bestAsk = parseFloat(book.asks?.[0]?.price ?? '0');
  const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : null;
  const spreadBps = bestBid > 0 && bestAsk > 0 && mid ? ((bestAsk - bestBid) / mid) * 10000 : null;

  const price = resolveMakerPrice(book, cfg.MAKER_PRICE_EDGE_BPS);
  if (price === null) {
    return { ok: false, error: 'maker_bad_price', waitMs: Date.now() - startedAt, makerBestBid: bestBid, makerBestAsk: bestAsk, ...(mid ? { makerMidPrice: mid } : {}), ...(spreadBps ? { makerSpreadBps: spreadBps } : {}), makerFillStatus: 'rejected' };
  }

  const size = signal.stakeUsd / price;
  const minOrderSize = parseFloat(book.min_order_size ?? '0');
  if (isFinite(minOrderSize) && minOrderSize > 0 && size < minOrderSize) {
    return { ok: false, error: 'maker_below_min_size', waitMs: Date.now() - startedAt, makerBestBid: bestBid, makerBestAsk: bestAsk, ...(mid ? { makerMidPrice: mid } : {}), ...(spreadBps ? { makerSpreadBps: spreadBps } : {}), makerFillStatus: 'rejected' };
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
    return { ok: false, error: result.error ?? 'maker_order_rejected', waitMs: Date.now() - startedAt, ...(result.order_id ? { makerOrderId: result.order_id } : {}), makerPostedPrice: price, makerPostedSize: size, makerBestBid: bestBid, makerBestAsk: bestAsk, ...(mid ? { makerMidPrice: mid } : {}), ...(spreadBps ? { makerSpreadBps: spreadBps } : {}), makerFillStatus: 'rejected' };
  }

  if (cfg.MAKER_MAX_WAIT_MS <= 0) {
    const cancelled = await confirmMakerCancel(result.order_id);
    if (!cancelled) {
      return { ok: false, error: 'maker_cancel_unconfirmed', waitMs: Date.now() - startedAt, makerOrderId: result.order_id, makerPostedPrice: price, makerPostedSize: size, makerBestBid: bestBid, makerBestAsk: bestAsk, ...(mid ? { makerMidPrice: mid } : {}), ...(spreadBps ? { makerSpreadBps: spreadBps } : {}), makerFillStatus: 'cancel_unconfirmed' };
    }
    return { ok: false, error: 'maker_not_filled', waitMs: Date.now() - startedAt, makerOrderId: result.order_id, makerPostedPrice: price, makerPostedSize: size, makerBestBid: bestBid, makerBestAsk: bestAsk, ...(mid ? { makerMidPrice: mid } : {}), ...(spreadBps ? { makerSpreadBps: spreadBps } : {}), makerFillStatus: 'timeout' };
  }

  const deadline = Date.now() + cfg.MAKER_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const order = await getClobOrder(result.order_id);
    if (!order) break;

    const matched = parseFloat(order.size_matched ?? '0');
    const original = parseFloat(order.original_size ?? '0');
    if (matched > 0) {
      if (isFinite(original) && matched + 1e-9 < original) {
        const cancelled = await confirmMakerCancel(result.order_id);
        if (!cancelled) {
          return { ok: false, error: 'maker_cancel_unconfirmed', waitMs: Date.now() - startedAt, makerOrderId: result.order_id, makerPostedPrice: price, makerPostedSize: size, makerBestBid: bestBid, makerBestAsk: bestAsk, ...(mid ? { makerMidPrice: mid } : {}), ...(spreadBps ? { makerSpreadBps: spreadBps } : {}), makerFillStatus: 'cancel_unconfirmed' };
        }
      }

      const filledStakeUsd = matched * price;
      const tradeResult: SimmerTradeResult = {
        success: true,
        shares_bought: matched,
      };
      return { ok: true, tradeResult, filledStakeUsd, waitMs: Date.now() - startedAt, makerOrderId: result.order_id, makerPostedPrice: price, makerPostedSize: size, makerBestBid: bestBid, makerBestAsk: bestAsk, ...(mid ? { makerMidPrice: mid } : {}), ...(spreadBps ? { makerSpreadBps: spreadBps } : {}), makerFillStatus: (matched + 1e-9 < original ? 'partial' : 'full'), makerSharesFilled: matched };
    }

    await sleep(cfg.MAKER_POLL_INTERVAL_MS);
  }

  const cancelled = await confirmMakerCancel(result.order_id);
  if (!cancelled) {
    return { ok: false, error: 'maker_cancel_unconfirmed', waitMs: Date.now() - startedAt, makerOrderId: result.order_id, makerPostedPrice: price, makerPostedSize: size, makerBestBid: bestBid, makerBestAsk: bestAsk, ...(mid ? { makerMidPrice: mid } : {}), ...(spreadBps ? { makerSpreadBps: spreadBps } : {}), makerFillStatus: 'cancel_unconfirmed' };
  }
  return { ok: false, error: 'maker_not_filled', waitMs: Date.now() - startedAt, makerOrderId: result.order_id, makerPostedPrice: price, makerPostedSize: size, makerBestBid: bestBid, makerBestAsk: bestAsk, ...(mid ? { makerMidPrice: mid } : {}), ...(spreadBps ? { makerSpreadBps: spreadBps } : {}), makerFillStatus: 'timeout' };
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
    const accountValue = parseFloat(state.marginSummary.accountValue || '0');

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
    const totalCurrentMargin = positions.reduce((sum, p) => sum + parseFloat(p.position.marginUsed || '0'), 0);
    let pendingMarginUsd = 0;
    try {
      const pendingRaw = await redis.get('hl:pending_margin_usd');
      pendingMarginUsd = pendingRaw ? Math.max(0, parseFloat(pendingRaw)) : 0;
    } catch { /* treat as zero on error */ }

    if (totalCurrentMargin + knownSessionExposureUsd + pendingMarginUsd + signal.stakeUsd > cfg.FUTURES_GLOBAL_MAX_MARGIN_USD) {
      logger.warn('[executor] skipping — global margin cap exceeded (including pending/session exposure)', {
        current: totalCurrentMargin.toFixed(2),
        pending: pendingMarginUsd.toFixed(2),
        session: knownSessionExposureUsd.toFixed(2),
        requested: signal.stakeUsd.toFixed(2),
        cap: cfg.FUTURES_GLOBAL_MAX_MARGIN_USD,
      });
      return { signal, skipped: true, skipReason: 'global_margin_cap' };
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
        logger.debug('[executor] failed to record pending margin (non-fatal)', { error: String(e) });
      }
      return {
        signal,
        skipped: false,
        tradeResult: { success: true, tx_hash: tradeResult.txHash, shares_bought: 0 },
        executionVenue: 'hyperliquid',
      };
    }

    return {
      signal,
      skipped: false,
      error: tradeResult.error || 'Hyperliquid order failed',
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
    const totalCurrentMargin = positions.reduce((sum, p) => sum + parseFloat(p.position.marginUsed || '0'), 0);
    
    // Safety: Account for session exposure to prevent overshooting cap during multi-signal cycles
    if (totalCurrentMargin + knownSessionExposureUsd + pmSignal.stakeUsd > cfg.FUTURES_GLOBAL_MAX_MARGIN_USD) {
       logger.warn('[executor] skipping delta hedge — global margin cap reached (including session exposure)', {
         current: totalCurrentMargin.toFixed(2),
         session: knownSessionExposureUsd.toFixed(2),
         hedge: pmSignal.stakeUsd.toFixed(2),
         cap: cfg.FUTURES_GLOBAL_MAX_MARGIN_USD,
       });
       return false;
    }
  } catch (err) {
    logger.error('[executor] margin check failed for hedge', { error: err instanceof Error ? err.message : '[non-Error thrown]' });
    return false; // Safety first
  }

  // 2. Identify the correlated asset symbol using shared logic
  const hlSymbol = resolveHlSymbol(pmSignal.question);

  if (!hlSymbol) {
    logger.debug('[executor] no correlated HL asset found for hedge', { pmMarketId: pmSignal.marketId });
    return false;
  }

  // 3. Execute 1:1 Delta Hedge (Short)
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
    stakeUsd: hedgeStakeUsd,
  });

  const result = await hl.placeMarketOrder({
    symbol: hlSymbol,
    isBuy: false, // SHORT to hedge a PM YES/LONG
    sizeUsd: hedgeStakeUsd,
    leverage: 1, // Hedge positions use 1x leverage to maximize safety
  });

  if (result.success) {
    logger.info('[executor] delta hedge successful', { hlSymbol, txHash: result.txHash });
    // Link the hedge in Redis for tracking
    await redis.set(`hedge:link:${pmSignal.marketId}`, hlSymbol, 'EX', 7 * 24 * 3600);
    return true;
  } else {
    const errMsg = result.error ?? 'unknown error';
    logger.warn('[executor] delta hedge failed', { hlSymbol, error: errMsg });
    void notifyTradeError(
      { marketId: pmSignal.marketId, question: pmSignal.question, direction: pmSignal.direction, stakeUsd: pmSignal.stakeUsd } as TradeSignal,
      `Delta hedge failed for ${hlSymbol}: ${errMsg}`,
      { venue: 'hyperliquid' },
    ).catch(() => { /* best-effort notification */ });
    return false;
  }
}

export async function executeSignal(
  signal: TradeSignal,
  redis: Redis,
  knownSessionExposureUsd = 0,
): Promise<ExecutionResult> {
  const executionId = createHash('sha256').update(`${signal.marketId}:${signal.direction}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16);
  const decisionStartedAt = Date.now();
  const modeConfigured = loadConfig().EXECUTION_MODE;
  void recordExecutionMetric(redis, 'mode', modeConfigured).catch(() => {});
  const emitExecutionEvent = (payload: Record<string, unknown>) => {
    void recordExecutionEvent(redis, 'execution_attempt', payload).catch(() => {
      void recordExecutionMetric(redis, 'errors', 'telemetry_emit_failed').catch(() => {});
    });
  };

  // 1) Idempotency check (Moved up to cover all platforms, executes before baseEvent setup)
  const cfg = loadConfig();
  const key = idempotencyKey(signal);
  const alreadyFired = await redis.get(key);
  if (alreadyFired) {
    logger.info('[executor] skipping — idempotency key already set', {
      marketId: signal.marketId,
      key,
    });
    void recordExecutionMetric(redis, 'skipped', 'already_executed').catch(() => {});
    return { signal, skipped: true, skipReason: 'already_executed' };
  }

  // 1b) Calibration correction (Phase 8b) — adjust edge before sizing
  const isTail = isTailPrice(signal.outcomePrice, cfg.TAIL_PRICE_THRESHOLD);
  const baseEvent = {
    executionId,
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
    isTailPrice: isTail,
    tailThreshold: cfg.TAIL_PRICE_THRESHOLD,
    takerMinEdge: cfg.TAKER_MIN_EDGE,
    makerMaxWaitMs: cfg.MAKER_MAX_WAIT_MS,
    makerPriceEdgeBps: cfg.MAKER_PRICE_EDGE_BPS,
    makerPollIntervalMs: cfg.MAKER_POLL_INTERVAL_MS,
  } as const;

  const recordSkip = (reason: string) => {
    void recordExecutionMetric(redis, 'skipped', reason).catch(() => {});
    emitExecutionEvent({ ...baseEvent, finalExecutionPath: 'skipped', skipReason: reason });
    return { signal, skipped: true, skipReason: reason };
  };
  if (cfg.CALIBRATION_ENABLED && !signal.isFutures) {
    try {
      const category = inferCategory(signal.question);
      const cal = await getCalibrationStats(redis, category);
      const correctedEdge = applyCalibrationCorrection(signal.edgeMagnitude ?? 0, cal, cfg.CALIBRATION_MIN_SAMPLES);
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
    } catch (err) {
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
    }
    return result;
  }

  // 3) Stake floor check (MIN_BET_USD, default $5)
  const minStake = getMinStake();
  if (signal.stakeUsd < minStake) {
    logger.info('[executor] skipping — stake below floor', {
      marketId: signal.marketId,
      stakeUsd: signal.stakeUsd,
      minBetUsd: minStake,
    });
    return recordSkip('stake_below_floor');
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

  const executionMode = cfg.EXECUTION_MODE;
  const simmerId = await resolveSimmerMarketId(signal.question);

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

      // Gate 4: market has fees — fee drag erodes edge on geopolitical markets
      if (ctx.market.fee_rate_bps > 0) {
        logger.info('[executor] skipping — market has fees', {
          marketId: signal.marketId,
          feeRateBps: ctx.market.fee_rate_bps,
        });
        return recordSkip(`fee_market:${ctx.market.fee_rate_bps.toString()}bps`);
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
  let makerTelemetry: Record<string, unknown> = {};
  let takerPath: 'taker_direct' | 'hybrid_taker_fallback' | null = null;
  let decisionSubmitted = false;

  if (executionMode !== 'taker' && !signal.isFutures && signal.feesEnabled !== true) {
    makerAttempted = true;
    if (!decisionSubmitted) {
      decisionSubmitted = true;
      void recordExecutionTiming(redis, 'decision_to_submit_ms', Date.now() - decisionStartedAt).catch(() => {});
    }
    void recordExecutionMetric(redis, 'maker_attempted').catch(() => {});
    const makerAttempt = await tryExecuteViaClobMaker(signal, cfg);
    void recordExecutionTiming(redis, 'maker_wait_ms', makerAttempt.waitMs).catch(() => {});
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
      decisionBestBid: makerAttempt.makerBestBid ?? null,
      decisionBestAsk: makerAttempt.makerBestAsk ?? null,
      decisionMidPrice: makerAttempt.makerMidPrice ?? null,
      decisionSpreadBps: makerAttempt.makerSpreadBps ?? null,
      counterfactualImmediateTakerPrice: makerAttempt.makerBestAsk ?? null,
      counterfactualImmediateTakerCostUsd: makerAttempt.makerBestAsk ? signal.stakeUsd : null,
    };
    if (makerAttempt.ok && makerAttempt.tradeResult?.success) {
      if (makerAttempt.filledStakeUsd && makerAttempt.filledStakeUsd > 0 && makerAttempt.filledStakeUsd !== signal.stakeUsd) {
        signal = { ...signal, stakeUsd: makerAttempt.filledStakeUsd };
      }

      makerFilled = true;
      void recordExecutionMetric(redis, 'maker_filled').catch(() => {});
      await redis.set(key, '1', 'EX', IDEMPOTENCY_TTL_SECONDS);
      if (makerTelemetry.makerFillStatus === 'partial') {
        void recordExecutionMetric(redis, 'maker_partial_fill').catch(() => {});
      } else {
        void recordExecutionMetric(redis, 'maker_full_fill').catch(() => {});
      }
      logger.info('[executor] maker order filled on CLOB', {
        marketId: signal.marketId,
        stakeUsd: signal.stakeUsd,
        sharesFilled: makerAttempt.tradeResult.shares_bought,
      });
      void notifyTradeExecuted(signal, undefined, { venue: 'clob', ...(makerAttempt.tradeResult.shares_bought != null && { sharesFilled: makerAttempt.tradeResult.shares_bought }) }).catch(() => {});

      void triggerDeltaHedge(signal, redis, knownSessionExposureUsd).catch((err) => {
        logger.warn('[executor] delta hedge async error (non-fatal)', {
          marketId: signal.marketId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      emitExecutionEvent({
        ...baseEvent,
        ...makerTelemetry,
        executionPath: 'maker_fill',
        finalExecutionPath: makerTelemetry.makerFillStatus === 'partial' ? 'maker_partial_fill' : 'maker_fill',
        finalVenue: 'clob',
        finalOrderType: 'maker',
        finalSharesFilled: makerAttempt.tradeResult?.shares_bought ?? null,
        finalStakeUsdExecuted: signal.stakeUsd,
        executionSucceeded: true,
        hedgeTriggered: true,
      });
      return {
        signal,
        skipped: false,
        tradeResult: makerAttempt.tradeResult,
        executionVenue: 'clob',
        hedgeDispatched: true,
      };
    }

    if (executionMode === 'maker') {
      logger.info('[executor] maker mode — no taker fallback', {
        marketId: signal.marketId,
        reason: makerAttempt.error ?? 'maker_not_filled',
      });
      return recordSkip(makerAttempt.error ?? 'maker_not_filled');
    }
  }

  if (executionMode === 'hybrid') {
    if (makerAttempted && !makerFilled) {
      void recordExecutionMetric(redis, 'taker_fallback').catch(() => {});
    }
    const takerGate = canExecuteTaker(signal, cfg);
    if (!takerGate.ok) {
      logger.info('[executor] skipping — taker gate blocked', {
        marketId: signal.marketId,
        reason: takerGate.reason,
      });
      return recordSkip(takerGate.reason);
    }
  }

  // 5) Try Simmer first

  if (simmerId) {
    takerPath = executionMode === 'taker' ? 'taker_direct' : (makerAttempted && !makerFilled ? 'hybrid_taker_fallback' : 'taker_direct');
    if (takerPath === 'taker_direct') {
      void recordExecutionMetric(redis, 'taker_direct').catch(() => {});
    } else {
      void recordExecutionMetric(redis, 'taker_fallback').catch(() => {});
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
      void recordExecutionTiming(redis, 'decision_to_submit_ms', Date.now() - decisionStartedAt).catch(() => {});
    }
    try {
      const tradeResult = await submitTrade({
        market_id: simmerId,
        side: signal.direction.toLowerCase() as 'yes' | 'no',
        amount: signal.stakeUsd,
        reasoning: `OSINT signal: "${signal.sourcedFrom}" — consensus P=${signal.consensusProbability?.toFixed(2) ?? 'N/A'}, market P=${signal.outcomePrice.toFixed(2)}, edge=${signal.edgeMagnitude.toFixed(2)}. ${signal.reasoning}`,
      });

      if (tradeResult.success) {
        await redis.set(key, '1', 'EX', IDEMPOTENCY_TTL_SECONDS);
        emitExecutionEvent({
          ...baseEvent,
          ...makerTelemetry,
          executionPath: takerPath,
          finalExecutionPath: takerPath,
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
        void notifyTradeExecuted(signal, tradeResult.tx_hash, { venue: 'simmer', ...(tradeResult.shares_bought != null && { sharesFilled: tradeResult.shares_bought }) }).catch(() => {});

        // Fire-and-forget the delta hedge — do not block PM trade confirmation on HL latency.
        // hedgeDispatched is reported as true optimistically; errors are logged inside triggerDeltaHedge.
        void triggerDeltaHedge(signal, redis, knownSessionExposureUsd).catch((err) => {
          logger.warn('[executor] delta hedge async error (non-fatal)', {
            marketId: signal.marketId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        const exeResult: ExecutionResult = {
          signal, skipped: false, tradeResult, executionVenue: 'simmer', hedgeDispatched: true,
        };
        return exeResult;
      }

      // Simmer returned success=false — fall back to CLOB for recoverable rejections
      // (market not found, order too small for Simmer's 5-share minimum)
      if (!shouldFallbackToClob(tradeResult.error)) {
        logger.warn('[executor] Simmer trade returned success=false', {
          marketId: signal.marketId,
          error: tradeResult.error,
        });
        return { signal, skipped: false, tradeResult, executionVenue: 'simmer' };
      }

      logger.warn('[executor] Simmer rejected — attempting CLOB fallback', {
        marketId: signal.marketId,
        error: tradeResult.error,
      });
    } catch (err) {
      const message = err instanceof SimmerError
        ? `HTTP ${err.statusCode.toString()}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);

      // Only fall back on recoverable Simmer failures
      if (!shouldFallbackToClob(message)) {
        logger.error('[executor] Simmer submission failed', {
          marketId: signal.marketId,
          error: message,
        });
        return { signal, skipped: false, error: message, executionVenue: 'simmer' };
      }

      logger.warn('[executor] Simmer market unavailable (exception); attempting CLOB fallback', {
        marketId: signal.marketId,
        error: message,
      });
    }
  } else {
    logger.info('[executor] market not in Simmer catalogue; attempting CLOB fallback', {
      marketId: signal.marketId,
      question: signal.question,
    });
  }

  // 6) Fee gate — skip CLOB if Gamma reports fees enabled on this market.
  // Simmer has its own fee gate (ctx.market.fee_rate_bps) earlier in the flow.
  // This gate covers the CLOB-only path (markets not in Simmer catalogue).
  if (signal.feesEnabled === true) {
    logger.info('[executor] skipping CLOB — market has fees enabled', {
      marketId: signal.marketId,
    });
    return recordSkip('fee_market:clob_path');
  }

  // 7) CLOB fallback
  if (!decisionSubmitted) {
    decisionSubmitted = true;
    void recordExecutionTiming(redis, 'decision_to_submit_ms', Date.now() - decisionStartedAt).catch(() => {});
  }
  const clob = await tryExecuteViaClob(signal);
  if (clob.ok && clob.tradeResult?.success) {
    const tradeResult = clob.tradeResult;
    await redis.set(key, '1', 'EX', IDEMPOTENCY_TTL_SECONDS);
    logger.info('[executor] trade submitted successfully via CLOB fallback', {
      marketId: signal.marketId,
      txHash: tradeResult.tx_hash,
    });
    void notifyTradeExecuted(signal, tradeResult.tx_hash).catch(() => {});
    // Fire-and-forget the delta hedge — do not block CLOB trade confirmation on HL latency.
    void triggerDeltaHedge(signal, redis, knownSessionExposureUsd).catch((err) => {
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
      hedgeDispatched: true,
    };
  }

  const fallbackError = clob.error ?? 'CLOB fallback failed';
  void recordExecutionMetric(redis, 'errors', 'clob_fallback_failed').catch(() => {});
  emitExecutionEvent({
    ...baseEvent,
    ...makerTelemetry,
    executionPath: 'execution_error',
    finalExecutionPath: 'error',
    finalVenue: 'clob',
    finalOrderType: 'taker',
    executionSucceeded: false,
    errorClass: 'clob_fallback_failed',
    errorMessage: fallbackError,
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
      sessionExposureUsd += signal.stakeUsd;
    }
    
    results.push(result);
  }
  return results;
}
