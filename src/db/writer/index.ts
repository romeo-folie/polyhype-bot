/**
 * pga-db-writer — XREADGROUP consumer that drains `db:writeq` into Postgres.
 *
 * Phase 1 (this file's first form):
 *   - Self-emits one `health_pings` row every DB_HEALTH_PING_INTERVAL_MS.
 *   - Bootstraps the consumer group on startup (idempotent).
 *   - Single consumer; no XAUTOCLAIM.
 *   - Lock lifecycle uses the tri-state helpers from src/shared/redis.ts
 *     (refreshLock + reacquireLockAfterExpiry). The two-state pattern was the
 *     bug fixed in commit 853eb21 — DO NOT REINTRODUCE IT HERE.
 *
 * Lifecycle on SIGTERM/SIGINT (mirrors src/copytrade/worker.ts):
 *   1. clear timers, stop the poll loop
 *   2. wait for the in-flight XREADGROUP batch to finish or time out
 *   3. release the lock under our token
 *   4. closeSql() then closeRedis() then process.exit(0)
 *
 * The whole point of running this as its own container is that the writer can
 * crash, restart, or hang on PG without ever taking down a worker. The Redis
 * stream is the durable buffer.
 */

import { logger } from '../../shared/logger.js';
import { loadConfig } from '../../shared/config.js';
import {
  getRedis,
  closeRedis,
  acquireLock,
  refreshLock,
  reacquireLockAfterExpiry,
  releaseLock,
} from '../../shared/redis.js';
import { getSql, closeSql } from '../client.js';
import { handlers } from './handlers/index.js';
import { deadLetter } from './deadLetter.js';
import { enqueueWrite } from '../writeQueue.js';

const LOCK_KEY = 'lock:pga-db-writer';
const HEARTBEAT_KEY = 'heartbeat:writer';

