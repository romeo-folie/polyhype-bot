import { z } from 'zod';

const DIRECTION = ['YES', 'NO', 'UP', 'DOWN', 'LONG', 'SHORT'] as const;

// Optional fields are also `.nullable()` because the executor emits `null`
// for unset maker telemetry fields (e.g. makerOrderId on the not-filled path).
// Without `.nullable()`, Zod would reject those payloads and the writer would
// silently drop every maker_telemetry row.
export const makerTelemetryRowSchema = z.object({
  observedAt:                 z.string().datetime().optional(),
  attemptId:                  z.string().uuid().optional(),
  executionId:                z.string().optional(),
  marketId:                   z.string(),
  direction:                  z.enum(DIRECTION),
  side:                       z.enum(['entry', 'exit']),
  makerAttempted:             z.boolean(),
  makerOrderId:               z.string().nullable().optional(),
  makerPostedPrice:           z.number().nullable().optional(),
  makerPostedSize:            z.number().nullable().optional(),
  makerWaitMs:                z.number().int().nullable().optional(),
  makerFillStatus:            z.string().nullable().optional(),
  makerCancelConfirmed:       z.boolean().nullable().optional(),
  makerPriceImprovementBps:   z.number().nullable().optional(),
  makerPriceImprovementUsd:   z.number().nullable().optional(),
  raw:                        z.record(z.unknown()).optional(),
});

export type MakerTelemetryRow = z.infer<typeof makerTelemetryRowSchema>;
