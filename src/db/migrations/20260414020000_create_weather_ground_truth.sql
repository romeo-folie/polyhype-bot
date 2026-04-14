-- Create weather_ground_truth table — observed daily highs for past weather
-- bracket events, so shadow-scan predictions (shadow_observations.kind in
-- 'weather_event','weather_bracket') can be validated against reality.
--
-- Source is the Open-Meteo archive API (no API key, covers US + international).
-- UNIQUE(city, target_date) so the reconciler can enqueue idempotently — the
-- handler uses ON CONFLICT DO NOTHING.

CREATE TABLE weather_ground_truth (
  id             BIGSERIAL        PRIMARY KEY,
  observed_at    TIMESTAMPTZ      NOT NULL DEFAULT now(), -- when we fetched it
  city           TEXT             NOT NULL,                -- canonical from CITY_COORDINATES
  target_date    DATE             NOT NULL,                -- market resolution day
  unit           TEXT             NOT NULL,                -- 'fahrenheit' | 'celsius'
  observed_high  DOUBLE PRECISION NOT NULL,                -- daily high in `unit`
  source         TEXT             NOT NULL DEFAULT 'open-meteo-archive',
  UNIQUE (city, target_date)
);

CREATE INDEX idx_weather_ground_truth_target_date
  ON weather_ground_truth (target_date DESC);
