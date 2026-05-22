-- Add breakout_retest_missing to skip_reason_t enum.
-- Missing since PR #365 (2026-05-03) added the breakout-retest gate; the enum
-- value was never backfilled, causing signal_decisions writes to fail and retry
-- indefinitely for any hl-momentum signal blocked by that gate.
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'breakout_retest_missing';
