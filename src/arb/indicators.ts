/**
 * Technical Indicators — Phase 9
 *
 * RSI, MACD, and Stochastic Oscillator computed from OHLCV candles.
 * All functions return null when insufficient data is available.
 */

import type { Redis } from 'ioredis';
import { buildCandles } from './candleAggregator.js';
import { loadConfig } from '../shared/config.js';

/**
 * Compute RSI using Wilder smoothing.
 * Returns null if fewer than (period + 1) candles available.
 *
 * @param symbol - Binance symbol (e.g. 'btcusdt')
 * @param redis - Redis client
 * @param period - RSI period (default from config, typically 14)
 * @returns RSI value (0-100) or null if insufficient data
 */
export async function computeRSI(
  symbol: string,
  redis: Redis,
  period?: number,
): Promise<number | null> {
  const cfg = loadConfig();
  const rsiPeriod = period ?? cfg.RSI_PERIOD;

  const candles = await buildCandles(symbol, redis);

  // Need at least (period + 1) candles to compute first RSI
  if (candles.length < rsiPeriod + 1) {
    return null;
  }

  const closes = candles.map(c => c.close);

  // Compute price changes
  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i]! - closes[i - 1]!);
  }

  // Split into gains and losses
  const gains = changes.map(c => (c > 0 ? c : 0));
  const losses = changes.map(c => (c < 0 ? -c : 0));

  // Initial average gain/loss (SMA of first `period` values)
  let avgGain = gains.slice(0, rsiPeriod).reduce((sum, g) => sum + g, 0) / rsiPeriod;
  let avgLoss = losses.slice(0, rsiPeriod).reduce((sum, l) => sum + l, 0) / rsiPeriod;

  // Apply Wilder smoothing for remaining values
  for (let i = rsiPeriod; i < gains.length; i++) {
    avgGain = (avgGain * (rsiPeriod - 1) + gains[i]!) / rsiPeriod;
    avgLoss = (avgLoss * (rsiPeriod - 1) + losses[i]!) / rsiPeriod;
  }

  // Calculate RSI with edge case handling
  if (avgLoss === 0 && avgGain === 0) {
    return 50;  // Flat market → neutral RSI
  }
  if (avgLoss === 0) {
    return 100;  // Pure gains → RSI = 100
  }
  if (avgGain === 0) {
    return 0;    // Pure losses → RSI = 0
  }

  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  // Guard against NaN/Infinity from numerical errors
  if (!isFinite(rsi)) {
    return 50;  // Fallback to neutral
  }

  return rsi;
}

/**
 * Compute MACD (line, signal, histogram).
 * Uses EMA for smoothing.
 * Returns null if insufficient candles.
 *
 * @param symbol - Binance symbol
 * @param redis - Redis client
 * @param fastPeriod - Fast EMA period (default from config, typically 12)
 * @param slowPeriod - Slow EMA period (default from config, typically 26)
 * @param signalPeriod - Signal line EMA period (default from config, typically 9)
 * @returns { macdLine, signalLine, histogram } or null
 */
export async function computeMACD(
  symbol: string,
  redis: Redis,
  fastPeriod?: number,
  slowPeriod?: number,
  signalPeriod?: number,
): Promise<{ macdLine: number; signalLine: number; histogram: number } | null> {
  const cfg = loadConfig();
  const fast = fastPeriod ?? cfg.MACD_FAST;
  const slow = slowPeriod ?? cfg.MACD_SLOW;
  const signal = signalPeriod ?? cfg.MACD_SIGNAL;

  const candles = await buildCandles(symbol, redis);

  // Need at least slow + signal candles for full MACD
  if (candles.length < slow + signal) {
    return null;
  }

  const closes = candles.map(c => c.close);

  // Compute EMA
  const emaFast = computeEMA(closes, fast);
  const emaSlow = computeEMA(closes, slow);

  if (emaFast === null || emaSlow === null) {
    return null;
  }

  const macdLine = emaFast - emaSlow;

  // Compute MACD line series for signal EMA
  const macdSeries: number[] = [];
  for (let i = slow - 1; i < closes.length; i++) {
    const fastVal = computeEMAAtIndex(closes, fast, i);
    const slowVal = computeEMAAtIndex(closes, slow, i);
    if (fastVal !== null && slowVal !== null) {
      macdSeries.push(fastVal - slowVal);
    }
  }

  if (macdSeries.length < signal) {
    return null;
  }

  const signalLine = computeEMA(macdSeries, signal);

  if (signalLine === null) {
    return null;
  }

  const histogram = macdLine - signalLine;

  // Guard against NaN/Infinity
  if (!isFinite(macdLine) || !isFinite(signalLine) || !isFinite(histogram)) {
    return null;
  }

  return { macdLine, signalLine, histogram };
}

/**
 * Compute Stochastic Oscillator (%K and %D).
 * %K = (close - lowestLow) / (highestHigh - lowestLow) * 100
 * %D = SMA of last dPeriod %K values
 * Returns null if insufficient candles.
 *
 * @param symbol - Binance symbol
 * @param redis - Redis client
 * @param kPeriod - %K period (default from config, typically 14)
 * @param dPeriod - %D SMA period (default from config, typically 3)
 * @returns { k: number, d: number } or null
 */
export async function computeStochastic(
  symbol: string,
  redis: Redis,
  kPeriod?: number,
  dPeriod?: number,
): Promise<{ k: number; d: number } | null> {
  const cfg = loadConfig();
  const k = kPeriod ?? cfg.STOCHASTIC_K_PERIOD;
  const d = dPeriod ?? cfg.STOCHASTIC_D_PERIOD;

  const candles = await buildCandles(symbol, redis);

  // Need at least k + d - 1 candles to compute %D
  if (candles.length < k + d - 1) {
    return null;
  }

  // Compute %K for each candle (starting at index k-1)
  const kValues: number[] = [];

  for (let i = k - 1; i < candles.length; i++) {
    const window = candles.slice(i - k + 1, i + 1);
    const high = Math.max(...window.map(c => c.high));
    const low = Math.min(...window.map(c => c.low));
    const close = candles[i]!.close;

    if (high === low) {
      // Avoid division by zero — set %K to 50 (neutral)
      kValues.push(50);
    } else {
      const kValue = ((close - low) / (high - low)) * 100;
      kValues.push(kValue);
    }
  }

  if (kValues.length < d) {
    return null;
  }

  // Latest %K
  const latestK = kValues[kValues.length - 1]!;

  // %D = SMA of last d %K values
  const dWindow = kValues.slice(-d);
  const latestD = dWindow.reduce((sum, val) => sum + val, 0) / d;

  // Guard against NaN/Infinity
  if (!isFinite(latestK) || !isFinite(latestD)) {
    return null;
  }

  return { k: latestK, d: latestD };
}

// ────────────────────────────────────────────────────────────────────────────
// Helper functions
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute EMA for a price series.
 * Returns the latest EMA value or null if insufficient data.
 */
function computeEMA(prices: number[], period: number): number | null {
  if (prices.length < period) {
    return null;
  }

  // Initial SMA
  const sma = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;
  let ema = sma;

  const k = 2 / (period + 1);

  // Apply EMA formula for remaining values
  for (let i = period; i < prices.length; i++) {
    ema = prices[i]! * k + ema * (1 - k);
  }

  return ema;
}

/**
 * Compute EMA value at a specific index in the price series.
 * Used for building MACD line series.
 */
function computeEMAAtIndex(prices: number[], period: number, index: number): number | null {
  if (index < period - 1) {
    return null;
  }

  const slice = prices.slice(0, index + 1);
  return computeEMA(slice, period);
}
