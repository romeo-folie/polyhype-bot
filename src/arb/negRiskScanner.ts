/**
 * NegRisk Multi-Outcome Arbitrage Scanner.
 *
 * NegRisk events have N mutually exclusive outcomes — exactly one resolves
 * YES at $1.00.  When sum(YES best-asks) < 1.0 - fees, buying 1 YES share
 * on every outcome locks in a guaranteed profit.
 *
 * Ships dark: `NEGRISK_ARB_ENABLED=false`.  Shadow-logs opportunities
 * regardless of the flag so we can evaluate edge quality before flipping.
 */

import {
  getNegRiskEvents,
  parseOutcomePrices,
  parseClobTokenIds,
} from '../mapping/gamma.js';
import type { GammaMarket } from '../mapping/gamma.js';
import { getClobOrderBook, submitClobBuy, CLOB_MIN_ORDER_USD } from '../shared/clob.js';
import { getBookTouchLevels } from '../shared/bookTouch.js';
import { getBankroll, deductStake } from '../shared/bankroll.js';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { notifyUnhedgedNegRiskPosition } from '../execution/telegram.js';
import { recordPosition } from '../execution/positionLedger.js';
import { priceZoneOf } from '../shared/zones.js';
import { checkGlobalGovernor, recordGlobalTrade } from '../shared/governor.js';
import { enqueueWrite } from '../db/writeQueue.js';
import type { Redis } from 'ioredis';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEDUP_PREFIX = 'arb:negrisk:attempted:';
/** Max concurrent CLOB orderbook fetches per event (respect API rate limits). */
const ORDERBOOK_CONCURRENCY = 5;
/** Delay between sequential leg submissions to pace CLOB order rate. */
const INTER_LEG_DELAY_MS = 200;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** A single outcome leg within a NegRisk arb opportunity. */
export interface NegRiskLeg {
  marketId: string;
  question: string;
  yesTokenId: string;
  /** Best ask price from CLOB orderbook (executable, not Gamma mid-price). */
  bestAsk: number;
  /** Available size at best ask (depth cap for sizing). */
  bestAskSize: number;
  /** Whether this market charges taker fees. */
  feesEnabled: boolean;
}

/** A complete NegRisk arb opportunity (all legs of one event). */
export interface NegRiskArbOpportunity {
  eventId: string;
  eventTitle: string;
  legs: NegRiskLeg[];
  /** Sum of all best asks across legs, per share. */
  sumAsks: number;
  /** Estimated fee sum across all legs, per share (multiply by shares for total USD fees). */
  totalFeesPerShare: number;
  /** Net edge per share = 1.0 − sumAsks − totalFeesPerShare. */
  edge: number;
  /** Gross edge per share = 1.0 − sumAsks (before fees). */
  grossEdge: number;
  /** Fraction of event outcomes that have usable orderbooks. */
  coverageRatio: number;
  /** Minimum depth (shares) across all legs — caps arb sizing. */
  minDepthShares: number;
}

