-- Add per-city resolution-source columns to weather_ground_truth.
--
-- resolution_high   — daily max from the exact source Polymarket resolves against
--                     (WU, NOAA METAR, or HKO). NULL until the resolution fetcher
--                     runs for that (city, target_date).
-- resolution_source — which fetcher populated resolution_high:
--                     'wu' | 'metar' | 'hko'
--
-- observed_high / source stay as-is (Open-Meteo archive at forecast coords).
-- The writer handler uses ON CONFLICT DO UPDATE so existing rows get backfilled.

ALTER TABLE weather_ground_truth
  ADD COLUMN resolution_high   DOUBLE PRECISION,
  ADD COLUMN resolution_source TEXT;
