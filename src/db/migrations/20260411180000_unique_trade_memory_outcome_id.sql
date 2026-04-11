-- Follow-up to 20260409210000_pgvector_trade_memory.sql.
--
-- The original migration created idx_tmc_outcome_id as a plain (non-UNIQUE)
-- partial btree index, so ON CONFLICT DO NOTHING in the writer handler and
-- embedTradeMemory cron could never dedupe by outcome_id — the only unique
-- constraint on the table is the BIGSERIAL `id` PK, which by definition never
-- conflicts, so concurrent retries silently created duplicate memory rows
-- for the same closed outcome.
--
-- The fix lands in this separate migration file because the original was
-- already recorded as applied (node-pg-migrate skips re-runs by filename,
-- not by content hash), so editing the prior file would be a no-op.
--
-- De-dupe first, then swap the index. dedup uses MIN(id) to keep the earliest
-- row and removes any later duplicates — safe because the surrogate id orders
-- by insert time (BIGSERIAL).

DELETE FROM trade_memory_cases a
 USING trade_memory_cases b
 WHERE a.outcome_id = b.outcome_id
   AND a.outcome_id IS NOT NULL
   AND a.id > b.id;

DROP INDEX IF EXISTS idx_tmc_outcome_id;

CREATE UNIQUE INDEX idx_tmc_outcome_id ON trade_memory_cases (outcome_id)
  WHERE outcome_id IS NOT NULL;
