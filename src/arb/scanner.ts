/**
 * Arbitrage scanner — scans active binary markets for YES+NO < $1.00.
 *
 * Strategy: buy YES + buy NO when combined ask < $1.00 - fees.
 * Both legs executed as FOK. If either leg fails, abort — no unhedged exposure.
 *
 * Rate limit: Polymarket allows 60 orders/minute. Scanner caps at 2 arb trades/run
 * (4 orders) to stay well within limits.
 */

import process from 'node:process';
import { getActiveMarkets, parseOutcomePrices, parseClobTokenIds } from '../mapping/gamma.js';
import { submitClobBuy } from '../shared/clob.js';
import { getBankroll, deductStake } from '../shared/bankroll.js';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { notifyUnhedgedArbPosition } from '../execution/telegram.js';
import { recordPosition } from '../execution/positionLedger.js';
import type { Redis } from 'ioredis';

// Max arb trades per scan run (2 trades = 4 orders, well within 60 orders/min limit)
const MAX_ARB_PER_RUN = 2;
// Dedup TTL: don't re-enter same market within 30 minutes
const ARB_DEDUP_TTL_S = 30 * 60;
// Minimum combined price guard: combined < MIN_COMBINED means prices are near-zero
// (data error or extreme illiquidity), which would produce Infinity/NaN share counts.
const MIN_COMBINED = 0.02;
// Number of markets to scan per arb run.
const ARB_SCAN_MARKET_COUNT = 1000;

const arbDedupKey = (marketId: string) => `arb:attempted:${marketId}`;

export interface ArbOpportunity {
  marketId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  yesAsk: number;
  noAsk: number;
  /** Net edge after estimated Polymarket taker fees (gross - combined × FEE_RATE) */
  edge: number;
  grossEdge: number;
}

export interface ArbResult {
  marketId: string;
  success: boolean;
  yesResult?: { success: boolean; error?: string };
  noResult?: { success: boolean; error?: string };
  numShares: number;
  yesCostUsd: number;
  noCostUsd: number;
  edge: number;
  error?: string;
}

/**
 * Scan active markets for arbitrage opportunities.
 * Returns array of found opportunities sorted by edge descending.
 */
export async function scanForArb(redis: Redis): Promise<ArbOpportunity[]> {
  const cfg = loadConfig();
  const minEdge = cfg.ARB_MIN_EDGE;
  const markets = await getActiveMarkets(ARB_SCAN_MARKET_COUNT);
  const opportunities: ArbOpportunity[] = [];

  for (const market of markets) {
    // Skip if recently attempted
    const deduped = await redis.get(arbDedupKey(market.id));
    if (deduped) continue;

    let prices: string[];
    try {
      prices = parseOutcomePrices(market.outcomePrices);
    } catch (err) {
      logger.debug('[arb] skipping market — price parse error', { marketId: market.id, err: String(err) });
      continue;
    }
    // Binary markets have exactly 2 outcomes — skip multi-outcome markets
    if (prices.length !== 2) continue;

    const yesAsk = parseFloat(prices[0] ?? '0');
    const noAsk = parseFloat(prices[1] ?? '0');
    if (!isFinite(yesAsk) || !isFinite(noAsk)) continue;
    if (yesAsk <= 0 || noAsk <= 0) continue;

    const combined = yesAsk + noAsk;
    // Guard against near-zero combined: would produce Infinity/NaN share counts.
    if (combined < MIN_COMBINED) continue;

    const grossEdge = 1.0 - combined;
    const feeRate = cfg.ARB_FEE_RATE;
    const estFees = combined * feeRate;
    const edge = grossEdge - estFees; // net edge

    if (edge <= minEdge) continue;

    let tokenIds: string[];
    try {
      tokenIds = parseClobTokenIds(market.clobTokenIds);
    } catch (err) {
      logger.debug('[arb] skipping market — tokenId parse error', { marketId: market.id, err: String(err) });
      continue;
    }
    if (tokenIds.length !== 2) continue;

    opportunities.push({
      marketId: market.id,
      question: market.question,
      yesTokenId: tokenIds[0]!,
      noTokenId: tokenIds[1]!,
      yesAsk,
      noAsk,
      edge,         // net edge (after fees)
      grossEdge,
    });
  }

  // Sort by edge descending — best opportunities first
  return opportunities.sort((a, b) => b.edge - a.edge);
}

