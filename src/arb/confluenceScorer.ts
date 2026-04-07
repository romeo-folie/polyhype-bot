/**
 * Confluence scorer.
 *
 * Aggregates RSI, MACD, Stochastic, and (Phase 2) OBV/MFI/VWAP/CMF signals
 * into a directional score. Score is `max(up,down) - min(up,down)`, with a
 * theoretical maximum equal to the number of voters (3 pre-Phase-2, 7 after).
 *
 * Vote rules:
 *   RSI:        < 30 → oversold (+1 UP), > 70 → overbought (+1 DOWN)
 *   MACD:       hist > 0 AND macdLine > signalLine → bullish_cross (+1 UP)
 *               hist < 0 AND macdLine < signalLine → bearish_cross (+1 DOWN)
 *   Stochastic: %K > %D AND both < 20 → oversold_cross (+1 UP)
 *               %K < %D AND both > 80 → overbought_cross (+1 DOWN)
 *   OBV:        slope > eps → rising (+1 UP), slope < -eps → falling (+1 DOWN)
 *   MFI:        < oversold → +1 UP, > overbought → +1 DOWN
 *   VWAP:       close > vwap*(1+band) → +1 UP, close < vwap*(1-band) → +1 DOWN
 *   CMF:        > +threshold → +1 UP, < -threshold → +1 DOWN
 *
 * Volume info (current vs SMA20) is also returned for the optional volume-spike gate.
 */

import type { Redis } from 'ioredis';
import { buildCandles } from './candleAggregator.js';
import {
  computeRSIFromCandles,
  computeMACDFromCandles,
  computeStochasticFromCandles,
  computeOBVSlope,
  computeMFI,
  computeVWAP,
  computeCMF,
  computeVolumeSMA,
} from './indicators.js';
import { loadConfig } from '../shared/config.js';

export interface ConfluenceScore {
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  score: number;
  signals: {
    rsi?: 'oversold' | 'overbought' | 'neutral';
    macd?: 'bullish_cross' | 'bearish_cross' | 'neutral';
    stochastic?: 'oversold_cross' | 'overbought_cross' | 'neutral';
    obv?: 'rising' | 'falling' | 'neutral';
    mfi?: 'oversold' | 'overbought' | 'neutral';
    vwap?: 'above' | 'below' | 'neutral';
    cmf?: 'positive' | 'negative' | 'neutral';
  };
  /** Volume snapshot used for the optional volume-spike gate. */
  volume?: {
    current: number | null;
    sma: number | null;
    ratio: number | null; // current / sma
  };
}

export async function scoreConfluence(symbol: string, redis: Redis): Promise<ConfluenceScore> {
  const cfg = loadConfig();

  const candles = await buildCandles(symbol, redis);

  const rsi = computeRSIFromCandles(candles, cfg.RSI_PERIOD);
  const macd = computeMACDFromCandles(candles, cfg.MACD_FAST, cfg.MACD_SLOW, cfg.MACD_SIGNAL);
  const stoch = computeStochasticFromCandles(
    candles,
    cfg.STOCHASTIC_K_PERIOD,
    cfg.STOCHASTIC_D_PERIOD,
  );

  const obvSlope = computeOBVSlope(candles, cfg.OBV_SLOPE_LOOKBACK);
  const mfi = computeMFI(candles, cfg.MFI_PERIOD);
  const vwap = computeVWAP(candles, cfg.VWAP_LOOKBACK_MIN);
  const cmf = computeCMF(candles, cfg.CMF_PERIOD);
  const lastClose = candles.length > 0 ? candles[candles.length - 1]!.close : null;
  const lastVol = candles.length > 0 ? candles[candles.length - 1]!.volume : null;
  const volSma = computeVolumeSMA(candles, cfg.VOLUME_SPIKE_PERIOD);

  return scoreFromValues(
    rsi,
    macd,
    stoch,
    {
      obvSlope,
      mfi,
      vwap,
      cmf,
      lastClose,
      cfg: {
        OBV_SLOPE_EPS: cfg.OBV_SLOPE_EPS,
        MFI_OVERSOLD: cfg.MFI_OVERSOLD,
        MFI_OVERBOUGHT: cfg.MFI_OVERBOUGHT,
        VWAP_BAND: cfg.VWAP_BAND,
        CMF_THRESHOLD: cfg.CMF_THRESHOLD,
      },
    },
    { current: lastVol, sma: volSma },
  );
}

