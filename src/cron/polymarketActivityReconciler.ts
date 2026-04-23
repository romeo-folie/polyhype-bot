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
 * (default 500) and then filter to events with timestamp > stored checkpoint
 * before processing. The checkpoint is advanced to the newest processed
 * timestamp at the end of a successful run. Per-tx dedup is the correctness
 * backstop; the checkpoint is the fast-path filter so steady-state cycles
 * only touch new rows.
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
import { recordOutcome, inferSource, inferCategory } from '../shared/outcomeRecorder.js';
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

/**
 * Build a conditionId → marketId[] map in a single SELECT against
 * market_catalog. market_catalog has no index on condition_id (only
 * (market_id, captured_at) and snapshot_id), so doing a per-redeem
 * subquery in the positions lookup devolves into a sequential scan
 * every call — painful as snapshots accumulate. One scan per cycle
 * is much better.
 */
async function buildConditionToMarketsMap(
  conditionIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (conditionIds.length === 0) return result;
  const sql = getSql();
  const rows = await sql<Array<{ condition_id: string; market_id: string }>>`
    SELECT DISTINCT condition_id, market_id
    FROM market_catalog
    WHERE condition_id = ANY(${conditionIds}::text[])
  `;
  for (const row of rows) {
    const existing = result.get(row.condition_id) ?? [];
    existing.push(row.market_id);
    result.set(row.condition_id, existing);
  }
  return result;
}

const QUESTION_FALLBACK_WINDOW_DAYS = 30;

/**
 * Fallback path: look up positions by exact question match when the
 * conditionId → marketId join via market_catalog returns nothing. This
 * handles the case where `market_catalog` is incomplete for markets we've
 * actually traded (observed 2026-04-23 for 2 weather markets where the
 * scanner ran but market_catalog wasn't written). Exact-match on
 * `question` (NOT fuzzy) — PM's activity API title mirrors our DB
 * question 1:1 for markets we've seen.
 *
 * Scoped to a 30-day window ending at the redeem timestamp because
 * (a) `positions` has no index on `question` — a full scan is cheap when
 * bounded on `opened_at` (which IS indexed) but pathological without,
 * and (b) weather bracket questions recur year over year ("Hong Kong
 * 30°C on April 22" could match an earlier year's identical bracket).
 */
