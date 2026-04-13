import { describe, it, expect, vi } from 'vitest';
import { recalibratePrice, getThetaForCategory, applyCategoryBias } from '../calibrationBias.js';

// Mock loadConfig to return controlled theta values without needing .env
vi.mock('../../shared/config.js', () => ({
  loadConfig: () => ({
    CALIBRATION_BIAS_ENABLED: false,
    CALIBRATION_BIAS_THETA_POLITICS: 1.83,
    CALIBRATION_BIAS_THETA_SPORTS_LONG: 1.74,
    CALIBRATION_BIAS_THETA_SPORTS_SHORT: 1.20,
    CALIBRATION_BIAS_THETA_WEATHER: 0.69,
    CALIBRATION_BIAS_THETA_CRYPTO: 1.0,
    CALIBRATION_BIAS_THETA_ENTERTAINMENT: 1.50,
    CALIBRATION_BIAS_THETA_DEFAULT: 1.0,
  }),
}));

describe('recalibratePrice', () => {
  it('returns identity when theta=1', () => {
    expect(recalibratePrice(0.50, 1)).toBe(0.50);
    expect(recalibratePrice(0.70, 1)).toBe(0.70);
    expect(recalibratePrice(0.10, 1)).toBe(0.10);
    expect(recalibratePrice(0.99, 1)).toBe(0.99);
  });

  it('returns 0 for marketPrice=0', () => {
    expect(recalibratePrice(0, 1.83)).toBe(0);
    expect(recalibratePrice(0, 0.69)).toBe(0);
  });

  it('returns 1 for marketPrice=1', () => {
    expect(recalibratePrice(1, 1.83)).toBe(1);
    expect(recalibratePrice(1, 0.69)).toBe(1);
  });

  it('returns 0.5 when marketPrice=0.5 (for any theta)', () => {
    // p=0.5 is a fixed point: 0.5^theta / (0.5^theta + 0.5^theta) = 0.5
    expect(recalibratePrice(0.50, 1.83)).toBeCloseTo(0.50, 10);
    expect(recalibratePrice(0.50, 0.69)).toBeCloseTo(0.50, 10);
    expect(recalibratePrice(0.50, 1.50)).toBeCloseTo(0.50, 10);
  });

  it('adjusts political favourite upward with theta=1.83', () => {
    // p=0.70, theta=1.83 => p* should be > 0.70 (underconfident market)
    const adjusted = recalibratePrice(0.70, 1.83);
    expect(adjusted).toBeGreaterThan(0.70);
    // Known value: 0.70^1.83 / (0.70^1.83 + 0.30^1.83)
    // 0.70^1.83 ~ 0.5098, 0.30^1.83 ~ 0.1069 => 0.5098 / 0.6167 ~ 0.8267
    expect(adjusted).toBeCloseTo(0.827, 2);
  });

  it('adjusts weather favourite downward with theta=0.69', () => {
    // p=0.80, theta=0.69 => p* should be < 0.80 (overconfident market)
    const adjusted = recalibratePrice(0.80, 0.69);
    expect(adjusted).toBeLessThan(0.80);
  });

  it('adjusts longshot downward with theta>1 (underconfident)', () => {
    // p=0.20, theta=1.83 => for p < 0.5 and theta > 1, p* < p
    // because underconfident markets are recalibrated away from 0.5.
    const adjusted = recalibratePrice(0.20, 1.83);
    // 0.20^1.83 / (0.20^1.83 + 0.80^1.83)
    // 0.20^1.83 ~ 0.0516, 0.80^1.83 ~ 0.6580 => 0.0516 / 0.7096 ~ 0.0727
    // So a 20% longshot becomes even less likely after recalibration.
    expect(adjusted).toBeLessThan(0.20);
  });

  it('is monotonic: higher market price => higher adjusted price', () => {
    const theta = 1.83;
    const prices = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    const adjusted = prices.map((p) => recalibratePrice(p, theta));
    for (let i = 1; i < adjusted.length; i++) {
      expect(adjusted[i]).toBeGreaterThan(adjusted[i - 1]);
    }
  });

  it('is symmetric around 0.5', () => {
    // recalibratePrice(p, theta) + recalibratePrice(1-p, theta) should equal 1
    const theta = 1.83;
    for (const p of [0.1, 0.2, 0.3, 0.4]) {
      const low = recalibratePrice(p, theta);
      const high = recalibratePrice(1 - p, theta);
      expect(low + high).toBeCloseTo(1.0, 10);
    }
  });
});

describe('getThetaForCategory', () => {
  it('returns politics theta for us-politics', () => {
    expect(getThetaForCategory('us-politics')).toBe(1.83);
  });

  it('returns politics theta for geopolitical', () => {
    expect(getThetaForCategory('geopolitical')).toBe(1.83);
  });

  it('returns politics theta for macro', () => {
    expect(getThetaForCategory('macro')).toBe(1.83);
  });

  it('returns sports long theta for sports with >720h to resolution', () => {
    expect(getThetaForCategory('sports', 800)).toBe(1.74);
  });

  it('returns sports short theta for sports with <=720h to resolution', () => {
    expect(getThetaForCategory('sports', 720)).toBe(1.20);
    expect(getThetaForCategory('sports', 48)).toBe(1.20);
  });

  it('returns sports short theta when no timeToResolution provided', () => {
    expect(getThetaForCategory('sports')).toBe(1.20);
  });

  it('returns weather theta for short-horizon (<=48h)', () => {
    expect(getThetaForCategory('weather')).toBe(0.69);
    expect(getThetaForCategory('weather', 24)).toBe(0.69);
    expect(getThetaForCategory('weather', 48)).toBe(0.69);
  });

  it('returns default theta for long-horizon weather (>48h)', () => {
    expect(getThetaForCategory('weather', 49)).toBe(1.0);
    expect(getThetaForCategory('weather', 720)).toBe(1.0);
  });

  it('returns crypto theta for crypto-regulatory', () => {
    expect(getThetaForCategory('crypto-regulatory')).toBe(1.0);
  });

  it('returns crypto theta for crypto-updown', () => {
    expect(getThetaForCategory('crypto-updown')).toBe(1.0);
  });

  it('returns entertainment theta for ai-tech', () => {
    expect(getThetaForCategory('ai-tech')).toBe(1.50);
  });

  it('returns entertainment theta for entertainment', () => {
    expect(getThetaForCategory('entertainment')).toBe(1.50);
  });

  it('returns default theta for unknown category', () => {
    expect(getThetaForCategory('unknown-category')).toBe(1.0);
  });
});

describe('applyCategoryBias', () => {
  it('returns full result with metadata', () => {
    const result = applyCategoryBias(0.70, 'us-politics');
    expect(result.rawPrice).toBe(0.70);
    expect(result.theta).toBe(1.83);
    expect(result.adjustedPrice).toBeGreaterThan(0.70);
    expect(result.adjustedPrice).toBeCloseTo(0.827, 2);
  });

  it('no adjustment for crypto', () => {
    const result = applyCategoryBias(0.70, 'crypto-regulatory');
    expect(result.theta).toBe(1.0);
    expect(result.adjustedPrice).toBe(0.70);
  });

  it('passes timeToResolutionHours through for sports', () => {
    const shortTerm = applyCategoryBias(0.70, 'sports', 48);
    const longTerm = applyCategoryBias(0.70, 'sports', 800);
    expect(shortTerm.theta).toBe(1.20);
    expect(longTerm.theta).toBe(1.74);
    // Long-term sports has higher theta, so adjustment should be more extreme
    expect(longTerm.adjustedPrice).toBeGreaterThan(shortTerm.adjustedPrice);
  });
});
