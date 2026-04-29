-- Add hl-momentum-specific skip reason values to skip_reason_t.
--
-- These are emitted by the hl-momentum scanner's signal_decisions logging:
-- anti-chase gates (RSI / VWAP distance), score/cooldown blocks, and the
-- dark-mode suppression path. First-class enum values make the skip_reason
-- column directly GROUP-BY-able without parsing skip_detail.
-- IF NOT EXISTS guards make this idempotent.

ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'score_below_min';
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'anti_chase_rsi';
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'anti_chase_vwap';
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'loss_cooldown';
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'momentum_cooldown';
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'scanner_dark';
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'long_hl_confirmation_missing';
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'oi_divergence_veto';
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'weighted_total_score_low';
