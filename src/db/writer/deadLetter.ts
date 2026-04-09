/**
 * Dead-letter sink for the writer.
 *
 * When a single message has failed `DB_WRITER_MAX_RETRIES` times in a row, we
 * forward the original payload to `db:writeq:dead` (capped to 5_000 entries
 * via MAXLEN ~) and XACK the original entry on the main stream so the PEL
 * stops growing. The Phase 7 dashboard alerts on `XLEN db:writeq:dead > 0`.
 */

import type { Redis } from 'ioredis';

const DEAD_LETTER_KEY = 'db:writeq:dead';
const DEAD_LETTER_MAXLEN = 5_000;

export interface DeadLetterEntry {
  id: string;
  payload: unknown;
}

export async function deadLetter(
  redis: Redis,
  table: string,
  entry: DeadLetterEntry,
  reason: string,
): Promise<void> {
  try {
    await redis.xadd(
      DEAD_LETTER_KEY,
      'MAXLEN',
      '~',
      String(DEAD_LETTER_MAXLEN),
      '*',
      'table',
      table,
      'origId',
      entry.id,
      'payload',
      JSON.stringify(entry.payload ?? {}),
      'reason',
      reason,
      'deadAt',
      new Date().toISOString(),
    );
  } catch {
    /* swallow — if even dead-letter XADD fails, the loop logger has the bigger picture */
  }
}
