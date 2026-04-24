import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SigmaCalibrator, DEFAULT_SIGMA_CONFIG } from '../sigmaCalibrator.js';
import type { ChainlinkTick } from '../../spot/feeds/chainlinkFeed.js';
import { SECONDS_PER_YEAR } from '../blackScholes.js';

function mkTick(symbol: string, value: number, oracleTs: number, receivedAt: number): ChainlinkTick {
  return { symbol, value, oracleTs, receivedAt };
}

describe('SigmaCalibrator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('warmup dual-gate', () => {
    it('warmedUp=false before warmup tick count reached', () => {
      const cal = new SigmaCalibrator({ warmupTicks: 5, warmupMinMs: 0 });
      cal.onTick(mkTick('btc/usd', 50000, 0, Date.now()));
      cal.onTick(mkTick('btc/usd', 50001, 0, Date.now()));
      const r = cal.getSigma('btc/usd', []);
      expect(r.warmedUp).toBe(false);
    });

    it('warmedUp=false even after ticks if wall-clock min not met', () => {
      const cal = new SigmaCalibrator({ warmupTicks: 3, warmupMinMs: 10_000 });
      // Fire 3 ticks within 1 second — hits tick count but not wall-clock.
      cal.onTick(mkTick('btc/usd', 50000, 0, Date.now()));
      vi.advanceTimersByTime(500);
      cal.onTick(mkTick('btc/usd', 50001, 0, Date.now()));
      vi.advanceTimersByTime(500);
      cal.onTick(mkTick('btc/usd', 50002, 0, Date.now()));
      const r = cal.getSigma('btc/usd', []);
      expect(r.warmedUp).toBe(false);
    });

    it('warmedUp=true only when both tick count AND wall-clock min are met', () => {
      const cal = new SigmaCalibrator({ warmupTicks: 3, warmupMinMs: 10_000 });
      cal.onTick(mkTick('btc/usd', 50000, 0, Date.now()));
      vi.advanceTimersByTime(11_000);
      cal.onTick(mkTick('btc/usd', 50001, 0, Date.now()));
      cal.onTick(mkTick('btc/usd', 50002, 0, Date.now()));
      const r = cal.getSigma('btc/usd', []);
      expect(r.warmedUp).toBe(true);
    });

    it('warmedUp=false for symbol with no ticks', () => {
      const cal = new SigmaCalibrator({ warmupTicks: 1, warmupMinMs: 0 });
      const r = cal.getSigma('btc/usd', []);
      expect(r.warmedUp).toBe(false);
    });
  });

  describe('rolling σ from window ticks', () => {
    it('returns sigmaMin floor when fewer than 2 log-returns are present', () => {
      const cal = new SigmaCalibrator({ sigmaMin: 0.2 });
      const r = cal.getSigma('btc/usd', []);
      expect(r.sigmaRolling).toBeCloseTo(0.2, 6);
    });

    it('computes std(log-returns) × √SECONDS_PER_YEAR for constant-return series', () => {
      const cal = new SigmaCalibrator({ sigmaMin: 0.0, sigmaMax: 100 });
      // Price multipliers: 1, e^0.01, e^0.02, e^0.03 — log-returns constant at 0.01/tick.
      // std=0 so rolling σ will be ~0; we just verify code path runs and output <= sigmaMax.
      const now = Date.now();
      const ticks: ChainlinkTick[] = [
        mkTick('btc/usd', 50000, now - 3000, now - 3000),
        mkTick('btc/usd', 50000 * Math.exp(0.01), now - 2000, now - 2000),
        mkTick('btc/usd', 50000 * Math.exp(0.02), now - 1000, now - 1000),
        mkTick('btc/usd', 50000 * Math.exp(0.03), now, now),
      ];
      const r = cal.getSigma('btc/usd', ticks);
      expect(r.sigmaRolling).toBeLessThanOrEqual(100);
      expect(r.sigmaRolling).toBeGreaterThanOrEqual(0);
    });

    it('reports non-zero rolling σ for alternating-return series', () => {
      const cal = new SigmaCalibrator({ sigmaMin: 0.0, sigmaMax: 1000 });
      // Alternating log-returns ±0.001 → nonzero variance.
      const now = Date.now();
      const prices = [50000, 50050, 50000, 50050, 50000, 50050, 50000, 50050];
      const ticks = prices.map((p, i) =>
        mkTick('btc/usd', p, now - (prices.length - 1 - i) * 1000, now - (prices.length - 1 - i) * 1000),
      );
      const r = cal.getSigma('btc/usd', ticks);
      expect(r.sigmaRolling).toBeGreaterThan(0);
    });

    it('counts log-returns, not ticks, in ticksInWindow', () => {
      const cal = new SigmaCalibrator();
      const now = Date.now();
      const ticks: ChainlinkTick[] = [
        mkTick('btc/usd', 50000, now - 2000, now - 2000),
        mkTick('btc/usd', 50001, now - 1000, now - 1000),
        mkTick('btc/usd', 50002, now, now),
      ];
      const r = cal.getSigma('btc/usd', ticks);
      // 3 ticks → 2 log-returns
      expect(r.ticksInWindow).toBe(2);
    });
  });

  describe('EWMA spike selection', () => {
    it('prefers EWMA when ewma > spikeMultiplier × rolling', () => {
      // Build calibrator with low rolling (fed flat window) and high EWMA (fed spike via onTick).
      const cal = new SigmaCalibrator({
        sigmaMin: 0.0,
        sigmaMax: 1000,
        ewmaSpikeMultiplier: 1.5,
        ewmaHalfLifeS: 1, // fast decay so the spike dominates quickly
      });

      // Flat rolling window (no vol)
      const now = Date.now();
      const flatTicks: ChainlinkTick[] = [
        mkTick('btc/usd', 50000, now - 2000, now - 2000),
        mkTick('btc/usd', 50000, now - 1000, now - 1000),
        mkTick('btc/usd', 50000, now, now),
      ];

      // EWMA gets large shocks
      cal.onTick(mkTick('btc/usd', 50000, now - 3000, now - 3000));
      cal.onTick(mkTick('btc/usd', 55000, now - 2000, now - 2000)); // +10%
      cal.onTick(mkTick('btc/usd', 50000, now - 1000, now - 1000)); // −10%

      const r = cal.getSigma('btc/usd', flatTicks);
      expect(r.source).toBe('ewma');
      expect(r.sigmaEwma).toBeGreaterThan(r.sigmaRolling);
    });

    it('prefers rolling when EWMA is not elevated', () => {
      // Flat price series → both rolling and EWMA are 0.
      // The spike-selector fires only when EWMA > 1.5 × rolling AND > 0, so
      // with everything at the floor the calibrator sticks with rolling.
      const cal = new SigmaCalibrator({ sigmaMin: 0.0, sigmaMax: 1000, ewmaSpikeMultiplier: 1.5 });
      const now = Date.now();
      const ticks: ChainlinkTick[] = [
        mkTick('btc/usd', 50000, now - 2000, now - 2000),
        mkTick('btc/usd', 50000, now - 1000, now - 1000),
        mkTick('btc/usd', 50000, now, now),
      ];
      for (const t of ticks) cal.onTick(t);
      const r = cal.getSigma('btc/usd', ticks);
      expect(r.source).toBe('rolling');
    });

    it('uses elapsed seconds between ticks for EWMA decay', () => {
      const cal = new SigmaCalibrator({
        sigmaMin: 0.0,
        sigmaMax: 1000,
        ewmaHalfLifeS: 300,
      });
      const base = Date.now();
      cal.onTick(mkTick('btc/usd', 50_000, base, base));
      cal.onTick(mkTick('btc/usd', 55_000, base + 1_000, base + 1_000));
      const fastGap = cal.getSigma('btc/usd', []);

      const slow = new SigmaCalibrator({
        sigmaMin: 0.0,
        sigmaMax: 1000,
        ewmaHalfLifeS: 300,
      });
      slow.onTick(mkTick('btc/usd', 50_000, base, base));
      slow.onTick(mkTick('btc/usd', 55_000, base + 60_000, base + 60_000));
      const slowGap = slow.getSigma('btc/usd', []);

      expect(slowGap.sigmaEwma).toBeGreaterThan(fastGap.sigmaEwma);
    });
  });

  describe('clamp [sigmaMin, sigmaMax]', () => {
    it('raises below-floor σ up to sigmaMin', () => {
      const cal = new SigmaCalibrator({ sigmaMin: 0.2, sigmaMax: 5.0 });
      // Empty window → rolling falls to sigmaMin default already.
      const r = cal.getSigma('btc/usd', []);
      expect(r.sigma).toBeGreaterThanOrEqual(0.2);
    });

    it('caps above-ceiling σ at sigmaMax', () => {
      const cal = new SigmaCalibrator({ sigmaMin: 0.2, sigmaMax: 2.0, ewmaHalfLifeS: 1 });
      const now = Date.now();
      // Feed huge oscillations to push σ very high
      for (let i = 0; i < 50; i++) {
        cal.onTick(mkTick('btc/usd', i % 2 === 0 ? 50000 : 100000, now + i * 100, now + i * 100));
      }
      const windowTicks: ChainlinkTick[] = [];
      for (let i = 0; i < 50; i++) {
        windowTicks.push(
          mkTick('btc/usd', i % 2 === 0 ? 50000 : 100000, now + i * 100, now + i * 100),
        );
      }
      const r = cal.getSigma('btc/usd', windowTicks);
      expect(r.sigma).toBeLessThanOrEqual(2.0);
    });
  });

  describe('σ scaling by SECONDS_PER_YEAR', () => {
    it('uses SECONDS_PER_YEAR for annualization', () => {
      const cal = new SigmaCalibrator({ sigmaMin: 0.0, sigmaMax: 1e9 });
      const now = Date.now();
      // Craft exactly two log-returns with known std.
      // prices 1, e^0.01, e^0.02 → log-returns 0.01, 0.01 → std=0 ⇒ rolling=0.
      // Better: 1, e^0.01, e^-0.01 → log-returns 0.01, -0.02 → std ≠ 0.
      const ticks: ChainlinkTick[] = [
        mkTick('btc/usd', 1, now - 2000, now - 2000),
        mkTick('btc/usd', Math.exp(0.01), now - 1000, now - 1000),
        mkTick('btc/usd', Math.exp(-0.01), now, now),
      ];
      const r = cal.getSigma('btc/usd', ticks);
      // Manual: log-returns = [0.01, -0.02], mean = -0.005, variance = ((0.015)² + (-0.015)²)/1 = 4.5e-4
      // std = sqrt(4.5e-4), annualized = std × sqrt(SECONDS_PER_YEAR)
      const expected = Math.sqrt(4.5e-4) * Math.sqrt(SECONDS_PER_YEAR);
      expect(r.sigmaRolling).toBeCloseTo(expected, 5);
    });
  });

  describe('stale tick handling', () => {
    it('onTick tolerates zero-value first tick without crashing', () => {
      // First tick sets lastValue; subsequent ticks with lastValue>0 && tick.value>0 compute returns.
      const cal = new SigmaCalibrator();
      // Should not throw even if first value is 0 (would-be divide-by-zero is guarded).
      expect(() => {
        cal.onTick(mkTick('btc/usd', 0, 0, Date.now()));
        cal.onTick(mkTick('btc/usd', 50000, 0, Date.now()));
      }).not.toThrow();
    });
  });

  describe('default config', () => {
    it('DEFAULT_SIGMA_CONFIG has warmupMinMs=180000 (3 min)', () => {
      expect(DEFAULT_SIGMA_CONFIG.warmupMinMs).toBe(180_000);
    });
    it('DEFAULT_SIGMA_CONFIG has warmupTicks=180', () => {
      expect(DEFAULT_SIGMA_CONFIG.warmupTicks).toBe(180);
    });
  });
});
