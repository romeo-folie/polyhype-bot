import { z } from 'zod';

export const marketCatalogRowSchema = z.object({
  snapshotId:   z.string().uuid(),
  capturedAt:   z.string().datetime().optional(),
  marketId:     z.string(),
  conditionId:  z.string().optional(),
  question:     z.string(),
  endDate:      z.string().datetime().optional(),
  outcomes:     z.array(z.string()).optional(),
  liquidity:    z.number().optional(),
  volume24h:    z.number().optional(),
  active:       z.boolean().optional(),
  archived:     z.boolean().optional(),
  raw:          z.record(z.unknown()).optional(),
});

export type MarketCatalogRow = z.infer<typeof marketCatalogRowSchema>;
