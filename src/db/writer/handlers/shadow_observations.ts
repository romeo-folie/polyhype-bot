import type { Sql } from 'postgres';
import { logger } from '../../../shared/logger.js';
import { shadowObservationRowSchema } from '../../schemas/shadow_observations.js';

export async function handleShadowObservations(sql: Sql, payloads: unknown[]): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const p of payloads) {
    const parsed = shadowObservationRowSchema.safeParse(p);
    if (!parsed.success) {
      logger.warn('[writer] shadow_observations payload rejected', {
        error: parsed.error.errors[0]?.message,
      });
      continue;
    }
    const d = parsed.data;
    rows.push({
      observed_at:  d.observedAt ?? new Date().toISOString(),
      kind:         d.kind,
      source:       d.source,
      symbol:       d.symbol ?? null,
      market_id:    d.marketId ?? null,
      direction:    d.direction ?? null,
      would_block:  d.wouldBlock,
      metric_value: d.metricValue ?? null,
      threshold:    d.threshold ?? null,
      payload:      d.payload ?? {},
    });
  }
  if (rows.length === 0) return;
  // BIGSERIAL PK — no ON CONFLICT needed (each observation is a new append).
  await sql`
    INSERT INTO shadow_observations ${sql(rows,
      'observed_at', 'kind', 'source', 'symbol', 'market_id', 'direction',
      'would_block', 'metric_value', 'threshold', 'payload'
    )}
  `;
}