/**
 * Execute an arbitrage trade: buy equal SHARES of YES + NO as FOK.
 * 
 * Sequential Execution: YES leg first; NO leg only if YES fills. This is intentional —
 * submitting both simultaneously would leave an unhedged YES position if the NO leg fails.
 */
export async function executeArb(
  opp: ArbOpportunity,
  redis: Redis,
): Promise<ArbResult> {
  const cfg = loadConfig();
  const combined = opp.yesAsk + opp.noAsk;

  // Bankroll-fraction sizing: risk at most ARB_MAX_STAKE_FRACTION of current bankroll per arb.
  // This caps drawdown from a single bad trade while allowing position growth as bankroll grows.
  const bankroll = await getBankroll(redis);
  const totalBudget = bankroll * cfg.ARB_MAX_STAKE_FRACTION;

  // Combined price < 1.0 is the arb condition: buying both YES and NO costs less than $1/share.
  // The edge (profit per share) = 1.0 - combined. totalBudget / combined = number of share pairs.
  if (totalBudget < 2.0) {
    // Minimum viable arb: need at least 1 share on each side. At combined ≈ 0.98 the min budget
    // is ~$2. Below this, fee drag exceeds expected profit.
    return {
      marketId: opp.marketId,
      success: false,
      numShares: 0,
      yesCostUsd: 0,
      noCostUsd: 0,
      edge: opp.edge,
      error: 'stake_too_small',
    };
  }

  if (combined < MIN_COMBINED || !isFinite(combined)) {
    // combined <= 0 or NaN indicates a data error (stale quotes, invalid market).
    // Guard here prevents division-by-zero / infinite share count in the line below.
    return {
      marketId: opp.marketId,
      success: false,
      numShares: 0,
      yesCostUsd: 0,
      noCostUsd: 0,
      edge: opp.edge,
      error: 'invalid_combined_price',
    };
  }

  // shares = how many YES+NO pairs we can buy within budget.
  // yesUsd / noUsd = cost of each leg. Their sum = totalBudget (within rounding).
  const shares = totalBudget / combined;
  const yesUsd = shares * opp.yesAsk;
  const noUsd  = shares * opp.noAsk;

  if (!isFinite(shares) || !isFinite(yesUsd) || !isFinite(noUsd) || shares <= 0) {
    logger.error('[arb] invalid share computation — aborting', {
      marketId: opp.marketId,
      combined,
      shares,
    });
    return {
      marketId: opp.marketId,
      success: false,
      numShares: 0,
      yesCostUsd: 0,
      noCostUsd: 0,
      edge: opp.edge,
      error: 'invalid_share_computation',
    };
  }

  const claimed = await redis.set(arbDedupKey(opp.marketId), '1', 'EX', ARB_DEDUP_TTL_S, 'NX');
  if (!claimed) {
    return {
      marketId: opp.marketId,
      success: false,
      numShares: 0,
      yesCostUsd: 0,
      noCostUsd: 0,
      edge: opp.edge,
      error: 'dedup_concurrent',
    };
  }

  logger.info('[arb] executing opportunity (Atomic)', {
    marketId: opp.marketId,
    yesAsk: opp.yesAsk,
    noAsk: opp.noAsk,
    edge: opp.edge.toFixed(4),
    shares: shares.toFixed(4),
  });

  function withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('submitClobBuy timeout')); }, 15_000);
    });
    return Promise.race([promise, timeout]).finally(() => { clearTimeout(timer); });
  }

  // Sequential execution to minimize unhedged exposure.
  // We execute Leg A first; if it fails, we never attempt Leg B.
  const yesResult = await withTimeout(submitClobBuy({ tokenId: opp.yesTokenId, amountUsd: yesUsd, orderType: 'FOK' }))
    .catch(err => ({ success: false as const, error: String(err) }));

  if (!yesResult.success) {
    logger.info('[arb] YES leg failed (FOK/Price move) — aborting NO leg', { 
      marketId: opp.marketId, 
      error: yesResult.error 
    });
    await redis.del(arbDedupKey(opp.marketId)).catch(() => undefined);
    return {
      marketId: opp.marketId,
      success: false,
      yesResult: { success: false, ...(yesResult.error ? { error: yesResult.error } : {}) },
      noResult: { success: false }, // Never attempted
      numShares: 0,
      yesCostUsd: 0,
      noCostUsd: 0,
      edge: opp.edge,
      error: 'yes_leg_failed',
    };
  }

  // YES succeeded, now attempt NO
  const noResult = await withTimeout(submitClobBuy({ tokenId: opp.noTokenId, amountUsd: noUsd, orderType: 'FOK' }))
    .catch(err => ({ success: false as const, error: String(err) }));

  if (!noResult.success) {
    logger.error('[arb] CRITICAL: YES filled, NO failed — unhedged YES', { 
      marketId: opp.marketId,
      noError: noResult.error 
    });
    notifyUnhedgedArbPosition({ 
      marketId: opp.marketId, 
      question: opp.question, 
      stakeUsd: yesUsd, 
      noError: noResult.error 
    }).catch(err => { logger.error('[arb] alert failed', { err }); });

    // Record the unhedged YES position in the ledger so the take-profit monitor
    // tracks it and can attempt a manual exit rather than leaving it invisible.
    await recordPosition(redis, {
      marketId: opp.marketId,
      question: opp.question,
      direction: 'YES',
      entryPrice: opp.yesAsk,
      stakeUsd: yesUsd,
      edgeMagnitude: opp.edge,
      openedAt: new Date().toISOString(),
      sourcedFrom: 'arb:unhedged-yes',
      executionVenue: 'clob',
    }).catch(err => { logger.error('[arb] failed to record unhedged position', { err }); });
    
    await deductStake(redis, yesUsd * (1 + cfg.ARB_FEE_RATE));
    return {
      marketId: opp.marketId,
      success: false,
      yesResult: { success: true },
      noResult: { success: false, ...(noResult.error ? { error: noResult.error } : {}) },
      numShares: shares,
      yesCostUsd: yesUsd,
      noCostUsd: 0,
      edge: opp.edge,
      error: 'no_leg_failed_unhedged',
    };
  }

  // Both success
  const totalCost = (yesUsd + noUsd) * (1 + cfg.ARB_FEE_RATE);
  await deductStake(redis, totalCost);

  logger.info('[arb] both legs filled (Atomic success)', {
    marketId: opp.marketId,
    totalCostUsd: totalCost.toFixed(4),
    shares: shares.toFixed(4),
    edge: opp.edge.toFixed(4),
  });

  return {
    marketId: opp.marketId,
    success: true,
    yesResult: { success: true },
    noResult: { success: true },
    numShares: shares,
    yesCostUsd: yesUsd,
    noCostUsd: noUsd,
    edge: opp.edge,
  };
}

export async function runArbScan(redis: Redis): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.ARB_ENABLED || !cfg.CLOB_FALLBACK_ENABLED) return;

  try {
    const opportunities = await scanForArb(redis);
    if (opportunities.length === 0) return;

    const toExecute = opportunities.slice(0, MAX_ARB_PER_RUN);
    for (const opp of toExecute) {
      await executeArb(opp, redis);
    }
  } catch (err) {
    logger.error('[arb] scan failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
