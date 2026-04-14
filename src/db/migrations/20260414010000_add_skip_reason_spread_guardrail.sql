-- Add spread_too_wide and one_sided_book to skip_reason_t enum.
-- Executor emits these when the entry spread guardrail fires on degenerate
-- CLOB books (MAX_ENTRY_SPREAD_BPS gate). Without these enum values the
-- Zod-validated DB writer would fail inserts (or degrade to `other` via the
-- normalizeSkipReason fallback), losing the diagnostic signal.
-- IF NOT EXISTS guards against re-run on already-migrated DBs.
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'spread_too_wide' AFTER 'market_resolved';
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'one_sided_book' AFTER 'spread_too_wide';
