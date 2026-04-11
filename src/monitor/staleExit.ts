/**
 * Stale-position exit.
 *
 * Rotates capital out of PM positions that never print meaningful profit.
 * The monitor loop (`src/monitor/index.ts`) calls `evaluateStale()` after
 * `evaluateTakeProfit()` returns a hold decision. On exit, the same
 * `executeTakeProfit()` taker path is reused with `reason='stale_exit'`.
 *
 * Two rules (either triggers):
 *
 *   Rule A — "never got profitable":
 *     age >= categoryAgeH && peakPnlPct < STALE_PEAK_PNL_TARGET_PCT
 *
 *   Rule B — "stuck underwater, flat":
 *     age >= categoryAgeH + STALE_UNDERWATER_EXTRA_H
 *       && currentPnlPct < 0
 *       && priceRangePct over STALE_VOL_WINDOW_H < STALE_VOL_MAX_PCT
 *
 * Copytrades and futures are excluded by the caller.
 *
 * State lives in Redis under two keys per position:
 *   stale:peak:<marketId>:<direction>        STRING — max pnl % seen
 *   stale:samples:<marketId>:<direction>     ZSET   — score=tsMs, member=pct snapshot
 *
 * A 7-day TTL is set on both so orphaned keys get cleaned up automatically.
 * `closePosition()` in `positionLedger.ts` also explicitly deletes them.
 *
 * Re-entry cooldown lives under:
 *   stale:cooldown:<marketId>                STRING — existence = cooldown active
 */

import type { Redis } from 'ioredis';
import type { Position } from '../execution/positionLedger.js';
import { loadConfig, type AppConfig } from '../shared/config.js';
import { inferCategory } from '../shared/outcomeRecorder.js';
import { logger } from '../shared/logger.js';

const PEAK_KEY_PREFIX = 'stale:peak:';
const SAMPLES_KEY_PREFIX = 'stale:samples:';
const FIRST_SEEN_KEY_PREFIX = 'stale:firstseen:';
const COOLDOWN_KEY_PREFIX = 'stale:cooldown:';
const STATE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export type StaleRule = 'stale_peak_miss' | 'stale_flat_underwater';

export interface StaleDecision {
  shouldExit: boolean;
  rule?: StaleRule;
  peakPnlPct: number;
  currentPnlPct: number;
  ageH: number;
  trackedH: number;
  categoryAgeH: number;
  priceRangePct?: number | undefined;
}

function peakKey(marketId: string, direction: string): string {
  return `${PEAK_KEY_PREFIX}${marketId}:${direction}`;
}

function samplesKey(marketId: string, direction: string): string {
  return `${SAMPLES_KEY_PREFIX}${marketId}:${direction}`;
}

function firstSeenKey(marketId: string, direction: string): string {
  return `${FIRST_SEEN_KEY_PREFIX}${marketId}:${direction}`;
}

function cooldownKey(marketId: string): string {
  return `${COOLDOWN_KEY_PREFIX}${marketId}`;
}

/**
 * Normalize an inferred category to a canonical stale-exit bucket.
 * `inferCategory()` returns sub-sports buckets and some non-canonical strings
 * (`mentions`, `sports-nba`, etc.) which must be mapped back to the 6 canonical
 * categories tracked by the config knobs.
 */
export function normalizeCategory(rawCategory: string): string {
  if (rawCategory.startsWith('sports')) return 'sports';
  const canonical = new Set([
    'crypto-regulatory',
    'crypto-updown',
    'ai-tech',
    'macro',
    'us-politics',
    'geopolitical',
  ]);
  if (canonical.has(rawCategory)) return rawCategory;
  return 'default';
}

/**
 * Look up the per-category age threshold in hours from config.
 */
export function getCategoryAgeH(category: string, cfg: AppConfig): number {
  switch (category) {
    case 'sports':
      return cfg.STALE_MIN_AGE_H_SPORTS;
    case 'crypto-regulatory':
      return cfg.STALE_MIN_AGE_H_CRYPTO_REGULATORY;
    case 'crypto-updown':
      return cfg.STALE_MIN_AGE_H_CRYPTO_UPDOWN;
    case 'ai-tech':
      return cfg.STALE_MIN_AGE_H_AI_TECH;
    case 'macro':
      return cfg.STALE_MIN_AGE_H_MACRO;
    case 'us-politics':
      return cfg.STALE_MIN_AGE_H_US_POLITICS;
    case 'geopolitical':
      return cfg.STALE_MIN_AGE_H_GEOPOLITICAL;
    default:
      return cfg.STALE_MIN_AGE_H_DEFAULT;
  }
}

export interface StaleSampleState {
  peakPnlPct: number;
  firstSeenMs: number;
}

/**
 * Update the rolling peak PnL and price-sample window for a position.
 * Called every monitor tick for eligible (non-copytrade, non-futures) positions.
 *
 * Also stamps `firstSeenMs` on the first call for a given position. This is
 * used to enforce a grace period: pre-existing positions that predate the
 * feature must be observed by the tracker for at least one category age
 * window before Rule A can fire against them.
 */
