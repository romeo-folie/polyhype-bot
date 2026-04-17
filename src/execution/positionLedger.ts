/**
 * Redis position ledger.
 *
 * Tracks open positions so the Phase 4 monitor can:
 * - List all active positions
 * - Know the entry price and stake to compute P&L
 * - Mark positions as closed after take-profit or expiry
 *
 * Storage: Redis hash per position, keyed by `position:<marketId>:<direction>`
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { markRecentlyClosed } from '../shared/closedGuard.js';
import { clearStaleState } from '../monitor/staleExit.js';
import { enqueueWrite } from '../db/writeQueue.js';

const POSITION_KEY_PREFIX = 'position:';
const POSITIONS_INDEX_KEY = 'positions:index'; // sorted set: score = openedAt ms

export interface Position {
  /** Polymarket numeric ID or Hyperliquid symbol (used as primary key in ledger) */
  marketId: string;
  /** Polymarket-specific fields (optional for futures) */
  conditionId?: string | undefined;
  /** Execution attempt correlation ID */
  executionId?: string | undefined;
  clobTokenIds?: string[] | undefined;
  /** Question or trade reasoning */
  question: string;
  /** Direction: YES/NO for PM, LONG/SHORT for futures */
  direction: 'YES' | 'NO' | 'UP' | 'DOWN' | 'LONG' | 'SHORT';
  /** Entry price of the purchased outcome (0–1 for PM, USD price for futures) */
  entryPrice: number;
  /** Amount staked in USDC (margin for futures) */
  stakeUsd: number;
  /** Consensus probability at time of entry (for PM) */
  consensusProbability?: number | undefined;
  /** Consensus stddev at time of entry (for post-trade analysis) */
  consensusStddev?: number | undefined;
  /** Original edge magnitude */
  edgeMagnitude: number;
  /** OSINT headline that triggered this trade */
  sourcedFrom: string;
  /** ISO timestamp */
  openedAt: string;
  /** tx_hash from the venue, if available */
  txHash?: string | undefined;
  /** Shares purchased — used when closing manually */
  sharesHeld?: number | undefined;
  /** Venue via which this position was entered */
  executionVenue: 'simmer' | 'clob' | 'hyperliquid';
  /** Configured execution mode at entry time */
  modeConfigured?: 'hybrid' | 'maker' | 'taker' | undefined;
  /** Final entry path selected by the executor */
  entryExecutionPath?: string | undefined;
  /** Order type used for the entry path */
  entryOrderType?: 'maker' | 'taker' | 'none' | undefined;
  /** Decision-time microstructure snapshot */
  decisionBestBid?: number | undefined;
  decisionBestAsk?: number | undefined;
  decisionMidPrice?: number | undefined;
  decisionSpreadBps?: number | undefined;
  counterfactualImmediateTakerPrice?: number | undefined;
  counterfactualImmediateTakerShares?: number | undefined;
  counterfactualImmediateTakerCostUsd?: number | undefined;
  makerPriceImprovementBps?: number | undefined;
  makerPriceImprovementUsd?: number | undefined;
  fallbackReason?: string | undefined;
  /** Optional reconciliation status for exit/settlement */
  reconciliationStatus?: string | undefined;
  /** True when an HL synthetic hedge has been opened for this PM position.
   * The PM shares are still held on-chain; the redeemer handles final settlement. */
  synthHedged?: boolean | undefined;
  /** True when the position's notional is below the CLOB $1 minimum.
   * The monitor skips these — they resolve at market settlement via the redeemer. */
  pendingSettlement?: boolean | undefined;
  /** Futures-specific metadata */
  isFutures?: boolean | undefined;
  leverage?: number | undefined;
  symbol?: string | undefined;
  side?: 'long' | 'short' | undefined;
  /** Asset ID (e.g. 'bitcoin') — used for tiered logic */
  assetId?: string | undefined;
  /** ISO timestamp for market resolution — used for tiered logic */
  endDate?: string | undefined;
  /** Peak priceChangePct seen since entry — used by trailing stop */
  highWaterMarkPct?: number | undefined;
  /** ATR snapshot at entry (futures only) — drives ATR-based SL/TP */
  entryAtr?: number | undefined;
  entryAtrPct?: number | undefined;
  /** Price-zone classification (Change 3 telemetry) */
  priceZone?: 1 | 2 | 3 | 4 | 5 | undefined;
}

