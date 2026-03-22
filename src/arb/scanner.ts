/**
 * Arbitrage scanner — scans active binary markets for YES+NO < $1.00.
 *
 * Strategy: buy YES + buy NO when combined ask < $1.00 - fees.
 * Both legs executed as FOK. If either leg fails, abort — no unhedged exposure.
 *
 * Rate limit: Polymarket allows 60 orders/minute. Scanner caps at 2 arb trades/run
 * (4 orders) to stay well within limits.
 */

import { getActiveMarkets, parseOutcomePrices, parseClobTokenIds } from '../mapping/gamma.js';
import { submitClobBuy } from '../shared/clob.js';
import { getBankroll, deductStake } from '../shared/bankroll.js';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { notifyUnhedgedArbPosition } from '../execution/telegram.js';
import type { Redis } from 'ioredis';

// Max arb trades per scan run (2 trades = 4 orders, well within 60 orders/min limit)
const MAX_ARB_PER_RUN = 2;
// Dedup TTL: don't re-enter same market within 30 minutes
const ARB_DEDUP_TTL_S = 30 * 60;
// Polymarket taker fee rate per leg (~2%). Used for net edge calculation.
const POLYMARKET_FEE_RATE = 0.02;
// NOTE (LOW): getActiveMarkets currently fetches a fixed 200-market page.
// Polymarket has 1000s of active markets. Pagination is deferred — at the
// default ARB_MIN_EDGE threshold (0.05 net), true arb opportunities are rare;
// the first 200 markets by liquidity are the most likely candidates.

const arbDedupKey = (marketId: string) => `arb:attempted:${marketId}`;

export interface ArbOpportunity {
  marketId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  yesAsk: number;
  noAsk: number;
  /** Net edge after estimated Polymarket taker fees (gross - combined × 2 × FEE_RATE) */
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
  const markets = await getActiveMarkets(200);
  const opportunities: ArbOpportunity[] = [];

