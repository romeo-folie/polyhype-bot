import type { Sql } from 'postgres';
import { logger } from '../../../shared/logger.js';
import { weatherGroundTruthRowSchema } from '../../schemas/weather_ground_truth.js';

interface Backfill {
  city: string;
  target_date: string;
  resolution_high: number | null;
  resolution_source: string | null;
  resolution_low: number | null;
  resolution_low_source: string | null;
}

export async function handleWeatherGroundTruth(sql: Sql, payloads: unknown[]): Promise<void> {
  const inserts: Record<string, unknown>[] = [];
  const backfills: Backfill[] = [];

  for (const p of payloads) {
    const parsed = weatherGroundTruthRowSchema.safeParse(p);
    if (!parsed.success) {
      const first = parsed.error.errors[0];
      logger.warn('[writer] weather_ground_truth payload rejected', {
        error: first?.message,
        path: first?.path?.join('.') ?? null,
        issueCount: parsed.error.errors.length,
      });
      continue;
    }
    const d = parsed.data;
    if (d.backfillOnly) {
      // Resolution-only update — never touches observed_high / observed_low.
      // Accept rows carrying the high pair, the low pair, or both.
      const hasHigh = d.resolutionHigh !== undefined && d.resolutionSource !== undefined;
      const hasLow = d.resolutionLow !== undefined && d.resolutionLowSource !== undefined;
      if (hasHigh || hasLow) {
        backfills.push({
          city:                  d.city,
          target_date:           d.targetDate,
          resolution_high:       d.resolutionHigh ?? null,
          resolution_source:     d.resolutionSource ?? null,
          resolution_low:        d.resolutionLow ?? null,
          resolution_low_source: d.resolutionLowSource ?? null,
        });
      }
    } else {
      inserts.push({
        observed_at:           d.observedAt ?? new Date().toISOString(),
        city:                  d.city,
        target_date:           d.targetDate,
        unit:                  d.unit,
        observed_high:         d.observedHigh,
        source:                d.source,
        resolution_high:       d.resolutionHigh ?? null,
        resolution_source:     d.resolutionSource ?? null,
        observed_low:          d.observedLow ?? null,
        resolution_low:        d.resolutionLow ?? null,
        resolution_low_source: d.resolutionLowSource ?? null,
      });
    }
  }

  if (inserts.length > 0) {
    // ON CONFLICT: insert new rows; for existing rows fill any still-null column
    // from the new value (COALESCE(existing, incoming) keeps set values, backfills
    // nulls). This lets a high-only row gain low ground truth later — and vice
    // versa — without a restrictive WHERE that would block one extreme once the
    // other is set. observed_high is never overwritten once present.
    await sql`
      INSERT INTO weather_ground_truth ${sql(inserts,
        'observed_at', 'city', 'target_date', 'unit', 'observed_high', 'source',
        'resolution_high', 'resolution_source',
        'observed_low', 'resolution_low', 'resolution_low_source'
      )}
      ON CONFLICT (city, target_date) DO UPDATE
        SET resolution_high       = COALESCE(weather_ground_truth.resolution_high, EXCLUDED.resolution_high),
            resolution_source     = COALESCE(weather_ground_truth.resolution_source, EXCLUDED.resolution_source),
            observed_low          = COALESCE(weather_ground_truth.observed_low, EXCLUDED.observed_low),
            resolution_low        = COALESCE(weather_ground_truth.resolution_low, EXCLUDED.resolution_low),
            resolution_low_source = COALESCE(weather_ground_truth.resolution_low_source, EXCLUDED.resolution_low_source)
    `;
  }

  for (const b of backfills) {
    await sql`
      UPDATE weather_ground_truth
         SET resolution_high       = COALESCE(resolution_high, ${b.resolution_high}),
             resolution_source     = COALESCE(resolution_source, ${b.resolution_source}),
             resolution_low        = COALESCE(resolution_low, ${b.resolution_low}),
             resolution_low_source = COALESCE(resolution_low_source, ${b.resolution_low_source})
       WHERE city        = ${b.city}
         AND target_date = ${b.target_date}
    `;
  }
}
