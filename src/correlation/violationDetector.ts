/**
 * Constraint violation detector — pure math, no I/O.
 *
 * Given a list of constraint edges and current market prices, returns
 * violations sorted by edge descending.
 *
 * Implication (A→B):
 *   Violation when P(A) > P(B) + minEdge.
 *   B is tradeTarget → buy B YES.
 *   Edge = P(A) - P(B).
 *
 * Mutual exclusion:
 *   Violation when P(A) + P(B) > 1 + minEdge.
 *   The more-overpriced side should be sold → buy NO on the more-overpriced
 *   market (the one with the HIGHER YES price).
 *   Edge = P(A) + P(B) - 1.
 */

import type { ConstraintEdge, ConstraintViolation, MarketPrice } from './types.js';

/**
 * Detect constraint violations across all edges.
 *
 * @param constraints Active constraint edges from the graph.
 * @param prices      Map<marketId, MarketPrice> from the market cache.
 * @param minEdge     Minimum violation magnitude to report.
 * @returns Violations sorted by edge descending.
 */
export function detectViolations(
  constraints: ConstraintEdge[],
  prices: Map<string, MarketPrice>,
  minEdge: number,
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];

  for (const constraint of constraints) {
    const mA = prices.get(constraint.marketIdA);
    const mB = prices.get(constraint.marketIdB);
    if (!mA || !mB) continue;

    const pA = mA.yesPrice;
    const pB = mB.yesPrice;

    if (constraint.type === 'implication') {
      // A→B means P(A) ≤ P(B). Violation: P(A) > P(B) + minEdge.
      const violationAmount = pA - pB;
      if (violationAmount <= minEdge) continue;

      violations.push({
        constraint,
        priceA: pA,
        priceB: pB,
        tradeTarget: 'B',
        direction: 'YES',
        edge: violationAmount,
        violationAmount,
      });
    } else {
      // mutual-exclusion: P(A) + P(B) ≤ 1. Violation: sum > 1 + minEdge.
      const sum = pA + pB;
      const violationAmount = sum - 1;
      if (violationAmount <= minEdge) continue;

      // Buy NO on the more-overpriced side (higher YES price).
      const overpriced: 'A' | 'B' = pA >= pB ? 'A' : 'B';

      violations.push({
        constraint,
        priceA: pA,
        priceB: pB,
        tradeTarget: overpriced,
        direction: 'NO',
        edge: violationAmount,
        violationAmount,
      });
    }
  }

  // Highest edge first.
  violations.sort((a, b) => b.edge - a.edge);
  return violations;
}
