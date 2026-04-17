/**
 * Telemetry metric snapshot cron — Phase 4 (#145).
 *
 * Reads all `telemetry:*` Redis hashes (populated by hincrby() calls in
 * src/shared/telemetry.ts) and writes a snapshot row to telemetry_metric_snapshots
 * for each field. Postgres becomes the long-term reporting store so dashboards
 * don't have to query live Redis hashes.
 *
 * This job is snapshot-only: it does NOT prune or expire the source Redis keys.
 * Bounding Redis memory for `telemetry:*` is a separate concern (handled by
 * TTL or maxmemory policy at the Redis level).
 *
 * Schedule: nightly (see docker-compose.yml pga-cron service, INTERVAL 24h).
 *
 * One row per (metricKey, fieldName) with the field value at snapshot time.
 * Overwrites on conflict (snapshot_at, metric_name) are expected at T+0 on restarts.
 *
 * Also refreshes outcomes_daily materialized view so it stays current for dashboards.
 */

import { getRedis } from '../shared/redis.js';
import { getSql, closeSql } from '../db/client.js';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (!cfg.PG_URL && !cfg.PG_URL_NOPASS) {
    logger.info('[snapshot-cron] No database URL set (PG_URL / PG_URL_NOPASS) — skipping');
    return;
  }

  const redis = getRedis();
  await redis.connect().catch(() => {
    /* already connected */
  });

  const sql = getSql();
  const snapshotAt = new Date().toISOString();

  // ── 1. Scan all telemetry:* keys ─────────────────────────────────────────

  const rows: Record<string, unknown>[] = [];
  let cursor = '0';

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'telemetry:*', 'COUNT', 100);
    cursor = nextCursor;

    for (const key of keys) {
      const type = await redis.type(key);
      if (type !== 'hash') continue;

      const hash = await redis.hgetall(key);
      const metricPrefix = key; // e.g. "telemetry:execution:events"

      for (const [field, rawValue] of Object.entries(hash)) {
        const value = Number(rawValue);
        if (!isFinite(value)) continue;
        rows.push({
          snapshot_at: snapshotAt,
          metric_name: `${metricPrefix}:${field}`,
          metric_value: value,
          metric_labels: null,
        });
      }
    }
  } while (cursor !== '0');

  logger.info('[snapshot-cron] collected metric rows', { count: rows.length });

  if (rows.length > 0) {
    await sql`
      INSERT INTO telemetry_metric_snapshots ${sql(rows, 'snapshot_at', 'metric_name', 'metric_value', 'metric_labels')}
      ON CONFLICT (snapshot_at, metric_name) DO UPDATE SET
        metric_value = EXCLUDED.metric_value
    `;
    logger.info('[snapshot-cron] telemetry_metric_snapshots written', { count: rows.length });
  }

  // ── 2. Refresh outcomes_daily materialized view ───────────────────────────
  // CONCURRENTLY requires a UNIQUE INDEX (idx_od_bucket_dims) — created in Phase 4 migration.
  try {
    await sql`REFRESH MATERIALIZED VIEW CONCURRENTLY outcomes_daily`;
    logger.info('[snapshot-cron] outcomes_daily refreshed');
  } catch (err) {
    // Non-fatal: view may be empty on first run (no rows to lock for CONCURRENTLY).
    // Fall back to non-concurrent refresh.
    try {
      await sql`REFRESH MATERIALIZED VIEW outcomes_daily`;
      logger.info('[snapshot-cron] outcomes_daily refreshed (non-concurrent fallback)');
    } catch (err2) {
      logger.warn('[snapshot-cron] outcomes_daily refresh failed', {
        error: err2 instanceof Error ? err2.message : String(err2),
      });
    }
  }

  await redis.quit().catch(() => {});
}

main()
  .catch((err) => {
    logger.error('[snapshot-cron] fatal error', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  })
  .finally(() => {
    closeSql().catch(() => {});
  });
