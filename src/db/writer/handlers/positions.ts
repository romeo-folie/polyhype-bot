/**
 * Positions handler — UPSERT on (market_id, direction, opened_at).
 *
 * Called on every state change: recordPosition, updatePosition, updateHighWaterMark
 * (Phase 3 wiring). Mutable columns are updated on conflict; immutable entry-snapshot
 * columns are intentionally excluded from the DO UPDATE clause.
 */
import type { Sql } from 'postgres';
import { logger } from '../../../shared/logger.js';
import { positionRowSchema } from '../../schemas/positions.js';

export async function handlePositions(sql: Sql, payloads: unknown[]): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const p of payloads) {
    const parsed = positionRowSchema.safeParse(p);
    if (!parsed.success) {
      logger.warn('[writer] positions payload rejected', {
        error: parsed.error.errors[0]?.message,
      });
      continue;
    }
    const d = parsed.data;
    rows.push({
      market_id:                          d.marketId,
      direction:                          d.direction,
      opened_at:                          d.openedAt,
      closed_at:                          d.closedAt ?? null,
      reconciliation_status:              d.reconciliationStatus ?? null,
      pending_settlement:                 d.pendingSettlement ?? false,
      synth_hedged:                       d.synthHedged ?? false,
      hedge_link:                         d.hedgeLink ?? null,
      entry_price:                        d.entryPrice,
      stake_usd:                          d.stakeUsd,
      shares_held:                        d.sharesHeld ?? null,
      execution_venue:                    d.executionVenue,
      execution_id:                       d.executionId ?? null,
      decision_id:                        d.decisionId ?? null,
      mode_configured:                    d.modeConfigured ?? null,
      entry_execution_path:               d.entryExecutionPath ?? null,
      entry_order_type:                   d.entryOrderType ?? null,
      fallback_reason:                    d.fallbackReason ?? null,
      decision_best_bid:                  d.decisionBestBid ?? null,
      decision_best_ask:                  d.decisionBestAsk ?? null,
      decision_mid_price:                 d.decisionMidPrice ?? null,
      decision_spread_bps:                d.decisionSpreadBps ?? null,
      counterfactual_taker_price:         d.counterfactualImmediateTakerPrice ?? null,
      counterfactual_taker_shares:        d.counterfactualImmediateTakerShares ?? null,
      counterfactual_taker_cost:          d.counterfactualImmediateTakerCostUsd ?? null,
      maker_price_improvement_bps:        d.makerPriceImprovementBps ?? null,
      maker_price_improvement_usd:        d.makerPriceImprovementUsd ?? null,
      mapping_confidence:                 d.mappingConfidence ?? null,
      relevance_class:                    d.relevanceClass ?? null,
      edge_class:                         d.edgeClass ?? null,
      sizing_reason:                      d.sizingReason ?? null,
      is_futures:                         d.isFutures ?? false,
      symbol:                             d.symbol ?? null,
      leverage:                           d.leverage ?? null,
      entry_atr:                          d.entryAtr ?? null,
      entry_atr_pct:                      d.entryAtrPct ?? null,
      price_zone:                         d.priceZone ?? null,
      consensus_probability:              d.consensusProbability ?? null,
      consensus_stddev:                   d.consensusStddev ?? null,
      question:                           d.question,
      sourced_from:                       d.sourcedFrom,
      updated_at:                         new Date().toISOString(),
      raw:                                d.raw ?? {},
    });
  }
  if (rows.length === 0) return;
  await sql`
    INSERT INTO positions ${sql(rows,
      'market_id', 'direction', 'opened_at', 'closed_at', 'reconciliation_status',
      'pending_settlement', 'synth_hedged', 'hedge_link', 'entry_price', 'stake_usd',
      'shares_held', 'execution_venue', 'execution_id', 'decision_id',
      'mode_configured', 'entry_execution_path', 'entry_order_type', 'fallback_reason',
      'decision_best_bid', 'decision_best_ask', 'decision_mid_price', 'decision_spread_bps',
      'counterfactual_taker_price', 'counterfactual_taker_shares', 'counterfactual_taker_cost',
      'maker_price_improvement_bps', 'maker_price_improvement_usd',
      'mapping_confidence', 'relevance_class', 'edge_class', 'sizing_reason',
      'is_futures', 'symbol', 'leverage', 'entry_atr', 'entry_atr_pct', 'price_zone',
      'consensus_probability', 'consensus_stddev', 'question', 'sourced_from',
      'updated_at', 'raw'
    )}
    ON CONFLICT (market_id, direction, opened_at) DO UPDATE SET
      closed_at             = EXCLUDED.closed_at,
      reconciliation_status = EXCLUDED.reconciliation_status,
      pending_settlement    = EXCLUDED.pending_settlement,
      synth_hedged          = EXCLUDED.synth_hedged,
      hedge_link            = EXCLUDED.hedge_link,
      shares_held           = EXCLUDED.shares_held,
      updated_at            = now(),
      raw                   = EXCLUDED.raw
  `;
}