function canonicalDirection(direction: Position['direction']): Position['direction'] {
  if (direction === 'UP') return 'YES';
  if (direction === 'DOWN') return 'NO';
  return direction;
}

function positionKey(marketId: string, direction: Position['direction']): string {
  return `${POSITION_KEY_PREFIX}${marketId}:${canonicalDirection(direction)}`;
}

/**
 * Human-readable label for a position direction.
 * PM positions use YES/NO; futures positions use LONG/SHORT.
 * Exported so notification and logging code uses a single consistent formatter.
 */
export function formatDirection(direction: Position['direction']): string {
  switch (direction) {
    case 'YES':
      return 'YES ↑';
    case 'NO':
      return 'NO ↓';
    case 'UP':
      return 'UP ↑';
    case 'DOWN':
      return 'DOWN ↓';
    case 'LONG':
      return 'LONG ↑';
    case 'SHORT':
      return 'SHORT ↓';
    default:
      return direction;
  }
}

/**
 * Persist an open position to Redis.
 */
export async function recordPosition(redis: Redis, positionIn: Position): Promise<void> {
  const position: Position = { ...positionIn, direction: canonicalDirection(positionIn.direction) };
  const key = positionKey(position.marketId, position.direction);
  const openedAtMs = new Date(position.openedAt).getTime();

  // Validate sharesHeld — warn if 0 or undefined (indicates missing shares_bought from venue).
  // Futures positions legitimately track via HL position state (symbol + USD margin)
  // instead of "shares", so undefined sharesHeld is expected there — don't warn.
  const isFuturesPosition =
    position.isFutures === true || position.executionVenue === 'hyperliquid';
  if (
    !isFuturesPosition &&
    (position.sharesHeld === undefined || position.sharesHeld === 0)
  ) {
    logger.warn(
      '[ledger] position recorded with zero or undefined sharesHeld — exit may require fallback calculation',
      {
        marketId: position.marketId,
        direction: position.direction,
        sharesHeld: position.sharesHeld,
        stakeUsd: position.stakeUsd,
        entryPrice: position.entryPrice,
      },
    );
  }

  // Store position as a flat hash
  await redis.hset(key, {
    marketId: position.marketId,
    conditionId: position.conditionId ?? '',
    executionId: position.executionId ?? '',
    clobTokenIds: JSON.stringify(position.clobTokenIds ?? []),
    question: position.question,
    direction: position.direction,
    entryPrice: String(position.entryPrice),
    stakeUsd: String(position.stakeUsd),
    consensusProbability:
      position.consensusProbability !== undefined ? String(position.consensusProbability) : '',
    edgeMagnitude: String(position.edgeMagnitude),
    sourcedFrom: position.sourcedFrom,
    openedAt: position.openedAt,
    consensusStddev: position.consensusStddev !== undefined ? String(position.consensusStddev) : '',
    txHash: position.txHash ?? '',
    sharesHeld: position.sharesHeld !== undefined ? String(position.sharesHeld) : '',
    executionVenue: position.executionVenue,
    modeConfigured: position.modeConfigured ?? '',
    entryExecutionPath: position.entryExecutionPath ?? '',
    entryOrderType: position.entryOrderType ?? '',
    decisionBestBid: position.decisionBestBid !== undefined ? String(position.decisionBestBid) : '',
    decisionBestAsk: position.decisionBestAsk !== undefined ? String(position.decisionBestAsk) : '',
    decisionMidPrice:
      position.decisionMidPrice !== undefined ? String(position.decisionMidPrice) : '',
    decisionSpreadBps:
      position.decisionSpreadBps !== undefined ? String(position.decisionSpreadBps) : '',
    counterfactualImmediateTakerPrice:
      position.counterfactualImmediateTakerPrice !== undefined
        ? String(position.counterfactualImmediateTakerPrice)
        : '',
    counterfactualImmediateTakerShares:
      position.counterfactualImmediateTakerShares !== undefined
        ? String(position.counterfactualImmediateTakerShares)
        : '',
    counterfactualImmediateTakerCostUsd:
      position.counterfactualImmediateTakerCostUsd !== undefined
        ? String(position.counterfactualImmediateTakerCostUsd)
        : '',
    makerPriceImprovementBps:
      position.makerPriceImprovementBps !== undefined
        ? String(position.makerPriceImprovementBps)
        : '',
    makerPriceImprovementUsd:
      position.makerPriceImprovementUsd !== undefined
        ? String(position.makerPriceImprovementUsd)
        : '',
    fallbackReason: position.fallbackReason ?? '',
    synthHedged: position.synthHedged ? 'true' : 'false',
    pendingSettlement: position.pendingSettlement ? 'true' : 'false',
    isFutures: position.isFutures ? 'true' : 'false',
    leverage: position.leverage !== undefined ? String(position.leverage) : '',
    symbol: position.symbol ?? '',
    side: position.side ?? '',
    assetId: position.assetId ?? '',
    endDate: position.endDate ?? '',
    entryAtr: position.entryAtr !== undefined ? String(position.entryAtr) : '',
    entryAtrPct: position.entryAtrPct !== undefined ? String(position.entryAtrPct) : '',
    priceZone: position.priceZone !== undefined ? String(position.priceZone) : '',
  });

  // Add to sorted index (score = openedAt ms for chronological retrieval)
  await redis.zadd(POSITIONS_INDEX_KEY, openedAtMs, key);

  void enqueueWrite('positions', position as unknown as Record<string, unknown>);
  logger.info('[ledger] position recorded', {
    marketId: position.marketId,
    direction: position.direction,
    stakeUsd: position.stakeUsd,
  });
}

