import { describe, it, expect } from 'vitest';
import {
  computeRSIFromCandles,
  computeMACDFromCandles,
  computeStochasticFromCandles,
  computeEMA,
  computeATRFromCandles,
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
    // period=3, input=[1,2,3,4]: SMA([1,2,3])=2, then EMA for values[3]=4: 4*0.5+2*0.5=3
    // Result is trimmed: result[0]=seed(2), result[1]=EMA(3). Length = 4-3+1 = 2.
    const result = computeEMA([1, 2, 3, 4], 3);
    expect(result).not.toBeNull();
    expect(result!).toHaveLength(2);
    expect(result![0]).toBeCloseTo(2, 5); // seed at index 0
    expect(result![1]).toBeCloseTo(3, 5); // 4 * 0.5 + 2 * 0.5
  });
});

// ---------------------------------------------------------------------------
// ATR (Average True Range)
// ---------------------------------------------------------------------------
describe('computeATRFromCandles', () => {
  it('returns null when insufficient data (< period + 1 candles)', () => {
    const candles = closesToCandles([100, 101, 102]);
    expect(computeATRFromCandles(candles, 14)).toBeNull();
  });

  it('computes ATR for flat candles (high=low=close → TR=0)', () => {
    const candles = closesToCandles(Array.from({ length: 20 }, () => 100));
    const result = computeATRFromCandles(candles, 14);
    expect(result).not.toBeNull();
    expect(result!.atr).toBe(0);
    expect(result!.atrPct).toBe(0);
  });

  it('computes ATR with distinct high/low values', () => {
    const candles: OHLCVCandle[] = Array.from({ length: 20 }, (_, i) => ({
      openTime: i * 60_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
    }));
    const result = computeATRFromCandles(candles, 14);
    expect(result).not.toBeNull();
    expect(result!.atr).toBeCloseTo(2, 5);
    expect(result!.atrPct).toBeCloseTo(2, 5); // 2/100 * 100 = 2%
  });

  it('computes atrPct relative to last close', () => {
    const candles: OHLCVCandle[] = Array.from({ length: 20 }, (_, i) => ({
      openTime: i * 60_000,
      open: 50,
      high: 50.5,
      low: 49.5,
      close: 50,
      volume: 1,
    }));
    const result = computeATRFromCandles(candles, 14);
    expect(result).not.toBeNull();
    expect(result!.atr).toBeCloseTo(1, 5);
    expect(result!.atrPct).toBeCloseTo(2, 5); // 1/50 * 100 = 2%
  });

  it('includes gap contribution in true range', () => {
    const candles: OHLCVCandle[] = [
      { openTime: 0, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { openTime: 60_000, open: 105, high: 106, low: 104, close: 105, volume: 1 },
    ];
    for (let i = 2; i < 20; i++) {
      candles.push({ openTime: i * 60_000, open: 105, high: 106, low: 104, close: 105, volume: 1 });
    }
    const result = computeATRFromCandles(candles, 5);
    expect(result).not.toBeNull();
    // Last 5 TRs are all max(106-104, |106-105|, |104-105|) = 2
    expect(result!.atr).toBeCloseTo(2, 5);
  });

  it('returns null when last close is 0', () => {
    const candles: OHLCVCandle[] = Array.from({ length: 20 }, (_, i) => ({
      openTime: i * 60_000, open: 0, high: 0, low: 0, close: 0, volume: 1,
    }));
    expect(computeATRFromCandles(candles, 14)).toBeNull();
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