export async function recordStaleSample(
  redis: Redis,
  position: Position,
  currentPnlPct: number,
  nowMs: number = Date.now(),
): Promise<StaleSampleState> {
  const pKey = peakKey(position.marketId, position.direction);
  const sKey = samplesKey(position.marketId, position.direction);
  const fKey = firstSeenKey(position.marketId, position.direction);

  // Stamp firstSeenAt on first observation (SET NX).
  await redis.set(fKey, String(nowMs), 'EX', STATE_TTL_SECONDS, 'NX');
  const firstSeenStr = await redis.get(fKey);
  const firstSeenMs =
    firstSeenStr !== null && Number.isFinite(parseInt(firstSeenStr, 10))
      ? parseInt(firstSeenStr, 10)
      : nowMs;

  // Peak PnL — monotonic max
  const existingStr = await redis.get(pKey);
  const existing = existingStr !== null ? parseFloat(existingStr) : Number.NEGATIVE_INFINITY;
  const peak = Number.isFinite(existing) ? Math.max(existing, currentPnlPct) : currentPnlPct;
  await redis.set(pKey, String(peak), 'EX', STATE_TTL_SECONDS);

  // Price sample — append to ZSET, score = timestamp ms, trim to window+buffer
  await redis.zadd(sKey, nowMs, `${nowMs}:${currentPnlPct.toFixed(4)}`);
  await redis.expire(sKey, STATE_TTL_SECONDS);

  return { peakPnlPct: peak, firstSeenMs };
}

/**
 * Compute the PnL range (max - min) over the rolling window, in percentage points.
 * Returns null if fewer than 2 samples are available.
 */
export async function computePnlRangePct(
  redis: Redis,
  position: Position,
  windowMs: number,
  nowMs: number = Date.now(),
): Promise<number | null> {
  const sKey = samplesKey(position.marketId, position.direction);
  const sinceMs = nowMs - windowMs;

  // Trim samples older than the window (keep key slim)
  await redis.zremrangebyscore(sKey, 0, sinceMs - 1);

  const members = await redis.zrangebyscore(sKey, sinceMs, '+inf');
  if (members.length < 2) return null;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const m of members) {
    const parts = m.split(':');
    if (parts.length !== 2) continue;
    const pct = parseFloat(parts[1]!);
    if (!Number.isFinite(pct)) continue;
    if (pct < min) min = pct;
    if (pct > max) max = pct;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return max - min;
}

/**
 * Evaluate whether a position should be exited for staleness.
 *
 * Gating is based on `trackedH` (how long the peak-pnl tracker has been
 * observing this position), NOT position age. This gives pre-existing
 * positions a full grace window to build up real peak-pnl data before
 * the feature can act on them — otherwise an old underwater position would
 * be killed on the very first monitor tick after the feature turns on.
 */
export function evaluateStale(opts: {
  position: Position;
  currentPnlPct: number;
  peakPnlPct: number;
  firstSeenMs: number;
  priceRangePct: number | null;
  cfg: AppConfig;
  nowMs?: number;
}): StaleDecision {
  const { position, currentPnlPct, peakPnlPct, firstSeenMs, priceRangePct, cfg } = opts;
  const nowMs = opts.nowMs ?? Date.now();

  const openedMs = new Date(position.openedAt).getTime();
  const ageH = (nowMs - openedMs) / (1000 * 60 * 60);
  const trackedH = (nowMs - firstSeenMs) / (1000 * 60 * 60);
  const category = normalizeCategory(inferCategory(position.question));
  const categoryAgeH = getCategoryAgeH(category, cfg);

  const base: StaleDecision = {
    shouldExit: false,
    peakPnlPct,
    currentPnlPct,
    ageH,
    trackedH,
    categoryAgeH,
    priceRangePct: priceRangePct ?? undefined,
  };

  // Grace period: tracker must have observed the position for at least one
  // full category window before Rule A can fire. Protects pre-existing
  // positions from insta-exit when the feature is first enabled.
  if (trackedH < categoryAgeH) return base;

  // Rule A: peak never reached the target
  if (peakPnlPct < cfg.STALE_PEAK_PNL_TARGET_PCT) {
    return { ...base, shouldExit: true, rule: 'stale_peak_miss' };
  }

  // Rule B: underwater + flat (needs enough extra tracked time)
  if (trackedH >= categoryAgeH + cfg.STALE_UNDERWATER_EXTRA_H && currentPnlPct < 0) {
    if (priceRangePct !== null && priceRangePct < cfg.STALE_VOL_MAX_PCT) {
      return { ...base, shouldExit: true, rule: 'stale_flat_underwater' };
    }
  }

  return base;
}

/**
 * Mark a market as recently stale-exited. Blocks re-entry from `executor.ts`
 * for STALE_REENTRY_COOLDOWN_H hours.
 */
export async function markStaleCooldown(redis: Redis, marketId: string): Promise<void> {
  const cfg = loadConfig();
  const ttlSec = Math.max(0, Math.round(cfg.STALE_REENTRY_COOLDOWN_H * 3600));
  if (ttlSec === 0) return;
  await redis.set(cooldownKey(marketId), '1', 'EX', ttlSec);
}

/**
 * Check whether re-entry into a market is currently blocked by stale cooldown.
 */
export async function isStaleCooldownActive(redis: Redis, marketId: string): Promise<boolean> {
  const v = await redis.get(cooldownKey(marketId));
  return v != null;
}

/**
 * Clear all stale-exit state keys for a position. Called from `closePosition()`
 * in the ledger so state doesn't outlive the position it tracks.
 */
export async function clearStaleState(
  redis: Redis,
  marketId: string,
  direction: string,
): Promise<void> {
  await redis
    .del(
      peakKey(marketId, direction),
      samplesKey(marketId, direction),
      firstSeenKey(marketId, direction),
    )
    .catch((err: unknown) => {
    logger.debug('[stale-exit] clearStaleState del failed (non-fatal)', {
      marketId,
      direction,
      error: String(err),
    });
  });
}
