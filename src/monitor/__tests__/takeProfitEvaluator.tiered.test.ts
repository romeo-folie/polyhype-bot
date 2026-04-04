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
