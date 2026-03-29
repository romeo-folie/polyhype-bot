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
import { submitClobBuy } from '../shared/clob.js';
import { hasOpenPosition } from './positionLedger.js';
import { getHyperliquid, HL_SYMBOL_MAP } from '../shared/hyperliquid.js';
import { loadConfig } from '../shared/config.js';
import type { SimmerTradeResult } from '../shared/simmer.js';
import type { Redis } from 'ioredis';
import type { TradeSignal } from '../mapping/index.js';

const IDEMPOTENCY_TTL_SECONDS = 3600; // 1 hour
const MIN_STAKE_USD = 0.01; // below this: skip (rounding noise)
const IDEMPOTENCY_KEY_PREFIX = 'trade:executed:';

export interface ExecutionResult {
  signal: TradeSignal;
  skipped: boolean;
  skipReason?: string;
  tradeResult?: SimmerTradeResult;
  error?: string;
  executionVenue?: 'simmer' | 'clob' | 'hyperliquid';
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
): Promise<ExecutionResult> {
  const cfg = loadConfig();
  const hl = getHyperliquid();

  try {
    // 1. Margin & Equity Check
    const state = await hl.getClearinghouseState();
    const accountValue = parseFloat(state?.marginSummary?.accountValue || '0');
    
    if (accountValue < signal.stakeUsd) {
      logger.warn('[executor] skipping — insufficient HL equity', {
        accountValue: accountValue.toFixed(2),
        required: signal.stakeUsd.toFixed(2),
      });
      return { signal, skipped: true, skipReason: 'insufficient_equity' };
    }

    // Check if we're already at the global margin cap
    const positions = await hl.getOpenPositions();
    const totalCurrentMargin = positions.reduce((sum, p) => sum + parseFloat(p.position.marginUsed || '0'), 0);
    
    if (totalCurrentMargin + signal.stakeUsd > cfg.FUTURES_GLOBAL_MAX_MARGIN_USD) {
      logger.warn('[executor] skipping — global margin cap exceeded', {
        current: totalCurrentMargin.toFixed(2),
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
async function triggerDeltaHedge(
  pmSignal: TradeSignal,
  redis: Redis,
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.FUTURES_ENABLED || pmSignal.isFutures) return;

  const hl = getHyperliquid();

  // 1. Margin Check (Added guard)
  try {
    const positions = await hl.getOpenPositions();
    const totalCurrentMargin = positions.reduce((sum, p) => sum + parseFloat(p.position.marginUsed || '0'), 0);
    
    if (totalCurrentMargin + pmSignal.stakeUsd > cfg.FUTURES_GLOBAL_MAX_MARGIN_USD) {
       logger.warn('[executor] skipping delta hedge — global margin cap reached', {
         current: totalCurrentMargin.toFixed(2),
         hedge: pmSignal.stakeUsd.toFixed(2),
         cap: cfg.FUTURES_GLOBAL_MAX_MARGIN_USD,
       });
       return;
    }
  } catch (err) {
    logger.error('[executor] margin check failed for hedge', { error: String(err) });
    return; // Safety first
  }

  // 2. Identify the correlated asset symbol
  let hlSymbol: string | undefined;
  const lowerQuestion = pmSignal.question.toLowerCase();
  
  for (const [id, symbol] of Object.entries(HL_SYMBOL_MAP)) {
    if (lowerQuestion.includes(id) || lowerQuestion.includes((symbol as string).toLowerCase())) {
      hlSymbol = symbol as string;
      break;
    }
  }

  if (!hlSymbol) {
    logger.debug('[executor] no correlated HL asset found for hedge', { pmMarketId: pmSignal.marketId });
    return;
  }

  // 2. Execute 1:1 Delta Hedge (Short)
  const hedgeStakeUsd = pmSignal.stakeUsd;

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
  } else {
    logger.warn('[executor] delta hedge failed', { hlSymbol, error: result.error });
  }
}

export async function executeSignal(
  signal: TradeSignal,
  redis: Redis,
): Promise<ExecutionResult> {
  // 1) Idempotency check (Moved up to cover all platforms)
  const key = idempotencyKey(signal);
  const alreadyFired = await redis.get(key);
  if (alreadyFired) {
    logger.info('[executor] skipping — idempotency key already set', {
      marketId: signal.marketId,
      key,
    });
    return { signal, skipped: true, skipReason: 'already_executed' };
  }

  // 2) Route Futures signals to specialized handler
  if (signal.isFutures) {
    const result = await executeHyperliquidSignal(signal, redis);
    if (result.tradeResult?.success) {
      await redis.set(key, '1', 'EX', IDEMPOTENCY_TTL_SECONDS);
    }
    return result;
  }

  // 1) Stake floor check
  if (signal.stakeUsd < MIN_STAKE_USD) {
    logger.info('[executor] skipping — stake below floor', {
      marketId: signal.marketId,
      stakeUsd: signal.stakeUsd,
    });
    return { signal, skipped: true, skipReason: 'stake_below_floor' };
  }

  // 2) Open position check — don't stack into a market we already hold
  const alreadyHolding = await hasOpenPosition(redis, signal.marketId, signal.direction);
  if (alreadyHolding) {
    logger.info('[executor] skipping — already holding position in this market', {
      marketId: signal.marketId,
      direction: signal.direction,
    });
    return { signal, skipped: true, skipReason: 'position_already_open' };
  }

  // 3) Stake floor check

  // 3) Try Simmer first
  const simmerId = await resolveSimmerMarketId(signal.question);

  if (simmerId) {
    // Context safeguard check — flip-flop detection, resolution criteria, market status
    const ctx = await getMarketContext(simmerId, signal.consensusProbability || 0.5);
    if (ctx) {
      // Gate 1: market already resolved or closed
      if (ctx.market.status === 'resolved' || ctx.market.status === 'closed') {
        logger.info('[executor] skipping — market already resolved/closed', {
          marketId: signal.marketId,
          status: ctx.market.status,
        });
        return { signal, skipped: true, skipReason: `market_${ctx.market.status}` };
      }

      // Gate 2: Simmer already knows we have a position on this side
      if (ctx.position.has_position && ctx.position.side === signal.direction.toLowerCase()) {
        logger.info('[executor] skipping — Simmer reports existing position', {
          marketId: signal.marketId,
          side: ctx.position.side,
        });
        return { signal, skipped: true, skipReason: 'simmer_position_exists' };
      }

      // Gate 3: severe flip-flop warning — we've been reversing too much on this market
      if (ctx.discipline.warning_level === 'severe') {
        logger.warn('[executor] skipping — severe flip-flop warning from Simmer', {
          marketId: signal.marketId,
          flipFlopWarning: ctx.discipline.flip_flop_warning,
          directionChanges24h: ctx.discipline.direction_changes_24h,
        });
        return { signal, skipped: true, skipReason: 'flip_flop_severe' };
      }

      // Gate 4: market has fees — fee drag erodes edge on geopolitical markets
      if (ctx.market.fee_rate_bps > 0) {
        logger.info('[executor] skipping — market has fees', {
          marketId: signal.marketId,
          feeRateBps: ctx.market.fee_rate_bps,
        });
        return { signal, skipped: true, skipReason: `fee_market:${ctx.market.fee_rate_bps.toString()}bps` };
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

    logger.info('[executor] submitting trade via Simmer', {
      marketId: signal.marketId,
      simmerId,
      direction: signal.direction,
      stakeUsd: signal.stakeUsd,
      edgeMagnitude: signal.edgeMagnitude,
      consensusP: signal.consensusProbability,
    });

    try {
      const tradeResult = await submitTrade({
        market_id: simmerId,
        side: signal.direction.toLowerCase() as 'yes' | 'no',
        amount: signal.stakeUsd,
        reasoning: `OSINT signal: "${signal.sourcedFrom}" — consensus P=${signal.consensusProbability?.toFixed(2) ?? 'N/A'}, market P=${signal.outcomePrice.toFixed(2)}, edge=${signal.edgeMagnitude.toFixed(2)}. ${signal.reasoning}`,
      });

      if (tradeResult.success) {
        await redis.set(key, '1', 'EX', IDEMPOTENCY_TTL_SECONDS);
        logger.info('[executor] trade submitted successfully via Simmer', {
          marketId: signal.marketId,
          txHash: tradeResult.tx_hash,
        });

        const exeResult: ExecutionResult = { signal, skipped: false, tradeResult, executionVenue: 'simmer' };
        // Trigger Delta Hedge (for News signals)
        void triggerDeltaHedge(signal, redis);
        
        return exeResult;
      }

      // Simmer returned success=false — only fall back for market-unavailable cases
      if (!isMarketNotFoundMessage(tradeResult.error)) {
        logger.warn('[executor] Simmer trade returned success=false', {
          marketId: signal.marketId,
          error: tradeResult.error,
        });
        return { signal, skipped: false, tradeResult, executionVenue: 'simmer' };
      }

      logger.warn('[executor] Simmer market unavailable; attempting CLOB fallback', {
        marketId: signal.marketId,
        error: tradeResult.error,
      });
    } catch (err) {
      const message = err instanceof SimmerError
        ? `HTTP ${err.statusCode.toString()}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);

      // Only fall back on market-not-found style failures
      if (!isMarketNotFoundMessage(message)) {
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

  // 4) CLOB fallback
  const clob = await tryExecuteViaClob(signal);
  if (clob.ok && clob.tradeResult?.success) {
    const tradeResult = clob.tradeResult;
    await redis.set(key, '1', 'EX', IDEMPOTENCY_TTL_SECONDS);
    logger.info('[executor] trade submitted successfully via CLOB fallback', {
      marketId: signal.marketId,
      txHash: tradeResult.tx_hash,
    });
    const exeResult: ExecutionResult = {
      signal,
      skipped: false,
      tradeResult,
      executionVenue: 'clob',
    };
    // Trigger Delta Hedge (for News signals)
    void triggerDeltaHedge(signal, redis);

    return exeResult;
  }

  const fallbackError = clob.error ?? 'CLOB fallback failed';
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
  for (const signal of signals) {
    const result = await executeSignal(signal, redis);
    results.push(result);
  }
  return results;
}
