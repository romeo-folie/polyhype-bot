-- Epic #142 Phase 2 — schema v1
-- Creates all 11 analytics tables and the shared ENUM types they depend on.
--
-- Cross-table FKs between `positions` and `hedge_events` are intentionally
-- OMITTED here — they form a mutual reference cycle. See migration
-- 20260409190001_add_cross_table_fks.sql for the two ALTER TABLE statements.
--
-- Hypertable conversion (signal_decisions, execution_events, shadow_observations)
-- is NOT done here — that is Phase 4 (#145). These three tables are created as
-- plain Postgres tables first so Phase 3 emit wiring can land without a Timescale
-- dependency. Phase 4 ships the SELECT create_hypertable(...) calls.

-- ── ENUM types ────────────────────────────────────────────────────────────────

CREATE TYPE signal_source_t AS ENUM (
  'osint', 'copytrade', 'spot', 'arb', 'crypto-arb', 'futures', 'sports', 'clob-flow'
);

-- Full skip taxonomy from #142 + #143. Adding a new value requires
-- `ALTER TYPE skip_reason_t ADD VALUE '...'` in a separate migration (cannot
-- run inside a transaction). If the taxonomy keeps growing, flip to TEXT + CHECK
-- against a reference table — see plan §Q5.
CREATE TYPE skip_reason_t AS ENUM (
  'extreme_price_llm_distrust',
  'zone3_edge_below_fee_buffer',
  'zone4_comfort_trap',
  'zone5_widow_maker',
  'kelly_sign_unstable',
  'noisy_signal',
  'negative_ev',
  'too_long_dated',
  'too_soon_expiring',
  'funding_adverse',
  'confluence_block',
  'volume_spike_block',
  'regime_no_trend',
  'regime_chop',
  'stake_below_floor',
  'already_executed',
  'position_already_open',
  'stake_below_hl_minimum',
  'insufficient_equity',
  'global_margin_cap',
  'global_governor',
  'maker_not_filled',
  'taker_edge_below_min',
  'liquidity_gate',
  'other'
);

-- Use direction_t (not direction) to avoid a column/type name collision when
-- columns are named `direction`.
CREATE TYPE direction_t AS ENUM ('YES', 'NO', 'UP', 'DOWN', 'LONG', 'SHORT');

-- venue_t avoids the `execution_venue execution_venue` collision in outcomes.
CREATE TYPE venue_t AS ENUM ('simmer', 'clob', 'hyperliquid', 'none');

CREATE TYPE order_type_t AS ENUM ('maker', 'taker', 'none');

CREATE TYPE outcome_result_t AS ENUM ('won', 'lost', 'pushed');


-- ── Table 1: signal_decisions ─────────────────────────────────────────────────
-- One row per evaluated candidate, whether it traded or was skipped.
-- HYPERTABLE CANDIDATE (Phase 4 / #145): partition key = created_at.
-- Stream-only — no dual-write from Redis (no matching Redis key exists today).

CREATE TABLE signal_decisions (
  decision_id                UUID            PRIMARY KEY,    -- minted at emit site
  created_at                 TIMESTAMPTZ     NOT NULL DEFAULT now(),
  source                     signal_source_t NOT NULL,
  market_id                  TEXT            NOT NULL,       -- PM numeric id OR HL symbol
  condition_id               TEXT,
  question                   TEXT            NOT NULL,
  category                   TEXT            NOT NULL,       -- inferCategory() output
  direction                  direction_t,                    -- nullable on early-gate skips
  -- Decision outcome
  has_trade                  BOOLEAN         NOT NULL,
  skip_reason                skip_reason_t,
  skip_detail                TEXT,                          -- e.g. "hours=121,max=96"
  -- Consensus / divergence snapshot
  consensus_probability      DOUBLE PRECISION,
  consensus_stddev           DOUBLE PRECISION,
  consensus_sample_count     INTEGER,
  current_yes_price          DOUBLE PRECISION,              -- market price at decision time
  divergence                 DOUBLE PRECISION,              -- edge magnitude
  ev                         DOUBLE PRECISION,
  kelly_fraction             DOUBLE PRECISION,              -- raw half-Kelly
  kelly_fraction_capped      DOUBLE PRECISION,              -- after maxBetFraction + liquidity gate
  price_zone                 SMALLINT        CHECK (price_zone BETWEEN 1 AND 5),
  -- Sizing
  bankroll_usd               DOUBLE PRECISION,
  stake_attempted_usd        DOUBLE PRECISION,
  stake_floor_bumped         BOOLEAN         NOT NULL DEFAULT false,
  book_depth_usd             DOUBLE PRECISION,
  -- Decision-time microstructure (null for non-CLOB sources)
  decision_best_bid          DOUBLE PRECISION,
  decision_best_ask          DOUBLE PRECISION,
  decision_mid_price         DOUBLE PRECISION,
  decision_spread_bps        DOUBLE PRECISION,
  -- Hybrid lifecycle
  mode_configured            TEXT,                          -- 'hybrid'|'maker'|'taker'
  -- Regime snapshot at decision time (null when confluence didn't run)
  confluence_score           SMALLINT,
  confluence_direction       TEXT,
  regime_adx                 DOUBLE PRECISION,
  regime_choppiness          DOUBLE PRECISION,
  volume_ratio               DOUBLE PRECISION,
  -- Lineage
  source_headline            TEXT,
  source_execution_id        TEXT,
  -- C6: mapping/edge taxonomy (#142 + #152)
  mapping_confidence         NUMERIC(5,4),
  relevance_class            TEXT,
  edge_class                 TEXT,
  sizing_reason              TEXT,
  raw                        JSONB           NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_sd_created_at         ON signal_decisions (created_at DESC);
CREATE INDEX idx_sd_category_source_ts ON signal_decisions (category, source, created_at DESC);
CREATE INDEX idx_sd_skip_reason_ts     ON signal_decisions (skip_reason, created_at DESC)
  WHERE has_trade = false;
CREATE INDEX idx_sd_market_id_ts       ON signal_decisions (market_id, created_at DESC);
CREATE INDEX idx_sd_executed_only_ts   ON signal_decisions (created_at DESC)
  WHERE has_trade = true;


-- ── Table 2: execution_events ─────────────────────────────────────────────────
-- One row per execution attempt (success or failure). Renamed from
-- `executed_attempts` per C2 / #145 canonical name.
-- HYPERTABLE CANDIDATE (Phase 4 / #145): partition key = created_at.
-- Stream-only.

CREATE TABLE execution_events (
  attempt_id                  UUID            PRIMARY KEY,  -- minted at emit site
  created_at                  TIMESTAMPTZ     NOT NULL DEFAULT now(),
  decision_id                 UUID,                         -- app-level FK to signal_decisions
  execution_id                TEXT,                         -- legacy executor.ts string id
  source                      signal_source_t NOT NULL,
  market_id                   TEXT            NOT NULL,
  direction                   direction_t     NOT NULL,
  -- Routing outcome
  final_execution_path        TEXT            NOT NULL,     -- 'maker_fill','taker_fallback','hyperliquid_fill',...
  final_venue                 venue_t         NOT NULL,
  final_order_type            order_type_t    NOT NULL,
  execution_succeeded         BOOLEAN         NOT NULL,
  skip_reason                 skip_reason_t,
  error_class                 TEXT,
  error_message               TEXT,
  -- Fill
  shares_filled               DOUBLE PRECISION,
  stake_usd_executed          DOUBLE PRECISION,
  entry_price                 DOUBLE PRECISION,
  fees_usd                    DOUBLE PRECISION,
  slippage_bps                DOUBLE PRECISION,
  -- Latency
  elapsed_ms                  INTEGER,
  -- Counterfactual + maker telemetry (snapshotted here for fast analytics)
  counterfactual_taker_price  DOUBLE PRECISION,
  counterfactual_taker_cost   DOUBLE PRECISION,
  maker_attempted             BOOLEAN,
  maker_wait_ms               INTEGER,
  maker_fill_status           TEXT,
  maker_posted_price          DOUBLE PRECISION,
  maker_price_improvement_bps DOUBLE PRECISION,
  maker_price_improvement_usd DOUBLE PRECISION,
  fallback_reason             TEXT,
  tx_hash                     TEXT,
  raw                         JSONB           NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_ee_created_at       ON execution_events (created_at DESC);
CREATE INDEX idx_ee_decision_id      ON execution_events (decision_id)
  WHERE decision_id IS NOT NULL;
CREATE INDEX idx_ee_market_id_ts     ON execution_events (market_id, created_at DESC);
CREATE INDEX idx_ee_source_success   ON execution_events (source, execution_succeeded, created_at DESC);
CREATE INDEX idx_ee_final_path_ts    ON execution_events (final_execution_path, created_at DESC);


-- ── Table 3: shadow_observations ──────────────────────────────────────────────
-- Unified shadow log for ATR / volume_spike / ADX / choppiness / zscore /
-- HL-funding gates. `kind` discriminator + JSONB payload keeps it flexible.
-- HYPERTABLE CANDIDATE (Phase 4 / #145): partition key = observed_at.
-- Stream-only.

CREATE TABLE shadow_observations (
  id           BIGSERIAL       PRIMARY KEY,
  observed_at  TIMESTAMPTZ     NOT NULL DEFAULT now(),
  kind         TEXT            NOT NULL,   -- 'atr'|'volume_spike'|'adx'|'choppiness'|'zscore'|'hl_funding'
  source       signal_source_t NOT NULL,
  symbol       TEXT,                       -- HL symbol / asset id / 'OSINT'
  market_id    TEXT,
  direction    direction_t,
  would_block  BOOLEAN         NOT NULL,   -- would a hard gate have blocked?
  metric_value DOUBLE PRECISION,           -- canonical single number (adx, ratio, zscore, etc.)
  threshold    DOUBLE PRECISION,           -- what it was compared against
  payload      JSONB           NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_sh_kind_observed_at ON shadow_observations (kind, observed_at DESC);
CREATE INDEX idx_sh_symbol_kind_ts   ON shadow_observations (symbol, kind, observed_at DESC);
CREATE INDEX idx_sh_block_rollup     ON shadow_observations (kind, would_block, observed_at DESC);
CREATE INDEX idx_sh_payload_gin      ON shadow_observations USING GIN (payload);


-- ── Table 4: outcomes ─────────────────────────────────────────────────────────
-- One row per closed position. Renamed from `closed_outcomes` per C2 / #144.
-- Plain Postgres (NOT a hypertable in v1 per C3). Promote to hypertable in v2
-- when: table size > 5 GB OR p95 latency on outcomes_daily MV refresh > 1 s.
-- Dual-write alongside existing Redis recordOutcome() path.
--
-- CRITICAL: is_reconciled must be set correctly. Calibration queries MUST
-- filter WHERE is_reconciled = false. See outcomeRecorder.ts.

CREATE TABLE outcomes (
  outcome_id                  UUID            PRIMARY KEY,  -- reuse UUID minted in recordOutcome()
  closed_at                   TIMESTAMPTZ     NOT NULL DEFAULT now(),
  opened_at                   TIMESTAMPTZ,
  execution_id                TEXT,
  attempt_id                  UUID,                         -- app-level FK to execution_events
  decision_id                 UUID,                         -- app-level FK to signal_decisions
  source                      signal_source_t NOT NULL,
  category                    TEXT            NOT NULL,
  market_id                   TEXT            NOT NULL,
  condition_id                TEXT,
  question                    TEXT            NOT NULL,
  direction                   direction_t     NOT NULL,
  urgency_score               DOUBLE PRECISION,
  consensus_probability       DOUBLE PRECISION NOT NULL,    -- 0.5 for reconciled imports
  consensus_stddev            DOUBLE PRECISION,
  divergence                  DOUBLE PRECISION NOT NULL,
  -- Outcome
  result                      outcome_result_t NOT NULL,
  return_pct                  DOUBLE PRECISION NOT NULL,
  holding_hours               DOUBLE PRECISION NOT NULL,
  -- Routing snapshot
  execution_venue             venue_t          NOT NULL,
  mode_configured             TEXT,
  entry_execution_path        TEXT,
  entry_order_type            order_type_t,
  fallback_reason             TEXT,
  decision_spread_bps         DOUBLE PRECISION,
  maker_price_improvement_bps DOUBLE PRECISION,
  maker_price_improvement_usd DOUBLE PRECISION,
  exit_reason                 TEXT,
  -- Entry snapshot (from Position ledger)
  entry_price                 DOUBLE PRECISION,
  stake_usd                   DOUBLE PRECISION,
  shares_held                 DOUBLE PRECISION,
  entry_atr                   DOUBLE PRECISION,
  entry_atr_pct               DOUBLE PRECISION,
  price_zone                  SMALLINT         CHECK (price_zone BETWEEN 1 AND 5),
  -- Settlement quirks
  synth_hedged                BOOLEAN          NOT NULL DEFAULT false,
  pending_settlement          BOOLEAN          NOT NULL DEFAULT false,
  reconciliation_status       TEXT,
  hedge_link                  TEXT,                         -- PM↔HL FK, free-form text
  -- CRITICAL: calibration filter
  is_reconciled               BOOLEAN          NOT NULL DEFAULT false,
  sourced_from                TEXT,
  raw                         JSONB            NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_out_closed_at          ON outcomes (closed_at DESC);
CREATE INDEX idx_out_category_closed_at ON outcomes (category, closed_at DESC)
  WHERE is_reconciled = false;
CREATE INDEX idx_out_source_closed_at   ON outcomes (source, closed_at DESC);
CREATE INDEX idx_out_reconciled_audit   ON outcomes (closed_at DESC)
  WHERE is_reconciled = true;
CREATE INDEX idx_out_market_id          ON outcomes (market_id);
CREATE INDEX idx_out_execution_id       ON outcomes (execution_id)
  WHERE execution_id IS NOT NULL;


-- ── Table 5: positions ────────────────────────────────────────────────────────
-- Mutable lifecycle row — one per entered position. Mirrors Redis position:* hashes.
-- Dual-write on EVERY state change (recordPosition, updatePosition,
-- updateHighWaterMark). UPSERT ON CONFLICT (market_id, direction, opened_at).
--
-- hedge_link FK to hedge_events is added in migration 20260409190001.

CREATE TABLE positions (
  id                          BIGSERIAL       PRIMARY KEY,
  market_id                   TEXT            NOT NULL,
  direction                   direction_t     NOT NULL,
  -- Lifecycle
  opened_at                   TIMESTAMPTZ     NOT NULL,
  closed_at                   TIMESTAMPTZ,                  -- null while open
  reconciliation_status       TEXT,
  pending_settlement          BOOLEAN         NOT NULL DEFAULT false,
  synth_hedged                BOOLEAN         NOT NULL DEFAULT false,
  hedge_link                  BIGINT,                       -- FK added in migration 20260409190001
  -- Entry snapshot
  entry_price                 NUMERIC(20,10)  NOT NULL,
  stake_usd                   NUMERIC(14,4)   NOT NULL,
  shares_held                 NUMERIC(28,10),
  execution_venue             venue_t         NOT NULL,
  execution_id                TEXT,
  decision_id                 UUID,                         -- app-level FK to signal_decisions
  -- Hybrid lifecycle
  mode_configured             TEXT,
  entry_execution_path        TEXT,
  entry_order_type            TEXT,
  fallback_reason             TEXT,
  -- Decision-time microstructure
  decision_best_bid           NUMERIC(20,10),
  decision_best_ask           NUMERIC(20,10),
  decision_mid_price          NUMERIC(20,10),
  decision_spread_bps         NUMERIC(10,2),
  counterfactual_taker_price  NUMERIC(20,10),
  counterfactual_taker_shares NUMERIC(28,10),
  counterfactual_taker_cost   NUMERIC(14,4),
  maker_price_improvement_bps NUMERIC(10,2),
  maker_price_improvement_usd NUMERIC(14,4),
  -- C6: mapping/edge taxonomy (#142 + #152)
  mapping_confidence          NUMERIC(5,4),
  relevance_class             TEXT,
  edge_class                  TEXT,
  sizing_reason               TEXT,
  -- Futures-specific
  is_futures                  BOOLEAN         NOT NULL DEFAULT false,
  symbol                      TEXT,
  leverage                    NUMERIC(8,2),
  entry_atr                   NUMERIC(20,10),
  entry_atr_pct               NUMERIC(10,6),
  price_zone                  SMALLINT        CHECK (price_zone BETWEEN 1 AND 5),
  -- Consensus snapshot
  consensus_probability       NUMERIC(5,4),
  consensus_stddev            NUMERIC(5,4),
  -- Metadata
  question                    TEXT            NOT NULL,
  sourced_from                TEXT            NOT NULL,
  updated_at                  TIMESTAMPTZ     NOT NULL DEFAULT now(),
  raw                         JSONB           NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (market_id, direction, opened_at)
);

CREATE INDEX idx_pos_open        ON positions (closed_at) WHERE closed_at IS NULL;
CREATE INDEX idx_pos_market      ON positions (market_id, direction);
CREATE INDEX idx_pos_decision_id ON positions (decision_id) WHERE decision_id IS NOT NULL;
CREATE INDEX idx_pos_hedge_link  ON positions (hedge_link)  WHERE hedge_link IS NOT NULL;


-- ── Table 6: hedge_events ─────────────────────────────────────────────────────
-- PM↔HL synthetic hedge lifecycle events.
-- FKs to positions are added in migration 20260409190001.

CREATE TABLE hedge_events (
  id             BIGSERIAL      PRIMARY KEY,
  pm_position_id BIGINT,                    -- FK added in migration 20260409190001
  hl_position_id BIGINT,                    -- FK added in migration 20260409190001
  hedge_action   TEXT           NOT NULL,   -- 'opened'|'closed'|'rebalanced'
  hl_symbol      TEXT           NOT NULL,
  hl_size        NUMERIC(28,10) NOT NULL,
  hl_entry_price NUMERIC(20,10),
  hl_exit_price  NUMERIC(20,10),
  pnl_usd        NUMERIC(14,4),
  observed_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
  raw            JSONB
);

CREATE INDEX idx_he_pm_position ON hedge_events (pm_position_id);
CREATE INDEX idx_he_hl_position ON hedge_events (hl_position_id);
CREATE INDEX idx_he_observed_at ON hedge_events (observed_at DESC);


-- ── Table 7: calibration_stats ────────────────────────────────────────────────
-- Per-category calibration bucketed stats. Mirrors Redis calibration:* hot state.
-- Dual-write via UPSERT on every recordOutcome() call.

CREATE TABLE calibration_stats (
  category         TEXT        NOT NULL,
  bucket           TEXT        NOT NULL,   -- e.g. price-zone bucket or probability decile
  trade_count      INT         NOT NULL DEFAULT 0,
  win_count        INT         NOT NULL DEFAULT 0,
  total_return_pct NUMERIC(14,6) NOT NULL DEFAULT 0,
  last_updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (category, bucket)
);


-- ── Table 8: telemetry_metric_snapshots ───────────────────────────────────────
-- Nightly snapshot of telemetry:* Redis counters. Tiny append-only table.
-- Populated by a nightly cron (Phase 4), not the stream writer.
-- Closes the unbounded-growth loop on telemetry:* keys which have no TTL.

CREATE TABLE telemetry_metric_snapshots (
  snapshot_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
  metric_name   TEXT             NOT NULL,
  metric_value  DOUBLE PRECISION NOT NULL,
  metric_labels JSONB,
  PRIMARY KEY (snapshot_at, metric_name)
);

CREATE INDEX idx_tms_metric_name ON telemetry_metric_snapshots (metric_name, snapshot_at DESC);


-- ── Table 9: maker_telemetry ──────────────────────────────────────────────────
-- Maker order lifecycle detail. Demoted from hypertable per C3 / #145.
-- Stream-only.

CREATE TABLE maker_telemetry (
  id                          BIGSERIAL        PRIMARY KEY,
  observed_at                 TIMESTAMPTZ      NOT NULL DEFAULT now(),
  attempt_id                  UUID,                          -- app-level FK to execution_events
  execution_id                TEXT,
  market_id                   TEXT             NOT NULL,
  direction                   direction_t      NOT NULL,
  side                        TEXT             NOT NULL,     -- 'entry' or 'exit'
  maker_attempted             BOOLEAN          NOT NULL,
  maker_order_id              TEXT,
  maker_posted_price          DOUBLE PRECISION,
  maker_posted_size           DOUBLE PRECISION,
  maker_wait_ms               INTEGER,
  maker_fill_status           TEXT,
  maker_cancel_confirmed      BOOLEAN,
  maker_price_improvement_bps DOUBLE PRECISION,
  maker_price_improvement_usd DOUBLE PRECISION,
  raw                         JSONB            NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_mt_observed_at   ON maker_telemetry (observed_at DESC);
CREATE INDEX idx_mt_market_id_ts  ON maker_telemetry (market_id, observed_at DESC);
CREATE INDEX idx_mt_side_status   ON maker_telemetry (side, maker_fill_status, observed_at DESC);
CREATE INDEX idx_mt_attempt_id    ON maker_telemetry (attempt_id) WHERE attempt_id IS NOT NULL;


-- ── Table 10: arb_latency_samples ─────────────────────────────────────────────
-- Per-event latency records from metrics:arb_latency:* Redis ring buffers.
-- Renamed from `arb_latency` per C2/C3 (#144). Demoted from hypertable.
-- Stream-only (one call site in executor.ts — see Phase 0 note on arb_latency).

CREATE TABLE arb_latency_samples (
  id          BIGSERIAL        PRIMARY KEY,
  observed_at TIMESTAMPTZ      NOT NULL DEFAULT now(),
  stage       TEXT             NOT NULL,
  latency_ms  INTEGER          NOT NULL,
  context     JSONB            NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_als_stage_observed_at ON arb_latency_samples (stage, observed_at DESC);


-- ── Table 11: market_catalog ──────────────────────────────────────────────────
-- Periodic watchlist dump — one row per market per snapshot. Renamed from
-- `market_catalog_snapshots` per C2 / #144. Snapshot cadence: every 4h cron tick
-- (src/cron/refreshWatchlist.ts). At ~2000 markets/snapshot × 6/day × 30d ≈ 360k rows.
-- Stream-only (or direct INSERT from cron — Phase 3 decides).

CREATE TABLE market_catalog (
  snapshot_id UUID             NOT NULL,
  captured_at TIMESTAMPTZ      NOT NULL DEFAULT now(),
  market_id   TEXT             NOT NULL,
  condition_id TEXT,
  question    TEXT             NOT NULL,
  end_date    TIMESTAMPTZ,
  outcomes    TEXT[],
  liquidity   DOUBLE PRECISION,
  volume_24h  DOUBLE PRECISION,
  active      BOOLEAN,
  archived    BOOLEAN,
  raw         JSONB            NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (captured_at, market_id)
);

CREATE INDEX idx_mc_market_id_captured ON market_catalog (market_id, captured_at DESC);
CREATE INDEX idx_mc_snapshot_id        ON market_catalog (snapshot_id);
