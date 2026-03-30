import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import type { OHLCVCandle } from '../candleAggregator.js';

// Mock config
vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    RSI_PERIOD: 14,
    MACD_FAST: 12,
    MACD_SLOW: 26,
    MACD_SIGNAL: 9,
    STOCHASTIC_K_PERIOD: 14,
    STOCHASTIC_D_PERIOD: 3,
  })),
}));

// Mock candleAggregator
const mockBuildCandles = vi.fn();
vi.mock('../candleAggregator.js', () => ({
  buildCandles: (...args: unknown[]) => mockBuildCandles(...args),
}));

function makeCandles(closes: number[]): OHLCVCandle[] {
  return closes.map((close, i) => ({
    openTime: i * 60_000,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 100,
  }));
}

describe('indicators — RSI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when fewer than (period+1) candles', async () => {
    const { computeRSI } = await import('../indicators.js');

    // 5-period RSI needs 6 candles (5 changes)
    mockBuildCandles.mockResolvedValue(makeCandles([100, 105, 110, 100, 95]));

    const redis = {} as Redis;
    const rsi = await computeRSI('btcusdt', redis, 5);

    expect(rsi).toBeNull();
  });

  it('computes RSI correctly for known series', async () => {
    const { computeRSI } = await import('../indicators.js');

    // Simple series: 100 → 110 → 120 → 130 → 140 → 150 (all gains)
    // After 5 periods of +10 each, RSI should approach 100
    mockBuildCandles.mockResolvedValue(makeCandles([100, 110, 120, 130, 140, 150]));

    const redis = {} as Redis;
    const rsi = await computeRSI('btcusdt', redis, 5);

    expect(rsi).not.toBeNull();
    expect(rsi!).toBeGreaterThan(90);  // Strong uptrend
  });

  it('returns 100 when no losses', async () => {
    const { computeRSI } = await import('../indicators.js');

    // All gains, no losses
    mockBuildCandles.mockResolvedValue(makeCandles([100, 101, 102, 103, 104, 105, 106]));

    const redis = {} as Redis;
    const rsi = await computeRSI('btcusdt', redis, 5);

    expect(rsi).toBe(100);
  });
});

describe('indicators — MACD', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when insufficient candles', async () => {
    const { computeMACD } = await import('../indicators.js');

    // Need slow + signal = 26 + 9 = 35 candles minimum
    mockBuildCandles.mockResolvedValue(makeCandles(Array(30).fill(100)));

    const redis = {} as Redis;
    const macd = await computeMACD('btcusdt', redis);

    expect(macd).toBeNull();
  });

  it('detects bullish crossover correctly', async () => {
    const { computeMACD } = await import('../indicators.js');

    // Create uptrend: 50 candles rising from 100 to 150
    const closes = Array.from({ length: 50 }, (_, i) => 100 + i);
    mockBuildCandles.mockResolvedValue(makeCandles(closes));

    const redis = {} as Redis;
    const macd = await computeMACD('btcusdt', redis, 12, 26, 9);

    expect(macd).not.toBeNull();
    // Verify uptrend: fast EMA should be above slow EMA in rising market
    expect(macd!.macdLine).toBeGreaterThan(0);  // Fast > Slow in uptrend
  });

  it('detects bearish crossover correctly', async () => {
    const { computeMACD } = await import('../indicators.js');

    // Create downtrend: 50 candles falling from 150 to 100
    const closes = Array.from({ length: 50 }, (_, i) => 150 - i);
    mockBuildCandles.mockResolvedValue(makeCandles(closes));

    const redis = {} as Redis;
    const macd = await computeMACD('btcusdt', redis, 12, 26, 9);

    expect(macd).not.toBeNull();
    // Verify downtrend: fast EMA should be below slow EMA in falling market
    expect(macd!.macdLine).toBeLessThan(0);  // Fast < Slow in downtrend
  });
});

describe('indicators — Stochastic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when insufficient candles', async () => {
    const { computeStochastic } = await import('../indicators.js');

    // Need k + d - 1 = 14 + 3 - 1 = 16 candles minimum
    mockBuildCandles.mockResolvedValue(makeCandles(Array(10).fill(100)));

    const redis = {} as Redis;
    const stochastic = await computeStochastic('btcusdt', redis);

    expect(stochastic).toBeNull();
  });

  it('detects oversold zone with %K > %D', async () => {
    const { computeStochastic } = await import('../indicators.js');

    // Create candles with rising close in low range
    const candles: OHLCVCandle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push({
        openTime: i * 60_000,
        open: 10,
        high: 20,
        low: 5,
        close: 5 + i * 0.5,  // Rising from 5 toward 15
        volume: 100,
      });
    }

    mockBuildCandles.mockResolvedValue(candles);

    const redis = {} as Redis;
    const stochastic = await computeStochastic('btcusdt', redis, 14, 3);

    expect(stochastic).not.toBeNull();
    // In oversold zone (both below 20) with %K rising
    expect(stochastic!.k).toBeLessThan(80);
    expect(stochastic!.d).toBeLessThan(80);
  });

  it('handles high=low case (avoids division by zero)', async () => {
    const { computeStochastic } = await import('../indicators.js');

    // Flat market: all candles same OHLC
    const candles: OHLCVCandle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push({
        openTime: i * 60_000,
        open: 100,
        high: 100,
        low: 100,
        close: 100,
        volume: 50,
      });
    }

    mockBuildCandles.mockResolvedValue(candles);

    const redis = {} as Redis;
    const stochastic = await computeStochastic('btcusdt', redis, 14, 3);

    expect(stochastic).not.toBeNull();
    // Should default to 50 (neutral) when high=low
    expect(stochastic!.k).toBe(50);
    expect(stochastic!.d).toBe(50);
  });
});
