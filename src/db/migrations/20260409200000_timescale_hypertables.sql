-- Phase 4 (#145) — TimescaleDB hypertable conversion, compression, retention + caggs.
-- Run AFTER 20260409190001_add_cross_table_fks.sql.
-- Requires: shared_preload_libraries=timescaledb (enabled in docker-compose.yml).
--
-- Target tables (created as plain PG tables in Phase 2):
--   signal_decisions    — partition by created_at
--   execution_events    — partition by created_at
--   shadow_observations — partition by observed_at
--
-- Retention:
--   signal_decisions:    12 months (drop)
--   execution_events:    NEVER (permanent audit log)
--   shadow_observations:  6 months (drop)
--
-- Compression:
--   signal_decisions:    after 30 days  (segmentby: source)
--   execution_events:    after 90 days  (segmentby: source)
--   shadow_observations: after 60 days  (segmentby: kind)

-- ── Step 1: Reshape PKs to include partition column ───────────────────────────
-- TimescaleDB requires all UNIQUE constraints (including PKs) to cover the
-- partitioning dimension. These tables currently have single-column PKs, which
-- must be widened to composite keys before create_hypertable() will succeed.
-- Since all FK references in this project are app-level (no DB FK constraints
-- point at these PKs), the change is safe and non-breaking.

ALTER TABLE signal_decisions DROP CONSTRAINT signal_decisions_pkey;
ALTER TABLE signal_decisions ADD PRIMARY KEY (decision_id, created_at);

ALTER TABLE execution_events DROP CONSTRAINT execution_events_pkey;
ALTER TABLE execution_events ADD PRIMARY KEY (attempt_id, created_at);

ALTER TABLE shadow_observations DROP CONSTRAINT shadow_observations_pkey;
ALTER TABLE shadow_observations ADD PRIMARY KEY (id, observed_at);

-- ── Step 2: Convert to hypertables ───────────────────────────────────────────

SELECT create_hypertable('signal_decisions',    'created_at',  if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('execution_events',    'created_at',  if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('shadow_observations', 'observed_at', if_not_exists => TRUE, migrate_data => TRUE);

-- ── Step 3: Compression policies ─────────────────────────────────────────────

ALTER TABLE signal_decisions SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'source',
  timescaledb.compress_orderby   = 'created_at DESC'
);
SELECT add_compression_policy('signal_decisions',    INTERVAL '30 days', if_not_exists => TRUE);

ALTER TABLE execution_events SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'source',
  timescaledb.compress_orderby   = 'created_at DESC'
);
SELECT add_compression_policy('execution_events',    INTERVAL '90 days', if_not_exists => TRUE);

ALTER TABLE shadow_observations SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'kind',
  timescaledb.compress_orderby   = 'observed_at DESC'
);
SELECT add_compression_policy('shadow_observations', INTERVAL '60 days', if_not_exists => TRUE);

-- ── Step 4: Retention policies ───────────────────────────────────────────────

SELECT add_retention_policy('signal_decisions',    INTERVAL '12 months', if_not_exists => TRUE);
-- execution_events: INTENTIONALLY NO RETENTION — permanent audit log.
SELECT add_retention_policy('shadow_observations', INTERVAL '6 months',  if_not_exists => TRUE);

-- ── Step 5: Continuous aggregates ────────────────────────────────────────────
-- Each cagg refreshes hourly, covering data up to 1h ago (end_offset) and
-- backfilling up to 3d ago (start_offset) in case of lag.

-- 5a. signal_decisions_daily
--     Slices: source × skip_reason × price_zone
CREATE MATERIALIZED VIEW signal_decisions_daily
WITH (timescaledb.continuous, timescaledb.materialized_only = FALSE) AS
SELECT
  time_bucket('1 day', created_at)       AS bucket,
  source,
  skip_reason,
  price_zone,
  COUNT(*)                                AS total_evaluated,
  COUNT(*) FILTER (WHERE has_trade)       AS total_traded,
  COUNT(*) FILTER (WHERE NOT has_trade)   AS total_skipped,
  AVG(divergence)                         AS avg_divergence,
  AVG(ev)                                 AS avg_ev,
  AVG(kelly_fraction_capped)              AS avg_kelly_capped
