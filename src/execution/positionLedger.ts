/**
 * Redis position ledger.
 *
 * Tracks open positions so the Phase 4 monitor can:
 * - List all active positions
 * - Know the entry price and stake to compute P&L
 * - Mark positions as closed after take-profit or expiry
 *
 * Storage: Redis hash per position, keyed by `position:<marketId>:<direction>`
 * TTL: 30 days (max expected market lifetime)
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';

const POSITION_KEY_PREFIX = 'position:';
const POSITION_TTL_SECONDS = 30 * 24 * 3600; // 30 days
const POSITIONS_INDEX_KEY = 'positions:index'; // sorted set: score = openedAt ms

export interface Position {
  marketId: string;
  conditionId: string;
  clobTokenIds: string[];
  question: string;
  direction: 'YES' | 'NO';
  /** Entry price of the purchased outcome (0–1) */
  entryPrice: number;
  /** Amount staked in USDC */
  stakeUsd: number;
  /** Consensus probability at time of entry */
  consensusProbability: number;
  /** Consensus stddev at time of entry (for post-trade analysis) */
  consensusStddev?: number | undefined;
  /** Original edge magnitude */
  edgeMagnitude: number;
  /** OSINT headline that triggered this trade */
  sourcedFrom: string;
  /** ISO timestamp */
  openedAt: string;
  /** tx_hash from Simmer, if available */
  txHash?: string | undefined;
  /** Shares purchased — used when closing the position via sell order */
  sharesHeld?: number | undefined;
}

function positionKey(marketId: string, direction: string): string {
  return `${POSITION_KEY_PREFIX}${marketId}:${direction}`;
}

/**
 * Persist an open position to Redis.
 */
export async function recordPosition(
  redis: Redis,
  position: Position,
): Promise<void> {
  const key = positionKey(position.marketId, position.direction);
  const openedAtMs = new Date(position.openedAt).getTime();

  // Store position as a flat hash
  await redis.hset(key, {
    marketId: position.marketId,
    conditionId: position.conditionId,
    clobTokenIds: JSON.stringify(position.clobTokenIds),
    question: position.question,
    direction: position.direction,
    entryPrice: String(position.entryPrice),
    stakeUsd: String(position.stakeUsd),
    consensusProbability: String(position.consensusProbability),
    edgeMagnitude: String(position.edgeMagnitude),
    sourcedFrom: position.sourcedFrom,
    openedAt: position.openedAt,
    consensusStddev: position.consensusStddev !== undefined ? String(position.consensusStddev) : '',
    txHash: position.txHash ?? '',
    sharesHeld: position.sharesHeld !== undefined ? String(position.sharesHeld) : '',
  });
  await redis.expire(key, POSITION_TTL_SECONDS);

  // Add to sorted index (score = openedAt ms for chronological retrieval)
  await redis.zadd(POSITIONS_INDEX_KEY, openedAtMs, key);

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
    if (!raw || !raw['marketId']) {
      // Key expired — remove from index
      await redis.zrem(POSITIONS_INDEX_KEY, key);
      continue;
    }
    positions.push(deserialisePosition(raw));
  }
  return positions;
}

/**
 * Remove a position from the ledger (after take-profit or manual close).
 */
export async function closePosition(
  redis: Redis,
  marketId: string,
  direction: 'YES' | 'NO',
): Promise<void> {
  const key = positionKey(marketId, direction);
  await redis.del(key);
  await redis.zrem(POSITIONS_INDEX_KEY, key);
  logger.info('[ledger] position closed', { marketId, direction });
}

/**
 * Check if a position exists for a given market + direction.
 */
export async function hasOpenPosition(
  redis: Redis,
  marketId: string,
  direction: 'YES' | 'NO',
): Promise<boolean> {
  const key = positionKey(marketId, direction);
  const exists = await redis.exists(key);
  return exists === 1;
}

// ── Deserialisation ────────────────────────────────────────────────────────

function deserialisePosition(raw: Record<string, string>): Position {
  const pos: Position = {
    marketId: raw['marketId'] ?? '',
    conditionId: raw['conditionId'] ?? '',
    clobTokenIds: raw['clobTokenIds'] ? (JSON.parse(raw['clobTokenIds']) as string[]) : [],
    question: raw['question'] ?? '',
    direction: (raw['direction'] ?? 'YES') as 'YES' | 'NO',
    entryPrice: parseFloat(raw['entryPrice'] ?? '0'),
    stakeUsd: parseFloat(raw['stakeUsd'] ?? '0'),
    consensusProbability: parseFloat(raw['consensusProbability'] ?? '0'),
    edgeMagnitude: parseFloat(raw['edgeMagnitude'] ?? '0'),
    sourcedFrom: raw['sourcedFrom'] ?? '',
    openedAt: raw['openedAt'] ?? new Date().toISOString(),
  };
  if (raw['consensusStddev']) pos.consensusStddev = parseFloat(raw['consensusStddev']);
  if (raw['txHash']) pos.txHash = raw['txHash'];
  if (raw['sharesHeld']) pos.sharesHeld = parseFloat(raw['sharesHeld']);
  return pos;
}
