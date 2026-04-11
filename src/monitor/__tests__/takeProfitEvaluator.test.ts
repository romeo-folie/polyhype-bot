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
        0.3,
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
        0.3,
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
        0.3,
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
        consensusProbability: 0.3,
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
        consensusProbability: 0.3,
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

  describe('divergence closed — BTC Up/Down positions', () => {
    // Regression: evaluator used to do `direction === 'YES' ? ... : ...` which
    // routed UP to the else branch and inverted the check: a fresh UP position
    // at entry=0.505 with consensus P(YES)=0.65 would fire divergence_closed
    // instantly (0.505 <= 0.65 → true). Fix: treat UP as a YES-side direction.
    it('holds UP position when currentYesPrice is still below consensus', () => {
      // entry 0.505, current 0.505, consensus P(YES) = 0.65
      // return = 0% (no SL, no TP) → only divergence_closed could fire
      // With fix: isYesSide → 0.505 >= 0.65 → false → HOLD
      const position = makePosition({
        direction: 'UP',
        entryPrice: 0.505,
        consensusProbability: 0.65,
      });
      const result = evaluateTakeProfit(
        position,
        makeCurrentPrice({
          direction: 'UP',
          currentOutcomePrice: 0.505,
          currentYesPrice: 0.505,
        }),
        THRESHOLD,
      );
      expect(result.shouldExit).toBe(false);
    });

    it('exits UP position with divergence_closed when currentYesPrice reaches consensus', () => {
      // entry 0.50, current 0.63, consensus 0.62 → UP token has rallied past fair
      // return = 26% > 25% would take_profit — keep return below threshold
      const position = makePosition({
        direction: 'UP',
        entryPrice: 0.55,
        consensusProbability: 0.62,
      });
      const result = evaluateTakeProfit(
        position,
        makeCurrentPrice({
          direction: 'UP',
          currentOutcomePrice: 0.63,
          currentYesPrice: 0.63,
        }),
        THRESHOLD,
      );
      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('divergence_closed');
    });

    it('holds DOWN position when currentYesPrice is still above P(YES)', () => {
      // DOWN side: scanner stores consensus as P(YES=UP wins) = 1 - fair_for_down
      // entry DOWN = 0.495, current DOWN = 0.495, consensus P(YES) = 0.35
      // currentYesPrice = 1 - 0.495 = 0.505 > 0.35 → HOLD
      const position = makePosition({
        direction: 'DOWN',
        entryPrice: 0.495,
        consensusProbability: 0.35,
      });
      const result = evaluateTakeProfit(
        position,
        makeCurrentPrice({
          direction: 'DOWN',
          currentOutcomePrice: 0.495,
          currentYesPrice: 0.505,
        }),
        THRESHOLD,
      );
      expect(result.shouldExit).toBe(false);
    });

    it('exits DOWN position with divergence_closed when currentYesPrice falls to consensus', () => {
      // DOWN token has rallied to 0.68 → currentYesPrice = 0.32 <= 0.35 consensus
      // return = (0.68-0.55)/0.55 ≈ 23.6% < 25% → not take_profit
      const position = makePosition({
        direction: 'DOWN',
        entryPrice: 0.55,
        consensusProbability: 0.35,
      });
      const result = evaluateTakeProfit(
        position,
        makeCurrentPrice({
          direction: 'DOWN',
          currentOutcomePrice: 0.68,
          currentYesPrice: 0.32,
        }),
        THRESHOLD,
      );
      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('divergence_closed');
    });
  });

  describe('reconciled positions — skip divergence_closed', () => {
    it('does not exit via divergence_closed for reconciled:simmer position', () => {
      // Reconciled positions have no consensus estimate. Without the fix,
      // consensusProbability defaults to 0.5 and divergence_closed fires
      // prematurely when currentYesPrice >= 0.5.
      // entry=0.40, current=0.44 → return=10% < 25%, no SL triggered
      // currentYesPrice=0.55 >= 0.5 → would fire divergence_closed WITHOUT fix
      const result = evaluateTakeProfit(
        makePosition({
          entryPrice: 0.4,
          consensusProbability: undefined,
          sourcedFrom: 'reconciled:simmer',
        }),
        makeCurrentPrice({ currentOutcomePrice: 0.44, currentYesPrice: 0.55 }),
        THRESHOLD,
      );
      expect(result.shouldExit).toBe(false);
    });

    it('does not exit via divergence_closed for reconciled:clob position', () => {
      const result = evaluateTakeProfit(
        makePosition({
          entryPrice: 0.4,
          consensusProbability: undefined,
          sourcedFrom: 'reconciled:clob',
        }),
        makeCurrentPrice({ currentOutcomePrice: 0.44, currentYesPrice: 0.55 }),
        THRESHOLD,
      );
      expect(result.shouldExit).toBe(false);
    });

    it('still exits on stop_loss for reconciled positions', () => {
      // entry=0.5, current=0.3 → return=-40% < -30%
      const result = evaluateTakeProfit(
        makePosition({
          entryPrice: 0.5,
          consensusProbability: undefined,
          sourcedFrom: 'reconciled:simmer',
        }),
        makeCurrentPrice({ currentOutcomePrice: 0.3, currentYesPrice: 0.3 }),
        THRESHOLD,
        0.3,
      );
      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('stop_loss');
    });

    it('still exits on take_profit_threshold for reconciled positions', () => {
      // entry=0.4, current=0.6 → return=50% > 25%
      const result = evaluateTakeProfit(
        makePosition({
          entryPrice: 0.4,
          consensusProbability: undefined,
          sourcedFrom: 'reconciled:simmer',
        }),
        makeCurrentPrice({ currentOutcomePrice: 0.6, currentYesPrice: 0.6 }),
        THRESHOLD,
      );
      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('take_profit_threshold');
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