/**
 * Retrieve all open positions from Redis.
 */
export async function getOpenPositions(redis: Redis): Promise<Position[]> {
  const keys = await redis.zrange(POSITIONS_INDEX_KEY, 0, -1);
  if (keys.length === 0) return [];

  const positions: Position[] = [];
  for (const key of keys) {
    const raw = await redis.hgetall(key);
    if (!raw.marketId) {
      // Key expired — remove from index
      await redis.zrem(POSITIONS_INDEX_KEY, key);
      continue;
    }
    positions.push(deserialisePosition(raw));
  }
  return positions;
}

/**
 * Fetch a single open position by marketId + direction. Returns null if not found.
 */
export async function getPosition(
  redis: Redis,
  marketId: string,
  direction: Position['direction'],
): Promise<Position | null> {
  const key = positionKey(marketId, direction);
  const raw = await redis.hgetall(key);
  if (raw.marketId) return deserialisePosition(raw);
  // Backward compat: legacy positions stored under raw direction (e.g. ...:UP / ...:DOWN)
  const legacyKey = `${POSITION_KEY_PREFIX}${marketId}:${direction}`;
  if (legacyKey === key) return null;
  const legacy = await redis.hgetall(legacyKey);
  if (!legacy.marketId) return null;
  return deserialisePosition(legacy);
}

/**
 * Remove a position from the ledger (after take-profit or manual close).
 */
export async function closePosition(
  redis: Redis,
  marketId: string,
  direction: Position['direction'],
): Promise<void> {
  const key = positionKey(marketId, direction);
  // Read before delete so we can emit the closed state to PG.
  const posRecord = await getPosition(redis, marketId, direction);
  await redis.del(key);
  await redis.zrem(POSITIONS_INDEX_KEY, key);
  // Clean up any legacy raw-direction key (e.g. ...:UP / ...:DOWN stored before canonicalization)
  const legacyKey = `${POSITION_KEY_PREFIX}${marketId}:${direction}`;
  if (legacyKey !== key) {
    await redis.del(legacyKey);
    await redis.zrem(POSITIONS_INDEX_KEY, legacyKey);
  }
  // Guard: prevent reconciler from re-importing dust residuals on Simmer as a
  // fresh position after an intentional close. See shared/closedGuard.ts.
  await markRecentlyClosed(redis, marketId);
  // Drop any stale-exit tracking state (peak pnl + price samples) for this position.
  await clearStaleState(redis, marketId, direction);
  if (posRecord) {
    void enqueueWrite('positions', {
      ...(posRecord as unknown as Record<string, unknown>),
      closedAt: new Date().toISOString(),
    });
  }
  logger.info('[ledger] position closed', { marketId, direction });
}