async function queryPositionsByQuestion(
  question: string,
  conditionId: string,
  redeemTimestampSec: number,
): Promise<PositionRow[]> {
  if (!question) return [];
  const sql = getSql();
  const redeemMs = redeemTimestampSec * 1000;
  const windowStartMs = redeemMs - QUESTION_FALLBACK_WINDOW_DAYS * 86_400_000;
  const windowStartIso = new Date(windowStartMs).toISOString();
  const windowEndIso = new Date(redeemMs).toISOString();
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
      ${conditionId}::text AS "conditionId",
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
    WHERE question = ${question}
      AND opened_at BETWEEN ${windowStartIso}::timestamptz AND ${windowEndIso}::timestamptz
    ORDER BY opened_at DESC
  `;
  return rows;
}

async function queryPositionsByMarketIds(
  marketIds: string[],
  conditionId: string,
): Promise<PositionRow[]> {
  if (marketIds.length === 0) return [];
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
      ${conditionId}::text AS "conditionId",
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
    WHERE market_id = ANY(${marketIds}::text[])
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

/**
 * Look up outcome rows that correspond to a specific position, not just any
 * outcome on the same market+direction. Multi-entry markets (same side
 * traded more than once) would otherwise cause false no-ops or flips on the
 * wrong row. `execution_id` is the preferred key when the position row has
 * one — it's unique per executor.ts run. When execution_id is missing
 * (pre-PR-197 positions), falls back to an opened_at proximity window so we
 * still apply to the closest match in time.
 */
async function queryExistingOutcome(
  marketId: string,
  direction: string,
  executionId: string | null,
  openedAt: string | null,
): Promise<ExistingOutcome[]> {
  const sql = getSql();
  if (executionId) {
    return await sql<ExistingOutcome[]>`
      SELECT outcome_id, result, return_pct, exit_reason, closed_at
      FROM outcomes
      WHERE market_id = ${marketId}
        AND direction = ${direction}
        AND execution_id = ${executionId}
      ORDER BY closed_at DESC
    `;
  }
  if (openedAt) {
    // ±2h window around the ledger's opened_at — tight enough to distinguish
    // intra-day re-entries on the same market.
    const anchor = new Date(openedAt);
    const lo = new Date(anchor.getTime() - 2 * 3600_000).toISOString();
    const hi = new Date(anchor.getTime() + 2 * 3600_000).toISOString();
    return await sql<ExistingOutcome[]>`
      SELECT outcome_id, result, return_pct, exit_reason, closed_at
      FROM outcomes
      WHERE market_id = ${marketId}
        AND direction = ${direction}
        AND opened_at BETWEEN ${lo}::timestamptz AND ${hi}::timestamptz
      ORDER BY closed_at DESC
    `;
  }
  // No disambiguator available — fall back to the loose lookup.
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
  redis: Redis,
  outcomeId: string,
  redeem: RedeemActivity,
  match: PositionRow,
  previousResult: string,
  previousReturnPct: number,
  previousExitReason: string | null,
): Promise<void> {
  const sql = getSql();
  const correctedReturnPct = computeReturnPct(redeem, match);
  const correctedResult: 'won' | 'lost' = redeem.usdcSize > 0 ? 'won' : 'lost';
  const correctedExitReason = correctedResult === 'won'
    ? 'auto_redeemed_win_pm_reconciler_flip'
    : 'auto_redeemed_loss_pm_reconciler_flip';
  // The redeem event IS when this position truly closed (CTF burned the
  // shares and paid out). Update closed_at + holding_hours to match so
  // downstream analytics (daily rollups, cohort studies) see the right time.
  const correctedClosedAt = new Date(redeem.timestamp * 1000).toISOString();
  const correctedHoldingHours = match.openedAt
    ? (redeem.timestamp * 1000 - new Date(match.openedAt).getTime()) / 3_600_000
    : 0;
  await sql`
    UPDATE outcomes
    SET
      result = ${correctedResult},
      return_pct = ${correctedReturnPct},
      exit_reason = ${correctedExitReason},
      closed_at = ${correctedClosedAt}::timestamptz,
      holding_hours = ${correctedHoldingHours},
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
  // Keep the Redis outcome history in sync: append a correction entry with
  // the same timestamp as the redeem so context injection / calibration
  // picks up the corrected result. The original (stale-lost) entry stays
  // but is superseded by the corrected one — acceptable given how rare
  // flips are and that Redis entries expire via OUTCOME_HISTORY_DAYS.
  await recordOutcome(
    redis,
    {
      source: inferSource(match.sourcedFrom ?? 'pm_reconciler'),
      category: inferCategory(match.question),
      question: match.question.slice(0, 200),
      direction: match.direction,
      consensusProbability: match.consensusProbability ?? 0.5,
      divergence: 0,
      result: correctedResult,
      returnPct: correctedReturnPct,
      holdingHours: match.openedAt
        ? (redeem.timestamp * 1000 - new Date(match.openedAt).getTime()) / 3_600_000
        : 0,
      executionVenue: (match.executionVenue ?? 'clob') as 'clob' | 'simmer' | 'hyperliquid',
      ...(match.executionId ? { executionId: match.executionId } : {}),
      exitReason: correctedExitReason,
    },
    { sourcedFrom: match.sourcedFrom ?? undefined, closedAtMs: redeem.timestamp * 1000 },
  );
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
    // Preserve the ledger's venue (simmer vs clob) so venue-sliced analytics
    // stay correct. Falls back to 'clob' only when the ledger truly lacks it.
    executionVenueOverride: match.executionVenue ?? 'clob',
    exitReason: weWon
      ? 'auto_redeemed_win_pm_reconciler'
      : 'auto_redeemed_loss_pm_reconciler',
    // Record at PM's redeem timestamp, NOT Date.now() — critical for backfill
    // so holding_hours and daily rollups reflect when the trade actually closed.
    closedAtMs: redeem.timestamp * 1000,
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
  conditionToMarkets?: Map<string, string[]>,
): Promise<void> {
  const dedupKey = `${PROCESSED_PREFIX}${redeem.transactionHash}`;
  if ((await redis.exists(dedupKey)) === 1) {
    summary.alreadyProcessed += 1;
    return;
  }

  // conditionToMarkets is pre-computed once per cycle in runPmActivityReconciler.
  // When absent (e.g. direct test calls), fall back to a single-shot lookup.
  const marketIds = conditionToMarkets
    ? conditionToMarkets.get(redeem.conditionId) ?? []
    : await (async () => {
        const sql = getSql();
        const rows = await sql<Array<{ market_id: string }>>`
          SELECT DISTINCT market_id FROM market_catalog
          WHERE condition_id = ${redeem.conditionId}
        `;
        return rows.map((r) => r.market_id);
      })();
  let positions = await queryPositionsByMarketIds(marketIds, redeem.conditionId);

  // Fallback: ONLY when market_catalog has no mapping for this conditionId
  // (observed 2026-04-23 for Moscow 12°C and Houston 70-71°F — positions we
  // actually traded but market_catalog never snapshotted). Gated on
  // `marketIds.length === 0`, NOT on `positions.length === 0`: if
  // market_catalog mapped but positions came back empty, that's a
  // legitimate manual-PM-trade case and we must NOT blind-match by
  // question text (risk of attributing the redeem to an unrelated position
  // sharing the same question text on a recurring weather bracket).
  //
  // Scoped to a 30-day pre-redeem window in the query to bound the seq
  // scan (positions has no index on question) and to filter out ancient
  // duplicates on recurring brackets like "Hong Kong 30°C on April 22" —
  // same question text can appear year over year.
  if (marketIds.length === 0 && redeem.title) {
    positions = await queryPositionsByQuestion(
      redeem.title,
      redeem.conditionId,
      redeem.timestamp,
    );
    if (positions.length > 0) {
      logger.info('[pm-reconciler] question-fallback recovered a position', {
        conditionId: redeem.conditionId,
        title: redeem.title,
        marketIds: positions.map((p) => p.marketId),
        txHash: redeem.transactionHash,
      });
    }
  }

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

  const existing = await queryExistingOutcome(
    match.marketId,
    match.direction,
    match.executionId,
    match.openedAt,
  );

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
      redis,
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
    // Outcome row is already 'lost' — keep its original exit_reason (could be
    // SL/TP, expired_unresolvable, etc.) and don't rewrite history. BUT the
    // PM redeem (even at $0) is definitive resolution, so clear the stale
    // pending_settlement flag on the positions row if still set. Without
    // this, positions show pending_settlement=true forever for
    // confirmed-loss resolutions where our redeemer wrote a loss before
    // seeing the on-chain outcome.
    if (match.pendingSettlement) {
      await clearPositionPendingSettlement(match.id, redeem.transactionHash);
      summary.positionsCleared += 1;
    }
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

  // Read the timestamp checkpoint and filter down to new redeems only.
  // First-ever run has no checkpoint → processes all 500 (intentional backfill
  // pass). Subsequent runs only walk events newer than the last processed ts.
  const checkpointRaw = await redis.get(CHECKPOINT_KEY).catch(() => null);
  const checkpointTs = checkpointRaw ? Number(checkpointRaw) : 0;
  const effectiveCheckpointTs = Number.isFinite(checkpointTs) ? checkpointTs : 0;
  const toProcess = redeems.filter((r) => r.timestamp > effectiveCheckpointTs);

  logger.info('[pm-reconciler] fetched redeems', {
    count: redeems.length,
    toProcess: toProcess.length,
    checkpointTs: effectiveCheckpointTs,
    wallet,
  });

  // Pre-compute conditionId → marketId[] in a single scan against
  // market_catalog. Keeps the per-redeem lookup to a Map hit and avoids
  // seq-scanning an unindexed column 500 times.
  const uniqueConditionIds = [...new Set(toProcess.map((r) => r.conditionId))];
  const conditionToMarkets = await buildConditionToMarketsMap(uniqueConditionIds);

  // Track the max timestamp of redeems that reconciled WITHOUT throwing. On
  // any error we leave the checkpoint where it was so the next cycle retries
  // the failed event (per-tx dedup still prevents double-writes on retry).
  let maxSuccessTs = 0;
  let anyError = false;
  for (const redeem of toProcess) {
    try {
      await reconcileRedeem(redis, redeem, summary, conditionToMarkets);
      if (redeem.timestamp > maxSuccessTs) maxSuccessTs = redeem.timestamp;
    } catch (err) {
      anyError = true;
      summary.errors += 1;
      logger.warn('[pm-reconciler] reconcile failed for redeem — continuing', {
        conditionId: redeem.conditionId,
        txHash: redeem.transactionHash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Only advance the checkpoint when every event in this cycle succeeded.
  // Partial-failure runs leave the checkpoint unchanged so the next cycle
  // pulls the same window again and retries whatever failed. Per-tx dedup
  // prevents double-writes on the successful portion.
  if (!anyError && maxSuccessTs > effectiveCheckpointTs) {
    await redis.set(CHECKPOINT_KEY, String(maxSuccessTs)).catch(() => {});
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
