import type { Sql } from 'postgres';
import { logger } from '../../../shared/logger.js';
import { hedgeEventRowSchema } from '../../schemas/hedge_events.js';

export async function handleHedgeEvents(sql: Sql, payloads: unknown[]): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const p of payloads) {
    const parsed = hedgeEventRowSchema.safeParse(p);
    if (!parsed.success) {
      logger.warn('[writer] hedge_events payload rejected', {
        error: parsed.error.errors[0]?.message,
      });
      continue;
    }
    const d = parsed.data;
    rows.push({
      pm_position_id: d.pmPositionId ?? null,
      hl_position_id: d.hlPositionId ?? null,
      hedge_action:   d.hedgeAction,
      hl_symbol:      d.hlSymbol,
      hl_size:        d.hlSize,
      hl_entry_price: d.hlEntryPrice ?? null,
      hl_exit_price:  d.hlExitPrice ?? null,
      pnl_usd:        d.pnlUsd ?? null,
      observed_at:    d.observedAt ?? new Date().toISOString(),
      raw:            d.raw ?? null,
    });
  }
  if (rows.length === 0) return;
  // BIGSERIAL PK — each hedge event is a new append.
  await sql`
    INSERT INTO hedge_events ${sql(rows,
      'pm_position_id', 'hl_position_id', 'hedge_action', 'hl_symbol', 'hl_size',
      'hl_entry_price', 'hl_exit_price', 'pnl_usd', 'observed_at', 'raw'
    )}
  `;
}
