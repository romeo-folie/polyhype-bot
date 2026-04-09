import { z } from 'zod';

export const hedgeEventRowSchema = z.object({
  pmPositionId:  z.number().int().optional(),  // positions.id
  hlPositionId:  z.number().int().optional(),  // positions.id
  hedgeAction:   z.enum(['opened', 'closed', 'rebalanced']),
  hlSymbol:      z.string(),
  hlSize:        z.number(),
  hlEntryPrice:  z.number().optional(),
  hlExitPrice:   z.number().optional(),
  pnlUsd:        z.number().optional(),
  observedAt:    z.string().datetime().optional(),
  raw:           z.record(z.unknown()).optional(),
});

export type HedgeEventRow = z.infer<typeof hedgeEventRowSchema>;
