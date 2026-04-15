-- Add no_clob_book to skip_reason_t enum.
-- Distinguishes ghost books (bid=0.01/ask=0.99, no active market makers) from
-- real-but-wide books (e.g. bid=0.30/ask=0.70). Ghost books can't be traded on
-- CLOB at any spread ceiling — they need an AMM venue (Simmer).
-- NOTE: This repo uses PG16 (timescaledb-ha); ADD VALUE inside a transaction is
-- fully supported since PG12. No special transaction handling required.

ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'no_clob_book' AFTER 'one_sided_book';
