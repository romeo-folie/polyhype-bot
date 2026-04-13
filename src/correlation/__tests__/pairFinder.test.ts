import { describe, it, expect } from 'vitest';
import { findCandidatePairs } from '../pairFinder.js';
import type { MarketPrice } from '../types.js';

function makeMarket(overrides: Partial<MarketPrice> = {}): MarketPrice {
  return {
    marketId: 'mkt-1',
    yesPrice: 0.50,
    noPrice: 0.50,
    clobTokenIds: ['yes-token', 'no-token'],
    conditionId: 'cond-1',
    question: 'Will something happen?',
    endDate: '2026-12-31T00:00:00Z',
    liquidity: 5000,
    ...overrides,
  };
}

describe('findCandidatePairs', () => {
  it('returns pairs sharing at least N entities', () => {
    const markets = [
      makeMarket({ marketId: 'a', conditionId: 'ca', question: 'Will Russia invade Ukraine in 2026?' }),
      makeMarket({ marketId: 'b', conditionId: 'cb', question: 'Will Russia attack Ukraine before summer?' }),
      makeMarket({ marketId: 'c', conditionId: 'cc', question: 'Will Bitcoin reach 100K?' }),
    ];

    const pairs = findCandidatePairs(markets, 2, 100);
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.sharedEntities).toContain('russia');
    expect(pairs[0]!.sharedEntities).toContain('ukraine');
  });

  it('does not return self-pairs', () => {
    const markets = [
      makeMarket({ marketId: 'a', conditionId: 'ca', question: 'Will Russia invade Ukraine?' }),
    ];
    const pairs = findCandidatePairs(markets, 1, 100);
    expect(pairs.length).toBe(0);
  });

  it('does not return duplicate pairs (A,B) and (B,A)', () => {
    const markets = [
      makeMarket({ marketId: 'a', conditionId: 'ca', question: 'Trump wins the election easily' }),
      makeMarket({ marketId: 'b', conditionId: 'cb', question: 'Trump loses the election' }),
    ];
    const pairs = findCandidatePairs(markets, 2, 100);
    expect(pairs.length).toBe(1);
  });

  it('excludes pairs with identical conditionId', () => {
    const markets = [
      makeMarket({ marketId: 'a', conditionId: 'same', question: 'Will Russia invade Ukraine?' }),
      makeMarket({ marketId: 'b', conditionId: 'same', question: 'Will Russia attack Ukraine?' }),
    ];
    const pairs = findCandidatePairs(markets, 2, 100);
    expect(pairs.length).toBe(0);
  });

  it('returns empty when no pairs share enough entities', () => {
    const markets = [
      makeMarket({ marketId: 'a', conditionId: 'ca', question: 'Will Bitcoin reach 100K?' }),
      makeMarket({ marketId: 'b', conditionId: 'cb', question: 'Will the Lakers win the NBA?' }),
    ];
    const pairs = findCandidatePairs(markets, 2, 100);
    expect(pairs.length).toBe(0);
  });

  it('caps output at maxPairs', () => {
    const markets = [
      makeMarket({ marketId: 'a', conditionId: 'ca', question: 'Russia Ukraine conflict war escalation' }),
      makeMarket({ marketId: 'b', conditionId: 'cb', question: 'Russia Ukraine ceasefire peace' }),
      makeMarket({ marketId: 'c', conditionId: 'cc', question: 'Russia Ukraine sanctions response' }),
    ];
    // All 3 pairs share 'russia' and 'ukraine', so there are 3 pairs.
    const pairs = findCandidatePairs(markets, 2, 2);
    expect(pairs.length).toBe(2);
  });

  it('sorts by overlap count descending', () => {
    const markets = [
      makeMarket({ marketId: 'a', conditionId: 'ca', question: 'Russia Ukraine conflict war NATO' }),
      makeMarket({ marketId: 'b', conditionId: 'cb', question: 'Russia Ukraine conflict war ceasefire' }),
      makeMarket({ marketId: 'c', conditionId: 'cc', question: 'Russia NATO alliance' }),
    ];
    const pairs = findCandidatePairs(markets, 2, 100);
    // a-b share more tokens than a-c or b-c.
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs[0]!.sharedEntities.length).toBeGreaterThanOrEqual(
      pairs[pairs.length - 1]!.sharedEntities.length,
    );
  });
});
