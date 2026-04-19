-- Add hl-momentum to signal_source_t.
--
-- The HL momentum scanner (src/futures/hlMomentumScanner.ts) emits
-- shadow_observations rows with source='hl-momentum'. Without this migration
-- those rows fail Zod validation at the write queue and are dropped silently,
-- making the 48h dark-mode review impossible.
--
-- IF NOT EXISTS guards re-runs. No AFTER clause — ordering is not load-bearing.

ALTER TYPE signal_source_t ADD VALUE IF NOT EXISTS 'hl-momentum';
