/**
 * Producer-side write queue — Epic #142.
 *
 * `enqueueWrite()` is the ONLY entry point production workers should use to
 * write durable analytics. It's fire-and-forget: it XADDs to the Redis stream
 * `db:writeq` and swallows every error. Workers must never fail a trade because
 * the analytics layer is down.
 *
 * Design notes:
 *  - Stream-only writes are at-least-once (caller owns idempotency by minting
 *    UUIDs at the emit site or using natural keys with ON CONFLICT DO NOTHING).
 *  - We MAXLEN ~ to bound memory pressure on Redis if the writer is offline for
 *    a long time. Old entries fall out the back; the writer's PEL is the only
 *    backstop for in-flight messages.
 *  - On enqueue failure we increment `telemetry:writeq:dropped` (a hash by
 *    table) so the Phase 7 lag dashboard can alert on sustained drops.
 */

import { getRedis } from '../shared/redis.js';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';

export async function enqueueWrite(
  table: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const cfg = loadConfig();
    const redis = getRedis();
    await redis.xadd(
      cfg.DB_STREAM_KEY,
      'MAXLEN',
      '~',
      String(cfg.DB_STREAM_MAXLEN),
      '*',
      'table',
      table,
      'payload',
      JSON.stringify(payload),
      'enqueuedAt',
      new Date().toISOString(),
    );
  } catch (err) {
    logger.warn('[writeq] enqueue failed (non-fatal)', {
      table,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await getRedis().hincrby('telemetry:writeq:dropped', table, 1);
    } catch {
      /* swallow — telemetry must never bubble */
    }
  }
}