/**
 * Mark a position as synthetically hedged without removing it from the ledger.
 * The PM shares are still held on-chain; the redeemer handles final settlement.
 */
export async function markPositionSynthHedged(
  redis: Redis,
  marketId: string,
  direction: Position['direction'],
): Promise<void> {
  const key = positionKey(marketId, direction);
  await redis.hset(key, { synthHedged: 'true' });
  const pos = await getPosition(redis, marketId, direction);
  if (pos) void enqueueWrite('positions', pos as unknown as Record<string, unknown>);
  logger.info('[ledger] position marked synthHedged', { marketId, direction });
}

/**
 * Mark a position as pending settlement (below CLOB minimum notional).
 * The monitor skips these — they resolve at market settlement via the redeemer.
 */
export async function markPositionPendingSettlement(
  redis: Redis,
  marketId: string,
  direction: Position['direction'],
): Promise<void> {
  const key = positionKey(marketId, direction);
  await redis.hset(key, { pendingSettlement: 'true' });
  const pos = await getPosition(redis, marketId, direction);
  if (pos) void enqueueWrite('positions', pos as unknown as Record<string, unknown>);
  logger.info('[ledger] position marked pendingSettlement', { marketId, direction });
}

export async function updateHighWaterMark(
  redis: Redis,
  marketId: string,
  direction: Position['direction'],
  pct: number,
): Promise<void> {
  const key = positionKey(marketId, direction);
  await redis.hset(key, { highWaterMarkPct: String(pct) });
}

export async function updatePositionShares(
  redis: Redis,
  marketId: string,
  direction: Position['direction'],
  sharesHeld: number,
  reconciliationStatus?: string,
): Promise<void> {
  const key = positionKey(marketId, direction);
  await redis.hset(key, {
    sharesHeld: String(sharesHeld),
    ...(reconciliationStatus ? { reconciliationStatus } : {}),
  });
  const pos = await getPosition(redis, marketId, direction);
  if (pos) void enqueueWrite('positions', pos as unknown as Record<string, unknown>);
  logger.info('[ledger] position shares reconciled', {
    marketId,
    direction,
    sharesHeld,
    reconciliationStatus,
  });
}

/**
 * Check if a position exists for a given market + direction.
 */
export async function hasOpenPosition(
  redis: Redis,
  marketId: string,
  direction: Position['direction'],
): Promise<boolean> {
  const key = positionKey(marketId, direction);
  const exists = await redis.exists(key);
  return exists === 1;
}

// ── Deserialisation ────────────────────────────────────────────────────────

