import { describe, it, expect } from 'vitest';
import { detectViolations } from '../violationDetector.js';
import type { ConstraintEdge, MarketPrice } from '../types.js';

function makeEdge(overrides: Partial<ConstraintEdge> = {}): ConstraintEdge {
  return {
    id: 'edge-1',
    type: 'implication',
    marketIdA: 'mkt-a',
    marketIdB: 'mkt-b',
    questionA: 'Market A question',
    questionB: 'Market B question',
    reasoning: 'A implies B',
    discoveredAt: Math.floor(Date.now() / 1000),
    endDateA: null,
    endDateB: null,
    ...overrides,
  };
}

function makePrice(overrides: Partial<MarketPrice> = {}): MarketPrice {
  return {
    marketId: 'mkt-a',
    yesPrice: 0.50,
    noPrice: 0.50,
    clobTokenIds: ['yes-token', 'no-token'],
    conditionId: 'cond-1',
    question: 'Some market',
    endDate: null,
    liquidity: 5000,
    ...overrides,
  };
}

function makePrices(pairs: [string, number][]): Map<string, MarketPrice> {
  const map = new Map<string, MarketPrice>();
  for (const [id, price] of pairs) {
    map.set(id, makePrice({ marketId: id, yesPrice: price }));
  }
  return map;
}

describe('violationDetector', () => {
  // ── Implication ─────────────────────────────────────────────────────────

  describe('implication (A→B)', () => {
    it('detects violation when P(A) > P(B) + minEdge', () => {
      const edges = [makeEdge({ type: 'implication', marketIdA: 'a', marketIdB: 'b' })];
      const prices = makePrices([['a', 0.60], ['b', 0.40]]);

      const violations = detectViolations(edges, prices, 0.05);
      expect(violations.length).toBe(1);
      expect(violations[0]!.tradeTarget).toBe('B');
      expect(violations[0]!.direction).toBe('YES');
      expect(violations[0]!.edge).toBeCloseTo(0.20, 5);
    });

    it('does NOT detect violation when P(A) <= P(B) + minEdge', () => {
      const edges = [makeEdge({ type: 'implication', marketIdA: 'a', marketIdB: 'b' })];
      const prices = makePrices([['a', 0.50], ['b', 0.48]]);

      const violations = detectViolations(edges, prices, 0.05);
      expect(violations.length).toBe(0);
    });

    it('does NOT detect violation when P(A) <= P(B)', () => {
      const edges = [makeEdge({ type: 'implication', marketIdA: 'a', marketIdB: 'b' })];
      const prices = makePrices([['a', 0.30], ['b', 0.50]]);

      const violations = detectViolations(edges, prices, 0.05);
      expect(violations.length).toBe(0);
    });

    it('tradeTarget is always B for implication', () => {
      const edges = [makeEdge({ type: 'implication', marketIdA: 'a', marketIdB: 'b' })];
      const prices = makePrices([['a', 0.80], ['b', 0.30]]);

      const violations = detectViolations(edges, prices, 0.05);
      expect(violations[0]!.tradeTarget).toBe('B');
    });

    it('edge equals P(A) - P(B)', () => {
      const edges = [makeEdge({ type: 'implication', marketIdA: 'a', marketIdB: 'b' })];
      const prices = makePrices([['a', 0.75], ['b', 0.55]]);

      const violations = detectViolations(edges, prices, 0.05);
      expect(violations[0]!.edge).toBeCloseTo(0.20, 5);
      expect(violations[0]!.violationAmount).toBeCloseTo(0.20, 5);
    });
  });

  // ── Mutual exclusion ────────────────────────────────────────────────────

  describe('mutual-exclusion', () => {
    it('detects violation when P(A) + P(B) > 1 + minEdge', () => {
      const edges = [makeEdge({
        id: 'me-1',
        type: 'mutual-exclusion',
        marketIdA: 'a',
        marketIdB: 'b',
      })];
      const prices = makePrices([['a', 0.60], ['b', 0.55]]);

      const violations = detectViolations(edges, prices, 0.05);
      expect(violations.length).toBe(1);
      expect(violations[0]!.edge).toBeCloseTo(0.15, 5);
    });

    it('does NOT detect violation when sum <= 1 + minEdge', () => {
      const edges = [makeEdge({
        id: 'me-1',
        type: 'mutual-exclusion',
        marketIdA: 'a',
        marketIdB: 'b',
      })];
      const prices = makePrices([['a', 0.50], ['b', 0.50]]);

      const violations = detectViolations(edges, prices, 0.05);
      expect(violations.length).toBe(0);
    });

    it('tradeTarget is the side with the HIGHER price (buy NO on overpriced)', () => {
      const edges = [makeEdge({
        id: 'me-1',
        type: 'mutual-exclusion',
        marketIdA: 'a',
        marketIdB: 'b',
      })];
      const prices = makePrices([['a', 0.70], ['b', 0.50]]);

      const violations = detectViolations(edges, prices, 0.05);
      expect(violations[0]!.tradeTarget).toBe('A');
      expect(violations[0]!.direction).toBe('NO');
    });

    it('direction is NO for mutual-exclusion', () => {
      const edges = [makeEdge({
        id: 'me-1',
        type: 'mutual-exclusion',
        marketIdA: 'a',
        marketIdB: 'b',
      })];
      const prices = makePrices([['a', 0.55], ['b', 0.60]]);

      const violations = detectViolations(edges, prices, 0.05);
      expect(violations[0]!.direction).toBe('NO');
      // B is more overpriced.
      expect(violations[0]!.tradeTarget).toBe('B');
    });

    it('edge equals P(A) + P(B) - 1', () => {
      const edges = [makeEdge({
        id: 'me-1',
        type: 'mutual-exclusion',
        marketIdA: 'a',
        marketIdB: 'b',
      })];
      const prices = makePrices([['a', 0.65], ['b', 0.55]]);

      const violations = detectViolations(edges, prices, 0.05);
      expect(violations[0]!.edge).toBeCloseTo(0.20, 5);
    });
  });

  // ── Cross-cutting ───────────────────────────────────────────────────────

  it('skips constraints where either market is missing from prices', () => {
    const edges = [makeEdge({ marketIdA: 'a', marketIdB: 'missing' })];
    const prices = makePrices([['a', 0.80]]);

    const violations = detectViolations(edges, prices, 0.05);
    expect(violations.length).toBe(0);
  });

  it('sorts violations by edge descending', () => {
    const edges = [
      makeEdge({ id: 'e1', marketIdA: 'a1', marketIdB: 'b1' }),
      makeEdge({ id: 'e2', marketIdA: 'a2', marketIdB: 'b2' }),
    ];
    const prices = makePrices([
      ['a1', 0.60], ['b1', 0.40],  // edge = 0.20
      ['a2', 0.90], ['b2', 0.20],  // edge = 0.70
    ]);

    const violations = detectViolations(edges, prices, 0.05);
    expect(violations.length).toBe(2);
    expect(violations[0]!.edge).toBeGreaterThan(violations[1]!.edge);
  });

  it('handles empty constraints list', () => {
    const violations = detectViolations([], new Map(), 0.05);
    expect(violations.length).toBe(0);
  });
});
