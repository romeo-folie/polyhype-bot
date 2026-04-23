import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Position } from '../execution/positionLedger.js';
import { recordOutcome, inferCategory, inferSource } from './outcomeRecorder.js';
import { recordUpDownOutcome } from './updownThrottle.js';
import { loadConfig } from './config.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { logger } from './logger.js';

/**
 * Record the outcome of a position exit. Centralises field mapping from Position
 * to the recordOutcome schema, reducing boilerplate across takeProfitExecutor and
 * resolutionRedeemer.
 */
export async function recordPositionOutcome(
  redis: Redis,
  position: Omit<
    Pick<
      Position,
      | 'executionId'
      | 'sourcedFrom'
      | 'question'
      | 'direction'
      | 'consensusProbability'
      | 'edgeMagnitude'
      | 'openedAt'
      | 'executionVenue'
      | 'modeConfigured'
      | 'entryExecutionPath'
      | 'entryOrderType'
      | 'fallbackReason'
      | 'decisionSpreadBps'
      | 'makerPriceImprovementBps'
      | 'makerPriceImprovementUsd'
      | 'marketId'
      | 'conditionId'
      | 'entryPrice'
      | 'stakeUsd'
      | 'sharesHeld'
      | 'entryAtr'
      | 'entryAtrPct'
      | 'priceZone'
      | 'synthHedged'
      | 'pendingSettlement'
    >,
    'openedAt'
  > & {
    // `openedAt` is optional so the redeemer helper can pass undefined when
    // neither the ledger nor the raw API response carries a real timestamp.
    // Fabricating `new Date().toISOString()` would make holdingHours ≈ 0 and
    // silently skew analytics by making "unknown hold time" indistinguishable
    // from "fast exit". Downstream holdingHours calc already handles undefined.
    openedAt?: string;
  },
  opts: {
    result: 'won' | 'lost' | 'pushed';
    returnPct: number;
    executionVenueOverride?: string;
    exitReason?: string;
    /**
     * Close timestamp override in milliseconds. Used by the PM-activity
     * reconciler to record historical REDEEM events with their actual
     * redemption timestamp instead of "now" — prevents backfill from
     * making hours-old wins look like they just closed. Applies to
     * holdingHours, closedAt, and any Redis outcome-history score.
     * Defaults to `Date.now()` for the normal exit path.
     */
    closedAtMs?: number;
  },
): Promise<void> {
  const closedAtMs = opts.closedAtMs ?? Date.now();
  const outcome = {
    source: inferSource(position.sourcedFrom),
    category: inferCategory(position.question),
    question: position.question.slice(0, 200),
    direction: position.direction as 'YES' | 'NO' | 'UP' | 'DOWN',
    consensusProbability: position.consensusProbability ?? 0.5,
    divergence: position.edgeMagnitude,
    result: opts.result,
    returnPct: opts.returnPct,
    holdingHours: position.openedAt
      ? (closedAtMs - new Date(position.openedAt).getTime()) / 3600000
      : 0,
    executionVenue: opts.executionVenueOverride ?? position.executionVenue ?? 'simmer',
  } as const;

  // Pushed = exact zero PnL (rare, typically only futures with rounding). Skip
  // the W/L streak counter for it — it's neither a win nor a loss.
  if (
    (position.direction === 'UP' || position.direction === 'DOWN') &&
    opts.result !== 'pushed'
  ) {
    const cfg = loadConfig();
    await recordUpDownOutcome(
      redis,
      opts.result === 'won' ? 'W' : 'L',
      cfg.UPDOWN_PNL_WINDOW_SIZE,
    );
  }

  await recordOutcome(redis, {
    ...outcome,
    ...(position.executionId ? { executionId: position.executionId } : {}),
    ...(position.modeConfigured ? { modeConfigured: position.modeConfigured } : {}),
    ...(position.entryExecutionPath ? { entryExecutionPath: position.entryExecutionPath } : {}),
    ...(position.entryOrderType ? { entryOrderType: position.entryOrderType } : {}),
    ...(position.fallbackReason ? { fallbackReason: position.fallbackReason } : {}),
    ...(position.decisionSpreadBps !== undefined
      ? { decisionSpreadBps: position.decisionSpreadBps }
      : {}),
    ...(position.makerPriceImprovementBps !== undefined
      ? { makerPriceImprovementBps: position.makerPriceImprovementBps }
      : {}),
    ...(position.makerPriceImprovementUsd !== undefined
      ? { makerPriceImprovementUsd: position.makerPriceImprovementUsd }
      : {}),
    ...(opts.exitReason ? { exitReason: opts.exitReason } : {}),
    ...(position.priceZone !== undefined ? { priceZone: position.priceZone } : {}),
  }, {
    sourcedFrom: position.sourcedFrom,
    ...(opts.closedAtMs !== undefined ? { closedAtMs: opts.closedAtMs } : {}),
  });

  const holdingHours = position.openedAt
    ? (closedAtMs - new Date(position.openedAt).getTime()) / 3_600_000
    : 0;
  void enqueueWrite('outcomes', {
    outcomeId: randomUUID(),
    closedAt: new Date(closedAtMs).toISOString(),
    openedAt: position.openedAt,
    executionId: position.executionId,
    source: inferSource(position.sourcedFrom),
    category: inferCategory(position.question),
    marketId: position.marketId,
    conditionId: position.conditionId,
    question: position.question,
    direction: position.direction,
    consensusProbability: position.consensusProbability ?? 0.5,
    divergence: position.edgeMagnitude,
    result: opts.result,
    returnPct: opts.returnPct,
    holdingHours,
    executionVenue: opts.executionVenueOverride ?? position.executionVenue ?? 'simmer',
    modeConfigured: position.modeConfigured,
    entryExecutionPath: position.entryExecutionPath,
    entryOrderType: position.entryOrderType,
    fallbackReason: position.fallbackReason,
    decisionSpreadBps: position.decisionSpreadBps,
    makerPriceImprovementBps: position.makerPriceImprovementBps,
    makerPriceImprovementUsd: position.makerPriceImprovementUsd,
    exitReason: opts.exitReason,
    entryPrice: position.entryPrice,
    stakeUsd: position.stakeUsd,
    sharesHeld: position.sharesHeld,
    entryAtr: position.entryAtr,
    entryAtrPct: position.entryAtrPct,
    priceZone: position.priceZone,
    synthHedged: position.synthHedged ?? false,
    pendingSettlement: position.pendingSettlement ?? false,
  });
}

