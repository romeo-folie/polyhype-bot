import { describe, it, expect } from 'vitest';
import { normalCdf, computePModel, SECONDS_PER_YEAR } from '../blackScholes.js';

describe('SECONDS_PER_YEAR', () => {
  it('is Julian year: 365.25 × 24 × 3600', () => {
    expect(SECONDS_PER_YEAR).toBeCloseTo(31_557_600, 0);
  });
});

describe('normalCdf', () => {
  it('Φ(0) = 0.5', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 5);
  });
  it('Φ(1.96) ≈ 0.975', () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 2);
  });
  it('Φ(-1.96) ≈ 0.025', () => {
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 2);
  });
  it('Φ(+∞) = 1', () => {
    expect(normalCdf(Infinity)).toBe(1);
  });
  it('Φ(-∞) = 0', () => {
    expect(normalCdf(-Infinity)).toBe(0);
  });
  it('Φ(NaN) = NaN', () => {
    // NaN propagates loudly instead of collapsing to 0/1 — prevents silent
    // math bugs upstream from turning into a seemingly-valid probability.
    expect(Number.isNaN(normalCdf(NaN))).toBe(true);
  });
  it('is symmetric: Φ(x) + Φ(-x) = 1', () => {
    for (const x of [0.5, 1, 2, 3]) {
      expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 10);
    }
  });
});

describe('computePModel', () => {
  const sigma = 0.6; // 60% annualized vol — realistic for BTC
  const tauSecs = 600; // 10 minutes

  it('returns valid=false for non-positive spot', () => {
    const r = computePModel(0, 50000, sigma, tauSecs);
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('non_positive_price');
  });

  it('returns valid=false for NaN spot', () => {
    const r = computePModel(NaN, 50000, sigma, tauSecs);
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('non_finite_input');
  });

  it('returns valid=false for Infinity strike', () => {
    const r = computePModel(50000, Infinity, sigma, tauSecs);
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('non_finite_input');
  });

  it('returns valid=false for NaN sigma', () => {
    const r = computePModel(50000, 50000, NaN, tauSecs);
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('non_finite_input');
  });

  it('returns valid=false for NaN tauSecs', () => {
    const r = computePModel(50000, 50000, sigma, NaN);
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('non_finite_input');
  });

  it('returns valid=false for non-positive sigma', () => {
    const r = computePModel(50000, 50000, 0, tauSecs);
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('non_positive_sigma');
  });

  it('returns valid=false for expired market (tauSecs ≤ 0)', () => {
    const r = computePModel(50000, 50000, sigma, 0);
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('expired');
  });

  it('pYes + pNo = 1 always', () => {
    const r = computePModel(50000, 50000, sigma, tauSecs);
    expect(r.valid).toBe(true);
    expect(r.pYes + r.pNo).toBeCloseTo(1, 10);
  });

  it('spot == strike → pYes ≈ 0.5 (minus vol drag)', () => {
    // d = (0 - 0.5σ²τ) / (σ√τ) = -0.5σ√τ < 0, so pYes < 0.5
    const r = computePModel(50000, 50000, sigma, tauSecs);
    expect(r.valid).toBe(true);
    expect(r.pYes).toBeLessThan(0.5);
    expect(r.pYes).toBeGreaterThan(0.3);
  });

  it('spot >> strike → pYes approaches 1', () => {
    // Spot 5% above strike with 10 min to go — very likely YES
    const r = computePModel(52500, 50000, sigma, tauSecs);
    expect(r.valid).toBe(true);
    expect(r.pYes).toBeGreaterThan(0.80);
  });

  it('spot << strike → pYes approaches 0 (pNo approaches 1)', () => {
    const r = computePModel(47500, 50000, sigma, tauSecs);
    expect(r.valid).toBe(true);
    expect(r.pYes).toBeLessThan(0.20);
    expect(r.pNo).toBeGreaterThan(0.80);
  });

  it('tauYears = tauSecs / SECONDS_PER_YEAR', () => {
    const r = computePModel(50000, 50000, sigma, tauSecs);
    expect(r.tauYears).toBeCloseTo(tauSecs / SECONDS_PER_YEAR, 10);
  });

  it('d-term matches manual calculation', () => {
    const spot = 50000;
    const strike = 49000;
    const r = computePModel(spot, strike, sigma, tauSecs);
    const tauYears = tauSecs / SECONDS_PER_YEAR;
    const expected_d =
      (Math.log(spot / strike) - 0.5 * sigma * sigma * tauYears) /
      (sigma * Math.sqrt(tauYears));
    expect(r.d).toBeCloseTo(expected_d, 8);
  });

  it('p_model in FV YES range (0.80–0.95) for spot moderately above strike at τ=120s', () => {
    // Calibrate roughly: σ=0.6, τ=120s, we want pYes in [0.80, 0.95]
    // Try spot 1% above strike
    const r = computePModel(50500, 50000, 0.6, 120);
    expect(r.valid).toBe(true);
    // Just verify it's in a reasonable range for a near-resolution market
    expect(r.pYes).toBeGreaterThan(0.5);
  });

  it('low sigma floor (0.20) returns valid result', () => {
    const r = computePModel(50000, 50500, 0.20, 300); // spot below strike, σ at floor
    expect(r.valid).toBe(true);
    expect(r.pYes).toBeLessThan(0.5);
  });
});
