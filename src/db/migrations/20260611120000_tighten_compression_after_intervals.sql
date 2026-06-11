-- Tighten TimescaleDB compression `compress_after` windows to bound disk growth.
--
-- The HL momentum/funding scanners log a signal_decisions row per symbol per
-- scan tick (~280k rows/day) and shadow_observations accrues similarly. With the
-- original 30d/60d compress_after (see 20260409200000_timescale_hypertables), the
-- heavy recent month sat UNCOMPRESSED — signal_decisions reached ~9 GB and the
-- host disk hit 95%+. Compressed chunks shrink ~enormously, so shortening the
-- window keeps only a small recent slice uncompressed.
--
-- add_compression_policy is idempotent only on EXISTENCE (if_not_exists), not on
-- the interval — so remove the existing policy first, then re-add with the new
-- interval. execution_events (90d, tiny) is left unchanged; retention
-- (add_retention_policy drop_after) is unchanged.
--
-- This changes only the POLICY (future chunk eligibility). Already-resident
-- chunks are (de)compressed by the background policy job, not here — compress_chunk
-- cannot run inside a migration transaction. The live DB was compressed manually
-- when these intervals were first applied (2026-06-11); this migration makes the
-- intervals survive a rebuild-from-migrations. Idempotent: re-running re-asserts
-- the same 7d/14d policies.

SELECT remove_compression_policy('signal_decisions',    if_exists => TRUE);
SELECT add_compression_policy('signal_decisions',        INTERVAL '7 days',  if_not_exists => TRUE);

SELECT remove_compression_policy('shadow_observations', if_exists => TRUE);
SELECT add_compression_policy('shadow_observations',     INTERVAL '14 days', if_not_exists => TRUE);
