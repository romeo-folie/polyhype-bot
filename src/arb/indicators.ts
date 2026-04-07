/**
 * Technical indicators for the crypto-arb confluence engine.
 *
 * All indicators are computed from 1-minute OHLCV candles built from the
 * BinanceFeed tick series (spot:prices:<symbol> sorted set).
 *
 * Functions return null when insufficient data is available.
 */

import type { Redis } from 'ioredis';
import { buildCandles, type OHLCVCandle } from './candleAggregator.js';
import { loadConfig } from '../shared/config.js';

// ---------------------------------------------------------------------------
// EMA helper (used internally by MACD)
// ---------------------------------------------------------------------------

/**
 * Compute EMA for a series of values.
 * EMA[0] = SMA of first `period` values.
 * EMA[i] = value[i] * k + EMA[i-1] * (1 - k), k = 2 / (period + 1).
 * Returns null if fewer than `period` values are provided.
 */
export function computeEMA(values: number[], period: number): number[] | null {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  // Seed with SMA of first `period` values.
  let sum = 0;
  for (let i = 0; i < period; i++) {
    const val = values[i];
    if (val !== undefined) sum += val;
  }

  // Return only the valid portion (period-1 onwards) — avoids NaN holes in the return value.
  // ema[0] = SMA seed (aligns with values[period-1]).
  // Length = values.length - period + 1.
  const ema: number[] = [sum / period];
  for (let i = period; i < values.length; i++) {
    const val = values[i];
    const prevEma = ema[ema.length - 1];
    if (val !== undefined && prevEma !== undefined) {
      ema.push(val * k + prevEma * (1 - k));
    }
  }

  return ema;
}

// ---------------------------------------------------------------------------
// ATR (Average True Range)
// ---------------------------------------------------------------------------

export interface ATRResult {
  atr: number;     // absolute ATR value
  atrPct: number;  // ATR as percentage of current close
}

/**
 * Compute Average True Range from OHLCV candles.
 * TR = max(high - low, |high - prevClose|, |low - prevClose|), then SMA over `period`.
 * Returns null if insufficient data.
 */
export function computeATRFromCandles(candles: OHLCVCandle[], period: number): ATRResult | null {
  if (candles.length < period + 1) return null;

  const trValues: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    trValues.push(tr);
  }

  if (trValues.length < period) return null;

  // SMA of last `period` TR values
  const recentTR = trValues.slice(-period);
  const atr = recentTR.reduce((sum, v) => sum + v, 0) / period;

  const lastClose = candles[candles.length - 1]!.close;
  if (lastClose === 0) return null;

  return { atr, atrPct: (atr / lastClose) * 100 };
}

/**
 * Compute ATR from Redis candle data for a given symbol.
 */
export async function computeATR(
  symbol: string,
  redis: Redis,
  period?: number,
): Promise<ATRResult | null> {
  const cfg = loadConfig();
  const p = period ?? cfg.FUTURES_ATR_PERIOD;
  const candles = await buildCandles(symbol, redis);
  return computeATRFromCandles(candles, p);
}

// ---------------------------------------------------------------------------
// RSI (Wilder smoothing)
// ---------------------------------------------------------------------------

/**
 * Compute RSI using Wilder's smoothing method.
 * Returns the most recent RSI value (0–100), or null if insufficient data.
 */
export async function computeRSI(
  symbol: string,
  redis: Redis,
  period?: number,
): Promise<number | null> {
  const cfg = loadConfig();
  const p = period ?? cfg.RSI_PERIOD;
  const candles = await buildCandles(symbol, redis);
  return computeRSIFromCandles(candles, p);
}

