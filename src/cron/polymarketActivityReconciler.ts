/**
 * Polymarket-activity reconciler — catches auto-redeemed wins that our local
 * redeemer/monitor never saw, including:
 *   - Positions closed prematurely (e.g. stop_loss fired, residual shares
 *     auto-redeemed at resolution)
 *   - Positions closed with `pending_settlement=true` awaiting on-chain
 *     settlement (no outcome row ever written — the "silent wins" bug)
 *   - Positions entered directly on Polymarket outside this agent
 *
 * How it works:
 *   1. Fetch recent REDEEM activity for our wallet from PM's public data API.
 *   2. For each redeem, look up the `positions` row(s) by condition_id. Use
 *      the ledger's own sourcedFrom / executionId / stake so calibration and
 *      per-source analytics stay intact.
 *   3. If no `outcomes` row exists for that position, write one with
 *      exit_reason='auto_redeemed_{win,loss}_pm_reconciler'.
 *   4. If an existing outcomes row has result='lost' but PM paid us (partial
 *      SL/TP fill + auto-redeemed residual), flip the row.
 *   5. Update the positions row: clear pending_settlement, stamp
 *      reconciliation_status='pm_reconciler_redeemed:<ts>'.
 *
 * Dedup: each transactionHash is stamped in Redis for 30 days so multiple
 * invocations of this script are idempotent.
 *
 * Checkpoint: we always fetch the most recent `PM_RECONCILER_LIMIT` redeems
 * (default 500) and rely on per-tx dedup. A timestamp checkpoint gates the
 * inner loop so we don't linearly process N×last-run's worth of rows.
 *
 * Gated by `PM_RECONCILER_ENABLED` (default true). Notifies via Telegram on
 * every flipped/inserted row.
 */

import 'dotenv/config';
import { Wallet } from 'ethers';
import type { Redis } from 'ioredis';
import { getSql, closeSql } from '../db/client.js';
import { getRedis, closeRedis, acquireLock, releaseLock } from '../shared/redis.js';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { fetchWithTimeout } from '../mapping/gamma.js';
import { recordPositionOutcome } from '../shared/positionOutcomeRecorder.js';
import { notifyMarketResolved } from '../execution/telegram.js';
import type { Position } from '../execution/positionLedger.js';

const DATA_API_BASE = 'https://data-api.polymarket.com';
const LOCK_KEY = 'lock:pm-activity-reconciler';
const LOCK_TTL_SEC = 300;
const CHECKPOINT_KEY = 'pm-reconciler:last-ts';
const PROCESSED_PREFIX = 'pm-reconciler:processed:';
const PROCESSED_TTL_SEC = 30 * 24 * 3600;
const DEFAULT_LIMIT = 500;
const API_TIMEOUT_MS = 15_000;

export interface RedeemActivity {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: 'REDEEM';
  size: number;
  usdcSize: number;
  transactionHash: string;
  title: string;
  slug: string;
  eventSlug: string;
}

interface PositionRow {
  id: string;
  marketId: string;
  direction: 'YES' | 'NO' | 'UP' | 'DOWN';
  openedAt: string;
  closedAt: string | null;
  entryPrice: number | null;
  stakeUsd: number | null;
  sharesHeld: number | null;
  executionId: string | null;
  modeConfigured: string | null;
  sourcedFrom: string | null;
  question: string;
  pendingSettlement: boolean;
  reconciliationStatus: string | null;
  conditionId: string | null;
  executionVenue: string | null;
  consensusProbability: number | null;
  entryExecutionPath: string | null;
  entryOrderType: string | null;
  fallbackReason: string | null;
  edgeClass: string | null;
  decisionSpreadBps: number | null;
  makerPriceImprovementBps: number | null;
  makerPriceImprovementUsd: number | null;
  priceZone: number | null;
  entryAtr: number | null;
  entryAtrPct: number | null;
  synthHedged: boolean;
}

