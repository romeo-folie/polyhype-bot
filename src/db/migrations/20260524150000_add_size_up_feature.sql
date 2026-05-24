-- Add size_up_ineligible to skip_reason_t.
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'size_up_ineligible';

-- Add top_up_count column to positions table (0 = never topped up).
ALTER TABLE positions ADD COLUMN IF NOT EXISTS top_up_count INTEGER NOT NULL DEFAULT 0;
