import type { Sql } from 'postgres';
import { logger } from '../../../shared/logger.js';
import { calibrationStatRowSchema } from '../../schemas/calibration_stats.js';

export async function handleCalibrationStats(sql: Sql, payloads: unknown[]): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const p of payloads) {
    const parsed = calibrationStatRowSchema.safeParse(p);
    if (!parsed.success) {
      logger.warn('[writer] calibration_stats payload rejected', {
        error: parsed.error.errors[0]?.message,
      });
      continue;
    }
    const d = parsed.data;
    rows.push({
      category:         d.category,
      bucket:           d.bucket,
      trade_count:      d.tradeCount ?? 0,
      win_count:        d.winCount ?? 0,
      total_return_pct: d.totalReturnPct ?? 0,
      last_updated_at:  d.lastUpdatedAt ?? new Date().toISOString(),
    });
  }
  if (rows.length === 0) return;
  await sql`
    INSERT INTO calibration_stats ${sql(rows,
      'category', 'bucket', 'trade_count', 'win_count', 'total_return_pct', 'last_updated_at'
    )}
    ON CONFLICT (category, bucket) DO UPDATE SET
      trade_count      = EXCLUDED.trade_count,
      win_count        = EXCLUDED.win_count,
      total_return_pct = EXCLUDED.total_return_pct,
      last_updated_at  = now()
  `;
}
