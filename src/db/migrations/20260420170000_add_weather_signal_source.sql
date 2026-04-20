-- Add weather to signal_source_t.
--
-- Weather scanner (src/weather/weatherScanner.ts) emits TradeSignals with
-- source='weather', which flows into execution_events, signal_decisions, and
-- outcomes. Without this value the DB writer silently drops those rows.
--
-- shadow_observations rows from the weather scanner use source='arb' (unchanged).

ALTER TYPE signal_source_t ADD VALUE IF NOT EXISTS 'weather';
