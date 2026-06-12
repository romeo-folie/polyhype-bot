import { z } from 'zod';

const SIGNAL_SOURCE = [
  'osint', 'copytrade', 'spot', 'arb', 'crypto-arb', 'futures', 'sports', 'clob-flow',
  'oracle-lag', 'near-zero-arb', 'longshot-bias', 'correlation-arb', 'hl-momentum', 'weather',
  'fv-scanner', 'hl-funding',
] as const;
const DIRECTION = ['YES', 'NO', 'UP', 'DOWN', 'LONG', 'SHORT'] as const;
const SKIP_REASON = [
  'extreme_price_llm_distrust', 'zone3_edge_below_fee_buffer', 'zone4_comfort_trap',
  'zone5_widow_maker', 'kelly_sign_unstable', 'noisy_signal', 'negative_ev',
  'too_long_dated', 'too_soon_expiring', 'funding_adverse', 'confluence_block',
  'volume_spike_block', 'regime_no_trend', 'regime_chop', 'stake_below_floor',
  'already_executed', 'position_already_open', 'stake_below_hl_minimum',
  'insufficient_equity', 'global_margin_cap', 'global_governor', 'maker_not_filled',
  'taker_edge_below_min', 'liquidity_gate', 'simmer_position_exists', 'market_resolved',
  'spread_too_wide', 'one_sided_book', 'no_clob_book',
  // hl-momentum-specific (added 2026-04-29)
  'score_below_min', 'anti_chase_rsi', 'anti_chase_vwap',
  'stretch_confirmation_pending', 'breakout_retest_missing',
  'loss_cooldown', 'momentum_cooldown', 'scanner_dark',
  'long_hl_confirmation_missing', 'oi_divergence_veto', 'weighted_total_score_low',
  '4h_ema_bias_mismatch', '1h_macd_mismatch',
  'entry_price_above_cap', 'contrarian_rsi_not_exhausted',
  // hl-funding-specific (added 2026-05-11)
  'denylist', 'apr_below_threshold', 'funding_cooldown',
  'oi_below_minimum', 'max_positions_reached',
  // executor guard (added 2026-05-15)
  'recently_resolved',
  // size-up gate (added 2026-05-24)
  'size_up_ineligible',
  // weather rest-above-cap pool gate (added 2026-06-05)
  'resting_notional_cap',
  // hl-momentum trend-chasing-long block (added 2026-06-12)
  'momentum_long_blocked',
  'other',
] as const;

const skipReasonSet: ReadonlySet<string> = new Set(SKIP_REASON);

/** Split compound skipReason like `extreme_price_llm_distrust:price=0.001` into enum + detail */
export function normalizeSkipReason(raw: string | undefined): { skipReason: string; skipDetail: string } {
  if (!raw) return { skipReason: 'other', skipDetail: '' };
  const colonIdx = raw.indexOf(':');
  if (colonIdx === -1) return { skipReason: skipReasonSet.has(raw) ? raw : 'other', skipDetail: skipReasonSet.has(raw) ? '' : raw };
  const base = raw.slice(0, colonIdx);
  const detail = raw.slice(colonIdx + 1);
  return { skipReason: skipReasonSet.has(base) ? base : 'other', skipDetail: detail };
}

export const signalDecisionRowSchema = z.object({
  decisionId:             z.string().uuid(),
  createdAt:              z.string().datetime().optional(),
  source:                 z.enum(SIGNAL_SOURCE),
  marketId:               z.string(),
  conditionId:            z.string().optional(),
  question:               z.string(),
  category:               z.string(),
  direction:              z.enum(DIRECTION).optional(),
  hasTrade:               z.boolean(),
  skipReason:             z.enum(SKIP_REASON).optional(),
  skipDetail:             z.string().optional(),
  consensusProbability:   z.number().optional(),
  consensusStddev:        z.number().optional(),
  consensusSampleCount:   z.number().int().optional(),
  currentYesPrice:        z.number().optional(),
  divergence:             z.number().optional(),
  ev:                     z.number().optional(),
  kellyFraction:          z.number().optional(),
  kellyFractionCapped:    z.number().optional(),
  priceZone:              z.number().int().min(1).max(5).optional(),
  bankrollUsd:            z.number().optional(),
  stakeAttemptedUsd:      z.number().optional(),
  stakeFloorBumped:       z.boolean().optional().default(false),
  bookDepthUsd:           z.number().optional(),
  decisionBestBid:        z.number().optional(),
  decisionBestAsk:        z.number().optional(),
  decisionMidPrice:       z.number().optional(),
  decisionSpreadBps:      z.number().optional(),
  modeConfigured:         z.string().optional(),
  confluenceScore:        z.number().int().optional(),
  confluenceDirection:    z.string().optional(),
  regimeAdx:              z.number().optional(),
  regimeChoppiness:       z.number().optional(),
  volumeRatio:            z.number().optional(),
  sourceHeadline:         z.string().optional(),
  sourceExecutionId:      z.string().optional(),
  mappingConfidence:      z.number().optional(),
  relevanceClass:         z.string().optional(),
  edgeClass:              z.string().optional(),
  sizingReason:           z.string().optional(),
  raw:                    z.record(z.unknown()).optional(),
});

export type SignalDecisionRow = z.infer<typeof signalDecisionRowSchema>;
