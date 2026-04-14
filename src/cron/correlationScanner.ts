/**
 * Correlation Violation Scanner (every 15min)
 *
 * Reads the constraint graph from Redis, fetches current market prices from
 * the watchlist cache, detects constraint violations, and executes single-leg
 * trades on the tradeTarget side via executeSignal().
 *
 * Ships dark: CORRELATION_SCANNER_ENABLED=false
 *
 * Log marker: [corr-scan]
 * Dedup key:  correlation:attempted:{marketId}  (TTL: CORRELATION_DEDUP_TTL_S)
 */

import 'dotenv/config';
import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getBankroll } from '../shared/bankroll.js';
import { getCachedMarkets } from '../shared/watchlist.js';
import { parseOutcomePrices, parseClobTokenIds } from '../mapping/gamma.js';
import { executeSignal } from '../execution/executor.js';
import { priceZoneOf } from '../shared/zones.js';
import { loadAllConstraints } from '../correlation/constraintGraph.js';
import { detectViolations } from '../correlation/violationDetector.js';
import { enqueueWrite } from '../db/writeQueue.js';
import type { MarketPrice, ConstraintViolation } from '../correlation/types.js';
import type { TradeSignal } from '../mapping/index.js';

const DEDUP_PREFIX = 'correlation:attempted:';

/**
 * Build a price map from cached markets.
 */
async function buildPriceMap(redis: Redis): Promise<Map<string, MarketPrice>> {
  const rawMarkets = await getCachedMarkets(redis);
  const map = new Map<string, MarketPrice>();

  for (const market of rawMarkets) {
    try {
      // Binary-only gate.
      if (market.outcomes) {
        const outcomes = typeof market.outcomes === 'string'
          ? (JSON.parse(market.outcomes) as unknown[])
          : market.outcomes;
        if (Array.isArray(outcomes) && outcomes.length > 2) continue;
      }

      // Skip expired markets.
      if (market.endDate && new Date(market.endDate).getTime() <= Date.now()) continue;

      const prices = parseOutcomePrices(market.outcomePrices);
      const yesPrice = parseFloat(prices[0] ?? '0');
      if (!isFinite(yesPrice)) continue;

      const noPrice = parseFloat(prices[1] ?? '0');

      const clobTokenIds = parseClobTokenIds(market.clobTokenIds);
      if (clobTokenIds.length < 2) continue;

      const liquidity = parseFloat(market.liquidity ?? '0');

      map.set(market.id, {
        marketId: market.id,
        yesPrice,
        noPrice: isFinite(noPrice) ? noPrice : 1 - yesPrice,
        clobTokenIds,
        conditionId: market.conditionId,
        question: market.question,
        endDate: market.endDate,
        liquidity,
      });
    } catch {
      // Skip unparseable markets.
    }
  }
  return map;
}

/**
 * Build a TradeSignal from a constraint violation.
 */
function buildSignal(
  violation: ConstraintViolation,
  target: MarketPrice,
  other: MarketPrice,
  stakeUsd: number,
): TradeSignal {
  return {
    marketId: target.marketId,
    conditionId: target.conditionId,
    clobTokenIds: target.clobTokenIds,
    question: target.question,
    direction: violation.direction,
    stakeUsd,
    edgeMagnitude: violation.edge,
    outcomePrice: violation.direction === 'YES' ? target.yesPrice : target.noPrice,
    priceZone: priceZoneOf(violation.direction === 'YES' ? target.yesPrice : target.noPrice),
    sourcedFrom: `correlation-arb (${violation.constraint.type}: ${other.question.slice(0, 60)})`,
    source: 'correlation-arb',
    reasoning:
      `Correlation arb: ${violation.constraint.type} constraint violated. ` +
      `P(A)=${violation.priceA.toFixed(3)}, P(B)=${violation.priceB.toFixed(3)}, ` +
      `gap=${violation.violationAmount.toFixed(3)}. ${violation.constraint.reasoning}`,
    endDate: target.endDate ?? undefined,
  };
}

/**
 * Resolve the target (tradeTarget) and other market from a violation.
 */
function resolveTargets(
  violation: ConstraintViolation,
  prices: Map<string, MarketPrice>,
): { target: MarketPrice; other: MarketPrice } | null {
  const mA = prices.get(violation.constraint.marketIdA);
  const mB = prices.get(violation.constraint.marketIdB);
  if (!mA || !mB) return null;

  if (violation.tradeTarget === 'A') return { target: mA, other: mB };
  return { target: mB, other: mA };
}

/**
 * Run the correlation violation scanner.
 */
