-- Phase 5 (#146) — pgvector extension + trade_memory_cases table.
-- Requires: shared_preload_libraries=timescaledb,vector (docker-compose.yml).
-- The timescaledb-ha:pg16 image bundles pgvector; no package install needed.
--
-- trade_memory_cases stores embedded representations of closed trade outcomes
-- (and notable skipped opportunities) for semantic retrieval at inference time.
--
-- Embedding source: reasoning_text built from outcome fields (question, direction,
-- category, result, return_pct, holding_hours, consensus_probability).
-- Model: OpenAI text-embedding-3-small → vector(1536).
-- Index: IVFFlat (preferred over HNSW on memory-constrained Raspberry Pi).
--   Rebuild index when row count exceeds 10k:
--   DROP INDEX idx_tmc_embedding; CREATE INDEX ... WITH (lists = 200);

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE memory_case_type_t AS ENUM (
  'success',              -- closed position with positive return
  'cautionary_traded',    -- closed position with negative return
  'cautionary_skipped'    -- skipped trade (reserved for future use)
);

CREATE TABLE trade_memory_cases (
  id                    BIGSERIAL          PRIMARY KEY,
  created_at            TIMESTAMPTZ        NOT NULL DEFAULT now(),
  -- Source linkage (soft; no FK constraints for resilience across migrations)
  outcome_id            UUID,
  decision_id           UUID,
  -- Market context
  market_id             TEXT               NOT NULL,
  condition_id          TEXT,
  question              TEXT               NOT NULL,
  category              TEXT               NOT NULL,
  direction             direction_t        NOT NULL,
  price_zone            SMALLINT           CHECK (price_zone BETWEEN 1 AND 5),
  -- Trade outcome
  case_type             memory_case_type_t NOT NULL,
  result                outcome_result_t,              -- null for cautionary_skipped
  return_pct            DOUBLE PRECISION,
  holding_hours         DOUBLE PRECISION,
  consensus_probability DOUBLE PRECISION,
  skip_reason           skip_reason_t,                -- populated for cautionary_skipped
  -- Reasoning text used as embedding source
  reasoning_text        TEXT               NOT NULL,
  -- Vector embedding
  embedding             vector(1536)       NOT NULL,
  model_version         TEXT               NOT NULL DEFAULT 'text-embedding-3-small',
  -- Calibration filter (mirrors outcomes.is_reconciled)
  is_reconciled         BOOLEAN            NOT NULL DEFAULT false
);

-- IVFFlat index (lists = 100, suitable for up to ~10k rows).
-- Uses cosine distance — appropriate for OpenAI text embeddings.
CREATE INDEX idx_tmc_embedding ON trade_memory_cases
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX idx_tmc_category  ON trade_memory_cases (category, created_at DESC);
CREATE INDEX idx_tmc_case_type ON trade_memory_cases (case_type, created_at DESC);
CREATE INDEX idx_tmc_market_id ON trade_memory_cases (market_id);
-- UNIQUE partial index so ON CONFLICT DO NOTHING can dedupe by outcome_id.
-- Without UNIQUE, the only constraint is the BIGSERIAL `id` PK (always unique),
-- so retries of the embed cron or the writer handler would silently create
-- duplicate memory rows for the same closed outcome.
CREATE UNIQUE INDEX idx_tmc_outcome_id ON trade_memory_cases (outcome_id)
  WHERE outcome_id IS NOT NULL;
