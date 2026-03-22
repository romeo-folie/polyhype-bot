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

/** Lua script: atomic decrement-and-clamp-at-zero. */
const DEDUCT_LUA = `
local v = redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
if tonumber(v) < 0 then
  redis.call('SET', KEYS[1], '0.000000')
  return '0.000000'
end
return v
`;

/**
 * Deduct stake on trade entry. Uses a Lua script for atomic
 * decrement-and-clamp-at-zero — safe under concurrent access.
 */
export async function deductStake(redis: Redis, stakeUsd: number): Promise<number> {
  // Ensure key exists before Lua script
  await getBankroll(redis);
  const result = await redis.eval(DEDUCT_LUA, 1, BANKROLL_KEY, (-stakeUsd).toFixed(6)) as string;
  const updated = parseFloat(result);
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
