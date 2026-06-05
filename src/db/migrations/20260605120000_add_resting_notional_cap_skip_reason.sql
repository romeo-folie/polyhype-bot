-- Add weather rest-above-cap pool gate skip reason to skip_reason_t.
--
-- Emitted by the executor when a rest-above-cap weather maker post is refused
-- because the aggregate unfilled out-of-range resting notional would exceed
-- WEATHER_REST_ABOVE_CAP_MAX_NOTIONAL_USD (resting orders deduct nothing from
-- bankroll, so this cap bounds correlated-fill exposure of the pool).
-- IF NOT EXISTS makes this idempotent.

ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'resting_notional_cap';