function deserialisePosition(raw: Record<string, string>): Position {
  const rawVenue = raw.executionVenue;
  const executionVenue: Position['executionVenue'] =
    rawVenue === 'clob' || rawVenue === 'hyperliquid' ? rawVenue : 'simmer';
  const pos: Position = {
    marketId: raw.marketId ?? '',
    conditionId: raw.conditionId,
    executionId: raw.executionId !== '' ? raw.executionId : undefined,
    clobTokenIds: raw.clobTokenIds ? (JSON.parse(raw.clobTokenIds) as string[]) : [],
    question: raw.question ?? '',
    direction: (raw.direction ?? 'YES') as Position['direction'],
    entryPrice: parseFloat(raw.entryPrice ?? '0'),
    stakeUsd: parseFloat(raw.stakeUsd ?? '0'),
    edgeMagnitude: parseFloat(raw.edgeMagnitude ?? '0'),
    sourcedFrom: raw.sourcedFrom ?? '',
    openedAt: raw.openedAt ?? new Date().toISOString(),
    executionVenue,
  };

  if (raw.consensusProbability !== undefined && raw.consensusProbability !== '')
    pos.consensusProbability = parseFloat(raw.consensusProbability);
  if (raw.consensusStddev !== undefined && raw.consensusStddev !== '')
    pos.consensusStddev = parseFloat(raw.consensusStddev);
  if (raw.txHash) pos.txHash = raw.txHash;
  if (raw.sharesHeld !== undefined && raw.sharesHeld !== '')
    pos.sharesHeld = parseFloat(raw.sharesHeld);
  if (raw.modeConfigured) pos.modeConfigured = raw.modeConfigured as Position['modeConfigured'];
  if (raw.entryExecutionPath) pos.entryExecutionPath = raw.entryExecutionPath;
  if (raw.entryOrderType) pos.entryOrderType = raw.entryOrderType as Position['entryOrderType'];
  if (raw.decisionBestBid !== undefined && raw.decisionBestBid !== '')
    pos.decisionBestBid = parseFloat(raw.decisionBestBid);
  if (raw.decisionBestAsk !== undefined && raw.decisionBestAsk !== '')
    pos.decisionBestAsk = parseFloat(raw.decisionBestAsk);
  if (raw.decisionMidPrice !== undefined && raw.decisionMidPrice !== '')
    pos.decisionMidPrice = parseFloat(raw.decisionMidPrice);
  if (raw.decisionSpreadBps !== undefined && raw.decisionSpreadBps !== '')
    pos.decisionSpreadBps = parseFloat(raw.decisionSpreadBps);
  if (
    raw.counterfactualImmediateTakerPrice !== undefined &&
    raw.counterfactualImmediateTakerPrice !== ''
  )
    pos.counterfactualImmediateTakerPrice = parseFloat(raw.counterfactualImmediateTakerPrice);
  if (
    raw.counterfactualImmediateTakerShares !== undefined &&
    raw.counterfactualImmediateTakerShares !== ''
  )
    pos.counterfactualImmediateTakerShares = parseFloat(raw.counterfactualImmediateTakerShares);
  if (
    raw.counterfactualImmediateTakerCostUsd !== undefined &&
    raw.counterfactualImmediateTakerCostUsd !== ''
  )
    pos.counterfactualImmediateTakerCostUsd = parseFloat(raw.counterfactualImmediateTakerCostUsd);
  if (raw.makerPriceImprovementBps !== undefined && raw.makerPriceImprovementBps !== '')
    pos.makerPriceImprovementBps = parseFloat(raw.makerPriceImprovementBps);
  if (raw.makerPriceImprovementUsd !== undefined && raw.makerPriceImprovementUsd !== '')
    pos.makerPriceImprovementUsd = parseFloat(raw.makerPriceImprovementUsd);
  if (raw.fallbackReason) pos.fallbackReason = raw.fallbackReason;
  if (raw.reconciliationStatus) pos.reconciliationStatus = raw.reconciliationStatus;

  if (raw.synthHedged === 'true') pos.synthHedged = true;
  if (raw.pendingSettlement === 'true') pos.pendingSettlement = true;
  if (raw.isFutures === 'true') {
    pos.isFutures = true;
    if (raw.leverage !== undefined && raw.leverage !== '') pos.leverage = parseFloat(raw.leverage);
    if (raw.symbol) pos.symbol = raw.symbol;
    if (raw.side) pos.side = raw.side as 'long' | 'short';
  }
  if (raw.assetId) pos.assetId = raw.assetId;
  if (raw.endDate) pos.endDate = raw.endDate;
  if (raw.entryAtr !== undefined && raw.entryAtr !== '')
    pos.entryAtr = parseFloat(raw.entryAtr);
  if (raw.entryAtrPct !== undefined && raw.entryAtrPct !== '')
    pos.entryAtrPct = parseFloat(raw.entryAtrPct);
  if (raw.highWaterMarkPct !== undefined && raw.highWaterMarkPct !== '')
    pos.highWaterMarkPct = parseFloat(raw.highWaterMarkPct);
  if (raw.priceZone !== undefined && raw.priceZone !== '') {
    const z = Number(raw.priceZone);
    if (z >= 1 && z <= 5) pos.priceZone = z as 1 | 2 | 3 | 4 | 5;
  }

  return pos;
}
