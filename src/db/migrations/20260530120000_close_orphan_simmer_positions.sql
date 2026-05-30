-- Close all open ledger positions that were entered via Simmer.
-- These 84 positions were opened between March 18 and April 14, 2026,
-- and all markets have long since resolved. Simmer auto-redeem was enabled,
-- so settled funds were already claimed automatically. Setting closed_at
-- removes them from the active position loop and prevents the redeemer
-- from attempting on-chain redemptions for stale entries.
UPDATE positions
SET closed_at = NOW()
WHERE closed_at IS NULL
  AND execution_venue = 'simmer';
