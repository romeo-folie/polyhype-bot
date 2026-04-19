import { z } from 'zod';

const SIGNAL_SOURCE = [
  'osint', 'copytrade', 'spot', 'arb', 'crypto-arb', 'futures', 'sports', 'clob-flow',
  'oracle-lag', 'near-zero-arb', 'longshot-bias', 'correlation-arb', 'hl-momentum',
] as const;
const DIRECTION = ['YES', 'NO', 'UP', 'DOWN', 'LONG', 'SHORT'] as const;
const VENUE = ['simmer', 'clob', 'hyperliquid', 'none'] as const;
const ORDER_TYPE = ['maker', 'taker', 'none'] as const;
const SKIP_REASON = [
  'extreme_price_llm_distrust', 'zone3_edge_below_fee_buffer', 'zone4_comfort_trap',
  'zone5_widow_maker', 'kelly_sign_unstable', 'noisy_signal', 'negative_ev',
  'too_long_dated', 'too_soon_expiring', 'funding_adverse', 'confluence_block',
  'volume_spike_block', 'regime_no_trend', 'regime_chop', 'stake_below_floor',
  'already_executed', 'position_already_open', 'stake_below_hl_minimum',
  'insufficient_equity', 'global_margin_cap', 'global_governor', 'maker_not_filled',
  'taker_edge_below_min', 'liquidity_gate', 'simmer_position_exists', 'market_resolved',
  'spread_too_wide', 'one_sided_book', 'no_clob_book',
  'other',
] as const;

export const executionEventRowSchema = z.object({
  attemptId:                  z.string().uuid(),
  createdAt:                  z.string().datetime().optional(),
  decisionId:                 z.string().uuid().optional(),
  executionId:                z.string().optional(),
  source:                     z.enum(SIGNAL_SOURCE),
  marketId:                   z.string(),
  direction:                  z.enum(DIRECTION),
  finalExecutionPath:         z.string(),
  finalVenue:                 z.enum(VENUE),
  finalOrderType:             z.enum(ORDER_TYPE),
  executionSucceeded:         z.boolean(),
  skipReason:                 z.enum(SKIP_REASON).optional(),
  errorClass:                 z.string().optional(),
  errorMessage:               z.string().optional(),
  sharesFilled:               z.number().optional(),
  stakeUsdExecuted:           z.number().optional(),
  entryPrice:                 z.number().optional(),
  feesUsd:                    z.number().optional(),
  slippageBps:                z.number().optional(),
  elapsedMs:                  z.number().int().optional(),
  counterfactualTakerPrice:   z.number().optional(),
  counterfactualTakerCost:    z.number().optional(),
  makerAttempted:             z.boolean().optional(),
  makerWaitMs:                z.number().int().optional(),
  makerFillStatus:            z.string().optional(),
  makerPostedPrice:           z.number().optional(),
  makerPriceImprovementBps:   z.number().optional(),
  makerPriceImprovementUsd:   z.number().optional(),
  fallbackReason:             z.string().optional(),
  txHash:                     z.string().optional(),
  raw:                        z.record(z.unknown()).optional(),
});

export type ExecutionEventRow = z.infer<typeof executionEventRowSchema>;
