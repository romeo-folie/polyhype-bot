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
import type { Redis } from 'ioredis';

// Max arb trades per scan run (2 trades = 4 orders, well within 60 orders/min limit)
const MAX_ARB_PER_RUN = 2;
// Dedup TTL: don't re-enter same market within 30 minutes
const ARB_DEDUP_TTL_S = 30 * 60;

const arbDedupKey = (marketId: string) => `arb:attempted:${marketId}`;

export interface ArbOpportunity {
  marketId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  yesAsk: number;
  noAsk: number;
  edge: number; // 1.00 - yesAsk - noAsk
}

export interface ArbResult {
  marketId: string;
  success: boolean;
  yesResult?: { success: boolean; error?: string };
  noResult?: { success: boolean; error?: string };
  stakePerLeg: number;
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
    const edge = 1.0 - combined;

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
      edge,
    });
  }

  // Sort by edge descending — best opportunities first
  return opportunities.sort((a, b) => b.edge - a.edge);
}

/**
 * Execute an arbitrage trade: buy YES + buy NO as FOK.
 * If YES leg fails, NO is NOT submitted (abort on first failure).
 * Marks market as attempted in Redis regardless of outcome.
 */
export async function executeArb(
  opp: ArbOpportunity,
  redis: Redis,
): Promise<ArbResult> {
  const cfg = loadConfig();

  // Mark as attempted immediately to prevent concurrent duplicate execution
  await redis.setex(arbDedupKey(opp.marketId), ARB_DEDUP_TTL_S, '1');

  const bankroll = await getBankroll(redis);
  const stakePerLeg = bankroll * cfg.ARB_MAX_STAKE_FRACTION;

  if (stakePerLeg < 1.0) {
    return {
      marketId: opp.marketId,
      success: false,
      stakePerLeg,
      edge: opp.edge,
      error: 'stake_too_small',
    };
  }

  logger.info('[arb] executing opportunity', {
    marketId: opp.marketId,
    question: opp.question.slice(0, 80),
    yesAsk: opp.yesAsk,
    noAsk: opp.noAsk,
    edge: opp.edge.toFixed(4),
    stakePerLeg,
  });

  // Leg 1: YES — FOK
  const yesResult = await submitClobBuy({
    tokenId: opp.yesTokenId,
    amountUsd: stakePerLeg,
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
      stakePerLeg,
      edge: opp.edge,
      error: 'yes_leg_failed',
    };
  }

  // Leg 2: NO — FOK
  const noResult = await submitClobBuy({
    tokenId: opp.noTokenId,
    amountUsd: stakePerLeg,
    orderType: 'FOK',
  });

  if (!noResult.success) {
    // YES filled, NO failed — we are now LONG YES with no hedge.
    // Log as critical — requires manual intervention.
    logger.error('[arb] CRITICAL: YES leg filled but NO leg failed — unhedged YES position', {
      marketId: opp.marketId,
      yesStake: stakePerLeg,
      noError: noResult.error,
    });
    return {
      marketId: opp.marketId,
      success: false,
      yesResult: { success: true },
      noResult: { success: false, ...(noResult.error ? { error: noResult.error } : {}) },
      stakePerLeg,
      edge: opp.edge,
      error: 'no_leg_failed_unhedged',
    };
  }

  // Both legs filled — deduct from bankroll (cost = stakePerLeg * 2, profit locked in at resolution)
  await deductStake(redis, stakePerLeg * 2);

  logger.info('[arb] both legs filled', {
    marketId: opp.marketId,
    stakePerLeg,
    edge: opp.edge.toFixed(4),
    expectedProfit: (opp.edge * stakePerLeg).toFixed(4),
  });

  return {
    marketId: opp.marketId,
    success: true,
    yesResult: { success: true },
    noResult: { success: true },
    stakePerLeg,
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
