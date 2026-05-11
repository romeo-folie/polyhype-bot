-- Add entry_funding_apr column to positions for hl-funding scanner analytics.
--
-- Persists the annualized funding rate (APR%) at the time of entry so that
-- Postgres analytics can slice hl-funding trade outcomes by entry APR band.
-- The monitor's sign-flip exit reads this from Redis (positionLedger), but
-- having it in Postgres lets us run post-hoc win-rate / APR-band queries.

ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_funding_apr DOUBLE PRECISION;
