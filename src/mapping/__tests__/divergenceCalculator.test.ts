import { describe, it, expect } from 'vitest';
import {
  computeDivergence,
  computeHalfKelly,
  NOISE_STDDEV_THRESHOLD,
} from '../divergenceCalculator.js';

const DEFAULT_INPUT = {
  bankrollUsd: 100,
  divergenceThreshold: 0.1,
  maxBetFraction: 0.1,
  consensusStddev: 0.01, // low stddev — passes noise gate
};

describe('computeHalfKelly', () => {
  it('returns 0 for price=0', () => {
    expect(computeHalfKelly(0.7, 0)).toBe(0);
  });

  it('returns 0 for price=1', () => {
    expect(computeHalfKelly(0.7, 1)).toBe(0);
  });

  it('returns 0 when no edge (p === price)', () => {
    // Kelly = (b*p - q)/b; when p = price, Kelly < 0 effectively
    const result = computeHalfKelly(0.5, 0.5);
    expect(result).toBe(0);
  });

  it('returns positive fraction when there is edge', () => {
    // p=0.7, price=0.5 → b=1, kelly=(1*0.7-0.3)/1=0.4, half=0.2
    const result = computeHalfKelly(0.7, 0.5);
    expect(result).toBeCloseTo(0.2, 4);
  });

  it('returns 0 when Kelly is negative (edge against us)', () => {
    // p=0.3, price=0.7 → would be negative Kelly
    expect(computeHalfKelly(0.3, 0.7)).toBe(0);
  });
});

describe('computeDivergence', () => {
  it('returns hasTrade=false when edge is below threshold', () => {
    const result = computeDivergence({
      ...DEFAULT_INPUT,
      consensusProbability: 0.55,
      currentYesPrice: 0.5, // edge = 0.05 < 0.10 threshold
    });
    expect(result.hasTrade).toBe(false);
    expect(result.decision).toBeNull();
  });

  it('returns hasTrade=true and direction=YES when consensus > market', () => {
    const result = computeDivergence({
      ...DEFAULT_INPUT,
      consensusProbability: 0.7,
      currentYesPrice: 0.5, // edge = 0.20
    });
    expect(result.hasTrade).toBe(true);
    expect(result.decision!.direction).toBe('YES');
    expect(result.decision!.edgeMagnitude).toBeCloseTo(0.2, 4);
  });

  it('returns direction=NO when consensus < market', () => {
    const result = computeDivergence({
      ...DEFAULT_INPUT,
      consensusProbability: 0.3,
      currentYesPrice: 0.55, // edge = -0.25
    });
    expect(result.hasTrade).toBe(true);
    expect(result.decision!.direction).toBe('NO');
  });

  it('caps stake at maxBetFraction * bankrollUsd', () => {
    // Large edge to make half-Kelly > maxBetFraction
    const result = computeDivergence({
      ...DEFAULT_INPUT,
      consensusProbability: 0.99,
      currentYesPrice: 0.1, // huge edge
    });
    expect(result.hasTrade).toBe(true);
    // Max bet = 10% of $100 = $10
    expect(result.decision!.stakeUsd).toBeLessThanOrEqual(10 + 1e-9);
  });

  it('stake is 0 when bankroll is 0', () => {
    const result = computeDivergence({
      ...DEFAULT_INPUT,
      bankrollUsd: 0,
      consensusProbability: 0.8,
      currentYesPrice: 0.5,
    });
    expect(result.hasTrade).toBe(true);
    expect(result.decision!.stakeUsd).toBe(0);
  });

  it('edge exactly at threshold trades (strict less-than gate)', () => {
    // edge = 0.20, clearly above 0.10 threshold — avoids floating-point boundary issues
    const result = computeDivergence({
      ...DEFAULT_INPUT,
      consensusProbability: 0.7,
      currentYesPrice: 0.5, // edge = 0.20
    });
    expect(result.hasTrade).toBe(true);
  });

  it('caps stake at 20% of bookDepthUsd (Liquidity Gate)', () => {
    // Bankroll $1000, 10% max bet = $100
    // Book depth $100, 20% cap = $20
    const result = computeDivergence({
      bankrollUsd: 1000,
      divergenceThreshold: 0.01,
      maxBetFraction: 0.1,
      consensusStddev: 0.01,
      consensusProbability: 0.8,
      currentYesPrice: 0.5, // Kelly (~0.3) > 10% maxBetFraction ($100)
      bookDepthUsd: 100,
    });

    expect(result.hasTrade).toBe(true);
    // Should be capped by book depth: 100 * 0.2 = 20
    expect(result.decision!.stakeUsd).toBeCloseTo(20, 2);
  });
});

