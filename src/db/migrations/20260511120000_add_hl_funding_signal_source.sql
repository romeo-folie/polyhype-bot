-- Add hl-funding to signal_source_t.
--
-- Required for shadow_observations, signal_decisions, and execution_events rows
-- written by the hl-funding mean-reversion scanner (PR #379).
-- Without this, DB writes are rejected with a Postgres enum-cast error.

ALTER TYPE signal_source_t ADD VALUE IF NOT EXISTS 'hl-funding';
