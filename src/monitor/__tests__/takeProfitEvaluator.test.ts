import { describe, it, expect } from 'vitest';
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
    executionVenue: 'simmer',
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
  describe('stop-loss', () => {
    it('exits with stop_loss when loss exceeds threshold', () => {
      // entryPrice=0.5, currentOutcomePrice=0.3 → return = -40% < -30%
      const result = evaluateTakeProfit(
        makePosition({ entryPrice: 0.5, consensusProbability: 0.7 }),
        makeCurrentPrice({ currentOutcomePrice: 0.3, currentYesPrice: 0.3 }),
        THRESHOLD,
        0.30,
      );
      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('stop_loss');
      expect(result.returnPct).toBeCloseTo(-40, 1);
    });

    it('holds when loss is below stop-loss threshold', () => {
      // entryPrice=0.5, currentOutcomePrice=0.4 → return = -20% > -30%
      const result = evaluateTakeProfit(
        makePosition({ entryPrice: 0.5, consensusProbability: 0.7 }),
        makeCurrentPrice({ currentOutcomePrice: 0.4, currentYesPrice: 0.4 }),
        THRESHOLD,
        0.30,
      );
      expect(result.shouldExit).toBe(false);
    });

    it('stop-loss takes priority over divergence_closed', () => {
      // Both conditions met: loss = -50% AND divergence closed
      // entryPrice=0.5, currentOutcomePrice=0.25 → return = -50%
      // consensus=0.2, currentYesPrice=0.25 >= 0.2 → divergence_closed too
      // But stop-loss should fire first (checked first)
      const result = evaluateTakeProfit(
        makePosition({ entryPrice: 0.5, consensusProbability: 0.2 }),
        makeCurrentPrice({ currentOutcomePrice: 0.25, currentYesPrice: 0.25 }),
        THRESHOLD,
        0.30,
      );
      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('stop_loss');
    });
  });

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

    it('holds when return < threshold and no divergence closed', () => {
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
      // entry=0.4, current=0.46 → return=15% < 25% → not take_profit
      // consensus=0.45, currentYesPrice=0.46 >= 0.45 → divergence_closed
      const result = evaluateTakeProfit(
        makePosition({ entryPrice: 0.4, consensusProbability: 0.45 }),
        makeCurrentPrice({ currentOutcomePrice: 0.46, currentYesPrice: 0.46 }),
        THRESHOLD,
      );
      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('divergence_closed');
    });

    it('holds when currentYesPrice < consensusProbability and return < threshold', () => {
      // return=10%, currentYesPrice=0.44 < consensus=0.7 → neither condition met
      const result = evaluateTakeProfit(
        makePosition({ entryPrice: 0.4, consensusProbability: 0.7 }),
        makeCurrentPrice({ currentOutcomePrice: 0.44, currentYesPrice: 0.44 }),
        THRESHOLD,
      );
      expect(result.shouldExit).toBe(false);
    });
  });

  describe('divergence closed — NO position', () => {
    it('exits with divergence_closed when currentYesPrice <= consensus and return < threshold', () => {
      // NO position: bought NO because market YES=0.55 > our P(YES)=0.30
      // Entry NO price = 0.68 (high entry to keep return below threshold)
      // Current NO = 0.72 → return = (0.72-0.68)/0.68 ≈ 5.9% < 25%
      // currentYesPrice = 1 - 0.72 = 0.28 <= consensusProbability=0.30 → divergence_closed
      const position = makePosition({
        direction: 'NO',
        entryPrice: 0.68,
        consensusProbability: 0.30,
      });
      const result = evaluateTakeProfit(
        position,
        makeCurrentPrice({
          direction: 'NO',
          currentOutcomePrice: 0.72,
          currentYesPrice: 0.28,
        }),
        THRESHOLD,
      );
      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('divergence_closed');
    });

    it('holds for NO when currentYesPrice is still above consensus', () => {
      // consensusProbability=0.30, currentYesPrice=0.45 > 0.30 → not closed yet
      // return=5% < threshold
      const position = makePosition({
        direction: 'NO',
        entryPrice: 0.55,
        consensusProbability: 0.30,
      });
      const result = evaluateTakeProfit(
        position,
        makeCurrentPrice({
          direction: 'NO',
          currentOutcomePrice: 0.578,
          currentYesPrice: 0.45,
        }),
        THRESHOLD,
      );
      expect(result.shouldExit).toBe(false);
    });
  });

  describe('return calculation', () => {
    it('calculates negative return correctly (loss)', () => {
      // entryPrice=0.5, currentOutcomePrice=0.4 → return = -20%
      // consensus=0.7, currentYesPrice=0.4 < 0.7 → no divergence_closed
      const result = evaluateTakeProfit(
        makePosition({ entryPrice: 0.5, consensusProbability: 0.7 }),
        makeCurrentPrice({ currentOutcomePrice: 0.4, currentYesPrice: 0.4 }),
        THRESHOLD,
      );
      expect(result.returnPct).toBeCloseTo(-20, 1);
      expect(result.shouldExit).toBe(false);
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