FROM signal_decisions
GROUP BY bucket, source, skip_reason, price_zone
WITH NO DATA;

SELECT add_continuous_aggregate_policy('signal_decisions_daily',
  start_offset      => INTERVAL '3 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists     => TRUE
);

-- 5b. execution_events_daily
--     Slices: source × final_execution_path × final_venue × final_order_type
CREATE MATERIALIZED VIEW execution_events_daily
WITH (timescaledb.continuous, timescaledb.materialized_only = FALSE) AS
SELECT
  time_bucket('1 day', created_at)                    AS bucket,
  source,
  final_execution_path,
  final_venue,
  final_order_type,
  COUNT(*)                                             AS total_attempts,
  COUNT(*) FILTER (WHERE execution_succeeded)          AS total_succeeded,
  AVG(elapsed_ms)                                      AS avg_elapsed_ms,
  AVG(maker_price_improvement_bps)
    FILTER (WHERE maker_attempted)                     AS avg_maker_improvement_bps,
  SUM(stake_usd_executed)
    FILTER (WHERE execution_succeeded)                 AS total_stake_usd
FROM execution_events
GROUP BY bucket, source, final_execution_path, final_venue, final_order_type
WITH NO DATA;

SELECT add_continuous_aggregate_policy('execution_events_daily',
  start_offset      => INTERVAL '3 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists     => TRUE
);

-- 5c. shadow_observations_daily
--     Slices: kind × source
CREATE MATERIALIZED VIEW shadow_observations_daily
WITH (timescaledb.continuous, timescaledb.materialized_only = FALSE) AS
SELECT
  time_bucket('1 day', observed_at)      AS bucket,
  kind,
  source,
  COUNT(*)                                AS total,
  COUNT(*) FILTER (WHERE would_block)     AS would_block_count,
  AVG(metric_value)                       AS avg_metric_value,
  MAX(metric_value)                       AS max_metric_value
FROM shadow_observations
GROUP BY bucket, kind, source
WITH NO DATA;

SELECT add_continuous_aggregate_policy('shadow_observations_daily',
  start_offset      => INTERVAL '3 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists     => TRUE
);

-- 5d. outcomes_daily — plain materialized view (outcomes is NOT a hypertable in v1).
--     Promote to cagg when outcomes becomes a hypertable (>5 GB or latency SLA breach).
--     Refresh: REFRESH MATERIALIZED VIEW CONCURRENTLY outcomes_daily;
--     Scheduled by pga-cron service (see docker-compose.yml).
--     Slices: category × price_zone × exit_reason × execution_venue
CREATE MATERIALIZED VIEW outcomes_daily AS
SELECT
  date_trunc('day', closed_at)              AS bucket,
  category,
  price_zone,
  exit_reason,
  execution_venue,
  COUNT(*)                                  AS total_outcomes,
  COUNT(*) FILTER (WHERE result = 'won')    AS win_count,
  COUNT(*) FILTER (WHERE result = 'lost')   AS loss_count,
  AVG(return_pct)                           AS avg_return_pct,
  AVG(holding_hours)                        AS avg_holding_hours,
  SUM(stake_usd)                            AS total_stake_usd
FROM outcomes
WHERE is_reconciled = false   -- CRITICAL: calibration filter, matches Phase 2 comment
GROUP BY bucket, category, price_zone, exit_reason, execution_venue
WITH NO DATA;

CREATE UNIQUE INDEX idx_od_bucket_dims
  ON outcomes_daily (bucket, category, price_zone, exit_reason, execution_venue);
CREATE INDEX idx_od_category_bucket
  ON outcomes_daily (category, bucket DESC);
