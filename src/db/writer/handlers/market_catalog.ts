import type { Sql } from 'postgres';
import { logger } from '../../../shared/logger.js';
import { marketCatalogRowSchema } from '../../schemas/market_catalog.js';

export async function handleMarketCatalog(sql: Sql, payloads: unknown[]): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const p of payloads) {
    const parsed = marketCatalogRowSchema.safeParse(p);
    if (!parsed.success) {
      logger.warn('[writer] market_catalog payload rejected', {
        error: parsed.error.errors[0]?.message,
      });
      continue;
    }
    const d = parsed.data;
    rows.push({
      snapshot_id:  d.snapshotId,
      captured_at:  d.capturedAt ?? new Date().toISOString(),
      market_id:    d.marketId,
      condition_id: d.conditionId ?? null,
      question:     d.question,
      end_date:     d.endDate ?? null,
      outcomes:     d.outcomes ?? null,
      liquidity:    d.liquidity ?? null,
      volume_24h:   d.volume24h ?? null,
      active:       d.active ?? null,
      archived:     d.archived ?? null,
      raw:          d.raw ?? {},
    });
  }
  if (rows.length === 0) return;
  await sql`
    INSERT INTO market_catalog ${sql(rows,
      'snapshot_id', 'captured_at', 'market_id', 'condition_id', 'question',
      'end_date', 'outcomes', 'liquidity', 'volume_24h', 'active', 'archived', 'raw'
    )}
    ON CONFLICT (captured_at, market_id) DO NOTHING
  `;
}
