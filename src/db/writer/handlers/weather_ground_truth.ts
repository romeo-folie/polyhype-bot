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
      observed_at:   d.observedAt ?? new Date().toISOString(),
      city:          d.city,
      target_date:   d.targetDate,
      unit:          d.unit,
      observed_high: d.observedHigh,
      source:        d.source,
    });
  }
  if (rows.length === 0) return;
  // UNIQUE(city, target_date) — reconciler retries are safe.
  await sql`
    INSERT INTO weather_ground_truth ${sql(rows,
      'observed_at', 'city', 'target_date', 'unit', 'observed_high', 'source'
    )}
    ON CONFLICT (city, target_date) DO NOTHING
  `;
}