export interface ReconcilerSummary {
  redeemsFetched: number;
  alreadyProcessed: number;
  outcomesInserted: number;
  outcomesFlipped: number;
  positionsCleared: number;
  synthInsertsSkipped: number;
  errors: number;
}

export async function fetchRedeems(wallet: string, limit = DEFAULT_LIMIT): Promise<RedeemActivity[]> {
  const params = new URLSearchParams({
    user: wallet,
    type: 'REDEEM',
    limit: String(limit),
    sortBy: 'TIMESTAMP',
    sortDirection: 'DESC',
  });
  const url = `${DATA_API_BASE}/activity?${params.toString()}`;
  const res = await fetchWithTimeout(url, API_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`pm-reconciler fetch failed: ${String(res.status)} ${res.statusText}`);
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) return [];
  return data.filter((r): r is RedeemActivity => {
    const o = r as Partial<RedeemActivity>;
    return (
      o?.type === 'REDEEM' &&
      typeof o.conditionId === 'string' &&
      typeof o.transactionHash === 'string' &&
      typeof o.timestamp === 'number' &&
      typeof o.size === 'number' &&
      typeof o.usdcSize === 'number'
    );
  });
}

async function queryPositionsByConditionId(conditionId: string): Promise<PositionRow[]> {
  const sql = getSql();
  const rows = await sql<PositionRow[]>`
    SELECT
      id::text,
      market_id AS "marketId",
      direction,
      opened_at AS "openedAt",
      closed_at AS "closedAt",
      entry_price::float8 AS "entryPrice",
      stake_usd::float8 AS "stakeUsd",
      shares_held::float8 AS "sharesHeld",
      execution_id AS "executionId",
      mode_configured AS "modeConfigured",
      sourced_from AS "sourcedFrom",
      question,
      pending_settlement AS "pendingSettlement",
      reconciliation_status AS "reconciliationStatus",
      condition_id AS "conditionId",
      execution_venue AS "executionVenue",
      consensus_probability::float8 AS "consensusProbability",
      entry_execution_path AS "entryExecutionPath",
      entry_order_type AS "entryOrderType",
      fallback_reason AS "fallbackReason",
      edge_class AS "edgeClass",
      decision_spread_bps::float8 AS "decisionSpreadBps",
      maker_price_improvement_bps::float8 AS "makerPriceImprovementBps",
      maker_price_improvement_usd::float8 AS "makerPriceImprovementUsd",
      price_zone AS "priceZone",
      entry_atr::float8 AS "entryAtr",
      entry_atr_pct::float8 AS "entryAtrPct",
      synth_hedged AS "synthHedged"
    FROM positions
    WHERE condition_id = ${conditionId}
    ORDER BY opened_at DESC
  `;
  return rows;
}

interface ExistingOutcome {
  outcome_id: string;
  result: string;
  return_pct: number;
  exit_reason: string | null;
  closed_at: Date;
}

async function queryExistingOutcome(
  marketId: string,
  direction: string,
): Promise<ExistingOutcome[]> {
  const sql = getSql();
  return await sql<ExistingOutcome[]>`
    SELECT outcome_id, result, return_pct, exit_reason, closed_at
    FROM outcomes
    WHERE market_id = ${marketId} AND direction = ${direction}
    ORDER BY closed_at DESC
  `;
}

/**
 * Pick the positions row that best matches a REDEEM event's share size.
 * Multiple positions share a condition_id when we traded both YES and NO;
 * the size of the redemption (shares burned) disambiguates.
 */
export function pickBestMatch(
  positions: PositionRow[],
  redeem: Pick<RedeemActivity, 'size' | 'usdcSize'>,
): PositionRow | null {
  if (positions.length === 0) return null;
  if (positions.length === 1) return positions[0]!;
  const target = redeem.size;
  // Prefer positions still pending_settlement — they're actually waiting
  // for resolution, vs. ones closed via an earlier full sell.
  const pending = positions.filter((p) => p.pendingSettlement);
  const pool = pending.length > 0 ? pending : positions;
  let best: PositionRow | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const p of pool) {
    const held = p.sharesHeld ?? 0;
    const delta = Math.abs(held - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = p;
    }
  }
  return best;
}

