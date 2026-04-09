import { z } from 'zod';

export const arbLatencySampleRowSchema = z.object({
  observedAt: z.string().datetime().optional(),
  stage:      z.string(),
  latencyMs:  z.number().int(),
  context:    z.record(z.unknown()).optional(),
});

export type ArbLatencySampleRow = z.infer<typeof arbLatencySampleRowSchema>;
