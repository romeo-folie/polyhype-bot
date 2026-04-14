-- Add spread_too_wide and one_sided_book to skip_reason_t enum.
-- Executor emits these when the entry spread guardrail fires on degenerate
-- CLOB books (MAX_ENTRY_SPREAD_BPS gate). Without these enum values the
-- Zod-validated DB writer would fail inserts (or degrade to `other` via the
-- normalizeSkipReason fallback), losing the diagnostic signal.
-- IF NOT EXISTS guards against re-run on already-migrated DBs.
-- Note: dropped the `AFTER 'market_resolved'` positioning clause — `market_resolved`
-- is referenced in the TS schema enum but was never added to the DB enum in any
-- prior migration (schema drift), so the original clause failed on prod. Enum
-- ordering isn't load-bearing anywhere; appending is functionally identical.
-- Also adding `market_resolved` itself here to close the drift — the Zod enum
-- would pass validation for it but any insert would crash the DB writer.
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'market_resolved';
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'spread_too_wide';
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'one_sided_book';
