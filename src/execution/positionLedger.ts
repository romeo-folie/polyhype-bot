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
  /** Polymarket numeric ID or Hyperliquid symbol (used as primary key in ledger) */
  marketId: string;
  /** Polymarket-specific fields (optional for futures) */
  conditionId?: string | undefined;
  clobTokenIds?: string[] | undefined;
  /** Question or trade reasoning */
  question: string;
  /** Direction: YES/NO for PM, LONG/SHORT for futures */
  direction: 'YES' | 'NO' | 'LONG' | 'SHORT';
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
  /** Futures-specific metadata */
  isFutures?: boolean | undefined;
  leverage?: number | undefined;
  symbol?: string | undefined;
  side?: 'long' | 'short' | undefined;
}

function positionKey(marketId: string, direction: Position['direction']): string {
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
    conditionId: position.conditionId ?? '',
    clobTokenIds: JSON.stringify(position.clobTokenIds || []),
    question: position.question,
    direction: position.direction,
    entryPrice: String(position.entryPrice),
    stakeUsd: String(position.stakeUsd),
    consensusProbability: position.consensusProbability !== undefined ? String(position.consensusProbability) : '',
    edgeMagnitude: String(position.edgeMagnitude),
    sourcedFrom: position.sourcedFrom,
    openedAt: position.openedAt,
    consensusStddev: position.consensusStddev !== undefined ? String(position.consensusStddev) : '',
    txHash: position.txHash ?? '',
    sharesHeld: position.sharesHeld !== undefined ? String(position.sharesHeld) : '',
    executionVenue: position.executionVenue,
    isFutures: position.isFutures ? 'true' : 'false',
    leverage: position.leverage !== undefined ? String(position.leverage) : '',
    symbol: position.symbol ?? '',
    side: position.side ?? '',
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
  direction: Position['direction'],
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
  direction: Position['direction'],
): Promise<boolean> {
  const key = positionKey(marketId, direction);
  const exists = await redis.exists(key);
  return exists === 1;
}

// ── Deserialisation ────────────────────────────────────────────────────────

function deserialisePosition(raw: Record<string, string>): Position {
  const venue = raw['executionVenue'] as Position['executionVenue'];
  const pos: Position = {
    marketId: raw['marketId'] ?? '',
    conditionId: raw['conditionId'],
    clobTokenIds: raw['clobTokenIds'] ? (JSON.parse(raw['clobTokenIds']) as string[]) : [],
    question: raw['question'] ?? '',
    direction: (raw['direction'] ?? 'YES') as Position['direction'],
    entryPrice: parseFloat(raw['entryPrice'] ?? '0'),
    stakeUsd: parseFloat(raw['stakeUsd'] ?? '0'),
    edgeMagnitude: parseFloat(raw['edgeMagnitude'] ?? '0'),
    sourcedFrom: raw['sourcedFrom'] ?? '',
    openedAt: raw['openedAt'] ?? new Date().toISOString(),
    executionVenue: venue || 'simmer',
  };
  if (raw['consensusProbability']) pos.consensusProbability = parseFloat(raw['consensusProbability']);
  if (raw['consensusStddev']) pos.consensusStddev = parseFloat(raw['consensusStddev']);
  if (raw['txHash']) pos.txHash = raw['txHash'];
  if (raw['sharesHeld']) pos.sharesHeld = parseFloat(raw['sharesHeld']);
  
  if (raw['isFutures'] === 'true') {
    pos.isFutures = true;
    if (raw['leverage']) pos.leverage = parseFloat(raw['leverage']);
    if (raw['symbol']) pos.symbol = raw['symbol'];
    if (raw['side']) pos.side = raw['side'] as 'long' | 'short';
  }

  return pos;
}
// ── CLI Entrypoint ─────────────────────────────────────────────────────────
import 'dotenv/config';
import { getRedis, closeRedis } from '../shared/redis.js';

async function main() {
  const redis = getRedis();
  const args = process.argv.slice(2);

  if (args[0] === '--list') {
    const positions = await getOpenPositions(redis);
    if (positions.length === 0) {
      console.log('No open positions.');
    } else {
      console.table(positions.map(p => ({
        marketId: p.marketId,
        direction: p.direction,
        stake: `$${p.stakeUsd.toFixed(2)}`,
        entry: (p.entryPrice * 100).toFixed(1) + '%',
        shares: p.sharesHeld?.toFixed(4) ?? 'N/A',
        venue: p.executionVenue,
        question: p.question.slice(0, 50) + '...'
      })));
    }
  } else if (args[0] === '--remove' && args[1] && args[2]) {
    const marketId = args[1];
    const direction = args[2].toUpperCase() as Position['direction'];
    await closePosition(redis, marketId, direction);
    console.log(`Successfully removed ${marketId}:${direction} from ledger.`);
  } else {
    console.log('Usage:');
    console.log('  npx tsx src/execution/positionLedger.ts --list');
    console.log('  npx tsx src/execution/positionLedger.ts --remove <marketId> <YES|NO|LONG|SHORT>');
  }

  await closeRedis();
}

const isMain = process.argv[1]?.endsWith('positionLedger.ts') || process.argv[1]?.endsWith('positionLedger.js');
if (isMain) {
  main().catch(err => {
    console.error('CLI Error:', err);
    process.exit(1);
  });
}
