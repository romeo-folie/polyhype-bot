import { describe, it, expect } from 'vitest';
import { evaluateTakeProfit } from '../takeProfitEvaluator.js';

describe('takeProfitEvaluator Tiered Logic', () => {
  const mockPosition = {
    marketId: 'bitcoin',
    direction: 'YES' as const,
    entryPrice: 0.5,
    consensusProbability: 0.6,
    sourcedFrom: 'spot:bitcoin',
  };

  it('triggers stop-loss for crypto at 10% (0.45)', () => {
    const currentPrice = {
      marketId: 'bitcoin',
      direction: 'YES' as const,
      currentOutcomePrice: 0.449, // > 10% loss
      currentYesPrice: 0.449,
    };
    
    // In monitor/index.ts we pass the tiered threshold
    const decision = evaluateTakeProfit(
      mockPosition as any,
      currentPrice,
      0.15, // tp
      0.10, // sl
    );

    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe('stop_loss');
  });

  it('holds crypto at 5% loss (0.475)', () => {
    const currentPrice = {
      marketId: 'bitcoin',
      direction: 'YES' as const,
      currentOutcomePrice: 0.475,
      currentYesPrice: 0.475,
    };
    
    const decision = evaluateTakeProfit(
      mockPosition as any,
      currentPrice,
      0.15,
      0.10,
    );

    expect(decision.shouldExit).toBe(false);
  });

  it('triggers take-profit for crypto at 15% (0.575)', () => {
    const currentPrice = {
      marketId: 'bitcoin',
      direction: 'YES' as const,
      currentOutcomePrice: 0.576, // > 15% gain
      currentYesPrice: 0.576,
    };

    const decision = evaluateTakeProfit(
      mockPosition as any,
      currentPrice,
      0.15,
      0.10,
    );

    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe('take_profit_threshold');
  });
});

// FV scanner: tpThreshold=2 (disabled), slThreshold=CRYPTO_UPDOWN_STOP_LOSS (0.10).
// TP and trailing must never fire — the near-res gate (0.95) is the winning exit.
describe('takeProfitEvaluator — fv-scanner tier (tpThreshold=2, slThreshold=0.10)', () => {
  const fvPosition = {
    marketId: '2062109',
    direction: 'YES' as const,
    entryPrice: 0.65,
    consensusProbability: 0.87,
    sourcedFrom: 'fv-scanner:bitcoin:YES:p0.870:e0.220',
  };

  it('holds at +3% gain (old crypto-updown TP would have fired)', () => {
    const currentPrice = {
      marketId: '2062109',
      direction: 'YES' as const,
      currentOutcomePrice: 0.65 * 1.031,
      currentYesPrice: 0.65 * 1.031,
    };
    const decision = evaluateTakeProfit(fvPosition as any, currentPrice, 2, 0.10);
    expect(decision.shouldExit).toBe(false);
  });

  it('holds at +50% gain (market drifting toward resolution)', () => {
    const currentPrice = {
      marketId: '2062109',
      direction: 'YES' as const,
      currentOutcomePrice: 0.65 * 1.50,
      currentYesPrice: 0.65 * 1.50,
    };
    const decision = evaluateTakeProfit(fvPosition as any, currentPrice, 2, 0.10);
    expect(decision.shouldExit).toBe(false);
  });

  it('fires stop-loss at -10% (spot flipped below strike)', () => {
    const currentPrice = {
      marketId: '2062109',
      direction: 'YES' as const,
      currentOutcomePrice: 0.65 * (1 - 0.101),
      currentYesPrice: 0.65 * (1 - 0.101),
    };
    const decision = evaluateTakeProfit(fvPosition as any, currentPrice, 2, 0.10);
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe('stop_loss');
  });
});

// SPORTS_STOP_LOSS=0.45, SPORTS_TAKE_PROFIT=0.25
// Live in-play prices swing ±15-30% on scoring plays — the old 16% default
// fired within one 5s monitor tick. These tests document the expected routing
// so the 45% threshold is never accidentally tightened back.
describe('takeProfitEvaluator — sports-arb tier (SPORTS_STOP_LOSS=0.45)', () => {
  const sportsMockPosition = {
    marketId: '1998942',
    direction: 'YES' as const,
    entryPrice: 0.57,
    consensusProbability: 0.80,
    sourcedFrom: 'sports:mlb:401815027',
  };

  it('holds at -16% loss (old default would have fired)', () => {
    const currentPrice = {
      marketId: '1998942',
      direction: 'YES' as const,
      currentOutcomePrice: 0.57 * (1 - 0.16), // exactly the old threshold
      currentYesPrice: 0.57 * (1 - 0.16),
    };
    const decision = evaluateTakeProfit(sportsMockPosition as any, currentPrice, 0.25, 0.45);
    expect(decision.shouldExit).toBe(false);
  });

  it('holds at -30% loss (normal in-game scoring swing)', () => {
    const currentPrice = {
      marketId: '1998942',
      direction: 'YES' as const,
      currentOutcomePrice: 0.57 * (1 - 0.30),
      currentYesPrice: 0.57 * (1 - 0.30),
    };
    const decision = evaluateTakeProfit(sportsMockPosition as any, currentPrice, 0.25, 0.45);
    expect(decision.shouldExit).toBe(false);
  });

  it('fires stop-loss at -46% (game situation definitively turned)', () => {
    const currentPrice = {
      marketId: '1998942',
      direction: 'YES' as const,
      currentOutcomePrice: 0.57 * (1 - 0.46),
      currentYesPrice: 0.57 * (1 - 0.46),
    };
    const decision = evaluateTakeProfit(sportsMockPosition as any, currentPrice, 0.25, 0.45);
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe('stop_loss');
  });

  it('fires take-profit at 25%', () => {
    const currentPrice = {
      marketId: '1998942',
      direction: 'YES' as const,
      currentOutcomePrice: 0.57 * 1.26,
      currentYesPrice: 0.57 * 1.26,
    };
    const decision = evaluateTakeProfit(sportsMockPosition as any, currentPrice, 0.25, 0.45);
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe('take_profit_threshold');
  });
});
