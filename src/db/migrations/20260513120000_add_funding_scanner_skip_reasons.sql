-- Add skip reasons emitted by the hl-funding scanner's OI gate and position cap.
--   oi_below_minimum     — OI (markPrice × contracts) < HL_FUNDING_SCANNER_MIN_OI_USD
--   max_positions_reached — already at HL_FUNDING_SCANNER_MAX_POSITIONS open positions

ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'oi_below_minimum';
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'max_positions_reached';