describe('EV gate & noise gate', () => {
  it('exports NOISE_STDDEV_THRESHOLD constant', () => {
    expect(NOISE_STDDEV_THRESHOLD).toBe(0.08);
  });

  it('rejects noisy signal when stddev > threshold', () => {
    const result = computeDivergence({
      ...DEFAULT_INPUT,
      consensusProbability: 0.7,
      consensusStddev: 0.09, // above 0.08 threshold
      currentYesPrice: 0.5,
    });
    expect(result.hasTrade).toBe(false);
    expect(result.skipReason).toContain('noisy_signal');
  });

  it('rejects negative EV at lower bound', () => {
    // p=0.52, stddev=0.05 → p_lower=0.47, market=0.50
    // Direction YES (0.52 > 0.50), outcomePrice=0.50, payout=2.0
    // p_for_ev = p_lower = 0.47, EV = 0.47*2 - 1 = -0.06 → negative
    const result = computeDivergence({
      ...DEFAULT_INPUT,
      consensusProbability: 0.52,
      consensusStddev: 0.05,
      currentYesPrice: 0.5,
      divergenceThreshold: 0.01, // low threshold so edge gate doesn't reject first
    });
    expect(result.hasTrade).toBe(false);
    expect(result.skipReason).toContain('negative_ev');
  });

  it('allows trade when EV positive at lower bound', () => {
    // p=0.70, stddev=0.02 → p_lower=0.68, market=0.50
    // Direction YES, outcomePrice=0.50, payout=2.0
    // EV = 0.68*2 - 1 = 0.36 → positive
    const result = computeDivergence({
      ...DEFAULT_INPUT,
      consensusProbability: 0.7,
      consensusStddev: 0.02,
      currentYesPrice: 0.5,
    });
    expect(result.hasTrade).toBe(true);
    expect(result.decision).not.toBeNull();
    expect(result.skipReason).toBeUndefined();
  });

  it('stddev=0 passes noise gate (formula-based estimates)', () => {
    const result = computeDivergence({
      ...DEFAULT_INPUT,
      consensusProbability: 0.7,
      consensusStddev: 0,
      currentYesPrice: 0.5,
    });
    expect(result.hasTrade).toBe(true);
  });
});

describe('extreme-price LLM-distrust gate', () => {
  it('rejects when market is < 2¢ but LLM consensus is high (Baidu/Alibaba case)', () => {
    const result = computeDivergence({
      ...DEFAULT_INPUT,
      consensusProbability: 0.5, // LLM defaults to ~50% under uncertainty
      currentYesPrice: 0.0015, // 0.15% — multi-outcome longshot
    });
    expect(result.hasTrade).toBe(false);
    expect(result.skipReason).toContain('extreme_price_llm_distrust');
  });

  it('rejects symmetric case: market > 98¢ but LLM consensus is low', () => {
    const result = computeDivergence({
      ...DEFAULT_INPUT,
      consensusProbability: 0.5,
      currentYesPrice: 0.99,
    });
    expect(result.hasTrade).toBe(false);
    expect(result.skipReason).toContain('extreme_price_llm_distrust');
  });

  it('allows trade when low-priced market has correspondingly low LLM consensus', () => {
    // Market at 1¢, LLM agrees it's a longshot (5%) — small but coherent edge
    const result = computeDivergence({
      ...DEFAULT_INPUT,
      consensusProbability: 0.05,
      currentYesPrice: 0.01,
      divergenceThreshold: 0.01,
    });
    expect(result.hasTrade).toBe(true);
    expect(result.skipReason).toBeUndefined();
  });

  it('allows trade when high-priced market has correspondingly high LLM consensus', () => {
    const result = computeDivergence({
      ...DEFAULT_INPUT,
      consensusProbability: 0.99,
      currentYesPrice: 0.985,
      divergenceThreshold: 0.001,
    });
    // May still be blocked by other gates but should not hit the distrust gate
    expect(result.skipReason).not.toContain('extreme_price_llm_distrust');
  });

  it('respects custom thresholds', () => {
    // With minPriceForLlmTrust=0.05, a market at 0.03 should now be in the zone
    const result = computeDivergence({
      ...DEFAULT_INPUT,
      consensusProbability: 0.4,
      currentYesPrice: 0.03,
      minPriceForLlmTrust: 0.05,
      maxLlmProbAtLowPrice: 0.2,
    });
    expect(result.hasTrade).toBe(false);
    expect(result.skipReason).toContain('extreme_price_llm_distrust');
  });

  it('does not gate markets safely above the trust floor', () => {
    // Market at 5%, LLM at 50% — outside the gate but should still trade
    const result = computeDivergence({
      ...DEFAULT_INPUT,
      consensusProbability: 0.5,
      currentYesPrice: 0.05,
    });
    expect(result.hasTrade).toBe(true);
    expect(result.skipReason).toBeUndefined();
  });
});
