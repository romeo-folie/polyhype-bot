/**
 * Confluence Scorer — Phase 9
 *
 * Aggregates RSI, MACD, and Stochastic signals into a single confluence score
 * with direction (UP/DOWN/NEUTRAL) for BTC crypto-arb gating.
 */

import type { Redis } from 'ioredis';
import { computeRSI, computeMACD, computeStochastic } from './indicators.js';

export interface ConfluenceScore {
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  score: number;        // 0–3: count of indicators agreeing on direction
  signals: {
    rsi?: 'oversold' | 'overbought' | 'neutral';
    macd?: 'bullish_cross' | 'bearish_cross' | 'neutral';
    stochastic?: 'oversold_cross' | 'overbought_cross' | 'neutral';
  };
}

/**
 * Score confluence across RSI, MACD, and Stochastic indicators.
 *
 * Signal rules:
 * - RSI: < 30 → oversold (+1 UP), > 70 → overbought (+1 DOWN), else neutral
 * - MACD: histogram > 0 AND macdLine > signalLine → bullish_cross (+1 UP),
 *         histogram < 0 AND macdLine < signalLine → bearish_cross (+1 DOWN), else neutral
 * - Stochastic: %K > %D AND both below 20 → oversold_cross (+1 UP),
 *               %K < %D AND both above 80 → overbought_cross (+1 DOWN), else neutral
 *
 * @param symbol - Binance symbol (e.g. 'btcusdt')
 * @param redis - Redis client
 * @returns ConfluenceScore with direction, score (0-3), and individual signals
 */
export async function scoreConfluence(
  symbol: string,
  redis: Redis,
): Promise<ConfluenceScore> {
  // Compute all indicators in parallel
  const [rsi, macd, stochastic] = await Promise.all([
    computeRSI(symbol, redis),
    computeMACD(symbol, redis),
    computeStochastic(symbol, redis),
  ]);

  const signals: ConfluenceScore['signals'] = {};
  let upVotes = 0;
  let downVotes = 0;

  // ── RSI signal ──
  if (rsi !== null) {
    if (rsi < 30) {
      signals.rsi = 'oversold';
      upVotes++;
    } else if (rsi > 70) {
      signals.rsi = 'overbought';
      downVotes++;
    } else {
      signals.rsi = 'neutral';
    }
  }

  // ── MACD signal ──
  if (macd !== null) {
    if (macd.histogram > 0 && macd.macdLine > macd.signalLine) {
      signals.macd = 'bullish_cross';
      upVotes++;
    } else if (macd.histogram < 0 && macd.macdLine < macd.signalLine) {
      signals.macd = 'bearish_cross';
      downVotes++;
    } else {
      signals.macd = 'neutral';
    }
  }

  // ── Stochastic signal ──
  if (stochastic !== null) {
    if (stochastic.k > stochastic.d && stochastic.k < 20 && stochastic.d < 20) {
      signals.stochastic = 'oversold_cross';
      upVotes++;
    } else if (stochastic.k < stochastic.d && stochastic.k > 80 && stochastic.d > 80) {
      signals.stochastic = 'overbought_cross';
      downVotes++;
    } else {
      signals.stochastic = 'neutral';
    }
  }

  // Determine direction and score
  let direction: 'UP' | 'DOWN' | 'NEUTRAL';
  let score: number;

  if (upVotes > downVotes) {
    direction = 'UP';
    score = upVotes;
  } else if (downVotes > upVotes) {
    direction = 'DOWN';
    score = downVotes;
  } else {
    // Tie or all neutral
    direction = 'NEUTRAL';
    score = upVotes;  // could be 0 or a tie value
  }

  return { direction, score, signals };
}
