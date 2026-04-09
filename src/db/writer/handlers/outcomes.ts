import type { Sql } from 'postgres';
import { logger } from '../../../shared/logger.js';
import { outcomeRowSchema } from '../../schemas/outcomes.js';

export async function handleOutcomes(sql: Sql, payloads: unknown[]): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const p of payloads) {
    const parsed = outcomeRowSchema.safeParse(p);
    if (!parsed.success) {
      logger.warn('[writer] outcomes payload rejected', {
        error: parsed.error.errors[0]?.message,
      });
      continue;
    }
    const d = parsed.data;
    rows.push({
      outcome_id:                   d.outcomeId,
      closed_at:                    d.closedAt ?? new Date().toISOString(),
      opened_at:                    d.openedAt ?? null,
      execution_id:                 d.executionId ?? null,
      attempt_id:                   d.attemptId ?? null,
      decision_id:                  d.decisionId ?? null,
      source:                       d.source,
      category:                     d.category,
      market_id:                    d.marketId,
      condition_id:                 d.conditionId ?? null,
      question:                     d.question,
      direction:                    d.direction,
      urgency_score:                d.urgencyScore ?? null,
      consensus_probability:        d.consensusProbability,
      consensus_stddev:             d.consensusStddev ?? null,
      divergence:                   d.divergence,
      result:                       d.result,
      return_pct:                   d.returnPct,
      holding_hours:                d.holdingHours,
      execution_venue:              d.executionVenue,
      mode_configured:              d.modeConfigured ?? null,
      entry_execution_path:         d.entryExecutionPath ?? null,
      entry_order_type:             d.entryOrderType ?? null,
      fallback_reason:              d.fallbackReason ?? null,
      decision_spread_bps:          d.decisionSpreadBps ?? null,
      maker_price_improvement_bps:  d.makerPriceImprovementBps ?? null,
      maker_price_improvement_usd:  d.makerPriceImprovementUsd ?? null,
      exit_reason:                  d.exitReason ?? null,
      entry_price:                  d.entryPrice ?? null,
      stake_usd:                    d.stakeUsd ?? null,
      shares_held:                  d.sharesHeld ?? null,
      entry_atr:                    d.entryAtr ?? null,
      entry_atr_pct:                d.entryAtrPct ?? null,
      price_zone:                   d.priceZone ?? null,
      synth_hedged:                 d.synthHedged ?? false,
      pending_settlement:           d.pendingSettlement ?? false,
      reconciliation_status:        d.reconciliationStatus ?? null,
      hedge_link:                   d.hedgeLink ?? null,
      is_reconciled:                d.isReconciled ?? false,
      sourced_from:                 d.sourcedFrom ?? null,
      raw:                          d.raw ?? {},
    });
  }
  if (rows.length === 0) return;
  await sql`
    INSERT INTO outcomes ${sql(rows,
      'outcome_id', 'closed_at', 'opened_at', 'execution_id', 'attempt_id', 'decision_id',
      'source', 'category', 'market_id', 'condition_id', 'question', 'direction',
      'urgency_score', 'consensus_probability', 'consensus_stddev', 'divergence',
      'result', 'return_pct', 'holding_hours', 'execution_venue', 'mode_configured',
      'entry_execution_path', 'entry_order_type', 'fallback_reason', 'decision_spread_bps',
      'maker_price_improvement_bps', 'maker_price_improvement_usd', 'exit_reason',
      'entry_price', 'stake_usd', 'shares_held', 'entry_atr', 'entry_atr_pct',
      'price_zone', 'synth_hedged', 'pending_settlement', 'reconciliation_status',
      'hedge_link', 'is_reconciled', 'sourced_from', 'raw'
    )}
    ON CONFLICT (outcome_id) DO NOTHING
  `;
}
