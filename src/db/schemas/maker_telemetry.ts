import { z } from 'zod';

const DIRECTION = ['YES', 'NO', 'UP', 'DOWN', 'LONG', 'SHORT'] as const;

export const makerTelemetryRowSchema = z.object({
  observedAt:                 z.string().datetime().optional(),
  attemptId:                  z.string().uuid().optional(),
  executionId:                z.string().optional(),
  marketId:                   z.string(),
  direction:                  z.enum(DIRECTION),
  side:                       z.enum(['entry', 'exit']),
  makerAttempted:             z.boolean(),
  makerOrderId:               z.string().optional(),
  makerPostedPrice:           z.number().optional(),
  makerPostedSize:            z.number().optional(),
  makerWaitMs:                z.number().int().optional(),
  makerFillStatus:            z.string().optional(),
  makerCancelConfirmed:       z.boolean().optional(),
  makerPriceImprovementBps:   z.number().optional(),
  makerPriceImprovementUsd:   z.number().optional(),
  raw:                        z.record(z.unknown()).optional(),
});

export type MakerTelemetryRow = z.infer<typeof makerTelemetryRowSchema>;
