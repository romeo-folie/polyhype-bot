import { z } from 'zod';

export const calibrationStatRowSchema = z.object({
  category:       z.string(),
  bucket:         z.string(),
  tradeCount:     z.number().int().optional().default(0),
  winCount:       z.number().int().optional().default(0),
  totalReturnPct: z.number().optional().default(0),
  lastUpdatedAt:  z.string().datetime().optional(),
});

export type CalibrationStatRow = z.infer<typeof calibrationStatRowSchema>;
