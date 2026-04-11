-- Add simmer_position_exists to skip_reason_t enum.
-- Executor emits this when Simmer already has an open position for the market
-- (position_already_open covers Redis-ledger dedup; this covers Simmer-side dedup).
-- IF NOT EXISTS guards against re-run on already-migrated DBs.
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'simmer_position_exists' AFTER 'position_already_open';