  for (const market of markets) {
    // Skip if recently attempted
    const deduped = await redis.get(arbDedupKey(market.id));
    if (deduped) continue;

    let prices: string[];
    try {
      prices = parseOutcomePrices(market.outcomePrices);
    } catch {
      continue;
    }
    if (prices.length < 2) continue;

    const yesAsk = parseFloat(prices[0] ?? '0');
    const noAsk = parseFloat(prices[1] ?? '0');
    if (!isFinite(yesAsk) || !isFinite(noAsk)) continue;

    const combined = yesAsk + noAsk;
    const grossEdge = 1.0 - combined;
    // Compute net edge: gross edge minus estimated Polymarket taker fees (~2%/leg).
    // Net edge = grossEdge - combined × 2 × FEE_RATE
    const estFees = combined * 2 * POLYMARKET_FEE_RATE;
    const edge = grossEdge - estFees; // net edge

    if (edge <= minEdge) continue;

    let tokenIds: string[];
    try {
      tokenIds = parseClobTokenIds(market.clobTokenIds);
    } catch {
      continue;
    }
    if (tokenIds.length < 2) continue;

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
 * Equal-share sizing (not equal-dollar) is required for a risk-free payoff:
 *   shares = totalBudget / (yesAsk + noAsk)
 *   yesUsd = shares × yesAsk
 *   noUsd  = shares × noAsk
 *
 * At resolution, exactly `shares` dollars arrive from whichever outcome wins,
 * regardless of which leg is more expensive. Equal-dollar sizing creates unequal
 * share counts and leaves directional exposure.
 *
 * Net edge (after fees) = gross edge - (yesAsk + noAsk) × 2 × FEE_RATE
 *
 * If YES leg fails, NO is NOT submitted (abort, no unhedged exposure).
 */
export async function executeArb(
  opp: ArbOpportunity,
  redis: Redis,
): Promise<ArbResult> {
  const cfg = loadConfig();
  const combined = opp.yesAsk + opp.noAsk;

  // Check bankroll BEFORE marking as attempted.
  const bankroll = await getBankroll(redis);
  const totalBudget = bankroll * cfg.ARB_MAX_STAKE_FRACTION;

  if (totalBudget < 2.0) {
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

  // Equal-share sizing: same number of outcome tokens per leg.
  // Revenue at resolution = shares × $1 regardless of which outcome wins.
  const shares = totalBudget / combined;
  const yesUsd = shares * opp.yesAsk;
  const noUsd  = shares * opp.noAsk;

  // opp.edge is already net of estimated fees (computed in scanForArb).

  // Atomically claim the dedup slot. SET NX prevents two overlapping cron runs
  // from both passing the get-based dedup in scanForArb and then double-trading.
  // This is the authoritative guard — scanForArb's redis.get is a pre-filter only.
  const claimed = await redis.set(arbDedupKey(opp.marketId), '1', 'EX', ARB_DEDUP_TTL_S, 'NX');
  if (!claimed) {
    logger.info('[arb] dedup NX: market already claimed by concurrent run', {
      marketId: opp.marketId,
    });
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

  logger.info('[arb] executing opportunity', {
    marketId: opp.marketId,
    question: opp.question.slice(0, 80),
    yesAsk: opp.yesAsk,
    noAsk: opp.noAsk,
    edge: opp.edge.toFixed(4),
    shares: shares.toFixed(4),
    yesUsd: yesUsd.toFixed(2),
    noUsd: noUsd.toFixed(2),
  });

  // Leg 1: YES — FOK (equal shares)
  const yesResult = await submitClobBuy({
    tokenId: opp.yesTokenId,
    amountUsd: yesUsd,
    orderType: 'FOK',
  });

  if (!yesResult.success) {
    logger.warn('[arb] YES leg failed — aborting, NO leg not submitted', {
      marketId: opp.marketId,
      error: yesResult.error,
    });
    return {
      marketId: opp.marketId,
      success: false,
      yesResult: { success: false, ...(yesResult.error ? { error: yesResult.error } : {}) },
      numShares: 0,
      yesCostUsd: 0,
      noCostUsd: 0,
      edge: opp.edge,
      error: 'yes_leg_failed',
    };
  }

  // Leg 2: NO — FOK (equal shares)
  const noResult = await submitClobBuy({
    tokenId: opp.noTokenId,
    amountUsd: noUsd,
    orderType: 'FOK',
  });

  if (!noResult.success) {
    // YES filled, NO failed — we are now LONG YES with no hedge.
    // This is a real financial risk event: log as critical AND send an
    // immediate Telegram alert requiring manual intervention.
    logger.error('[arb] CRITICAL: YES leg filled but NO leg failed — unhedged YES position', {
      marketId: opp.marketId,
      yesStake: yesUsd,
      noError: noResult.error,
    });
    // Fire-and-forget notification — alert Romeo regardless of WS/network state
    void notifyUnhedgedArbPosition({
      marketId: opp.marketId,
      question: opp.question,
      stakeUsd: yesUsd,
      noError: noResult.error,
    });
    // Persist alert in Redis so the monitoring layer can detect unhedged positions
    await redis.setex(`alert:unhedged:${opp.marketId}`, 3600, JSON.stringify({
      marketId: opp.marketId,
      yesStake: yesUsd,
      noError: noResult.error,
      ts: Date.now(),
    }));
    // YES leg filled = real USDC spent — deduct 1 leg so bankroll stays accurate
    await deductStake(redis, yesUsd);
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

  // Both legs filled — deduct actual cost from bankroll.
  // At resolution, `shares × $1` arrives from whichever outcome wins.
  // Net profit ≈ shares × edge.
  await deductStake(redis, yesUsd + noUsd);

  logger.info('[arb] both legs filled', {
    marketId: opp.marketId,
    yesUsd: yesUsd.toFixed(2),
    noUsd: noUsd.toFixed(2),
    shares: shares.toFixed(4),
    edge: opp.edge.toFixed(4),
    expectedProfit: (opp.edge * shares).toFixed(4),
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

/**
 * Run one full arb scan cycle: scan → execute top opportunities.
 * Called from cron or on-demand.
 */
export async function runArbScan(redis: Redis): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.ARB_ENABLED) {
    logger.info('[arb] skipping scan — ARB_ENABLED=false');
    return;
  }
  if (!cfg.CLOB_FALLBACK_ENABLED) {
    logger.info('[arb] skipping scan — CLOB disabled');
    return;
  }

  let opportunities: ArbOpportunity[];
  try {
    opportunities = await scanForArb(redis);
  } catch (err) {
    logger.error('[arb] scan failed', { error: String(err) });
    return;
  }

  if (opportunities.length === 0) {
    logger.info('[arb] no opportunities found');
    return;
  }

  logger.info('[arb] opportunities found', { count: opportunities.length, top: opportunities[0] });

  const toExecute = opportunities.slice(0, MAX_ARB_PER_RUN);
  for (const opp of toExecute) {
    await executeArb(opp, redis);
  }
}
