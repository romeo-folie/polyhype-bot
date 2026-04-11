/**
 * Handler for trade_memory_cases inserts.
 *
 * Unlike other handlers, this one does NOT use sql(rows, col...) bulk syntax
 * because the `embedding` column is a pgvector type (vector(1536)). postgres.js
 * does not know about this custom type, so we serialise the embedding as the
 * pgvector text literal '[a,b,c,...]' and inject it with a ::vector cast in the
 * SQL string — which postgres.js renders as `$N::vector`.
 *
 * Rows are inserted individually (not bulk) to keep the casting simple. Batch
 * sizes are small (trade closures are infrequent) so this is fine.
 */

import type { Sql } from 'postgres';
import { logger } from '../../../shared/logger.js';
import { tradeMemoryInsertSchema, type TradeMemoryInsert } from '../../schemas/trade_memory.js';

export async function handleTradeMemory(sql: Sql, payloads: unknown[]): Promise<void> {
  const valid: TradeMemoryInsert[] = [];
  for (const p of payloads) {
    const parsed = tradeMemoryInsertSchema.safeParse(p);
    if (!parsed.success) {
      logger.warn('[writer] trade_memory payload rejected', {
        error: parsed.error.errors[0]?.message,
      });
      continue;
    }
    valid.push(parsed.data);
  }
  if (valid.length === 0) return;

  for (const row of valid) {
    // Serialise embedding as pgvector text literal: '[0.1,0.2,...]'
    const embStr = `[${row.embedding.join(',')}]`;
    await sql`
      INSERT INTO trade_memory_cases (
        outcome_id, decision_id, market_id, condition_id, question, category,
        direction, price_zone, case_type, result, return_pct, holding_hours,
        consensus_probability, skip_reason, reasoning_text, embedding, model_version, is_reconciled
      ) VALUES (
        ${row.outcomeId ?? null},
        ${row.decisionId ?? null},
        ${row.marketId},
        ${row.conditionId ?? null},
        ${row.question},
        ${row.category},
        ${row.direction},
        ${row.priceZone ?? null},
        ${row.caseType},
        ${row.result ?? null},
        ${row.returnPct ?? null},
        ${row.holdingHours ?? null},
        ${row.consensusProbability ?? null},
        ${row.skipReason ?? null},
        ${row.reasoningText},
        ${embStr}::vector,
        ${row.modelVersion},
        ${row.isReconciled}
      )
      ON CONFLICT DO NOTHING
    `.catch((err: unknown) => {
      logger.warn('[writer] trade_memory insert failed', {
        error: err instanceof Error ? err.message : String(err),
        marketId: row.marketId,
      });
    });
  }
}
