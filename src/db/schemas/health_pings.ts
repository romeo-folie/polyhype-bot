/**
 * Zod row schema for the canary `health_pings` table.
 *
 * Phase 1 ships ONLY this table. It exists permanently as a synthetic
 * end-to-end test of the writer pipeline:
 *   writer → enqueueWrite('health_pings', …) → XADD → XREADGROUP → handler → INSERT
 *
 * Phase 7's lag dashboard will read max(observed_at) from this table to compute
 * writer freshness independent of `heartbeat:writer` (Redis vs PG cross-check).
 */

import { z } from 'zod';

export const healthPingRowSchema = z.object({
  writer: z.string().min(1),
  observedAt: z.string().datetime(),
});

export type HealthPingRow = z.infer<typeof healthPingRowSchema>;
