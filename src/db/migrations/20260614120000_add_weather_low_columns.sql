-- Add daily-MINIMUM columns to weather_ground_truth for "Lowest temperature"
-- market support. Mirrors the existing high columns:
--
-- observed_low          — daily min from the Open-Meteo archive at forecast coords.
-- resolution_low        — daily min from the exact source Polymarket resolves
--                         against (WU, NOAA METAR, or HKO). NULL until the
--                         resolution fetcher runs for that (city, target_date).
-- resolution_low_source — which fetcher populated resolution_low: 'wu'|'metar'|'hko'.
--
-- The high columns (observed_high / resolution_high / source / resolution_source)
-- are unchanged. The writer handler upserts both extremes in one row per
-- (city, target_date), so a city's highest- and lowest-temperature markets share
-- a single ground-truth row.

ALTER TABLE weather_ground_truth
  ADD COLUMN IF NOT EXISTS observed_low          DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS resolution_low        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS resolution_low_source TEXT;
