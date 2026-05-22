-- Add is_contrarian, meme_atr_sl_pct, meme_atr_tp_pct columns to positions.
--
-- is_contrarian: true when the hl-momentum trade was opened in contrarian
-- (mean-reversion) mode — direction is opposite to the measured momentum signal.
-- Used to slice win-rate analytics by contrarian vs trend-following entries.
--
-- meme_atr_sl_pct / meme_atr_tp_pct: ATR-derived stop-loss and take-profit
-- percentages frozen at entry for meme-symbol hl-momentum positions. Mirrors
-- the values stored in Redis by the executor so Postgres analytics can audit
-- the SL/TP ladder applied to each trade.

ALTER TABLE positions ADD COLUMN IF NOT EXISTS is_contrarian BOOLEAN;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS meme_atr_sl_pct DOUBLE PRECISION;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS meme_atr_tp_pct DOUBLE PRECISION;
