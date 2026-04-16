-- Add runtime-only signal sources to signal_source_t.
--
-- Runtime code has been emitting oracle-lag, near-zero-arb, longshot-bias, and
-- correlation-arb in TradeSignal.source since those strategies shipped, but the
-- DB enum never picked them up. Every signal_decisions / execution_events /
-- outcomes / shadow_observations row for those sources failed Zod validation at
-- the writer and was either silently dropped or routed to db:writeq:dead —
-- making those strategies invisible in DB analytics.
--
-- IF NOT EXISTS guards re-runs. No AFTER clause — ordering isn't load-bearing
-- anywhere in the codebase.
-- See memory/feedback_zod_db_enum_drift.md.

ALTER TYPE signal_source_t ADD VALUE IF NOT EXISTS 'oracle-lag';
ALTER TYPE signal_source_t ADD VALUE IF NOT EXISTS 'near-zero-arb';
ALTER TYPE signal_source_t ADD VALUE IF NOT EXISTS 'longshot-bias';
ALTER TYPE signal_source_t ADD VALUE IF NOT EXISTS 'correlation-arb';
