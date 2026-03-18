/**
 * Redis position ledger.
 *
 * Persists open positions after a successful Simmer trade execution.
 * The Phase 4 position monitor reads from this ledger to track P&L and
 * trigger take-profit sells.
 *
 * Key schema:  position:<marketId>
 * TTL:         7 days (positions resolve within this window)
 * Index key:   position:index  (Redis set of active marketIds)
 */

import { getRedis } from '../shared/redis.js';
import { logger } from '../shared/logger.js';
import type { TradeSignal } from '../mapping/index.js';

const KEY_PREFIX = 'position:';
const INDEX_KEY = 'position:index';
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface OpenPosition {
  marketId: string;
  conditionId: string;
  clobTokenIds: string[];
  question: string;
  direction: 'YES' | 'NO';
  stakeUsd: number;
  entryPrice: number;
  consensusProbability: number;
  txHash: string;
  entryTs: string; // ISO 8601
  sourcedFrom: string;
}

/**
 * Persist an open position to Redis after a successful trade.
 */
export async function persistPosition(
  signal: TradeSignal,
  txHash: string,
): Promise<void> {
  const redis = getRedis();
  const key = `${KEY_PREFIX}${signal.marketId}`;

  const position: OpenPosition = {
    marketId: signal.marketId,
    conditionId: signal.conditionId,
    clobTokenIds: signal.clobTokenIds,
    question: signal.question,
    direction: signal.direction,
    stakeUsd: signal.stakeUsd,
    entryPrice: signal.outcomePrice,
    consensusProbability: signal.consensusProbability,
    txHash,
    entryTs: new Date().toISOString(),
    sourcedFrom: signal.sourcedFrom,
  };

  try {
    await redis.setex(key, TTL_SECONDS, JSON.stringify(position));
    await redis.sadd(INDEX_KEY, signal.marketId);
    // Ensure the index key also has a TTL (reset on each write — keep it alive)
    await redis.expire(INDEX_KEY, TTL_SECONDS);

    logger.info('[position-ledger] position persisted', {
      marketId: signal.marketId,
      direction: signal.direction,
      stakeUsd: signal.stakeUsd,
      txHash,
    });
  } catch (err) {
    logger.error('[position-ledger] failed to persist position', {
      marketId: signal.marketId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Retrieve an open position by market ID. Returns null if not found or expired.
 */
export async function getPosition(marketId: string): Promise<OpenPosition | null> {
  const redis = getRedis();
  const raw = await redis.get(`${KEY_PREFIX}${marketId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OpenPosition;
  } catch {
    return null;
  }
}

/**
 * Retrieve all active open positions from the index.
 */
export async function getAllPositions(): Promise<OpenPosition[]> {
  const redis = getRedis();
  const marketIds = await redis.smembers(INDEX_KEY);
  const positions: OpenPosition[] = [];

  for (const marketId of marketIds) {
    const pos = await getPosition(marketId);
    if (pos) {
      positions.push(pos);
    } else {
      // Key expired — clean from index
      await redis.srem(INDEX_KEY, marketId);
    }
  }

  return positions;
}

/**
 * Remove a position from the ledger (after take-profit or resolution).
 */
export async function removePosition(marketId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(`${KEY_PREFIX}${marketId}`);
  await redis.srem(INDEX_KEY, marketId);
  logger.info('[position-ledger] position removed', { marketId });
}
