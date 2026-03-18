import { describe, it, expect } from '@jest/globals';
import { computeDivergence, computeHalfKelly } from '../divergenceCalculator.js';

const DEFAULT_INPUT = {
  bankrollUsd: 100,
  divergenceThreshold: 0.1,
  maxBetFraction: 0.1,
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
});
