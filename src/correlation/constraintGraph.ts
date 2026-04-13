/**
 * Redis persistence for the constraint graph.
 *
 * Key schema:
 *   correlation:graph:edge:{edgeId}            STRING  JSON(ConstraintEdge)  TTL: CORRELATION_GRAPH_TTL_S
 *   correlation:graph:index:market:{marketId}   SET     edgeId members       TTL: CORRELATION_GRAPH_TTL_S
 *   correlation:graph:all_edge_ids              SET     all edgeId members   TTL: CORRELATION_GRAPH_TTL_S
 *
 * Each edge is stored individually so it can have its own TTL. The index
 * sets allow both full enumeration (violation scanner) and per-market
 * lookup (eviction on market close).
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import type { ConstraintEdge } from './types.js';

const EDGE_PREFIX = 'correlation:graph:edge:';
const MARKET_INDEX_PREFIX = 'correlation:graph:index:market:';
const ALL_EDGES_KEY = 'correlation:graph:all_edge_ids';

/**
 * Persist a constraint edge in Redis.
 *
 * Writes the edge JSON + updates both market-index sets and the global
 * edge-id set. All keys share the same TTL so they expire together.
 */
export async function saveConstraint(
  redis: Redis,
  edge: ConstraintEdge,
  ttlS: number,
): Promise<void> {
  const pipeline = redis.pipeline();

  pipeline.set(`${EDGE_PREFIX}${edge.id}`, JSON.stringify(edge), 'EX', ttlS);
  pipeline.sadd(`${MARKET_INDEX_PREFIX}${edge.marketIdA}`, edge.id);
  pipeline.expire(`${MARKET_INDEX_PREFIX}${edge.marketIdA}`, ttlS);
  pipeline.sadd(`${MARKET_INDEX_PREFIX}${edge.marketIdB}`, edge.id);
  pipeline.expire(`${MARKET_INDEX_PREFIX}${edge.marketIdB}`, ttlS);
  pipeline.sadd(ALL_EDGES_KEY, edge.id);
  pipeline.expire(ALL_EDGES_KEY, ttlS);

  await pipeline.exec();
}

/**
 * Load all live constraint edges.
 *
 * Reads the global edge-id set, then MGETs every edge key. Edges whose
 * STRING key has already expired (TTL elapsed) are silently skipped.
 */
export async function loadAllConstraints(redis: Redis): Promise<ConstraintEdge[]> {
  const edgeIds = await redis.smembers(ALL_EDGES_KEY);
  if (edgeIds.length === 0) return [];

  const keys = edgeIds.map((id) => `${EDGE_PREFIX}${id}`);
  const values = await redis.mget(...keys);

  const edges: ConstraintEdge[] = [];
  const orphanIds: string[] = [];

  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    if (!raw) {
      orphanIds.push(edgeIds[i]!);
      continue;
    }
    try {
      edges.push(JSON.parse(raw) as ConstraintEdge);
    } catch {
      orphanIds.push(edgeIds[i]!);
    }
  }

  // Clean up orphaned IDs whose STRING keys have expired.
  if (orphanIds.length > 0) {
    await redis.srem(ALL_EDGES_KEY, ...orphanIds);
    logger.debug('[correlation] cleaned orphaned edge IDs', { count: orphanIds.length });
  }

  return edges;
}

/**
 * Evict expired constraints — edges where either market's endDate is
 * in the past. Returns the number of evicted edges.
 */
export async function evictExpiredConstraints(redis: Redis): Promise<number> {
  const edges = await loadAllConstraints(redis);
  const now = Date.now();
  let evicted = 0;

  for (const edge of edges) {
    const endA = edge.endDateA ? new Date(edge.endDateA).getTime() : Infinity;
    const endB = edge.endDateB ? new Date(edge.endDateB).getTime() : Infinity;

    if (endA > now && endB > now) continue;

    // At least one market has closed — remove the edge.
    const pipeline = redis.pipeline();
    pipeline.del(`${EDGE_PREFIX}${edge.id}`);
    pipeline.srem(ALL_EDGES_KEY, edge.id);
    pipeline.srem(`${MARKET_INDEX_PREFIX}${edge.marketIdA}`, edge.id);
    pipeline.srem(`${MARKET_INDEX_PREFIX}${edge.marketIdB}`, edge.id);
    await pipeline.exec();
    evicted++;
  }

  if (evicted > 0) {
    logger.info('[correlation] evicted expired constraints', { evicted });
  }

  return evicted;
}