/** Convert a PositionRow into the Position-shape that recordPositionOutcome expects. */
function positionRowToPosition(row: PositionRow): Omit<Position, 'openedAt'> & { openedAt?: string } {
  return {
    marketId: row.marketId,
    conditionId: row.conditionId ?? '',
    question: row.question,
    direction: row.direction,
    executionId: row.executionId ?? '',
    sourcedFrom: row.sourcedFrom ?? 'pm_reconciler',
    consensusProbability: row.consensusProbability ?? 0.5,
    edgeMagnitude: 0,
    openedAt: row.openedAt,
    executionVenue: (row.executionVenue ?? 'clob') as Position['executionVenue'],
    modeConfigured: row.modeConfigured ?? undefined,
    entryExecutionPath: row.entryExecutionPath ?? undefined,
    entryOrderType: row.entryOrderType ?? undefined,
    fallbackReason: row.fallbackReason ?? undefined,
    decisionSpreadBps: row.decisionSpreadBps ?? undefined,
    makerPriceImprovementBps: row.makerPriceImprovementBps ?? undefined,
    makerPriceImprovementUsd: row.makerPriceImprovementUsd ?? undefined,
    entryPrice: row.entryPrice ?? 0,
    stakeUsd: row.stakeUsd ?? 0,
    sharesHeld: row.sharesHeld ?? 0,
    entryAtr: row.entryAtr ?? undefined,
    entryAtrPct: row.entryAtrPct ?? undefined,
    priceZone: row.priceZone ?? undefined,
    synthHedged: row.synthHedged,
    pendingSettlement: row.pendingSettlement,
    // Unused downstream but required by Position type — supply defaults.
    clobTokenIds: [],
    endDate: '',
    highWaterMarkPct: undefined,
  } as unknown as Omit<Position, 'openedAt'> & { openedAt?: string };
}

function computeReturnPct(redeem: RedeemActivity, match: PositionRow): number {
  const stake = match.stakeUsd ?? 0;
  if (stake > 0) return ((redeem.usdcSize - stake) / stake) * 100;
  // Fall back to entry-price formula when stake is missing but entry+shares known.
  const shares = match.sharesHeld ?? 0;
  const entry = match.entryPrice ?? 0;
  if (shares > 0 && entry > 0) {
    return ((redeem.usdcSize - shares * entry) / (shares * entry)) * 100;
  }
  return redeem.usdcSize > 0 ? 100 : -100;
}

async function flipExistingOutcome(
  outcomeId: string,
  redeem: RedeemActivity,
  match: PositionRow,
  previousResult: string,
  previousReturnPct: number,
  previousExitReason: string | null,
): Promise<void> {
  const sql = getSql();
  const correctedReturnPct = computeReturnPct(redeem, match);
  const correctedResult = redeem.usdcSize > 0 ? 'won' : 'lost';
  await sql`
    UPDATE outcomes
    SET
      result = ${correctedResult},
      return_pct = ${correctedReturnPct},
      exit_reason = ${correctedResult === 'won'
        ? 'auto_redeemed_win_pm_reconciler'
        : 'auto_redeemed_loss_pm_reconciler'},
      raw = COALESCE(raw, '{}'::jsonb) || ${JSON.stringify({
        pm_reconciler: {
          tx_hash: redeem.transactionHash,
          redeem_ts: redeem.timestamp,
          pm_usdc_received: redeem.usdcSize,
          pm_shares_burned: redeem.size,
          previous_result: previousResult,
          previous_return_pct: previousReturnPct,
          previous_exit_reason: previousExitReason,
          applied_at: new Date().toISOString(),
        },
      })}::jsonb
    WHERE outcome_id = ${outcomeId}
  `;
}

