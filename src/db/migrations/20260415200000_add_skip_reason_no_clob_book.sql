-- Add no_clob_book to skip_reason_t enum.
-- Distinguishes ghost books (bid=0.01/ask=0.99, no active market makers) from
-- real-but-wide books (e.g. bid=0.30/ask=0.70). Ghost books can't be traded on
-- CLOB at any spread ceiling — they need an AMM venue (Simmer).
-- NOTE: ADD VALUE cannot run inside a transaction in PG14-; wrap is intentional.

ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'no_clob_book' AFTER 'one_sided_book';
