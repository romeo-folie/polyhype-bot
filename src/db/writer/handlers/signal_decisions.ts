import type { Sql } from 'postgres';
import { logger } from '../../../shared/logger.js';
import { signalDecisionRowSchema, normalizeSkipReason } from '../../schemas/signal_decisions.js';

export async function handleSignalDecisions(sql: Sql, payloads: unknown[]): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const p of payloads) {
    // Split compound skipReason (e.g. "extreme_price_llm_distrust:price=0.001") into enum + detail
    const rec = p as Record<string, unknown> | null;
    if (rec && typeof rec.skipReason === 'string' && rec.skipReason.includes(':')) {
      const { skipReason, skipDetail } = normalizeSkipReason(rec.skipReason);
      rec.skipReason = skipReason;
      if (!rec.skipDetail && skipDetail) rec.skipDetail = skipDetail;
    }
    const parsed = signalDecisionRowSchema.safeParse(p);
    if (!parsed.success) {
      logger.warn('[writer] signal_decisions payload rejected', {
        error: parsed.error.errors[0]?.message,
      });
      continue;
    }
    const d = parsed.data;
    rows.push({
      decision_id:            d.decisionId,
      created_at:             d.createdAt ?? new Date().toISOString(),
      source:                 d.source,
      market_id:              d.marketId,
      condition_id:           d.conditionId ?? null,
      question:               d.question,
      category:               d.category,
      direction:              d.direction ?? null,
      has_trade:              d.hasTrade,
      skip_reason:            d.skipReason ?? null,
      skip_detail:            d.skipDetail ?? null,
      consensus_probability:  d.consensusProbability ?? null,
      consensus_stddev:       d.consensusStddev ?? null,
      consensus_sample_count: d.consensusSampleCount ?? null,
      current_yes_price:      d.currentYesPrice ?? null,
      divergence:             d.divergence ?? null,
      ev:                     d.ev ?? null,
      kelly_fraction:         d.kellyFraction ?? null,
      kelly_fraction_capped:  d.kellyFractionCapped ?? null,
      price_zone:             d.priceZone ?? null,
      bankroll_usd:           d.bankrollUsd ?? null,
      stake_attempted_usd:    d.stakeAttemptedUsd ?? null,
      stake_floor_bumped:     d.stakeFloorBumped ?? false,
      book_depth_usd:         d.bookDepthUsd ?? null,
      decision_best_bid:      d.decisionBestBid ?? null,
      decision_best_ask:      d.decisionBestAsk ?? null,
      decision_mid_price:     d.decisionMidPrice ?? null,
      decision_spread_bps:    d.decisionSpreadBps ?? null,
      mode_configured:        d.modeConfigured ?? null,
      confluence_score:       d.confluenceScore ?? null,
      confluence_direction:   d.confluenceDirection ?? null,
      regime_adx:             d.regimeAdx ?? null,
      regime_choppiness:      d.regimeChoppiness ?? null,
      volume_ratio:           d.volumeRatio ?? null,
      source_headline:        d.sourceHeadline ?? null,
      source_execution_id:    d.sourceExecutionId ?? null,
      mapping_confidence:     d.mappingConfidence ?? null,
      relevance_class:        d.relevanceClass ?? null,
      edge_class:             d.edgeClass ?? null,
      sizing_reason:          d.sizingReason ?? null,
      raw:                    d.raw ?? {},
    });
  }
  if (rows.length === 0) return;
  await sql`
    INSERT INTO signal_decisions ${sql(rows,
      'decision_id', 'created_at', 'source', 'market_id', 'condition_id', 'question',
      'category', 'direction', 'has_trade', 'skip_reason', 'skip_detail',
      'consensus_probability', 'consensus_stddev', 'consensus_sample_count', 'current_yes_price',
      'divergence', 'ev', 'kelly_fraction', 'kelly_fraction_capped', 'price_zone',
      'bankroll_usd', 'stake_attempted_usd', 'stake_floor_bumped', 'book_depth_usd',
      'decision_best_bid', 'decision_best_ask', 'decision_mid_price', 'decision_spread_bps',
      'mode_configured', 'confluence_score', 'confluence_direction', 'regime_adx',
      'regime_choppiness', 'volume_ratio', 'source_headline', 'source_execution_id',
      'mapping_confidence', 'relevance_class', 'edge_class', 'sizing_reason', 'raw'
    )}
    ON CONFLICT DO NOTHING
  `;
}
