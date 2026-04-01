/**
 * Confluence scorer.
 *
 * Aggregates RSI, MACD, and Stochastic signals into a directional score.
 * Score 0–3: net agreement (agreeing votes minus dissenting votes).
 * e.g., 2 UP + 1 DOWN → score 1; 2 UP + 0 DOWN → score 2; 3 UP → score 3.
 * Direction: UP (bullish) or DOWN (bearish) or NEUTRAL.
 *
 * Rules:
 *   RSI:        < 30 → oversold (+1 UP), > 70 → overbought (+1 DOWN)
 *   MACD:       histogram > 0 AND macdLine > signalLine → bullish_cross (+1 UP)
 *               histogram < 0 AND macdLine < signalLine → bearish_cross (+1 DOWN)
 *   Stochastic: %K > %D AND both below 20 → oversold_cross (+1 UP)
 *               %K < %D AND both above 80 → overbought_cross (+1 DOWN)
 */

import type { Redis } from 'ioredis';
import { buildCandles } from './candleAggregator.js';
import { computeRSIFromCandles, computeMACDFromCandles, computeStochasticFromCandles } from './indicators.js';
import { loadConfig } from '../shared/config.js';

export interface ConfluenceScore {
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  score: number; // 0 (no signal) to 3 (all 3 agree)
  signals: {
    rsi?: 'oversold' | 'overbought' | 'neutral';
    macd?: 'bullish_cross' | 'bearish_cross' | 'neutral';
    stochastic?: 'oversold_cross' | 'overbought_cross' | 'neutral';
  };
}

export async function scoreConfluence(symbol: string, redis: Redis): Promise<ConfluenceScore> {
  const cfg = loadConfig();

  // Build candles once for all three indicators (avoids triple Redis fetch)
  const candles = await buildCandles(symbol, redis);

  // Compute all three indicators from the same candle set
  const rsi = computeRSIFromCandles(candles, cfg.RSI_PERIOD);
  const macd = computeMACDFromCandles(candles, cfg.MACD_FAST, cfg.MACD_SLOW, cfg.MACD_SIGNAL);
  const stoch = computeStochasticFromCandles(candles, cfg.STOCHASTIC_K_PERIOD, cfg.STOCHASTIC_D_PERIOD);

  return scoreFromValues(rsi, macd, stoch);
}

/** Exported for unit testing with pre-computed values. */
export function scoreFromValues(
  rsi: number | null,
  macd: { macdLine: number; signalLine: number; histogram: number } | null,
  stoch: { k: number; d: number } | null,
): ConfluenceScore {
  let upCount = 0;
  let downCount = 0;

  const signals: ConfluenceScore['signals'] = {};

  // RSI signal
  if (rsi !== null) {
    if (rsi < 30) {
      signals.rsi = 'oversold';
      upCount++;
    } else if (rsi > 70) {
      signals.rsi = 'overbought';
      downCount++;
    } else {
      signals.rsi = 'neutral';
    }
  }

  // MACD signal
  if (macd !== null) {
    if (macd.histogram > 0 && macd.macdLine > macd.signalLine) {
      signals.macd = 'bullish_cross';
      upCount++;
    } else if (macd.histogram < 0 && macd.macdLine < macd.signalLine) {
      signals.macd = 'bearish_cross';
      downCount++;
    } else {
      signals.macd = 'neutral';
    }
  }

  // Stochastic signal
  if (stoch !== null) {
    if (stoch.k > stoch.d && stoch.k < 20 && stoch.d < 20) {
      signals.stochastic = 'oversold_cross';
      upCount++;
    } else if (stoch.k < stoch.d && stoch.k > 80 && stoch.d > 80) {
      signals.stochastic = 'overbought_cross';
      downCount++;
    } else {
      signals.stochastic = 'neutral';
    }
  }

  let direction: 'UP' | 'DOWN' | 'NEUTRAL';
  if (upCount > downCount) {
    direction = 'UP';
  } else if (downCount > upCount) {
    direction = 'DOWN';
  } else {
    direction = 'NEUTRAL';
  }

  // Net score: agreeing votes minus dissenting votes.
  // Distinguishes genuine consensus (2-0 → score 2) from mixed signals (2-1 → score 1).
  // A 2-1 split now has lower score than 2-0, matching the intent of CRYPTO_ARB_MIN_CONFLUENCE_SCORE.
  const score = Math.max(upCount, downCount) - Math.min(upCount, downCount);

  return { direction, score, signals };
}
