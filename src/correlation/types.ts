/**
 * Cross-Market Correlation Arbitrage — shared types.
 *
 * Constraint types:
 *   - implication:       A→B means P(A) ≤ P(B). If both are YES, A can only
 *                        resolve YES when B also resolves YES.
 *   - mutual-exclusion:  At most one of A, B can resolve YES. P(A) + P(B) ≤ 1.
 */

import { createHash } from 'node:crypto';

// ── Constraint types ─────────────────────────────────────────────────────────

export type ConstraintType = 'implication' | 'mutual-exclusion';

export interface ConstraintEdge {
  /** Stable ID: truncated SHA-256 of `${marketIdA}:${marketIdB}:${type}` */
  id: string;
  type: ConstraintType;
  /**
   * For implication:       A implies B, so P(A) ≤ P(B).
   * For mutual-exclusion:  P(A) + P(B) ≤ 1.
   */
  marketIdA: string;
  marketIdB: string;
  questionA: string;
  questionB: string;
  /** LLM reasoning for why this relationship holds. */
  reasoning: string;
  /** Unix seconds when the edge was last confirmed by LLM. */
  discoveredAt: number;
  /** End dates for eviction — the constraint expires when either market closes. */
  endDateA: string | null;
  endDateB: string | null;
}

export interface MarketPrice {
  marketId: string;
  yesPrice: number;
  clobTokenIds: string[];
  conditionId: string;
  question: string;
  endDate: string | null;
  liquidity: number;
}

export interface ConstraintViolation {
  constraint: ConstraintEdge;
  priceA: number;
  priceB: number;
  /**
   * Which side to trade on (passed to resolveTargets as the target market).
   *   implication:       always 'B' (P(B) is too low, buy YES on B).
   *   mutual-exclusion:  the side with the HIGHER YES price (buy NO on it).
   */
  tradeTarget: 'A' | 'B';
  /** Direction to trade on the target market ('YES' or 'NO'). */
  direction: 'YES' | 'NO';
  /** Edge magnitude (violation amount). */
  edge: number;
  /** Raw violation amount before threshold deduction. */
  violationAmount: number;
}

// ── Deterministic helpers ────────────────────────────────────────────────────

/**
 * Canonical pair key — lexicographically sorted so (A,B) and (B,A) produce
 * the same key.
 */
export function pairKey(idA: string, idB: string): string {
  return [idA, idB].sort().join(':');
}

/**
 * Stable edge ID: truncated SHA-256 of the canonical triple.
 */
export function edgeId(marketIdA: string, marketIdB: string, type: ConstraintType): string {
  const [a, b] = [marketIdA, marketIdB].sort();
  return createHash('sha256')
    .update(`${a}:${b}:${type}`)
    .digest('hex')
    .slice(0, 16);
}
