-- Epic #142 Phase 2 — cross-table FK cycle
--
-- `positions.hedge_link → hedge_events.id` and
-- `hedge_events.pm/hl_position_id → positions.id` are mutually referential.
-- Both tables were created in migration 20260409190000 with plain BIGINT columns.
-- This migration bolts on the FK constraints now that both tables exist.
--
-- ON DELETE SET NULL: if a hedge_event is deleted, positions.hedge_link goes
-- null (position survives). If a position is deleted, the hedge_event's FK goes
-- null (hedge record survives for audit). This preserves the audit trail either
-- direction.

ALTER TABLE positions
  ADD CONSTRAINT fk_pos_hedge_link
  FOREIGN KEY (hedge_link) REFERENCES hedge_events(id)
  ON DELETE SET NULL;

ALTER TABLE hedge_events
  ADD CONSTRAINT fk_he_pm_position
  FOREIGN KEY (pm_position_id) REFERENCES positions(id)
  ON DELETE SET NULL;

ALTER TABLE hedge_events
  ADD CONSTRAINT fk_he_hl_position
  FOREIGN KEY (hl_position_id) REFERENCES positions(id)
  ON DELETE SET NULL;
