import { z } from 'zod';

/**
 * Schema for inserting a row into trade_memory_cases.
 * The embedding must be exactly 1536 dimensions (text-embedding-3-small).
 * The handler serialises embedding as a pgvector literal and casts via ::vector.
 */
export const tradeMemoryInsertSchema = z.object({
  outcomeId:            z.string().uuid().optional(),
  decisionId:           z.string().uuid().optional(),
  marketId:             z.string(),
  conditionId:          z.string().optional(),
  question:             z.string(),
  category:             z.string(),
  direction:            z.enum(['YES', 'NO', 'UP', 'DOWN', 'LONG', 'SHORT']),
  priceZone:            z.number().int().min(1).max(5).optional(),
  caseType:             z.enum(['success', 'cautionary_traded', 'cautionary_skipped']),
  result:               z.enum(['won', 'lost', 'pushed']).optional(),
  returnPct:            z.number().optional(),
  holdingHours:         z.number().optional(),
  consensusProbability: z.number().min(0).max(1).optional(),
  skipReason:           z.string().optional(),
  reasoningText:        z.string().min(1),
  embedding:            z.array(z.number()).length(1536),
  modelVersion:         z.string().default('text-embedding-3-small'),
  isReconciled:         z.boolean().default(false),
});

export type TradeMemoryInsert = z.infer<typeof tradeMemoryInsertSchema>;
