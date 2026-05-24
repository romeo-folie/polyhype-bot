-- Add contrarian RSI exhaustion gate skip reason to skip_reason_t.
--
-- Emitted by the hl-momentum scanner when a contrarian entry is blocked because
-- RSI is not in the true exhaustion zone (LONG requires RSI ≤ OVERSOLD threshold;
-- SHORT requires RSI ≥ OVERBOUGHT threshold). IF NOT EXISTS makes this idempotent.

ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'contrarian_rsi_not_exhausted';
