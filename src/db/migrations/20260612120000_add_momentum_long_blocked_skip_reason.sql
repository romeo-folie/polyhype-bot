-- Add momentum_long_blocked to skip_reason_t enum.
-- New hl-momentum gate (HL_MOMENTUM_BLOCK_MOMENTUM_LONGS): momentum-direction LONG
-- entries are suppressed (Apr–Jun 2026: −4.7 cum price-% vs SHORTs +24.2);
-- contrarian LONGs are exempt. Enum value must exist before the db-writer's Zod
-- schema starts emitting it or signal_decisions inserts fail and retry forever.
ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS 'momentum_long_blocked';
