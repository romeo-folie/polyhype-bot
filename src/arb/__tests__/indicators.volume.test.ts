import { describe, it, expect } from 'vitest';
import {
  computeOBV,
  computeOBVSlope,
  computeMFI,
  computeVWAP,
  computeCMF,
  computeVolumeSMA,
} from '../indicators.js';
import type { OHLCVCandle } from '../candleAggregator.js';

function mkCandle(close: number, vol: number, hi?: number, lo?: number): OHLCVCandle {
  return {
    openTime: 0,
    open: close,
    high: hi ?? close + 0.5,
    low: lo ?? close - 0.5,
    close,
    volume: vol,
  };
}

describe('Phase 2 volume indicators', () => {
  describe('computeOBV', () => {
    it('accumulates signed volume on up/down bars', () => {
      const candles = [mkCandle(100, 10), mkCandle(101, 5), mkCandle(100, 3), mkCandle(100, 2)];
      const obv = computeOBV(candles);
      expect(obv).toEqual([0, 5, 2, 2]);
    });
  });

  describe('computeOBVSlope', () => {
    it('returns positive on rising OBV', () => {
      const candles = [
        mkCandle(100, 10), mkCandle(101, 10), mkCandle(102, 10), mkCandle(103, 10),
        mkCandle(104, 10), mkCandle(105, 10),
      ];
      const slope = computeOBVSlope(candles, 5);
      expect(slope).not.toBeNull();
      expect(slope!).toBeGreaterThan(0);
    });

    it('returns negative on falling OBV', () => {
      const candles = [
        mkCandle(105, 10), mkCandle(104, 10), mkCandle(103, 10), mkCandle(102, 10),
        mkCandle(101, 10), mkCandle(100, 10),
      ];
      const slope = computeOBVSlope(candles, 5);
      expect(slope).not.toBeNull();
      expect(slope!).toBeLessThan(0);
    });

    it('returns null if not enough data', () => {
      expect(computeOBVSlope([mkCandle(100, 10)], 10)).toBeNull();
    });
  });

  describe('computeMFI', () => {
    it('returns ~100 on monotonic uptrend with volume', () => {
      const candles: OHLCVCandle[] = [];
      for (let i = 0; i < 16; i++) candles.push(mkCandle(100 + i, 10));
      const mfi = computeMFI(candles, 14);
      expect(mfi).not.toBeNull();
      expect(mfi!).toBe(100);
    });

    it('returns null when a window bar has zero volume', () => {
      const candles: OHLCVCandle[] = [];
      for (let i = 0; i < 16; i++) candles.push(mkCandle(100 + i, i === 10 ? 0 : 10));
      expect(computeMFI(candles, 14)).toBeNull();
    });
  });

  describe('computeVWAP', () => {
    it('weighted average of typical price', () => {
      const c1 = mkCandle(100, 10, 101, 99); // tp 100, vol 10 → 1000
      const c2 = mkCandle(110, 30, 111, 109); // tp 110, vol 30 → 3300
      const vwap = computeVWAP([c1, c2], 60);
      // (1000 + 3300) / 40 = 107.5
      expect(vwap).toBeCloseTo(107.5, 4);
    });

    it('returns null on zero volume', () => {
      const c = mkCandle(100, 0);
      expect(computeVWAP([c], 60)).toBeNull();
    });
  });

  describe('computeCMF', () => {
    it('positive when closes near highs with volume', () => {
      const candles: OHLCVCandle[] = [];
      for (let i = 0; i < 20; i++) candles.push(mkCandle(101, 10, 101, 100)); // close at high
      const cmf = computeCMF(candles, 20);
      expect(cmf).not.toBeNull();
      expect(cmf!).toBeGreaterThan(0.5);
    });

    it('negative when closes near lows', () => {
      const candles: OHLCVCandle[] = [];
      for (let i = 0; i < 20; i++) candles.push(mkCandle(100, 10, 101, 100)); // close at low
      const cmf = computeCMF(candles, 20);
      expect(cmf).not.toBeNull();
      expect(cmf!).toBeLessThan(-0.5);
    });
  });

  describe('computeVolumeSMA', () => {
    it('arithmetic mean of last N volumes', () => {
      const candles = [mkCandle(100, 10), mkCandle(100, 20), mkCandle(100, 30)];
      expect(computeVolumeSMA(candles, 3)).toBe(20);
    });

    it('returns null on insufficient data', () => {
      expect(computeVolumeSMA([mkCandle(100, 10)], 5)).toBeNull();
    });
  });
});
