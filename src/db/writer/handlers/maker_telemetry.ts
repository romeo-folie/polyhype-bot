import type { Sql } from 'postgres';
import { logger } from '../../../shared/logger.js';
import { makerTelemetryRowSchema } from '../../schemas/maker_telemetry.js';

export async function handleMakerTelemetry(sql: Sql, payloads: unknown[]): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const p of payloads) {
    const parsed = makerTelemetryRowSchema.safeParse(p);
    if (!parsed.success) {
      logger.warn('[writer] maker_telemetry payload rejected', {
        error: parsed.error.errors[0]?.message,
      });
      continue;
    }
    const d = parsed.data;
    rows.push({
      observed_at:                  d.observedAt ?? new Date().toISOString(),
      attempt_id:                   d.attemptId ?? null,
      execution_id:                 d.executionId ?? null,
      market_id:                    d.marketId,
      direction:                    d.direction,
      side:                         d.side,
      maker_attempted:              d.makerAttempted,
      maker_order_id:               d.makerOrderId ?? null,
      maker_posted_price:           d.makerPostedPrice ?? null,
      maker_posted_size:            d.makerPostedSize ?? null,
      maker_wait_ms:                d.makerWaitMs ?? null,
      maker_fill_status:            d.makerFillStatus ?? null,
      maker_cancel_confirmed:       d.makerCancelConfirmed ?? null,
      maker_price_improvement_bps:  d.makerPriceImprovementBps ?? null,
      maker_price_improvement_usd:  d.makerPriceImprovementUsd ?? null,
      raw:                          d.raw ?? {},
    });
  }
  if (rows.length === 0) return;
  // BIGSERIAL PK — each maker lifecycle event is a new append.
  await sql`
    INSERT INTO maker_telemetry ${sql(rows,
      'observed_at', 'attempt_id', 'execution_id', 'market_id', 'direction', 'side',
      'maker_attempted', 'maker_order_id', 'maker_posted_price', 'maker_posted_size',
      'maker_wait_ms', 'maker_fill_status', 'maker_cancel_confirmed',
      'maker_price_improvement_bps', 'maker_price_improvement_usd', 'raw'
    )}
  `;
}
