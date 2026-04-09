/**
 * Phase 1 canary handler — bulk-inserts `health_pings` rows.
 *
 * Validates each payload with the Zod schema and drops malformed entries
 * (logged at WARN). Inserts the survivors in one statement. There is no
 * ON CONFLICT clause: `id` is BIGSERIAL and rows are append-only — duplicates
 * here would mean the producer XADDed the same logical event twice, which is
 * fine for a canary.
 */

import type { Sql } from 'postgres';
import { logger } from '../../../shared/logger.js';
import { healthPingRowSchema } from '../../schemas/health_pings.js';

export async function handleHealthPings(sql: Sql, payloads: unknown[]): Promise<void> {
  const valid: { writer: string; observed_at: string }[] = [];
  for (const p of payloads) {
    const parsed = healthPingRowSchema.safeParse(p);
    if (!parsed.success) {
      logger.warn('[writer] health_pings payload rejected', {
        error: parsed.error.errors[0]?.message,
      });
      continue;
    }
    valid.push({ writer: parsed.data.writer, observed_at: parsed.data.observedAt });
  }
  if (valid.length === 0) return;
  // postgres.js: pass an array of row objects + the column list to get a bulk INSERT.
  await sql`INSERT INTO health_pings ${sql(valid, 'writer', 'observed_at')}`;
}