/**
 * Redemption/resolution-path helper.
 *
 * `resolutionRedeemer` works with a raw Simmer/CLOB API response (`raw`)
 * plus an optionally looked-up ledger `Position` — sometimes one, sometimes
 * the other, sometimes both. Callers also need per-site overrides for
 * direction / question / venue because the redeemer renames these as it
 * figures out the PM-side semantics.
 *
 * This helper merges ledger state + raw response + overrides into a Position
 * shape suitable for `recordPositionOutcome`. Delegation means outcomes land
 * in both Redis (calibration context) and Postgres (analytics join), fixing
 * the "resolutions never reach DB" gap.
 */
export interface RedemptionOutcomeOverrides {
  marketId: string;
  direction: Position['direction'];
  question: string;
  result: 'won' | 'lost' | 'pushed';
  returnPct: number;
  executionVenue?: 'simmer' | 'clob' | 'hyperliquid';
  exitReason?: string;
  /** Force a sourcedFrom value (e.g. 'reconciled:simmer'). Falls back to
   * ledgerPos.sourcedFrom or 'reconciled:redemption'. */
  sourcedFromOverride?: string;
}

export async function recordRedemptionOutcome(
  redis: Redis,
  ledgerPos: Position | null | undefined,
  raw: Record<string, unknown> | null | undefined,
  overrides: RedemptionOutcomeOverrides,
): Promise<void> {
  const rawGet = <T,>(key: string, guard: (v: unknown) => v is T): T | undefined => {
    const v = raw?.[key];
    return guard(v) ? v : undefined;
  };
  const isString = (v: unknown): v is string => typeof v === 'string';
  const isNumber = (v: unknown): v is number => typeof v === 'number' && isFinite(v);

  // Read both camelCase (Position-shaped) and snake_case (Simmer/CLOB API
  // response) keys. The reconciliation path passes raw `closedPos` with
  // `average_price`, `value_usdc`, `shares`, `market_id`, etc. — without
  // snake_case support, every numeric field here would fall to 0 and DB rows
  // would carry no stake/entry/condition attribution.
  const rawConsensusProbability =
    rawGet('consensusProbability', isNumber) ?? rawGet('consensus_probability', isNumber);
  const rawEdgeMagnitude =
    rawGet('edgeMagnitude', isNumber) ?? rawGet('edge_magnitude', isNumber);
  const rawOpenedAt = rawGet('openedAt', isString) ?? rawGet('opened_at', isString);
  const rawExecutionVenue = (rawGet('executionVenue', isString) ??
    rawGet('execution_venue', isString) ??
    rawGet('venue', isString)) as Position['executionVenue'] | undefined;
  const rawEntryPrice =
    rawGet('entryPrice', isNumber) ?? rawGet('average_price', isNumber);
  // Simmer's `value_usdc` is the PROCEEDS of a closed position, not the
  // stake — don't conflate them. Stake is shares × average_price.
  const rawShares = rawGet('shares', isNumber) ?? rawGet('sharesHeld', isNumber);
  const rawDerivedStakeUsd =
    rawShares !== undefined && rawEntryPrice !== undefined
      ? rawShares * rawEntryPrice
      : undefined;
  const rawStakeUsd = rawGet('stakeUsd', isNumber) ?? rawDerivedStakeUsd;
  const rawConditionId =
    rawGet('conditionId', isString) ?? rawGet('condition_id', isString);

  const sourcedFrom =
    overrides.sourcedFromOverride ??
    ledgerPos?.sourcedFrom ??
    rawGet('sourcedFrom', isString) ??
    rawGet('sourced_from', isString) ??
    'reconciled:redemption';

  const openedAt = ledgerPos?.openedAt ?? rawOpenedAt;
  const conditionId = ledgerPos?.conditionId ?? rawConditionId;

  const merged: Parameters<typeof recordPositionOutcome>[1] = {
    marketId: overrides.marketId,
    direction: overrides.direction,
    // Full question preserved for Postgres analytics; recordPositionOutcome
    // truncates to 200 chars internally for the Redis-side outcome hash.
    question: overrides.question,
    sourcedFrom,
    executionId: ledgerPos?.executionId,
    consensusProbability:
      ledgerPos?.consensusProbability ?? rawConsensusProbability ?? 0.5,
    edgeMagnitude: ledgerPos?.edgeMagnitude ?? rawEdgeMagnitude ?? 0,
    // openedAt intentionally undefined when unknown — don't fabricate a
    // timestamp that would make holdingHours ≈ 0 and look like a fast exit.
    ...(openedAt !== undefined ? { openedAt } : {}),
    executionVenue:
      ledgerPos?.executionVenue ??
      rawExecutionVenue ??
      overrides.executionVenue ??
      'clob',
    stakeUsd: ledgerPos?.stakeUsd ?? rawStakeUsd ?? 0,
    entryPrice: ledgerPos?.entryPrice ?? rawEntryPrice ?? 0,
    ...(conditionId ? { conditionId } : {}),
    ...(ledgerPos?.modeConfigured ? { modeConfigured: ledgerPos.modeConfigured } : {}),
    ...(ledgerPos?.entryExecutionPath
      ? { entryExecutionPath: ledgerPos.entryExecutionPath }
      : {}),
    ...(ledgerPos?.entryOrderType ? { entryOrderType: ledgerPos.entryOrderType } : {}),
    ...(ledgerPos?.fallbackReason ? { fallbackReason: ledgerPos.fallbackReason } : {}),
    ...(ledgerPos?.decisionSpreadBps !== undefined
      ? { decisionSpreadBps: ledgerPos.decisionSpreadBps }
      : {}),
    ...(ledgerPos?.makerPriceImprovementBps !== undefined
      ? { makerPriceImprovementBps: ledgerPos.makerPriceImprovementBps }
      : {}),
    ...(ledgerPos?.makerPriceImprovementUsd !== undefined
      ? { makerPriceImprovementUsd: ledgerPos.makerPriceImprovementUsd }
      : {}),
    ...(ledgerPos?.sharesHeld !== undefined ? { sharesHeld: ledgerPos.sharesHeld } : {}),
    ...(ledgerPos?.entryAtr !== undefined ? { entryAtr: ledgerPos.entryAtr } : {}),
    ...(ledgerPos?.entryAtrPct !== undefined ? { entryAtrPct: ledgerPos.entryAtrPct } : {}),
    ...(ledgerPos?.priceZone !== undefined ? { priceZone: ledgerPos.priceZone } : {}),
    ...(ledgerPos?.synthHedged !== undefined ? { synthHedged: ledgerPos.synthHedged } : {}),
    ...(ledgerPos?.pendingSettlement !== undefined
      ? { pendingSettlement: ledgerPos.pendingSettlement }
      : {}),
  };

  try {
    await recordPositionOutcome(redis, merged, {
      result: overrides.result,
      returnPct: overrides.returnPct,
      ...(overrides.executionVenue
        ? { executionVenueOverride: overrides.executionVenue }
        : {}),
      ...(overrides.exitReason ? { exitReason: overrides.exitReason } : {}),
    });
  } catch (err) {
    // Don't let outcome recording break the redemption flow — it's
    // fire-and-forget analytics. Log and move on.
    logger.warn('[redemption-outcome] record failed (non-fatal)', {
      marketId: overrides.marketId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