async function insertOutcomeForPosition(
  redis: Redis,
  redeem: RedeemActivity,
  match: PositionRow,
): Promise<void> {
  const weWon = redeem.usdcSize > 0;
  const returnPct = computeReturnPct(redeem, match);
  await recordPositionOutcome(redis, positionRowToPosition(match), {
    result: weWon ? 'won' : 'lost',
    returnPct,
    executionVenueOverride: 'clob',
    exitReason: weWon
      ? 'auto_redeemed_win_pm_reconciler'
      : 'auto_redeemed_loss_pm_reconciler',
  });
}

async function clearPositionPendingSettlement(positionId: string, txHash: string): Promise<void> {
  const sql = getSql();
  await sql`
    UPDATE positions
    SET pending_settlement = false,
        reconciliation_status = ${`pm_reconciler_redeemed:${txHash}:${new Date().toISOString()}`}
    WHERE id = ${positionId}::bigint
  `;
}

export async function reconcileRedeem(
  redis: Redis,
  redeem: RedeemActivity,
  summary: ReconcilerSummary,
): Promise<void> {
  const dedupKey = `${PROCESSED_PREFIX}${redeem.transactionHash}`;
  if ((await redis.exists(dedupKey)) === 1) {
    summary.alreadyProcessed += 1;
    return;
  }

  const positions = await queryPositionsByConditionId(redeem.conditionId);
  const match = pickBestMatch(positions, redeem);

  if (!match) {
    // Position entered outside our system (manual PM trade, or pre-tracking).
    // Skip synthetic inserts for now — they'd lack execution_id / source and
    // pollute analytics. Just log and stamp the dedup key so we don't loop.
    logger.info('[pm-reconciler] redeem with no matching position — skipping', {
      conditionId: redeem.conditionId,
      title: redeem.title,
      usdcSize: redeem.usdcSize,
      txHash: redeem.transactionHash,
    });
    summary.synthInsertsSkipped += 1;
    await redis.set(dedupKey, '1', 'EX', PROCESSED_TTL_SEC);
    return;
  }

  const existing = await queryExistingOutcome(match.marketId, match.direction);

  if (existing.some((o) => o.result === 'won')) {
    // Already correctly recorded as a win — nothing to do.
    await redis.set(dedupKey, '1', 'EX', PROCESSED_TTL_SEC);
    return;
  }

  const expectedResult: 'won' | 'lost' = redeem.usdcSize > 0 ? 'won' : 'lost';
  const lostOutcomes = existing.filter((o) => o.result === 'lost');

  if (expectedResult === 'won' && lostOutcomes.length > 0) {
    // Flip misattributed loss (partial SL fill + residual auto-redeem pattern).
    const target = lostOutcomes[0]!;
    await flipExistingOutcome(
      target.outcome_id,
      redeem,
      match,
      target.result,
      Number(target.return_pct),
      target.exit_reason,
    );
    await clearPositionPendingSettlement(match.id, redeem.transactionHash);
    await redis.set(dedupKey, '1', 'EX', PROCESSED_TTL_SEC);
    summary.outcomesFlipped += 1;
    summary.positionsCleared += 1;
    logger.info('[pm-reconciler] flipped outcome', {
      marketId: match.marketId,
      direction: match.direction,
      question: match.question,
      previousResult: target.result,
      previousReturnPct: Number(target.return_pct),
      usdcReceived: redeem.usdcSize,
    });
    await notifyMarketResolved({
      question: match.question,
      direction: match.direction,
      result: 'won',
      stakeUsd: match.stakeUsd ?? 0,
      reason: 'pm-reconciler backfill (partial fill + auto-redeem)',
    }).catch(() => {});
    return;
  }

  if (expectedResult === 'lost' && lostOutcomes.length > 0) {
    // Already recorded as lost; leave it alone (don't overwrite SL/TP exit_reason).
    await redis.set(dedupKey, '1', 'EX', PROCESSED_TTL_SEC);
    return;
  }

  // No prior outcome row — insert one using position's full context.
  await insertOutcomeForPosition(redis, redeem, match);
  if (match.pendingSettlement) {
    await clearPositionPendingSettlement(match.id, redeem.transactionHash);
    summary.positionsCleared += 1;
  }
  await redis.set(dedupKey, '1', 'EX', PROCESSED_TTL_SEC);
  summary.outcomesInserted += 1;
  logger.info('[pm-reconciler] inserted outcome', {
    marketId: match.marketId,
    direction: match.direction,
    question: match.question,
    result: expectedResult,
    usdcReceived: redeem.usdcSize,
    stakeUsd: match.stakeUsd,
  });
  if (expectedResult === 'won') {
    await notifyMarketResolved({
      question: match.question,
      direction: match.direction,
      result: 'won',
      stakeUsd: match.stakeUsd ?? 0,
      reason: 'pm-reconciler backfill (auto-redeemed win)',
    }).catch(() => {});
  }
}

