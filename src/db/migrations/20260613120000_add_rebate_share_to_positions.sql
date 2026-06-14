-- Add rebate_share column to positions for rebate-farming analytics.
--
-- Persists the maker rebate share for the market's fee category (0.20 crypto /
-- 0.25 rest) captured at fill, so a pair-completion leg built later from a held
-- position inherits the correct share instead of defaulting to 0.25 (which
-- overstates est_rebate_usd on crypto markets). The completion path reads this
-- from Redis (positionLedger); persisting to Postgres lets us slice estimated-
-- vs-actual rebate accuracy by fee category. Entry-snapshot value (immutable).

ALTER TABLE positions ADD COLUMN IF NOT EXISTS rebate_share DOUBLE PRECISION;
