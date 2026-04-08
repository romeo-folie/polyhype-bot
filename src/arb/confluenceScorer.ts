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
  computeADX,
  computeChoppinessIndex,
  computeBollingerBands,
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
    clob_flow_imbalance?: 'buy_heavy' | 'sell_heavy' | 'neutral';
  };
  /** Volume snapshot used for the optional volume-spike gate. */
  volume?: {
    current: number | null;
    sma: number | null;
    ratio: number | null; // current / sma
  };
  /** Phase 3 — Regime data (ADX, Choppiness, Bollinger). All optional. */
  regime?: {
    adx: number | null;
    plusDI: number | null;
    minusDI: number | null;
    choppiness: number | null;
    bbBandwidth: number | null;
    bbRegime: 'calm' | 'normal' | 'explosive' | null;
  };
}

export async function scoreConfluence(
  symbol: string,
  redis: Redis,
  opts?: { marketId?: string },
): Promise<ConfluenceScore> {
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
  // Volume spike must compare *closed* bars only. The kline feed upserts the
  // in-progress minute in place, so `candles[last]` is typically a partial bar
  // whose volume is proportional to how far into the minute we are. Fall back
  // to the final bar only if no closed bar exists (shouldn't happen in prod).
  const closedCandles = candles.filter((c) => c.closed !== false);
  const lastClosed =
    closedCandles.length > 0
      ? closedCandles[closedCandles.length - 1]!
      : (candles[candles.length - 1] ?? null);
  const lastVol = lastClosed?.volume ?? null;
  const volSma = computeVolumeSMA(closedCandles, cfg.VOLUME_SPIKE_PERIOD);

  const adxResult = computeADX(candles, cfg.ADX_PERIOD);
  const choppiness = computeChoppinessIndex(candles, cfg.CHOPPINESS_PERIOD);
  const bb = computeBollingerBands(candles, cfg.BB_PERIOD, cfg.BB_SIGMA);

  let bbRegime: 'calm' | 'normal' | 'explosive' | null = null;
  if (bb !== null) {
    if (bb.bandwidth < cfg.BB_CALM_BANDWIDTH) bbRegime = 'calm';
    else if (bb.bandwidth > cfg.BB_EXPLOSIVE_BANDWIDTH) bbRegime = 'explosive';
    else bbRegime = 'normal';
  }

  let clobFlowRatio: number | null = null;
  if (opts?.marketId) {
    try {
      clobFlowRatio = await computeClobFlowImbalance(
        opts.marketId,
        redis,
        cfg.CLOB_FLOW_IMBALANCE_WINDOW_S,
      );
    } catch {
      clobFlowRatio = null;
    }
  }

  const result = scoreFromValues(
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
    { ratio: clobFlowRatio, threshold: cfg.CLOB_FLOW_GATE_THRESHOLD },
  );

  result.regime = {
    adx: adxResult?.adx ?? null,
    plusDI: adxResult?.plusDI ?? null,
    minusDI: adxResult?.minusDI ?? null,
    choppiness,
    bbBandwidth: bb?.bandwidth ?? null,
    bbRegime,
  };

  return result;
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

export interface ClobFlowVoteInput {
  /** Buy / sell notional ratio (buy / sell). null when no data. */
  ratio: number | null;
  /** Threshold above which buy_heavy fires; below 1/threshold fires sell_heavy. */
  threshold: number;
}

/**
 * Compute buy/sell notional imbalance from a tape window stored in
 * `clob:tape:{marketId}`. Returns null when there is no usable data.
 * Used by `scoreFromValues` and the live confluence pipeline.
 */
export async function computeClobFlowImbalance(
  marketId: string,
  redis: Redis,
  windowSec: number,
): Promise<number | null> {
  const now = Date.now();
  const min = now - windowSec * 1000;
  const entries = await redis.zrangebyscore(`clob:tape:${marketId}`, min, now);
  if (!entries || entries.length === 0) return null;
  let buy = 0;
  let sell = 0;
  for (const raw of entries) {
    try {
      const t = JSON.parse(raw) as { price?: number; size?: number; side?: string };
      const notional = (t.price ?? 0) * (t.size ?? 0);
      if (!Number.isFinite(notional) || notional <= 0) continue;
      if (t.side === 'BUY') buy += notional;
      else if (t.side === 'SELL') sell += notional;
    } catch {
      // ignore malformed
    }
  }
  if (buy === 0 && sell === 0) return null;
  if (sell === 0) return Number.POSITIVE_INFINITY;
  return buy / sell;
}

/** Exported for unit testing with pre-computed values. */
export function scoreFromValues(
  rsi: number | null,
  macd: { macdLine: number; signalLine: number; histogram: number } | null,
  stoch: { k: number; d: number } | null,
  volumeVotes?: VolumeVoteInput,
  volumeSnapshot?: { current: number | null; sma: number | null },
  clobFlow?: ClobFlowVoteInput,
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

  if (clobFlow && clobFlow.ratio !== null && clobFlow.threshold > 1) {
    const r = clobFlow.ratio;
    const inv = 1 / clobFlow.threshold;
    if (r >= clobFlow.threshold) { signals.clob_flow_imbalance = 'buy_heavy'; upCount++; }
    else if (r <= inv) { signals.clob_flow_imbalance = 'sell_heavy'; downCount++; }
    else signals.clob_flow_imbalance = 'neutral';
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
