-- Phase 1 / Epic #142 — canary table.
--
-- This is the only table that exists after Phase 1. It validates the entire
-- pipeline (worker → Redis stream → writer → PG INSERT) without touching any
-- production data path. The writer self-emits one row every
-- DB_HEALTH_PING_INTERVAL_MS (default 30s) so steady-state row growth is the
-- canary signal in `docker compose ps`/the lag dashboard.
--
-- Stays forever — Phase 2 schema (#144) only adds tables, never drops this.

-- Up Migration
CREATE TABLE IF NOT EXISTS health_pings (
  id          BIGSERIAL    PRIMARY KEY,
  writer      TEXT         NOT NULL,
  observed_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_health_pings_observed_at
  ON health_pings (observed_at DESC);

-- Down Migration
-- DROP INDEX IF EXISTS idx_health_pings_observed_at;
-- DROP TABLE IF EXISTS health_pings;
