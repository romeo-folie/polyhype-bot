-- Add hl-funding-specific skip reason values to skip_reason_t.
--
-- These are emitted by the hl-funding scanner's signal_decisions logging:
--   denylist              — symbol on HL_FUNDING_SCANNER_SYMBOL_DENYLIST
--   apr_below_threshold   — |APR| <= ENTRY_APR_THRESHOLD (most common)
--   funding_cooldown      — per-(symbol,side) post-entry cooldown active
-- position_already_open (both same+opposite side) already exists in the enum.

ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'denylist';
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'apr_below_threshold';
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'funding_cooldown';
