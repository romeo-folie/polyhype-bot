-- Backfill: weather scanner wrote raw 'nyc' city before canonical-key fix.
-- Reconciler writes 'new york', so these shadow rows never joined ground truth.
UPDATE shadow_observations
SET payload = jsonb_set(payload, '{city}', '"new york"'::jsonb)
WHERE kind IN ('weather_event', 'weather_bracket')
  AND payload->>'city' = 'nyc';
