import type { Sql } from 'postgres';
import { logger } from '../../../shared/logger.js';
import { executionEventRowSchema } from '../../schemas/execution_events.js';

export async function handleExecutionEvents(sql: Sql, payloads: unknown[]): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const p of payloads) {
    const parsed = executionEventRowSchema.safeParse(p);
    if (!parsed.success) {
      logger.warn('[writer] execution_events payload rejected', {
        error: parsed.error.errors[0]?.message,
      });
      continue;
    }
    const d = parsed.data;
    rows.push({
      attempt_id:                   d.attemptId,
      created_at:                   d.createdAt ?? new Date().toISOString(),
      decision_id:                  d.decisionId ?? null,
      execution_id:                 d.executionId ?? null,
      source:                       d.source,
      market_id:                    d.marketId,
      direction:                    d.direction,
      final_execution_path:         d.finalExecutionPath,
      final_venue:                  d.finalVenue,
      final_order_type:             d.finalOrderType,
      execution_succeeded:          d.executionSucceeded,
      skip_reason:                  d.skipReason ?? null,
      error_class:                  d.errorClass ?? null,
      error_message:                d.errorMessage ?? null,
      shares_filled:                d.sharesFilled ?? null,
      stake_usd_executed:           d.stakeUsdExecuted ?? null,
      entry_price:                  d.entryPrice ?? null,
      fees_usd:                     d.feesUsd ?? null,
      slippage_bps:                 d.slippageBps ?? null,
      elapsed_ms:                   d.elapsedMs ?? null,
      counterfactual_taker_price:   d.counterfactualTakerPrice ?? null,
      counterfactual_taker_cost:    d.counterfactualTakerCost ?? null,
      maker_attempted:              d.makerAttempted ?? null,
      maker_wait_ms:                d.makerWaitMs ?? null,
      maker_fill_status:            d.makerFillStatus ?? null,
      maker_posted_price:           d.makerPostedPrice ?? null,
      maker_price_improvement_bps:  d.makerPriceImprovementBps ?? null,
      maker_price_improvement_usd:  d.makerPriceImprovementUsd ?? null,
      fallback_reason:              d.fallbackReason ?? null,
      tx_hash:                      d.txHash ?? null,
      raw:                          d.raw ?? {},
    });
  }
  if (rows.length === 0) return;
  await sql`
    INSERT INTO execution_events ${sql(rows,
      'attempt_id', 'created_at', 'decision_id', 'execution_id', 'source', 'market_id',
      'direction', 'final_execution_path', 'final_venue', 'final_order_type',
      'execution_succeeded', 'skip_reason', 'error_class', 'error_message',
      'shares_filled', 'stake_usd_executed', 'entry_price', 'fees_usd', 'slippage_bps',
      'elapsed_ms', 'counterfactual_taker_price', 'counterfactual_taker_cost',
      'maker_attempted', 'maker_wait_ms', 'maker_fill_status', 'maker_posted_price',
      'maker_price_improvement_bps', 'maker_price_improvement_usd',
      'fallback_reason', 'tx_hash', 'raw'
    )}
    ON CONFLICT (attempt_id) DO NOTHING
  `;
}