/** Result of executing a NegRisk arb. */
export interface NegRiskArbResult {
  eventId: string;
  success: boolean;
  /** Index of the last successfully filled leg (-1 if first leg failed). */
  lastFilledLegIndex: number;
  totalLegs: number;
  totalCostUsd: number;
  numShares: number;
  edge: number;
  error?: string;
  legResults: { marketId: string; success: boolean; costUsd: number; error?: string }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dedupKey(eventId: string): string {
  return `${DEDUP_PREFIX}${eventId}`;
}

function withTimeout<T>(promise: Promise<T>, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('CLOB order timeout'));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Fetch CLOB orderbooks for a batch of token IDs with bounded concurrency.
 * Returns a Map<tokenId, { bestAsk, bestAskSize }> for tokens that have asks.
 */
async function fetchOrderbooks(
  tokenIds: string[],
  concurrency: number,
): Promise<Map<string, { bestAsk: number; bestAskSize: number }>> {
  const results = new Map<string, { bestAsk: number; bestAskSize: number }>();

  // Process in batches of `concurrency`
  for (let i = 0; i < tokenIds.length; i += concurrency) {
    const batch = tokenIds.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map(async (tokenId) => {
        const book = await getClobOrderBook(tokenId);
        return { tokenId, book };
      }),
    );

    for (const result of settled) {
      if (result.status !== 'fulfilled' || !result.value.book) continue;
      const { tokenId, book } = result.value;
      // Order-agnostic touch: asks[0] on a REST book is the WORST ask
      // (best-at-the-END ordering) — reading it made every leg look ~0.99 so
      // outcome sums never dropped below 1 and no arb could ever surface.
      const best = getBookTouchLevels(book).bestAsk;
      if (!best || best.price <= 0 || best.size <= 0) continue;
      results.set(tokenId, { bestAsk: best.price, bestAskSize: best.size });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Scan NegRisk events for multi-outcome arb opportunities.
 *
 * Two-stage filter:
 *   1. Quick-reject on Gamma outcomePrices (best-bid) when sum >= 1.0
 *   2. Fetch CLOB orderbooks for surviving candidates and compute executable edge
 */
export async function scanNegRiskArb(redis: Redis): Promise<NegRiskArbOpportunity[]> {
  const cfg = loadConfig();
  const events = await getNegRiskEvents({ limit: cfg.NEGRISK_ARB_MAX_EVENTS });
  if (events.length === 0) return [];

  const opportunities: NegRiskArbOpportunity[] = [];

  for (const event of events) {
    const markets = (event.markets ?? []).filter(
      (m: GammaMarket) => m.active && !m.closed,
    );
    const totalMarkets = markets.length;
    if (totalMarkets < 2) continue;
    if (totalMarkets > cfg.NEGRISK_ARB_MAX_OUTCOMES) {
      logger.debug('[negrisk-arb] skipping event — too many outcomes', {
        eventId: event.id,
        title: event.title,
        outcomes: totalMarkets,
        max: cfg.NEGRISK_ARB_MAX_OUTCOMES,
      });
      continue;
    }

    // Dedup check/claim — set key even during shadow-logging to avoid
    // re-fetching orderbooks for the same event every scan cycle
    const dedupClaimed = await redis.set(
      dedupKey(event.id),
      '1',
      'EX',
      cfg.NEGRISK_ARB_DEDUP_TTL_S,
      'NX',
    );
    if (dedupClaimed !== 'OK') continue;

    // ── Stage 1: Quick-reject on Gamma outcomePrices ───────────────────
    let gammaAskSum = 0;
    let parseable = true;
    const marketMeta: {
      market: GammaMarket;
      yesTokenId: string;
    }[] = [];

    for (const m of markets) {
      try {
        const prices = parseOutcomePrices(m.outcomePrices);
        const tokens = parseClobTokenIds(m.clobTokenIds);
        if (prices.length < 1 || tokens.length < 1) { parseable = false; break; }
        const yesPrice = parseFloat(prices[0]!);
        if (!isFinite(yesPrice)) { parseable = false; break; }
        gammaAskSum += yesPrice;
        marketMeta.push({ market: m, yesTokenId: tokens[0]! });
      } catch {
        parseable = false;
        break;
      }
    }

    if (!parseable) continue;
    // If sum of Gamma outcomePrices >= 1.0, no arb even on optimistic pricing
    if (gammaAskSum >= 1.0) continue;

    // ── Stage 2: Fetch CLOB orderbooks for executable pricing ──────────
    const tokenIds = marketMeta.map((mm) => mm.yesTokenId);
    const orderbooks = await fetchOrderbooks(tokenIds, ORDERBOOK_CONCURRENCY);

    // Build legs from orderbook data
    const legs: NegRiskLeg[] = [];
    for (const mm of marketMeta) {
      const ob = orderbooks.get(mm.yesTokenId);
      if (!ob) continue; // no orderbook → this outcome won't be in the arb
      legs.push({
        marketId: mm.market.id,
        question: mm.market.question,
        yesTokenId: mm.yesTokenId,
        bestAsk: ob.bestAsk,
        bestAskSize: ob.bestAskSize,
        feesEnabled: mm.market.feesEnabled === true,
      });
    }

    // Coverage check
    const coverageRatio = totalMarkets > 0 ? legs.length / totalMarkets : 0;
    if (coverageRatio < cfg.NEGRISK_ARB_MIN_COVERAGE) {
      logger.debug('[negrisk-arb] skipping event — insufficient coverage', {
        eventId: event.id,
        title: event.title,
        coverage: coverageRatio.toFixed(2),
        legsWithBook: legs.length,
        totalMarkets,
      });
      continue;
    }

    // Compute edge using executable ask prices
    const sumAsks = legs.reduce((acc, l) => acc + l.bestAsk, 0);
    const feeRate = cfg.NEGRISK_ARB_FEE_RATE;
    const totalFeesPerShare = legs.reduce(
      (acc, l) =>
        acc + (l.feesEnabled ? l.bestAsk * (1 - l.bestAsk) * feeRate : 0),
      0,
    );
    const grossEdge = 1.0 - sumAsks;
    const edge = grossEdge - totalFeesPerShare;

    if (edge < cfg.NEGRISK_ARB_MIN_EDGE) continue;

    const minDepthShares = Math.min(...legs.map((l) => l.bestAskSize));

    opportunities.push({
      eventId: event.id,
      eventTitle: event.title,
      legs,
      sumAsks,
      totalFeesPerShare,
      edge,
      grossEdge,
      coverageRatio,
      minDepthShares,
    });
  }

  return opportunities.sort((a, b) => b.edge - a.edge);
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Execute a NegRisk multi-leg arb: buy YES on every outcome sequentially.
 *
 * Sequential FOK execution — same pattern as binary arb.  If any leg fails
 * after the first succeeds, record unhedged positions + Telegram alert.
 */
export async function executeNegRiskArb(
  opp: NegRiskArbOpportunity,
  redis: Redis,
): Promise<NegRiskArbResult> {
  const cfg = loadConfig();

  // Sizing: constrained by bankroll fraction AND thinnest orderbook depth
  const bankroll = await getBankroll(redis);
  const totalBudget = bankroll * cfg.NEGRISK_ARB_MAX_STAKE_FRACTION;
  if (totalBudget < 2.0 || opp.sumAsks <= 0) {
    return {
      eventId: opp.eventId,
      success: false,
      lastFilledLegIndex: -1,
      totalLegs: opp.legs.length,
      totalCostUsd: 0,
      numShares: 0,
      edge: opp.edge,
      error: 'stake_too_small',
      legResults: [],
    };
  }

  const maxSharesFromBudget = totalBudget / opp.sumAsks;
  const shares = Math.min(maxSharesFromBudget, opp.minDepthShares);

  // Validate every leg meets CLOB minimum
  for (const leg of opp.legs) {
    const legCost = shares * leg.bestAsk;
    if (legCost < CLOB_MIN_ORDER_USD) {
      return {
        eventId: opp.eventId,
        success: false,
        lastFilledLegIndex: -1,
        totalLegs: opp.legs.length,
        totalCostUsd: 0,
        numShares: 0,
        edge: opp.edge,
        error: `leg_below_minimum:${leg.marketId}:$${legCost.toFixed(2)}`,
        legResults: [],
      };
    }
  }

  // Record global trade activity BEFORE execution so the governor reflects
  // submitted orders even if execution partially fails
  await recordGlobalTrade(redis, 'polymarket');

  logger.info('[negrisk-arb] executing multi-leg arb', {
    eventId: opp.eventId,
    title: opp.eventTitle,
    legs: opp.legs.length,
    shares: shares.toFixed(4),
    sumAsks: opp.sumAsks.toFixed(4),
    edge: opp.edge.toFixed(4),
    totalBudget: totalBudget.toFixed(2),
  });

  // ── Sequential FOK execution ──────────────────────────────────────────
  const legResults: NegRiskArbResult['legResults'] = [];
  let lastFilledLegIndex = -1;
  let totalCostUsd = 0;

  for (let i = 0; i < opp.legs.length; i++) {
    const leg = opp.legs[i]!;
    const legCostUsd = shares * leg.bestAsk;

    // Pace between legs to avoid CLOB order rate limits on multi-leg events
    if (i > 0) await delay(INTER_LEG_DELAY_MS);

    const result = await withTimeout(
      submitClobBuy({
        tokenId: leg.yesTokenId,
        amountUsd: legCostUsd,
        orderType: 'FOK',
      }),
    ).catch((err: unknown) => ({ success: false as const, error: String(err) }));

    legResults.push({
      marketId: leg.marketId,
      success: result.success,
      costUsd: result.success ? legCostUsd : 0,
      ...(result.error ? { error: result.error } : {}),
    });

    if (!result.success) {
      logger.warn('[negrisk-arb] leg failed — aborting remaining', {
        eventId: opp.eventId,
        legIndex: i,
        totalLegs: opp.legs.length,
        marketId: leg.marketId,
        error: result.error,
      });
      break;
    }

    totalCostUsd += legCostUsd;
    lastFilledLegIndex = i;

    logger.debug('[negrisk-arb] leg filled', {
      eventId: opp.eventId,
      legIndex: i,
      marketId: leg.marketId,
      costUsd: legCostUsd.toFixed(2),
    });
  }

  // ── Handle outcomes ───────────────────────────────────────────────────

  // All legs filled → success
  if (lastFilledLegIndex === opp.legs.length - 1) {
    // Use same per-leg fee model as scanner: fee = p*(1-p)*feeRate per leg
    const feeAdjustedCost = totalCostUsd + opp.totalFeesPerShare * shares;
    await deductStake(redis, feeAdjustedCost);

    logger.info('[negrisk-arb] all legs filled — success', {
      eventId: opp.eventId,
      title: opp.eventTitle,
      legs: opp.legs.length,
      totalCostUsd: totalCostUsd.toFixed(4),
      feeAdjustedCost: feeAdjustedCost.toFixed(4),
      shares: shares.toFixed(4),
      edge: opp.edge.toFixed(4),
      guaranteedReturn: shares.toFixed(4),
      projectedProfit: (shares - feeAdjustedCost).toFixed(4),
    });

    return {
      eventId: opp.eventId,
      success: true,
      lastFilledLegIndex,
      totalLegs: opp.legs.length,
      totalCostUsd,
      numShares: shares,
      edge: opp.edge,
      legResults,
    };
  }

  // First leg failed → clean abort, clear dedup so scanner can re-evaluate
  if (lastFilledLegIndex === -1) {
    await redis.del(dedupKey(opp.eventId)).catch(() => {});
    return {
      eventId: opp.eventId,
      success: false,
      lastFilledLegIndex,
      totalLegs: opp.legs.length,
      totalCostUsd: 0,
      numShares: 0,
      edge: opp.edge,
      error: 'first_leg_failed',
      legResults,
    };
  }

  // Partial fill: legs 0..k filled, k+1 failed → UNHEDGED
  logger.error('[negrisk-arb] CRITICAL: partial fill — unhedged positions', {
    eventId: opp.eventId,
    title: opp.eventTitle,
    filledLegs: lastFilledLegIndex + 1,
    totalLegs: opp.legs.length,
    totalCostUsd: totalCostUsd.toFixed(4),
  });

  // Record each filled leg as a tracked position
  for (let i = 0; i <= lastFilledLegIndex; i++) {
    const leg = opp.legs[i]!;
    const legCostUsd = shares * leg.bestAsk;
    await recordPosition(redis, {
      marketId: leg.marketId,
      executionId: `negrisk-${opp.eventId}-leg${i.toString()}-${Date.now().toString()}`,
      question: leg.question,
      direction: 'YES',
      entryPrice: leg.bestAsk,
      stakeUsd: legCostUsd,
      sharesHeld: shares,
      edgeMagnitude: opp.edge,
      openedAt: new Date().toISOString(),
      sourcedFrom: `negrisk-arb:unhedged:${opp.eventId}`,
      executionVenue: 'clob',
      priceZone: priceZoneOf(leg.bestAsk),
    }).catch((err: unknown) => {
      logger.error('[negrisk-arb] failed to record unhedged position', {
        marketId: leg.marketId,
        err: String(err),
      });
    });
  }

  // Compute fees for filled legs only
  const filledLegFees = opp.legs
    .slice(0, lastFilledLegIndex + 1)
    .reduce(
      (acc, l) =>
        acc + (l.feesEnabled ? l.bestAsk * (1 - l.bestAsk) * cfg.NEGRISK_ARB_FEE_RATE : 0),
      0,
    );
  await deductStake(redis, totalCostUsd + filledLegFees * shares);

  // Telegram alert
  const failedLeg = opp.legs[lastFilledLegIndex + 1];
  const failedResult = legResults[lastFilledLegIndex + 1];
  const alertOpts: Parameters<typeof notifyUnhedgedNegRiskPosition>[0] = {
    eventId: opp.eventId,
    eventTitle: opp.eventTitle,
    filledLegs: lastFilledLegIndex + 1,
    totalLegs: opp.legs.length,
    totalCostUsd,
    failedLegMarketId: failedLeg?.marketId ?? 'unknown',
  };
  if (failedResult?.error) alertOpts.failedLegError = failedResult.error;
  notifyUnhedgedNegRiskPosition(alertOpts).catch((err: unknown) => {
    logger.error('[negrisk-arb] alert failed', { err: String(err) });
  });

  return {
    eventId: opp.eventId,
    success: false,
    lastFilledLegIndex,
    totalLegs: opp.legs.length,
    totalCostUsd,
    numShares: shares,
    edge: opp.edge,
    error: `partial_fill:${(lastFilledLegIndex + 1).toString()}/${opp.legs.length.toString()}`,
    legResults,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run a full NegRisk arb scan cycle.
 *
 * Always shadow-logs found opportunities regardless of NEGRISK_ARB_ENABLED.
 * Only executes when enabled.
 */
export async function runNegRiskArbScan(redis: Redis): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.ARB_ENABLED || !cfg.CLOB_FALLBACK_ENABLED) return;

  try {
    const opportunities = await scanNegRiskArb(redis);

    if (opportunities.length === 0) {
      logger.debug('[negrisk-arb] scan complete — no opportunities');
      return;
    }

    // Always shadow-log
    for (const opp of opportunities) {
      logger.info(
        cfg.NEGRISK_ARB_ENABLED
          ? '[negrisk-arb] opportunity found'
          : '[negrisk-arb] opportunity found (shadow)',
        {
          eventId: opp.eventId,
          title: opp.eventTitle,
          legs: opp.legs.length,
          sumAsks: opp.sumAsks.toFixed(4),
          grossEdge: opp.grossEdge.toFixed(4),
          totalFeesPerShare: opp.totalFeesPerShare.toFixed(4),
          edge: opp.edge.toFixed(4),
          coverage: opp.coverageRatio.toFixed(2),
          minDepthShares: opp.minDepthShares.toFixed(2),
          wouldExecute: cfg.NEGRISK_ARB_ENABLED,
        },
      );
      void enqueueWrite('shadow_observations', {
        kind: 'negrisk_arb',
        source: 'arb',
        wouldBlock: !cfg.NEGRISK_ARB_ENABLED,
        metricValue: opp.edge,
        threshold: cfg.NEGRISK_ARB_MIN_EDGE,
        payload: {
          eventId: opp.eventId,
          title: opp.eventTitle,
          legs: opp.legs.length,
          sumAsks: opp.sumAsks,
          grossEdge: opp.grossEdge,
          totalFeesPerShare: opp.totalFeesPerShare,
          coverage: opp.coverageRatio,
          minDepthShares: opp.minDepthShares,
          wouldExecute: cfg.NEGRISK_ARB_ENABLED,
          scannerEnabled: cfg.NEGRISK_ARB_ENABLED,
        },
      });
    }

    if (!cfg.NEGRISK_ARB_ENABLED) return;

    // Global governor check — only gate execution, not scanning/shadow-logging
    const gov = await checkGlobalGovernor(redis, 'polymarket');
    if (!gov.ok) {
      logger.debug('[negrisk-arb] global governor throttle, skipping execution');
      return;
    }

    const toExecute = opportunities.slice(0, cfg.NEGRISK_ARB_MAX_PER_RUN);
    for (const opp of toExecute) {
      await executeNegRiskArb(opp, redis);
    }
  } catch (err: unknown) {
    logger.error('[negrisk-arb] scan failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
