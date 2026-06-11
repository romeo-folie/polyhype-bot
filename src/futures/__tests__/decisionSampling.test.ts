import { describe, it, expect, vi, afterEach } from 'vitest';
import { shouldDropSampledDecision } from '../decisionSampling.js';

describe('shouldDropSampledDecision', () => {
  afterEach(() => vi.restoreAllMocks());

  it('never drops a trade, regardless of sample rate', () => {
    expect(shouldDropSampledDecision(true, 0)).toBe(false);
    expect(shouldDropSampledDecision(true, 0.1)).toBe(false);
    expect(shouldDropSampledDecision(true, 1)).toBe(false);
  });

  it('never drops a skip when sampling is disabled (rate >= 1)', () => {
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(shouldDropSampledDecision(false, 1)).toBe(false);
    expect(rand).not.toHaveBeenCalled(); // short-circuits before rolling
  });

  it('always drops a skip when rate is 0', () => {
    // Math.random() ∈ [0,1) is always >= 0 → always dropped.
    expect(shouldDropSampledDecision(false, 0)).toBe(true);
  });

  it('drops a skip when the roll lands at/above the rate, keeps it below', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.6);
    expect(shouldDropSampledDecision(false, 0.5)).toBe(true); // 0.6 >= 0.5 → drop
    vi.spyOn(Math, 'random').mockReturnValue(0.4);
    expect(shouldDropSampledDecision(false, 0.5)).toBe(false); // 0.4 < 0.5 → keep
  });
});
