import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { shouldDropSampledDecision } from './decisionSampling.js';
import { hasOpenPosition, getOpenPositions } from '../execution/positionLedger.js';
import { getAllCachedAssetCtxs, fundingRateToApr } from './hlAssetCtxCache.js';
import type { TradeSignal } from '../mapping/index.js';

export function fundingCooldownKey(symbol: string, direction: 'LONG' | 'SHORT'): string {
  return `hl-funding:cooldown:${symbol}:${direction}`;
}

async function countOpenFundingPositions(redis: Redis): Promise<number> {
  const positions = await getOpenPositions(redis);
  return positions.filter((p) => p.sourcedFrom === 'hl-funding').length;
}

/**
 * Scan all HL perps for extreme funding-rate conditions and return contra
 * TradeSignals. One bulk HTTP call per tick via the bulk asset-ctx cache.
 *
 * Entry: |APR| > HL_FUNDING_SCANNER_ENTRY_APR_THRESHOLD
 * Direction: SHORT when funding is positive (crowded longs paying), LONG when negative.
 * Exits are handled by the futures monitor (funding-normalized, sign-flip, SL, TP, max-hold).
 * Ships dark: HL_FUNDING_SCANNER_ENABLED=false — shadow logs always run.
 */
export async function scanHlFunding(redis: Redis): Promise<TradeSignal[]> {
  const cfg = loadConfig();
  const all = await getAllCachedAssetCtxs(redis, cfg.HL_FUNDING_SCANNER_BULK_CTX_TTL_SEC);

  const denylist = cfg.HL_FUNDING_SCANNER_SYMBOL_DENYLIST
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  // Count open funding positions via Redis ledger (fail open so a Redis hiccup
  // doesn't suppress shadow logs for the whole scan).
  const openCount = await countOpenFundingPositions(redis).catch(() => 0);

  const signals: TradeSignal[] = [];

  for (const [symbol, ctx] of Object.entries(all)) {
    const apr = fundingRateToApr(ctx.fundingRate);
    const absApr = Math.abs(apr);
    const direction: 'LONG' | 'SHORT' = apr > 0 ? 'SHORT' : 'LONG';
    const decisionId = randomUUID();

    const belowThreshold = absApr <= cfg.HL_FUNDING_SCANNER_ENTRY_APR_THRESHOLD;
    const oiUsd = ctx.openInterest * ctx.markPrice;
    const belowMinOi = oiUsd < cfg.HL_FUNDING_SCANNER_MIN_OI_USD;

    // Always shadow-log every symbol so we can analyse signal distribution
    // without enabling live entries.
    void enqueueWrite('shadow_observations', {
      kind: 'hl_funding_scan',
      source: 'hl-funding',
      symbol,
      direction,
      wouldBlock: !cfg.HL_FUNDING_SCANNER_ENABLED || belowThreshold || belowMinOi,
      metricValue: apr,
      threshold: cfg.HL_FUNDING_SCANNER_ENTRY_APR_THRESHOLD,
      payload: {
        apr,
        fundingRate: ctx.fundingRate,
        markPrice: ctx.markPrice,
        openInterest: ctx.openInterest,
        oiUsd,
      },
    }).catch(() => {});

    if (denylist.includes(symbol.toUpperCase())) {
      logDecision(decisionId, symbol, direction, false, 'denylist');
      continue;
    }

    if (belowMinOi) {
      logDecision(decisionId, symbol, direction, false, 'oi_below_minimum');
      continue;
    }

    if (belowThreshold) {
      logDecision(decisionId, symbol, direction, false, 'apr_below_threshold');
      continue;
    }

    const lossCooldown = await redis.get(`futures:loss-cooldown:${symbol}`).catch(() => null);
    if (lossCooldown) {
      logDecision(decisionId, symbol, direction, false, 'loss_cooldown');
      continue;
    }

    const fundingCooldown = await redis.get(fundingCooldownKey(symbol, direction)).catch(() => null);
    if (fundingCooldown) {
      logDecision(decisionId, symbol, direction, false, 'funding_cooldown');
      continue;
    }

    // HL executor blocks both same-side and opposite-side stacking to prevent
    // double-funded margin with net-zero exposure. Pre-gate here to avoid
    // emitting signals that will always be dropped downstream.
    const opposite: 'LONG' | 'SHORT' = direction === 'LONG' ? 'SHORT' : 'LONG';
    const [sideOpen, oppositeSideOpen] = await Promise.all([
      hasOpenPosition(redis, symbol, direction),
      hasOpenPosition(redis, symbol, opposite),
    ]);
    if (sideOpen || oppositeSideOpen) {
      logDecision(decisionId, symbol, direction, false, 'position_already_open');
      continue;
    }

    if (!cfg.HL_FUNDING_SCANNER_ENABLED) {
      logDecision(decisionId, symbol, direction, false, 'scanner_dark');
      continue;
    }

    // Enforce per-scan cap: stop emitting once we'd hit the limit.
    if (openCount + signals.length >= cfg.HL_FUNDING_SCANNER_MAX_POSITIONS) {
      logDecision(decisionId, symbol, direction, false, 'max_positions_reached');
      continue;
    }

    const stakeUsd = Math.min(cfg.HL_FUNDING_SCANNER_STAKE_USD, cfg.FUTURES_MAX_PER_TRADE_USD);

    logger.info('[hl-funding] signal', {
      symbol,
      direction,
      apr: apr.toFixed(2),
      oiUsd: Math.round(oiUsd),
      stakeUsd,
    });

    logDecision(decisionId, symbol, direction, true);

    signals.push({
      marketId: symbol,
      question: `HL funding ${direction} ${symbol}`,
      direction,
      stakeUsd,
      edgeMagnitude: Math.min(1, absApr / 400),
      outcomePrice: ctx.markPrice,
      sourcedFrom: 'hl-funding',
      reasoning: `Funding APR=${apr.toFixed(1)}% (threshold=${cfg.HL_FUNDING_SCANNER_ENTRY_APR_THRESHOLD}%); OI=$${Math.round(oiUsd / 1e6)}M; contra ${direction}`,
      isFutures: true,
      source: 'hl-funding',
      eventTs: Date.now(),
      decisionId,
      entryFundingApr: apr,
    });
  }

  return signals;
}

function logDecision(
  decisionId: string,
  symbol: string,
  direction: string,
  hasTrade: boolean,
  skipReason?: string,
): void {
  // Throttle the per-tick skip flood: persist every trade, sample skip rows at
  // HL_DECISION_LOG_SAMPLE_RATE to bound signal_decisions write rate. logDecision
  // is module-level (9 skip call sites), so read the rate here rather than thread it.
  if (shouldDropSampledDecision(hasTrade, loadConfig().HL_DECISION_LOG_SAMPLE_RATE)) return;
  void enqueueWrite('signal_decisions', {
    decisionId,
    source: 'hl-funding' as const,
    marketId: symbol,
    question: `HL funding ${direction} ${symbol}`,
    category: 'futures',
    direction,
    hasTrade,
    skipReason: skipReason ?? (hasTrade ? undefined : 'other'),
  }).catch(() => {});
}