export async function runPmActivityReconciler(redis: Redis): Promise<ReconcilerSummary> {
  const summary: ReconcilerSummary = {
    redeemsFetched: 0,
    alreadyProcessed: 0,
    outcomesInserted: 0,
    outcomesFlipped: 0,
    positionsCleared: 0,
    synthInsertsSkipped: 0,
    errors: 0,
  };

  const cfg = loadConfig();
  if (!cfg.PM_RECONCILER_ENABLED) {
    logger.info('[pm-reconciler] disabled via PM_RECONCILER_ENABLED=false');
    return summary;
  }

  let wallet = cfg.POLYMARKET_FUNDER_ADDRESS;
  if (!wallet && cfg.POLYGON_WALLET_PRIVATE_KEY) {
    try {
      wallet = new Wallet(cfg.POLYGON_WALLET_PRIVATE_KEY).address;
    } catch {
      // fall through — handled below
    }
  }
  if (!wallet) {
    logger.warn('[pm-reconciler] no wallet address resolvable — skipping');
    return summary;
  }

  const redeems = await fetchRedeems(wallet, cfg.PM_RECONCILER_LIMIT);
  summary.redeemsFetched = redeems.length;
  logger.info('[pm-reconciler] fetched redeems', { count: redeems.length, wallet });

  // Update checkpoint to the newest observed timestamp (advisory — per-tx dedup
  // is the real correctness guarantee).
  const maxTs = redeems.reduce((a, r) => Math.max(a, r.timestamp), 0);
  if (maxTs > 0) {
    await redis.set(CHECKPOINT_KEY, String(maxTs)).catch(() => {});
  }

  for (const redeem of redeems) {
    try {
      await reconcileRedeem(redis, redeem, summary);
    } catch (err) {
      summary.errors += 1;
      logger.warn('[pm-reconciler] reconcile failed for redeem — continuing', {
        conditionId: redeem.conditionId,
        txHash: redeem.transactionHash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('[pm-reconciler] cycle complete', { ...summary });
  return summary;
}

async function main(): Promise<void> {
  const redis = getRedis();
  const lockToken = await acquireLock(LOCK_KEY, LOCK_TTL_SEC);
  if (!lockToken) {
    logger.info('[pm-reconciler] another instance holds the lock — exiting');
    await closeRedis();
    return;
  }
  try {
    await runPmActivityReconciler(redis);
  } finally {
    await releaseLock(LOCK_KEY, lockToken).catch(() => {});
    await closeSql().catch(() => {});
    await closeRedis();
  }
}

const isDirect =
  process.argv[1]?.endsWith('/polymarketActivityReconciler.js') === true ||
  process.argv[1]?.endsWith('/polymarketActivityReconciler.ts') === true;

if (isDirect) {
  main().catch(async (err) => {
    logger.error('[pm-reconciler] fatal', { error: err instanceof Error ? err.message : String(err) });
    await closeSql().catch(() => {});
    await closeRedis().catch(() => {});
    process.exit(1);
  });
}