export async function runCorrelationScan(redis: Redis): Promise<void> {
  const cfg = loadConfig();

  // 1. Load constraint graph.
  const constraints = await loadAllConstraints(redis);
  if (constraints.length === 0) {
    logger.debug('[corr-scan] no constraints in graph — discovery may not have run yet');
    return;
  }

  // 2. Build price map from cache.
  const prices = await buildPriceMap(redis);
  if (prices.size === 0) {
    logger.warn('[corr-scan] market cache empty');
    return;
  }

  // 3. Detect violations.
  const violations = detectViolations(constraints, prices, cfg.CORRELATION_MIN_EDGE);

  // 4. Filter violations by liquidity on both sides.
  const liquidViolations = violations.filter((v) => {
    const mA = prices.get(v.constraint.marketIdA);
    const mB = prices.get(v.constraint.marketIdB);
    return (
      mA && mB &&
      mA.liquidity >= cfg.CORRELATION_MIN_LIQUIDITY &&
      mB.liquidity >= cfg.CORRELATION_MIN_LIQUIDITY
    );
  });

  logger.info('[corr-scan] scan summary', {
    constraints: constraints.length,
    marketsInCache: prices.size,
    violations: violations.length,
    liquidViolations: liquidViolations.length,
    enabled: cfg.CORRELATION_SCANNER_ENABLED,
  });

  if (liquidViolations.length === 0) return;

  const bankrollUsd = await getBankroll(redis);
  let executed = 0;

  for (const violation of liquidViolations) {
    if (executed >= cfg.CORRELATION_MAX_TRADES_PER_RUN) break;

    const targets = resolveTargets(violation, prices);
    if (!targets) continue;

    const { target, other } = targets;

    const stakeUsd = Math.min(
      bankrollUsd * cfg.CORRELATION_MAX_STAKE_FRACTION,
      cfg.CORRELATION_MAX_STAKE_USD,
    );

    const wouldExecute = cfg.CORRELATION_SCANNER_ENABLED && stakeUsd > 0;

    // Shadow mode: short-lived dedup to avoid log spam.
    if (!wouldExecute) {
      const shadowKey = `${DEDUP_PREFIX}shadow:${target.marketId}:${violation.constraint.id}`;
      const shadowClaimed = await redis.set(shadowKey, '1', 'EX', 300, 'NX');
      if (!shadowClaimed) continue;

      logger.info('[corr-scan] violation found', {
        constraintType: violation.constraint.type,
        targetMarketId: target.marketId,
        targetQuestion: target.question.slice(0, 100),
        otherMarketId: other.marketId,
        otherQuestion: other.question.slice(0, 100),
        priceA: violation.priceA.toFixed(4),
        priceB: violation.priceB.toFixed(4),
        direction: violation.direction,
        edge: violation.edge.toFixed(4),
        stakeUsd: stakeUsd.toFixed(2),
        wouldExecute: false,
        shadow: true,
      });
      void enqueueWrite('shadow_observations', {
        kind: 'correlation',
        source: 'arb',
        marketId: target.marketId,
        direction: violation.direction,
        wouldBlock: true,
        metricValue: violation.edge,
        threshold: cfg.CORRELATION_MIN_EDGE,
        payload: {
          constraintType: violation.constraint.type,
          constraintId: violation.constraint.id,
          targetQuestion: target.question.slice(0, 200),
          otherMarketId: other.marketId,
          otherQuestion: other.question.slice(0, 200),
          priceA: violation.priceA,
          priceB: violation.priceB,
          stakeUsd,
          wouldExecute: false,
          shadow: true,
          scannerEnabled: cfg.CORRELATION_SCANNER_ENABLED,
        },
      });
      continue;
    }

    // Real execution: full-TTL dedup.
    const dedupKey = `${DEDUP_PREFIX}${target.marketId}:${violation.constraint.id}`;
    const claimed = await redis.set(dedupKey, '1', 'EX', cfg.CORRELATION_DEDUP_TTL_S, 'NX');
    if (!claimed) {
      logger.debug('[corr-scan] dedup hit — skipping', { marketId: target.marketId, edgeId: violation.constraint.id });
      continue;
    }

    logger.info('[corr-scan] violation found', {
      constraintType: violation.constraint.type,
      targetMarketId: target.marketId,
      targetQuestion: target.question.slice(0, 100),
      otherMarketId: other.marketId,
      otherQuestion: other.question.slice(0, 100),
      priceA: violation.priceA.toFixed(4),
      priceB: violation.priceB.toFixed(4),
      direction: violation.direction,
      edge: violation.edge.toFixed(4),
      stakeUsd: stakeUsd.toFixed(2),
      wouldExecute: true,
      shadow: false,
    });
    void enqueueWrite('shadow_observations', {
      kind: 'correlation',
      source: 'arb',
      marketId: target.marketId,
      direction: violation.direction,
      wouldBlock: false,
      metricValue: violation.edge,
      threshold: cfg.CORRELATION_MIN_EDGE,
      payload: {
        constraintType: violation.constraint.type,
        constraintId: violation.constraint.id,
        targetQuestion: target.question.slice(0, 200),
        otherMarketId: other.marketId,
        otherQuestion: other.question.slice(0, 200),
        priceA: violation.priceA,
        priceB: violation.priceB,
        stakeUsd,
        wouldExecute: true,
        shadow: false,
        scannerEnabled: cfg.CORRELATION_SCANNER_ENABLED,
      },
    });

    const signal = buildSignal(violation, target, other, stakeUsd);
    const result = await executeSignal(signal, redis, stakeUsd);

    if (!result.skipped) {
      logger.info('[corr-scan] trade executed', {
        marketId: target.marketId,
        direction: violation.direction,
        stakeUsd,
        venue: result.executionVenue,
        entryPrice: result.entryPrice,
      });
      executed++;
    } else {
      logger.info('[corr-scan] trade skipped by executor', {
        marketId: target.marketId,
        skipReason: result.skipReason,
      });
    }
  }
}

// ── Standalone entrypoint (cron) ──────────────────────────────────────────

async function main() {
  const { getRedis, closeRedis } = await import('../shared/redis.js');
  const redis = getRedis();
  try {
    await runCorrelationScan(redis);
  } finally {
    await closeRedis();
  }
}

const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/correlationScanner.js') === true;

if (isMainModule) {
  void main().catch((err: unknown) => {
    logger.error('[corr-scan] fatal error', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
