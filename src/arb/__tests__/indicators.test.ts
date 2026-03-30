import { describe, it, expect } from 'vitest';
import {
  computeRSIFromCandles,
  computeMACDFromCandles,
  computeStochasticFromCandles,
  computeEMA,
} from '../indicators.js';
import type { OHLCVCandle } from '../candleAggregator.js';

/** Build minimal candles from an array of close prices (high=low=open=close for simplicity). */
function closesToCandles(closes: number[]): OHLCVCandle[] {
  return closes.map((c, i) => ({
    openTime: i * 60_000,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1,
  }));
}

/** Build candles with distinct high/low for Stochastic tests. */
function makeCandle(close: number, high: number, low: number, i: number): OHLCVCandle {
  return { openTime: i * 60_000, open: close, high, low, close, volume: 1 };
}

// ---------------------------------------------------------------------------
// EMA
// ---------------------------------------------------------------------------
describe('computeEMA', () => {
  it('returns null when fewer than period values', () => {
    expect(computeEMA([1, 2], 3)).toBeNull();
  });

  it('seeds correctly with SMA and applies multiplier', () => {
    // period=3: SMA([1,2,3])=2, then EMA[3] = 4 * 0.5 + 2 * 0.5 = 3
    const result = computeEMA([1, 2, 3, 4], 3);
    expect(result).not.toBeNull();
    expect(result![2]).toBeCloseTo(2, 5); // seed
    expect(result![3]).toBeCloseTo(3, 5); // 4 * 0.5 + 2 * 0.5
  });
});

// ---------------------------------------------------------------------------
// RSI
// ---------------------------------------------------------------------------
describe('computeRSIFromCandles', () => {
  it('returns null when insufficient data (< period + 1 candles)', () => {
    const candles = closesToCandles([100, 101, 102]);
    expect(computeRSIFromCandles(candles, 14)).toBeNull();
  });

  it('returns 100 when there are no losses', () => {
    // Uniformly rising prices — avgLoss = 0
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const candles = closesToCandles(closes);
    expect(computeRSIFromCandles(candles, 14)).toBe(100);
  });

  it('returns 0 when there are no gains', () => {
    // Uniformly falling prices — avgGain = 0 → RS = 0 → RSI = 0
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
    const candles = closesToCandles(closes);
    expect(computeRSIFromCandles(candles, 14)).toBe(0);
  });

  it('returns a value in [0, 100] for mixed price series', () => {
    const closes = [44, 46, 45, 47, 46, 48, 47, 46, 44, 45, 47, 48, 46, 45, 47];
    const candles = closesToCandles(closes);
    const rsi = computeRSIFromCandles(candles, 14);
    expect(rsi).not.toBeNull();
    expect(rsi!).toBeGreaterThanOrEqual(0);
    expect(rsi!).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// MACD
// ---------------------------------------------------------------------------
describe('computeMACDFromCandles', () => {
  it('returns null when insufficient data', () => {
    const candles = closesToCandles([1, 2, 3, 4, 5]);
    // Need at least slowPeriod + signalPeriod = 26 + 9 = 35 candles
    expect(computeMACDFromCandles(candles, 12, 26, 9)).toBeNull();
  });

  it('returns macdLine, signalLine, histogram for sufficient data', () => {
    // 40 candles — enough for 26 slow + 9 signal
    const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i * 0.3) * 10);
    const candles = closesToCandles(closes);
    const result = computeMACDFromCandles(candles, 12, 26, 9);
    expect(result).not.toBeNull();
    expect(typeof result!.macdLine).toBe('number');
    expect(typeof result!.signalLine).toBe('number');
    // histogram = macdLine - signalLine
    expect(result!.histogram).toBeCloseTo(result!.macdLine - result!.signalLine, 8);
  });

  it('detects bullish scenario: rising prices produce positive histogram', () => {
    // Steadily rising prices → fast EMA > slow EMA → positive macdLine
    const closes = Array.from({ length: 40 }, (_, i) => 50 + i * 2);
    const candles = closesToCandles(closes);
    const result = computeMACDFromCandles(candles, 12, 26, 9);
    expect(result).not.toBeNull();
    expect(result!.macdLine).toBeGreaterThan(0);
  });

  it('detects bearish scenario: falling prices produce negative histogram', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 130 - i * 2);
    const candles = closesToCandles(closes);
    const result = computeMACDFromCandles(candles, 12, 26, 9);
    expect(result).not.toBeNull();
    expect(result!.macdLine).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// Stochastic
// ---------------------------------------------------------------------------
describe('computeStochasticFromCandles', () => {
  it('returns null when insufficient data', () => {
    const candles = [makeCandle(50, 60, 40, 0)];
    expect(computeStochasticFromCandles(candles, 14, 3)).toBeNull();
  });

  it('returns k=100 when close is at highest high across kPeriod', () => {
    // All candles same range [40, 60], last close = 60 = highestHigh → %K = 100
    const candles = Array.from({ length: 16 }, (_, i) => makeCandle(60, 60, 40, i));
    const result = computeStochasticFromCandles(candles, 14, 3);
    expect(result).not.toBeNull();
    expect(result!.k).toBeCloseTo(100, 3);
  });

  it('returns k=0 when close is at lowest low across kPeriod', () => {
    const candles = Array.from({ length: 16 }, (_, i) => makeCandle(40, 60, 40, i));
    const result = computeStochasticFromCandles(candles, 14, 3);
    expect(result).not.toBeNull();
    expect(result!.k).toBeCloseTo(0, 3);
  });

  it('returns k and d in [0, 100] for normal series', () => {
    const closes = [44, 46, 45, 47, 46, 48, 47, 46, 44, 45, 47, 48, 46, 45, 47, 49];
    const candles = closes.map((c, i) => makeCandle(c, c + 2, c - 2, i));
    const result = computeStochasticFromCandles(candles, 14, 3);
    expect(result).not.toBeNull();
    expect(result!.k).toBeGreaterThanOrEqual(0);
    expect(result!.k).toBeLessThanOrEqual(100);
    expect(result!.d).toBeGreaterThanOrEqual(0);
    expect(result!.d).toBeLessThanOrEqual(100);
  });

  it('handles flat range (highest == lowest) without NaN — returns 50', () => {
    const candles = Array.from({ length: 16 }, (_, i) => makeCandle(100, 100, 100, i));
    const result = computeStochasticFromCandles(candles, 14, 3);
    expect(result).not.toBeNull();
    expect(result!.k).toBe(50);
    expect(result!.d).toBe(50);
  });
});
