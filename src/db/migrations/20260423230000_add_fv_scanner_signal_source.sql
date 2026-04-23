-- Add fv-scanner to signal_source_t.
--
-- FV scanner (Black-Scholes fair-value for 15m BTC/ETH Up/Down markets) ships
-- as a new source. Without this, every shadow_observations / signal_decisions /
-- execution_events row from the FV scanner fails Zod validation and is silently
-- dropped or routed to db:writeq:dead.
--
-- IF NOT EXISTS guards re-runs. See memory/feedback_zod_db_enum_drift.md.

ALTER TYPE signal_source_t ADD VALUE IF NOT EXISTS 'fv-scanner';
