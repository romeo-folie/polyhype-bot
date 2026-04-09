import type { Sql } from 'postgres';
import { logger } from '../../../shared/logger.js';
import { arbLatencySampleRowSchema } from '../../schemas/arb_latency_samples.js';

export async function handleArbLatencySamples(sql: Sql, payloads: unknown[]): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const p of payloads) {
    const parsed = arbLatencySampleRowSchema.safeParse(p);
    if (!parsed.success) {
      logger.warn('[writer] arb_latency_samples payload rejected', {
        error: parsed.error.errors[0]?.message,
      });
      continue;
    }
    const d = parsed.data;
    rows.push({
      observed_at: d.observedAt ?? new Date().toISOString(),
      stage:       d.stage,
      latency_ms:  d.latencyMs,
      context:     d.context ?? {},
    });
  }
  if (rows.length === 0) return;
  // BIGSERIAL PK — each sample is a new append.
  await sql`
    INSERT INTO arb_latency_samples ${sql(rows,
      'observed_at', 'stage', 'latency_ms', 'context'
    )}
  `;
}
