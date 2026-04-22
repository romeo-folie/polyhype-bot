import type { Sql } from 'postgres';
import { logger } from '../../../shared/logger.js';
import { weatherGroundTruthRowSchema } from '../../schemas/weather_ground_truth.js';

export async function handleWeatherGroundTruth(sql: Sql, payloads: unknown[]): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const p of payloads) {
    const parsed = weatherGroundTruthRowSchema.safeParse(p);
    if (!parsed.success) {
      logger.warn('[writer] weather_ground_truth payload rejected', {
        error: parsed.error.errors[0]?.message,
      });
      continue;
    }
    const d = parsed.data;
    rows.push({
      observed_at:       d.observedAt ?? new Date().toISOString(),
      city:              d.city,
      target_date:       d.targetDate,
      unit:              d.unit,
      observed_high:     d.observedHigh,
      source:            d.source,
      resolution_high:   d.resolutionHigh ?? null,
      resolution_source: d.resolutionSource ?? null,
    });
  }
  if (rows.length === 0) return;
  // ON CONFLICT: insert new rows normally; for existing rows, backfill
  // resolution_high/source if not yet set (never overwrite once populated).
  await sql`
    INSERT INTO weather_ground_truth ${sql(rows,
      'observed_at', 'city', 'target_date', 'unit', 'observed_high', 'source',
      'resolution_high', 'resolution_source'
    )}
    ON CONFLICT (city, target_date) DO UPDATE
      SET resolution_high   = EXCLUDED.resolution_high,
          resolution_source = EXCLUDED.resolution_source
      WHERE weather_ground_truth.resolution_high IS NULL
        AND EXCLUDED.resolution_high IS NOT NULL
  `;
}
