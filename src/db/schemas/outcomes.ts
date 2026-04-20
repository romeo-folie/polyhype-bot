import { z } from 'zod';

const SIGNAL_SOURCE = [
  'osint', 'copytrade', 'spot', 'arb', 'crypto-arb', 'futures', 'sports', 'clob-flow',
  'oracle-lag', 'near-zero-arb', 'longshot-bias', 'correlation-arb', 'hl-momentum', 'weather',
] as const;
const DIRECTION = ['YES', 'NO', 'UP', 'DOWN', 'LONG', 'SHORT'] as const;
const VENUE = ['simmer', 'clob', 'hyperliquid', 'none'] as const;
const ORDER_TYPE = ['maker', 'taker', 'none'] as const;
const OUTCOME_RESULT = ['won', 'lost', 'pushed'] as const;

export const outcomeRowSchema = z.object({
  outcomeId:                  z.string().uuid(),
  closedAt:                   z.string().datetime().optional(),
  openedAt:                   z.string().datetime().optional(),
  executionId:                z.string().optional(),
  attemptId:                  z.string().uuid().optional(),
  decisionId:                 z.string().uuid().optional(),
  source:                     z.enum(SIGNAL_SOURCE),
  category:                   z.string(),
  marketId:                   z.string(),
  conditionId:                z.string().optional(),
  question:                   z.string(),
  direction:                  z.enum(DIRECTION),
  urgencyScore:               z.number().optional(),
  consensusProbability:       z.number(),
  consensusStddev:            z.number().optional(),
  divergence:                 z.number(),
  result:                     z.enum(OUTCOME_RESULT),
  returnPct:                  z.number(),
  holdingHours:               z.number(),
  executionVenue:             z.enum(VENUE),
  modeConfigured:             z.string().optional(),
  entryExecutionPath:         z.string().optional(),
  entryOrderType:             z.enum(ORDER_TYPE).optional(),
  fallbackReason:             z.string().optional(),
  decisionSpreadBps:          z.number().optional(),
  makerPriceImprovementBps:   z.number().optional(),
  makerPriceImprovementUsd:   z.number().optional(),
  exitReason:                 z.string().optional(),
  entryPrice:                 z.number().optional(),
  stakeUsd:                   z.number().optional(),
  sharesHeld:                 z.number().optional(),
  entryAtr:                   z.number().optional(),
  entryAtrPct:                z.number().optional(),
  priceZone:                  z.number().int().min(1).max(5).optional(),
  synthHedged:                z.boolean().optional().default(false),
  pendingSettlement:          z.boolean().optional().default(false),
  reconciliationStatus:       z.string().optional(),
  hedgeLink:                  z.string().optional(),
  isReconciled:               z.boolean().optional().default(false),
  sourcedFrom:                z.string().optional(),
  raw:                        z.record(z.unknown()).optional(),
});

export type OutcomeRow = z.infer<typeof outcomeRowSchema>;