/** Exported for unit testing without Redis. */
export function computeRSIFromCandles(candles: OHLCVCandle[], period: number): number | null {
  const closes = candles.map((c) => c.close);
  if (closes.length < period + 1) return null;

  // Initial average gain/loss over first `period` changes
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const curr = closes[i];
    const prev = closes[i - 1];
    if (curr !== undefined && prev !== undefined) {
      const change = curr - prev;
      if (change > 0) avgGain += change;
      else avgLoss += Math.abs(change);
    }
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder smoothing for remaining periods
  for (let i = period + 1; i < closes.length; i++) {
    const curr = closes[i];
    const prev = closes[i - 1];
    if (curr !== undefined && prev !== undefined) {
      const change = curr - prev;
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ---------------------------------------------------------------------------
// MACD
// ---------------------------------------------------------------------------

export interface MACDResult {
  macdLine: number;
  signalLine: number;
  histogram: number;
}

/**
 * Compute MACD (line, signal, histogram) from candle closes.
 * Returns the most recent values, or null if insufficient data.
 */
export async function computeMACD(
  symbol: string,
  redis: Redis,
  fastPeriod?: number,
  slowPeriod?: number,
  signalPeriod?: number,
): Promise<MACDResult | null> {
  const cfg = loadConfig();
  const fast = fastPeriod ?? cfg.MACD_FAST;
  const slow = slowPeriod ?? cfg.MACD_SLOW;
  const signal = signalPeriod ?? cfg.MACD_SIGNAL;
  const candles = await buildCandles(symbol, redis);
  return computeMACDFromCandles(candles, fast, slow, signal);
}

/** Exported for unit testing without Redis. */
export function computeMACDFromCandles(
  candles: OHLCVCandle[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): MACDResult | null {
  // fastPeriod must be strictly less than slowPeriod — the MACD line is meaningful only when
  // the fast EMA reacts quicker than the slow EMA. Misconfigured periods produce invalid output.
  if (fastPeriod >= slowPeriod) {
    return null; // invalid configuration — caller should swap periods
  }

  const closes = candles.map((c) => c.close);
  if (closes.length < slowPeriod + signalPeriod) return null;

  const fastEMA = computeEMA(closes, fastPeriod);
  const slowEMA = computeEMA(closes, slowPeriod);
  if (!fastEMA || !slowEMA) return null;

  // MACD line = fastEMA - slowEMA.
  // computeEMA now returns a trimmed array (length = closes.length - period + 1).
  // fastEMA[j] aligns with closes[fastPeriod-1+j]; slowEMA[j] aligns with closes[slowPeriod-1+j].
  // The MACD line is valid from closes[slowPeriod-1] onward — i.e., slowEMA indices 0..N-1
  // and fastEMA indices (slowPeriod-fastPeriod)..N-1 (fastEMA is longer than slowEMA).
  const macdLine: number[] = [];
  const fastOffset = slowPeriod - fastPeriod; // fastEMA index offset relative to slowEMA
  for (let j = 0; j < slowEMA.length; j++) {
    const fastVal = fastEMA[fastOffset + j];
    const slowVal = slowEMA[j];
    if (fastVal !== undefined && slowVal !== undefined) {
      macdLine.push(fastVal - slowVal);
    }
  }

  if (macdLine.length < signalPeriod) return null;

  const signalEMA = computeEMA(macdLine, signalPeriod);
  if (!signalEMA) return null;

  const lastMacd = macdLine[macdLine.length - 1];
  const lastSignal = signalEMA[signalEMA.length - 1];

  if (lastMacd === undefined || lastSignal === undefined) return null;

  return {
    macdLine: lastMacd,
    signalLine: lastSignal,
    histogram: lastMacd - lastSignal,
  };
}

// ---------------------------------------------------------------------------
// Stochastic Oscillator
// ---------------------------------------------------------------------------

export interface StochasticResult {
  k: number; // %K
  d: number; // %D (SMA of %K)
}

/**
 * Compute Stochastic Oscillator (%K and %D).
 * %K = (close - lowestLow) / (highestHigh - lowestLow) * 100
 * %D = SMA of last dPeriod %K values
 * Returns the most recent values, or null if insufficient data.
 */
export async function computeStochastic(
  symbol: string,
  redis: Redis,
  kPeriod?: number,
  dPeriod?: number,
): Promise<StochasticResult | null> {
  const cfg = loadConfig();
  const kP = kPeriod ?? cfg.STOCHASTIC_K_PERIOD;
  const dP = dPeriod ?? cfg.STOCHASTIC_D_PERIOD;
  const candles = await buildCandles(symbol, redis);
  return computeStochasticFromCandles(candles, kP, dP);
}

/** Exported for unit testing without Redis. */
export function computeStochasticFromCandles(
  candles: OHLCVCandle[],
  kPeriod: number,
  dPeriod: number,
): StochasticResult | null {
  if (candles.length < kPeriod + dPeriod - 1) return null;

  // Compute %K for each position from kPeriod onwards
  const kValues: number[] = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const window = candles.slice(i - kPeriod + 1, i + 1);
    const highestHigh = Math.max(...window.map((c) => c.high));
    const lowestLow = Math.min(...window.map((c) => c.low));
    const candle = candles[i];
    if (candle === undefined) continue;
    const close = candle.close;

    if (highestHigh === lowestLow) {
      kValues.push(50); // flat range — neutral
    } else {
      kValues.push(((close - lowestLow) / (highestHigh - lowestLow)) * 100);
    }
  }

  if (kValues.length < dPeriod) return null;

  // %D = SMA of last dPeriod %K values
  const lastK = kValues[kValues.length - 1];
  if (lastK === undefined) return null;
  const dWindow = kValues.slice(-dPeriod);
  const lastD = dWindow.reduce((sum, v) => sum + v, 0) / dPeriod;

  return { k: lastK, d: lastD };
}

// ---------------------------------------------------------------------------
// Phase 2 — Volume-aware indicators
// ---------------------------------------------------------------------------

/**
 * On-Balance Volume — running cumulative signed volume.
 * +volume on up bars, -volume on down bars, 0 on unchanged bars.
 */
export function computeOBV(candles: OHLCVCandle[]): number[] {
  const obv: number[] = [];
  let running = 0;
  for (let i = 0; i < candles.length; i++) {
    const curr = candles[i]!;
    if (i === 0) {
      obv.push(0);
      continue;
    }
    const prev = candles[i - 1]!;
    if (curr.close > prev.close) running += curr.volume;
    else if (curr.close < prev.close) running -= curr.volume;
    obv.push(running);
  }
  return obv;
}

/**
 * Slope of OBV over the last `lookback` bars (simple last - first delta).
 * Returns null if insufficient data.
 */
export function computeOBVSlope(candles: OHLCVCandle[], lookback = 10): number | null {
  if (candles.length < lookback + 1) return null;
  const obv = computeOBV(candles);
  const tail = obv.slice(-lookback - 1);
  const first = tail[0];
  const last = tail[tail.length - 1];
  if (first === undefined || last === undefined) return null;
  return last - first;
}

/**
 * Money Flow Index — volume-weighted RSI on typical price.
 * Returns null if any bar in the window has zero volume or insufficient data.
 */
export function computeMFI(candles: OHLCVCandle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const window = candles.slice(-(period + 1));
  let posFlow = 0;
  let negFlow = 0;
  for (let i = 1; i < window.length; i++) {
    const curr = window[i]!;
    const prev = window[i - 1]!;
    if (curr.volume <= 0) return null;
    const tpCurr = (curr.high + curr.low + curr.close) / 3;
    const tpPrev = (prev.high + prev.low + prev.close) / 3;
    const flow = tpCurr * curr.volume;
    if (tpCurr > tpPrev) posFlow += flow;
    else if (tpCurr < tpPrev) negFlow += flow;
  }
  if (posFlow + negFlow === 0) return 50;
  if (negFlow === 0) return 100;
  const ratio = posFlow / negFlow;
  return 100 - 100 / (1 + ratio);
}

/**
 * Volume-Weighted Average Price over the last `lookback` bars.
 * Returns null if zero total volume or insufficient data.
 */
export function computeVWAP(candles: OHLCVCandle[], lookback = 60): number | null {
  if (candles.length === 0) return null;
  const window = candles.slice(-lookback);
  let pvSum = 0;
  let vSum = 0;
  for (const c of window) {
    if (c.volume <= 0) continue;
    const tp = (c.high + c.low + c.close) / 3;
    pvSum += tp * c.volume;
    vSum += c.volume;
  }
  if (vSum === 0) return null;
  return pvSum / vSum;
}

/**
 * Chaikin Money Flow — Σ(MFV) / Σ(volume) over the period.
 * MFV = ((close - low) - (high - close)) / (high - low) × volume.
 * Returns null on insufficient data or zero volume.
 */
export function computeCMF(candles: OHLCVCandle[], period = 20): number | null {
  if (candles.length < period) return null;
  const window = candles.slice(-period);
  let mfvSum = 0;
  let vSum = 0;
  for (const c of window) {
    if (c.volume <= 0) continue;
    const range = c.high - c.low;
    const mfm = range === 0 ? 0 : ((c.close - c.low) - (c.high - c.close)) / range;
    mfvSum += mfm * c.volume;
    vSum += c.volume;
  }
  if (vSum === 0) return null;
  return mfvSum / vSum;
}

/**
 * Simple moving average of volume over the last `period` bars.
 * Returns null on insufficient data.
 */
export function computeVolumeSMA(candles: OHLCVCandle[], period = 20): number | null {
  if (candles.length < period) return null;
  const window = candles.slice(-period);
  let sum = 0;
  for (const c of window) sum += c.volume;
  return sum / period;
}
