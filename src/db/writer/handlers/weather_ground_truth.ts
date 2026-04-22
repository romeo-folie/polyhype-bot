import type { Sql } from 'postgres';
import { logger } from '../../../shared/logger.js';
import { weatherGroundTruthRowSchema } from '../../schemas/weather_ground_truth.js';

export async function handleWeatherGroundTruth(sql: Sql, payloads: unknown[]): Promise<void> {
  const inserts: Record<string, unknown>[] = [];
  const backfills: { city: string; target_date: string; resolution_high: number; resolution_source: string }[] = [];

  for (const p of payloads) {
    const parsed = weatherGroundTruthRowSchema.safeParse(p);
    if (!parsed.success) {
      logger.warn('[writer] weather_ground_truth payload rejected', {
        error: parsed.error.errors[0]?.message,
      });
      continue;
    }
    const d = parsed.data;
    if (d.backfillOnly) {
      // Resolution-only update — never touches observed_high.
      if (d.resolutionHigh !== undefined && d.resolutionSource !== undefined) {
        backfills.push({
          city:              d.city,
          target_date:       d.targetDate,
          resolution_high:   d.resolutionHigh,
          resolution_source: d.resolutionSource,
        });
      }
    } else {
      inserts.push({
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
  }

  if (inserts.length > 0) {
    // ON CONFLICT: insert new rows; for existing rows backfill resolution columns if not yet set.
    await sql`
      INSERT INTO weather_ground_truth ${sql(inserts,
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

  for (const b of backfills) {
    await sql`
      UPDATE weather_ground_truth
         SET resolution_high   = ${b.resolution_high},
             resolution_source = ${b.resolution_source}
       WHERE city        = ${b.city}
         AND target_date = ${b.target_date}
         AND resolution_high IS NULL
    `;
  }
}