interface VolumeVoteInput {
  obvSlope: number | null;
  mfi: number | null;
  vwap: number | null;
  cmf: number | null;
  lastClose: number | null;
  cfg: {
    OBV_SLOPE_EPS: number;
    MFI_OVERSOLD: number;
    MFI_OVERBOUGHT: number;
    VWAP_BAND: number;
    CMF_THRESHOLD: number;
  };
}

/** Exported for unit testing with pre-computed values. */
export function scoreFromValues(
  rsi: number | null,
  macd: { macdLine: number; signalLine: number; histogram: number } | null,
  stoch: { k: number; d: number } | null,
  volumeVotes?: VolumeVoteInput,
  volumeSnapshot?: { current: number | null; sma: number | null },
): ConfluenceScore {
  let upCount = 0;
  let downCount = 0;
  const signals: ConfluenceScore['signals'] = {};

  if (rsi !== null) {
    if (rsi < 30) { signals.rsi = 'oversold'; upCount++; }
    else if (rsi > 70) { signals.rsi = 'overbought'; downCount++; }
    else signals.rsi = 'neutral';
  }

  if (macd !== null) {
    if (macd.histogram > 0 && macd.macdLine > macd.signalLine) {
      signals.macd = 'bullish_cross'; upCount++;
    } else if (macd.histogram < 0 && macd.macdLine < macd.signalLine) {
      signals.macd = 'bearish_cross'; downCount++;
    } else {
      signals.macd = 'neutral';
    }
  }

  if (stoch !== null) {
    if (stoch.k > stoch.d && stoch.k < 20 && stoch.d < 20) {
      signals.stochastic = 'oversold_cross'; upCount++;
    } else if (stoch.k < stoch.d && stoch.k > 80 && stoch.d > 80) {
      signals.stochastic = 'overbought_cross'; downCount++;
    } else {
      signals.stochastic = 'neutral';
    }
  }

  if (volumeVotes) {
    const v = volumeVotes;
    // OBV slope
    if (v.obvSlope !== null) {
      if (v.obvSlope > v.cfg.OBV_SLOPE_EPS) { signals.obv = 'rising'; upCount++; }
      else if (v.obvSlope < -v.cfg.OBV_SLOPE_EPS) { signals.obv = 'falling'; downCount++; }
      else signals.obv = 'neutral';
    }
    // MFI
    if (v.mfi !== null) {
      if (v.mfi < v.cfg.MFI_OVERSOLD) { signals.mfi = 'oversold'; upCount++; }
      else if (v.mfi > v.cfg.MFI_OVERBOUGHT) { signals.mfi = 'overbought'; downCount++; }
      else signals.mfi = 'neutral';
    }
    // VWAP
    if (v.vwap !== null && v.lastClose !== null && v.vwap > 0) {
      const upBand = v.vwap * (1 + v.cfg.VWAP_BAND);
      const downBand = v.vwap * (1 - v.cfg.VWAP_BAND);
      if (v.lastClose > upBand) { signals.vwap = 'above'; upCount++; }
      else if (v.lastClose < downBand) { signals.vwap = 'below'; downCount++; }
      else signals.vwap = 'neutral';
    }
    // CMF
    if (v.cmf !== null) {
      if (v.cmf > v.cfg.CMF_THRESHOLD) { signals.cmf = 'positive'; upCount++; }
      else if (v.cmf < -v.cfg.CMF_THRESHOLD) { signals.cmf = 'negative'; downCount++; }
      else signals.cmf = 'neutral';
    }
  }

  let direction: 'UP' | 'DOWN' | 'NEUTRAL';
  if (upCount > downCount) direction = 'UP';
  else if (downCount > upCount) direction = 'DOWN';
  else direction = 'NEUTRAL';

  const score = Math.max(upCount, downCount) - Math.min(upCount, downCount);

  const result: ConfluenceScore = { direction, score, signals };
  if (volumeSnapshot) {
    const ratio =
      volumeSnapshot.current !== null && volumeSnapshot.sma !== null && volumeSnapshot.sma > 0
        ? volumeSnapshot.current / volumeSnapshot.sma
        : null;
    result.volume = {
      current: volumeSnapshot.current,
      sma: volumeSnapshot.sma,
      ratio,
    };
  }
  return result;
}
