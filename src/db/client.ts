/**
 * Postgres client singleton — Epic #142.
 *
 * Mirrors the discipline of `src/shared/redis.ts`:
 *   - lazy connection (only opens when first used)
 *   - no signal handlers here; callers own lifecycle
 *   - small connection pool sized for the writer (one consumer + a few readers later)
 *
 * `PG_URL` is currently optional in the Zod schema (Phase 1 ships before #147 cutover),
 * so this module fails loud only when something actually tries to use it. The writer is
 * the only consumer in Phase 1; all production workers stay PG-free.
 */

import postgres, { type Sql } from 'postgres';

let _sql: Sql | null = null;

export function getSql(): Sql {
  if (_sql) return _sql;
  const url = process.env.PG_URL ?? process.env.PG_URL_NOPASS ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('Database connection URL is not set; tried PG_URL, then PG_URL_NOPASS, then DATABASE_URL');
  }
  _sql = postgres(url, {
    max: 8,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: true,
    onnotice: () => {
      /* squelch NOTICE noise from migrations etc. */
    },
  });
  return _sql;
}

/** Gracefully close the pool. Call from worker shutdown handlers, never from a signal handler here. */
export async function closeSql(): Promise<void> {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
  }
}

// NOTE (matches src/shared/redis.ts comment): we deliberately do NOT register
// SIGTERM/SIGINT handlers in this module. Each worker that opens the pool is
// responsible for releasing locks first, then calling closeSql() + closeRedis()
// before exiting. A handler here would race the worker's lock-release path.
