/**
 * Dispatch table for the writer.
 *
 * Each handler takes (sql, payloads[]) and is responsible for ALL bulk-insert
 * semantics for its table — Zod validation, ON CONFLICT, etc. The writer loop
 * calls them grouped by `table` so each handler sees a single batch per
 * iteration of XREADGROUP.
 *
 * Adding a new table = (1) write a handler module, (2) register it here, (3)
 * write the migration. The writer code itself does not change.
 */

import type { Sql } from 'postgres';
import { handleHealthPings } from './health_pings.js';

export type WriterHandler = (sql: Sql, payloads: unknown[]) => Promise<void>;

export const handlers: Record<string, WriterHandler> = {
  health_pings: handleHealthPings,
};
