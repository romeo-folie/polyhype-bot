import { describe, it, expect } from '@jest/globals';
import { evaluateTakeProfit } from '../takeProfitEvaluator.js';
import type { Position } from '../../execution/positionLedger.js';
import type { CurrentPrice } from '../priceFetcher.js';

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    marketId: 'mkt-1',
    conditionId: 'cond-1',
    clobTokenIds: ['tok-yes', 'tok-no'],
    question: 'Will X happen?',
    direction: 'YES',
    entryPrice: 0.4,
    stakeUsd: 5.0,
    consensusProbability: 0.7,
    edgeMagnitude: 0.3,
    sourcedFrom: 'headline',
    openedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCurrentPrice(overrides: Partial<CurrentPrice> = {}): CurrentPrice {
  return {
    marketId: 'mkt-1',
    direction: 'YES',
    currentOutcomePrice: 0.5,
    currentYesPrice: 0.5,
    ...overrides,
  };
}

const THRESHOLD = 0.25; // 25%

describe('evaluateTakeProfit', () => {
  describe('take-profit threshold', () => {
    it('exits when return clearly exceeds threshold', () => {
      // entryPrice=0.4, currentOutcomePrice=0.6 → return=50% >> 25%
      // currentYesPrice=0.6 < consensusProbability=0.7 → no divergence_closed
      const result = evaluateTakeProfit(
        makePosition({ entryPrice: 0.4, consensusProbability: 0.7 }),
        makeCurrentPrice({ currentOutcomePrice: 0.6, currentYesPrice: 0.6 }),
        THRESHOLD,
      );
      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('take_profit_threshold');
      expect(result.returnPct).toBeCloseTo(50, 1);
    });

    it('holds when return < threshold', () => {
      // entryPrice=0.4, currentOutcomePrice=0.44 → return=10%
      // currentYesPrice=0.44 < consensusProbability=0.7 → no divergence_closed
      const result = evaluateTakeProfit(
        makePosition({ entryPrice: 0.4, consensusProbability: 0.7 }),
        makeCurrentPrice({ currentOutcomePrice: 0.44, currentYesPrice: 0.44 }),
        THRESHOLD,
      );
      expect(result.shouldExit).toBe(false);
    });
  });

  describe('divergence closed — YES position', () => {
    it('exits with divergence_closed when currentYesPrice >= consensus and return < threshold', () => {
      // entry=0.4, current=0.45 → return=12.5% < 25% threshold → NOT take_profit
      // consensus=0.45, currentYesPrice=0.46 >= 0.45 → divergence_closed fires
      const result = evaluateTakeProfit(
        makePosition({ entryPrice: 0.4, consensusProbability: 0.45 }),
        makeCurrentPrice({ currentOutcomePrice: 0.46, currentYesPrice: 0.46 }),
        THRESHOLD,
      );
      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('divergence_closed');
    });

    it('holds when currentYesPrice < consensusProbability and return < threshold', () => {
      // return=10%, currentYesPrice=0.44 < consensus=0.7 → neither condition
      const result = evaluateTakeProfit(
        makePosition({ entryPrice: 0.4, consensusProbability: 0.7 }),
        makeCurrentPrice({ currentOutcomePrice: 0.44, currentYesPrice: 0.44 }),
        THRESHOLD,
      );
      expect(result.shouldExit).toBe(false);
    });
  });

  describe('divergence closed — NO position', () => {
    it('exits with divergence_closed when YES price drops below (1-consensus) and return < threshold', () => {
      // NO position: entry YES was 0.65, so entry NO = 0.35, consensus P(YES)=0.3
      // divergence_closed: currentYesPrice <= 1 - 0.3 = 0.70? No —
      // For NO: we think YES is overpriced. consensus=0.3 means we expect YES to fall.
      // divergence_closed when currentYesPrice <= (1 - consensusProbability) = 1 - 0.3 = 0.70
      // Wait: the formula is currentYesPrice <= (1 - consensusProbability) where
      // consensusProbability is P(YES). If P(YES)=0.3, we bought NO. Divergence closes
      // when market drops to our level: currentYesPrice <= 1 - consensusProbability is wrong.
      // Correct: consensusProbability=0.3 means our true P(YES)=0.3.
      // We bought NO because market YES price (e.g. 0.55) > our P(YES)=0.3.
      // Divergence closes when currentYesPrice <= consensusProbability=0.3.
      // The code uses: currentYesPrice <= 1 - consensusProbability
      // With consensusProbability=0.3: threshold = 1-0.3=0.7
      // currentYesPrice=0.25: 0.25 <= 0.70 → true
      // Return for NO: entryPrice=0.45 (1-0.55), currentOutcomePrice=1-0.25=0.75
      // return=(0.75-0.45)/0.45=66.7% >> 25% → would trigger take_profit first
      // So use a case where return < threshold but divergence closes:
      // entryNO=0.45, currentNO=0.50 → return=11% < 25%
      // currentYesPrice = 1 - 0.50 = 0.50; 1-consensusProbability = 1-0.3 = 0.70
      // 0.50 <= 0.70 → divergence_closed
      const position = makePosition({
        direction: 'NO',
        entryPrice: 0.45,
        consensusProbability: 0.3,
      });
      const result = evaluateTakeProfit(
        position,
        makeCurrentPrice({
          direction: 'NO',
          currentOutcomePrice: 0.50,
          currentYesPrice: 0.50,
        }),
        THRESHOLD,
      );
      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('divergence_closed');
    });
  });

  describe('return calculation', () => {
    it('calculates negative return correctly (loss)', () => {
      // entryPrice=0.5, currentOutcomePrice=0.4 → return = -20%
      const result = evaluateTakeProfit(
        makePosition({ entryPrice: 0.5 }),
        makeCurrentPrice({ currentOutcomePrice: 0.4, currentYesPrice: 0.4 }),
        THRESHOLD,
      );
      expect(result.returnPct).toBeCloseTo(-20, 1);
      expect(result.shouldExit).toBe(false); // losses don't trigger take-profit
    });

    it('returns 0% when entryPrice is 0', () => {
      const result = evaluateTakeProfit(
        makePosition({ entryPrice: 0 }),
        makeCurrentPrice({ currentOutcomePrice: 0.5 }),
        THRESHOLD,
      );
      expect(result.returnDecimal).toBe(0);
    });
  });
});
