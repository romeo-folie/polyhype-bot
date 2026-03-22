/**
 * Live bankroll tracker — Redis-backed.
 *
 * bankroll:current = cash available (USDC)
 * Updated on every trade entry (subtract stake) and exit (add proceeds).
 * Cold-start: falls back to BANKROLL_USD env config.
 *
 * All mutations use INCRBYFLOAT for atomicity — safe under concurrent
 * pipeline access (news cron + spot cron + monitor cron).
 */
import type { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { logger } from './logger.js';

const BANKROLL_KEY = 'bankroll:current';

/** Get current bankroll. Falls back to config on cold start (NX-guarded). */
export async function getBankroll(redis: Redis): Promise<number> {
  const raw = await redis.get(BANKROLL_KEY);
  if (raw !== null) return parseFloat(raw);
  // Cold start — seed from config. NX prevents overwriting a concurrent write.
  const initial = loadConfig().BANKROLL_USD;
  const wasSet = await redis.set(BANKROLL_KEY, initial.toFixed(6), 'NX');
  if (wasSet) {
    logger.info('[bankroll] cold-start seed', { initial });
  }
  // Re-read in case another process seeded first
  const current = await redis.get(BANKROLL_KEY);
  return parseFloat(current!);
}

/** Set bankroll to an absolute value. */
export async function setBankroll(redis: Redis, amount: number): Promise<void> {
  await redis.set(BANKROLL_KEY, amount.toFixed(6));
}

/**
 * Deduct stake on trade entry. Uses INCRBYFLOAT for atomicity.
 * Clamps at 0 via a follow-up read (INCRBYFLOAT can go negative).
 */
export async function deductStake(redis: Redis, stakeUsd: number): Promise<number> {
  // Ensure key exists before INCRBYFLOAT
  await getBankroll(redis);
  const updated = parseFloat(await redis.incrbyfloat(BANKROLL_KEY, -stakeUsd));
  if (updated < 0) {
    // Clamp to 0 — we don't allow negative bankroll
    await redis.set(BANKROLL_KEY, '0.000000');
    logger.info('[bankroll] stake deducted (clamped to 0)', { stakeUsd, after: 0 });
    return 0;
  }
  logger.info('[bankroll] stake deducted', { stakeUsd, after: updated });
  return updated;
}

/** Credit proceeds on trade exit. Uses INCRBYFLOAT for atomicity. */
export async function creditProceeds(redis: Redis, proceedsUsd: number): Promise<number> {
  // Ensure key exists before INCRBYFLOAT
  await getBankroll(redis);
  const updated = parseFloat(await redis.incrbyfloat(BANKROLL_KEY, proceedsUsd));
  logger.info('[bankroll] proceeds credited', { proceedsUsd, after: updated });
  return updated;
}
