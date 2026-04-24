import { z } from 'zod';

const SIGNAL_SOURCE = [
  'osint', 'copytrade', 'spot', 'arb', 'crypto-arb', 'futures', 'sports', 'clob-flow',
  'oracle-lag', 'near-zero-arb', 'longshot-bias', 'correlation-arb', 'hl-momentum', 'weather',
  'fv-scanner',
] as const;
const DIRECTION = ['YES', 'NO', 'UP', 'DOWN', 'LONG', 'SHORT'] as const;

export const shadowObservationRowSchema = z.object({
  observedAt:   z.string().datetime().optional(),
  kind:         z.string(),   // 'atr'|'volume_spike'|'adx'|'choppiness'|'zscore'|'hl_funding'
  source:       z.enum(SIGNAL_SOURCE),
  symbol:       z.string().optional(),
  marketId:     z.string().optional(),
  direction:    z.enum(DIRECTION).optional(),
  wouldBlock:   z.boolean(),
  metricValue:  z.number().optional(),
  threshold:    z.number().optional(),
  payload:      z.record(z.unknown()).optional(),
});

export type ShadowObservationRow = z.infer<typeof shadowObservationRowSchema>;
