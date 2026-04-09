import type { Sql } from 'postgres';
import { logger } from '../../../shared/logger.js';
import { telemetryMetricSnapshotRowSchema } from '../../schemas/telemetry_metric_snapshots.js';

export async function handleTelemetryMetricSnapshots(sql: Sql, payloads: unknown[]): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const p of payloads) {
    const parsed = telemetryMetricSnapshotRowSchema.safeParse(p);
    if (!parsed.success) {
      logger.warn('[writer] telemetry_metric_snapshots payload rejected', {
        error: parsed.error.errors[0]?.message,
      });
      continue;
    }
    const d = parsed.data;
    rows.push({
      snapshot_at:    d.snapshotAt ?? new Date().toISOString(),
      metric_name:    d.metricName,
      metric_value:   d.metricValue,
      metric_labels:  d.metricLabels ?? null,
    });
  }
  if (rows.length === 0) return;
  await sql`
    INSERT INTO telemetry_metric_snapshots ${sql(rows,
      'snapshot_at', 'metric_name', 'metric_value', 'metric_labels'
    )}
    ON CONFLICT (snapshot_at, metric_name) DO NOTHING
  `;
}