async function runWriter(): Promise<void> {
  const cfg = loadConfig();
  if (!process.env.PG_URL && !process.env.PG_URL_NOPASS && !process.env.DATABASE_URL) {
    logger.error('[writer] No database URL set (tried PG_URL, PG_URL_NOPASS, DATABASE_URL) — refusing to start');
    process.exit(1);
  }

  const redis = getRedis();
  const sql = getSql();

  // ── Lock acquisition ────────────────────────────────────────────────
  // Single-writer invariant: only one pga-db-writer instance may consume
  // db:writeq at a time. Two consumers in the same group is technically safe
  // for XREADGROUP, but we want the operational invariant of "one writer" so
  // schema migrations and dead-letter handling have no concurrency surprises.
  let lockToken: string | null = await acquireLock(LOCK_KEY, cfg.DB_WRITER_LOCK_TTL_SEC);
  if (!lockToken) {
    logger.error('[writer] another pga-db-writer holds the lock — exiting');
    process.exit(1);
  }
  logger.info('[writer] lock acquired', { ttlSec: cfg.DB_WRITER_LOCK_TTL_SEC });

  // ── Consumer group bootstrap (idempotent) ───────────────────────────
  try {
    await redis.xgroup(
      'CREATE',
      cfg.DB_STREAM_KEY,
      cfg.DB_STREAM_GROUP,
      '$',
      'MKSTREAM',
    );
    logger.info('[writer] consumer group created', {
      stream: cfg.DB_STREAM_KEY,
      group: cfg.DB_STREAM_GROUP,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('BUSYGROUP')) throw err;
  }

  // ── Lifecycle / shutdown plumbing ───────────────────────────────────
  let running = true;
  let shuttingDown = false;
  let inFlight = false; // true while a batch is being dispatched

  // Tri-state lock refresh — load-bearing fix from commit 853eb21.
  // The previous two-state pattern (refreshed-or-bust) interpreted "key
  // expired by TTL" the same as "stolen by another instance" and silently
  // killed workers when a cycle ran longer than the TTL.
  const refreshIntervalMs = Math.floor((cfg.DB_WRITER_LOCK_TTL_SEC * 1000) / 3);
  const lockTimer = setInterval(() => {
    void (async () => {
      try {
        const state = await refreshLock(LOCK_KEY, lockToken!, cfg.DB_WRITER_LOCK_TTL_SEC);
        if (state === 'refreshed') return;
        if (state === 'expired') {
          // OUR own TTL lapsed (slow batch, GC stall, Redis pause). The lock
          // is gone and nobody else has taken it — re-acquire under the SAME
          // token so the existing release/refresh cycle keeps working.
          const ok = await reacquireLockAfterExpiry(
            LOCK_KEY,
            lockToken!,
            cfg.DB_WRITER_LOCK_TTL_SEC,
          );
          if (ok) {
            logger.warn('[writer] lock TTL expired; reacquired same token (no contender)');
            return;
          }
          logger.error('[writer] lock expired and another instance grabbed it — shutting down');
          await shutdown('lock-lost');
          return;
        }
        // 'stolen' — a DIFFERENT token holds the key. Another writer is up.
        logger.error('[writer] lock stolen by another instance — shutting down');
        await shutdown('lock-stolen');
      } catch (err) {
        logger.warn('[writer] lock refresh threw', { error: String(err) });
      }
    })();
  }, refreshIntervalMs);

  // Heartbeat — read by the docker healthcheck (Node one-liner) every 10s.
  // 60s TTL gives us 6x headroom over the 10s healthcheck interval.
  const heartbeatTimer = setInterval(() => {
    void redis
      .set(HEARTBEAT_KEY, String(Math.floor(Date.now() / 1000)), 'EX', 60)
      .catch((err: unknown) => {
        logger.warn('[writer] heartbeat set failed', { error: String(err) });
      });
  }, 5_000);

  // Phase 1 canary self-emit. The writer is ALSO a producer for this one
  // table — proves the round-trip on every interval.
  const canaryTimer = setInterval(() => {
    void enqueueWrite('health_pings', {
      writer: cfg.DB_STREAM_CONSUMER,
      observedAt: new Date().toISOString(),
    });
  }, cfg.DB_HEALTH_PING_INTERVAL_MS);

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    running = false;
    logger.info('[writer] shutdown initiated', { reason });
    clearInterval(lockTimer);
    clearInterval(heartbeatTimer);
    clearInterval(canaryTimer);

    // Wait for the in-flight batch to finish (XACK + handler), capped so we
    // never block compose's grace period. 5s is well under the default 10s
    // SIGKILL window.
    const deadline = Date.now() + 5_000;
    while (inFlight && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    if (lockToken) {
      try {
        await releaseLock(LOCK_KEY, lockToken);
      } catch (err) {
        logger.warn('[writer] releaseLock failed', { error: String(err) });
      }
      lockToken = null;
    }
    try {
      await closeSql();
    } catch (err) {
      logger.warn('[writer] closeSql failed', { error: String(err) });
    }
    try {
      await closeRedis();
    } catch (err) {
      logger.warn('[writer] closeRedis failed', { error: String(err) });
    }
    process.exit(0);
  }

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  logger.info('[writer] started', {
    stream: cfg.DB_STREAM_KEY,
    group: cfg.DB_STREAM_GROUP,
    consumer: cfg.DB_STREAM_CONSUMER,
    batch: cfg.DB_WRITER_BATCH_SIZE,
    blockMs: cfg.DB_WRITER_BLOCK_MS,
  });

  // Per-message retry counter (reset on success, dead-lettered at threshold).
  const retryCounts = new Map<string, number>();

  // ── Main loop ────────────────────────────────────────────────────────
  // Start with '0' to drain our own PEL (messages that were in-flight during
  // a previous crash and were never ACK'd). Once PEL is empty, switch to '>'
  // to receive new messages. This is the standard single-consumer recovery
  // pattern — no XAUTOCLAIM needed for a single-consumer setup.
  let streamReadId = '0';

  while (running) {
    try {
      // ioredis types xreadgroup as variadic strings; explicit cast keeps tsc happy.
      const readArgs: (string | number)[] = [
        'GROUP', cfg.DB_STREAM_GROUP, cfg.DB_STREAM_CONSUMER,
        'COUNT', cfg.DB_WRITER_BATCH_SIZE,
      ];
      // Only block when reading new messages ('>'); PEL reads must be non-blocking.
      if (streamReadId === '>') {
        readArgs.push('BLOCK', cfg.DB_WRITER_BLOCK_MS);
      }
      readArgs.push('STREAMS', cfg.DB_STREAM_KEY, streamReadId);

      const res = (await (redis.xreadgroup as (...a: unknown[]) => Promise<unknown>)(
        ...readArgs,
      )) as [string, [string, string[]][]][] | null;

      // When reading PEL ('0') and nothing comes back, PEL is empty — flip to '>'.
      // res[0]?.[1] can be null (not just undefined) when ioredis returns the
      // empty-PEL response as [[streamKey, null]], so use ?. all the way through.
      if (streamReadId !== '>' && (!res || (res[0]?.[1]?.length ?? 0) === 0)) {
        logger.info('[writer] PEL drain complete — switching to live stream');
        streamReadId = '>';
        continue;
      }

      if (!res || res.length === 0) continue;
      const batch = res[0]?.[1];
      if (!batch || batch.length === 0) continue;

      inFlight = true;
      try {
        // Group entries by table discriminator.
        const byTable = new Map<string, { id: string; payload: unknown }[]>();
        const malformed: string[] = [];

        for (const [id, fields] of batch) {
          if (!fields || !Array.isArray(fields)) {
            malformed.push(id);
            continue;
          }
          const kv: Record<string, string> = {};
          for (let i = 0; i + 1 < fields.length; i += 2) {
            kv[fields[i]!] = fields[i + 1]!;
          }
          const table = kv.table;
          if (!table) {
            malformed.push(id);
            continue;
          }
          let payload: unknown;
          try {
            payload = JSON.parse(kv.payload ?? '{}');
          } catch {
            malformed.push(id);
            continue;
          }
          let bucket = byTable.get(table);
          if (!bucket) {
            bucket = [];
            byTable.set(table, bucket);
          }
          bucket.push({ id, payload });
        }

        if (malformed.length > 0) {
          logger.warn('[writer] dropping malformed entries', { count: malformed.length });
          for (const id of malformed) {
            await deadLetter(redis, '<unknown>', { id, payload: null }, 'malformed');
            await redis.xack(cfg.DB_STREAM_KEY, cfg.DB_STREAM_GROUP, id);
          }
        }

        // Dispatch each table's bucket through its handler.
        for (const [table, rows] of byTable) {
          const handler = handlers[table];
          if (!handler) {
            logger.warn('[writer] no handler registered for table', {
              table,
              count: rows.length,
            });
            for (const r of rows) {
              await deadLetter(redis, table, r, 'no_handler');
              await redis.xack(cfg.DB_STREAM_KEY, cfg.DB_STREAM_GROUP, r.id);
            }
            continue;
          }
          try {
            await handler(
              sql,
              rows.map((r) => r.payload),
            );
            await redis.xack(
              cfg.DB_STREAM_KEY,
              cfg.DB_STREAM_GROUP,
              ...rows.map((r) => r.id),
            );
            for (const r of rows) retryCounts.delete(r.id);
          } catch (err) {
            logger.error('[writer] handler failed', {
              table,
              count: rows.length,
              error: err instanceof Error ? err.message : String(err),
            });
            for (const r of rows) {
              const n = (retryCounts.get(r.id) ?? 0) + 1;
              if (n >= cfg.DB_WRITER_MAX_RETRIES) {
                await deadLetter(redis, table, r, 'max_retries');
                await redis.xack(cfg.DB_STREAM_KEY, cfg.DB_STREAM_GROUP, r.id);
                retryCounts.delete(r.id);
              } else {
                retryCounts.set(r.id, n);
                // Don't XACK — leave on PEL; XREADGROUP > skips, but a future
                // XAUTOCLAIM (when we shard) will pick this up. For now, the
                // retry count guarantees we eventually dead-letter.
              }
            }
          }
        }
      } finally {
        inFlight = false;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // NOGROUP means the consumer group (or stream) was deleted out from under us —
      // e.g. a DEBUG RELOAD, external FLUSHDB, or accidental DEL during ops. Recreate
      // the group idempotently and reset the read cursor to '0' so we drain PEL again
      // (there won't be a real PEL, but this resets to a clean delivery state). The
      // stream itself is re-created via MKSTREAM if needed.
      if (msg.includes('NOGROUP')) {
        logger.warn('[writer] consumer group missing — recreating and resetting cursor');
        try {
          await redis.xgroup('CREATE', cfg.DB_STREAM_KEY, cfg.DB_STREAM_GROUP, '$', 'MKSTREAM');
        } catch (cgErr) {
          const cgMsg = cgErr instanceof Error ? cgErr.message : String(cgErr);
          if (!cgMsg.includes('BUSYGROUP')) {
            logger.warn('[writer] xgroup recreate failed', { error: cgMsg });
          }
        }
        streamReadId = '0'; // restart PEL drain
      } else {
        logger.error('[writer] loop error', { error: msg });
      }
      // Brief backoff so a hot error doesn't pin a CPU.
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

runWriter().catch((err: unknown) => {
  logger.error('[writer] fatal', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
