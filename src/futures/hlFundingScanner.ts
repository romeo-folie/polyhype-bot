import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { hasOpenPosition } from '../execution/positionLedger.js';
import { getAllCachedAssetCtxs, fundingRateToApr } from './hlAssetCtxCache.js';
import type { TradeSignal } from '../mapping/index.js';

export function fundingCooldownKey(symbol: string, direction: 'LONG' | 'SHORT'): string {
  return `hl-funding:cooldown:${symbol}:${direction}`;
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

  const signals: TradeSignal[] = [];

  for (const [symbol, ctx] of Object.entries(all)) {
    const apr = fundingRateToApr(ctx.fundingRate);
    const absApr = Math.abs(apr);
    const direction: 'LONG' | 'SHORT' = apr > 0 ? 'SHORT' : 'LONG';
    const decisionId = randomUUID();

    const belowThreshold = absApr <= cfg.HL_FUNDING_SCANNER_ENTRY_APR_THRESHOLD;

    // Always shadow-log every symbol so we can analyse signal distribution
    // without enabling live entries (kind=hl_funding_scan, would_block=true when dark).
    void enqueueWrite('shadow_observations', {
      kind: 'hl_funding_scan',
      source: 'hl-funding',
      symbol,
      direction,
      wouldBlock: !cfg.HL_FUNDING_SCANNER_ENABLED || belowThreshold,
      metricValue: apr,
      payload: {
        apr,
        fundingRate: ctx.fundingRate,
        markPrice: ctx.markPrice,
        openInterest: ctx.openInterest,
        threshold: cfg.HL_FUNDING_SCANNER_ENTRY_APR_THRESHOLD,
      },
    }).catch(() => {});

    if (denylist.includes(symbol.toUpperCase())) {
      logDecision(decisionId, symbol, direction, false, 'denylist');
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

    // Same-side dedup: skip if any position (any source) is open on this side.
    // Opposite-side is allowed — HL nets at position level.
    const sideOpen = await hasOpenPosition(redis, symbol, direction);
    if (sideOpen) {
      logDecision(decisionId, symbol, direction, false, 'same_side_position_open');
      continue;
    }

    if (!cfg.HL_FUNDING_SCANNER_ENABLED) {
      logDecision(decisionId, symbol, direction, false, 'scanner_dark');
      continue;
    }

    const stakeUsd = Math.min(cfg.HL_FUNDING_SCANNER_STAKE_USD, cfg.FUTURES_MAX_PER_TRADE_USD);

    logger.info('[hl-funding] signal', {
      symbol,
      direction,
      apr: apr.toFixed(2),
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
      reasoning: `Funding APR=${apr.toFixed(1)}% (threshold=${cfg.HL_FUNDING_SCANNER_ENTRY_APR_THRESHOLD}%); contra ${direction}`,
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
