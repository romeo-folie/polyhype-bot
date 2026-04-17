/**
 * Near-zero scanner theme extractor.
 *
 * Classifies a market question into a concentration-risk theme so the scanner
 * can enforce NEAR_ZERO_MAX_PER_THEME. Themes are curated keyword rules —
 * deterministic and inspectable vs. LLM tagging.
 *
 * Each rule has 1+ RegExps that must ALL match (AND logic), reducing
 * false positives (e.g. "Iran" alone without a conflict keyword is not
 * iran-israel-conflict).
 *
 * Returns null when no theme matches; those candidates count only against
 * the global NEAR_ZERO_MAX_OPEN_POSITIONS cap.
 *
 * Redis keys managed here:
 *   near_zero:theme_open:{theme}  — SET of "{marketId}:{direction}" per theme
 *   near_zero:positions_open      — SET of "{marketId}:{direction}" for all
 *                                   open near-zero-arb positions (global cap)
 */

import type { Redis } from 'ioredis';
import { getOpenPositions } from '../execution/positionLedger.js';
import { logger } from './logger.js';

// ── Theme rules ──────────────────────────────────────────────────────────────

interface ThemeRule {
  theme: string;
  // All matchers must match (AND logic).
  matchers: RegExp[];
}

export const THEME_RULES: ThemeRule[] = [
  {
    theme: 'iran-israel-conflict',
    matchers: [/iran|israel|hezbollah|hamas|gaza/i, /conflict|war|ceasefire|strike|truce|attack/i],
  },
  {
    theme: 'oil-price-target',
    matchers: [/\bwti\b|crude|oil/i, /\$[\d,]+/],
  },
  {
    theme: 'btc-price-target',
    matchers: [/\b(bitcoin|btc)\b/i, /\$[\d,]+/],
  },
  {
    theme: 'eth-price-target',
    matchers: [/\b(ethereum|eth)\b/i, /\$[\d,]+/],
  },
  {
    theme: 'inflation',
    matchers: [/\binflation\b|\bcpi\b/i],
  },
  {
    theme: 'fed-rates',
    matchers: [/\bfed\b|\bfomc\b/i, /rates?\s+(cut|hike|pause)|(cut|hike|pause)\s+rates?/i],
  },
  {
    theme: 'ukraine-russia',
    matchers: [/ukraine|russia|putin|zelensky/i],
  },
  {
    theme: 'taiwan-china',
    matchers: [/taiwan|tsmc|xi\s+jinping/i],
  },
];

export function extractTheme(question: string): string | null {
  for (const rule of THEME_RULES) {
    if (rule.matchers.every((re) => re.test(question))) {
      return rule.theme;
    }
  }
  return null;
}

// ── Redis state helpers ──────────────────────────────────────────────────────

const THEME_KEY_PREFIX = 'near_zero:theme_open:';
const POSITIONS_OPEN_KEY = 'near_zero:positions_open';

function positionMember(marketId: string, direction: string): string {
  return `${marketId}:${direction}`;
}

function themeKey(theme: string): string {
  return `${THEME_KEY_PREFIX}${theme}`;
}

/** Record a newly entered near-zero-arb position in theme + global open sets. */
export async function addNearZeroPosition(
  redis: Redis,
  theme: string | null,
  marketId: string,
  direction: string,
): Promise<void> {
  const member = positionMember(marketId, direction);
  const ops: Promise<unknown>[] = [redis.sadd(POSITIONS_OPEN_KEY, member)];
  if (theme) ops.push(redis.sadd(themeKey(theme), member));
  await Promise.all(ops).catch((err: unknown) => {
    logger.warn('[theme-extractor] addNearZeroPosition failed (non-fatal)', {
      marketId,
      theme,
      error: String(err),
    });
  });
}

/** Remove a closed near-zero-arb position from theme + global open sets. */
export async function removeNearZeroPosition(
  redis: Redis,
  theme: string | null,
  marketId: string,
  direction: string,
): Promise<void> {
  const member = positionMember(marketId, direction);
  const ops: Promise<unknown>[] = [redis.srem(POSITIONS_OPEN_KEY, member)];
  if (theme) ops.push(redis.srem(themeKey(theme), member));
  await Promise.all(ops).catch((err: unknown) => {
    logger.warn('[theme-extractor] removeNearZeroPosition failed (non-fatal)', {
      marketId,
      theme,
      error: String(err),
    });
  });
}

/** Return the number of currently open near-zero-arb positions. */
export async function countOpenNearZeroPositions(redis: Redis): Promise<number> {
  return redis.scard(POSITIONS_OPEN_KEY);
}

/** Return the number of open near-zero-arb positions for a specific theme. */
export async function countOpenPositionsInTheme(redis: Redis, theme: string): Promise<number> {
  return redis.scard(themeKey(theme));
}

/**
 * Rebuild near_zero:theme_open:{theme} and near_zero:positions_open from the
 * live position ledger. Run periodically to heal any drift caused by missed
 * SREM calls (e.g. crash during exit).
 */
export async function rebuildNearZeroThemeSets(redis: Redis): Promise<void> {
  const allPositions = await getOpenPositions(redis);
  const nearZero = allPositions.filter((p) => p.sourcedFrom?.startsWith('near-zero-arb'));

  // Build fresh sets in memory.
  const themeMap = new Map<string, string[]>();
  const allMembers: string[] = [];

  for (const pos of nearZero) {
    const member = positionMember(pos.marketId, pos.direction);
    allMembers.push(member);
    const theme = extractTheme(pos.question);
    if (theme) {
      const arr = themeMap.get(theme) ?? [];
      arr.push(member);
      themeMap.set(theme, arr);
    }
  }

  // Atomically replace all sets via MULTI/EXEC transaction so there is no
  // window where sets are empty or partially rebuilt.
  // Purge known theme keys from THEME_RULES — no KEYS scan needed since
  // all possible theme keys are derivable at compile time.
  const tx = redis.multi();
  tx.del(POSITIONS_OPEN_KEY);
  if (allMembers.length > 0) tx.sadd(POSITIONS_OPEN_KEY, ...allMembers);
  for (const rule of THEME_RULES) tx.del(themeKey(rule.theme));
  for (const [theme, members] of themeMap.entries()) {
    tx.sadd(themeKey(theme), ...members);
  }

  await tx.exec();

  logger.info('[theme-extractor] rebuilt near-zero open sets', {
    totalOpen: allMembers.length,
    themes: Object.fromEntries([...themeMap.entries()].map(([t, m]) => [t, m.length])),
  });
}
