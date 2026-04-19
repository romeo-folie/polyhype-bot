import type { OHLCVCandle } from '../arb/candleAggregator.js';
import {
  computeVWAP,
  computeEMA,
  computeMACDFromCandles,
  computeOBVSlope,
  computeCMF,
  computeADX,
} from '../arb/indicators.js';

export type TrendVote = 'UP' | 'DOWN' | 'neutral';

export interface HlTrendVoters {
  vwap: TrendVote;
  emaFastVsSlow: TrendVote;
  macdLine: TrendVote;
  obv: TrendVote;
  cmf: TrendVote;
  /** Directional vote from +DI vs -DI. Suppressed (neutral) when ADX is too weak to be meaningful. */
  adxDI: TrendVote;
}

export interface HlTrendScore {
  /** Signed directional score: upVotes - downVotes. Range [-6, +6]. */
  score: number;
  /** Raw ADX value for the momentum-gate gate (independent of the adxDI direction vote). */
  adx: number | null;
  voters: HlTrendVoters;
}

// +DI/-DI divergence is noise when ADX is below this — suppress the vote.
const ADX_MIN_FOR_DI_VOTE = 20;

function signVote(value: number | null): TrendVote {
  if (value === null || !Number.isFinite(value)) return 'neutral';
  if (value > 0) return 'UP';
  if (value < 0) return 'DOWN';
  return 'neutral';
}

/**
 * Trend-only confluence scorer for Hyperliquid momentum entries.
 *
 * Evaluates six directional voters — all trend-following; no mean-reversion
 * indicators (no RSI, Stochastic, or Bollinger-Band-bounce voters). In a
 * sustained selloff all six should agree bearish; in a sustained rally all
 * six should agree bullish.
 *
 * Score = upVotes - downVotes (range [-6, +6]).
 * Null voters contribute 0 so partial-data candle arrays don't throw.
 *
 * Returns null only when the candle array is too short to compute anything
 * meaningful (< 2 bars). With 2–34 bars, at least VWAP + OBV will vote.
 */
export function scoreHlTrend(candles: OHLCVCandle[]): HlTrendScore | null {
  if (candles.length < 2) return null;

  const lastCandle = candles[candles.length - 1];
  if (!lastCandle) return null;
  const lastClose = lastCandle.close;

  // ── Voter 1: VWAP position ──────────────────────────────────────────────
  const vwap = computeVWAP(candles);
  let vwapVote: TrendVote = 'neutral';
  if (vwap !== null) {
    vwapVote = lastClose > vwap ? 'UP' : lastClose < vwap ? 'DOWN' : 'neutral';
  }

  // ── Voter 2: EMA fast (9) vs slow (21) cross ────────────────────────────
  const closes = candles.map((c) => c.close);
  const ema9 = computeEMA(closes, 9);
  const ema21 = computeEMA(closes, 21);
  let emaVote: TrendVote = 'neutral';
  if (ema9 && ema21 && ema9.length > 0 && ema21.length > 0) {
    const lastEma9 = ema9[ema9.length - 1];
    const lastEma21 = ema21[ema21.length - 1];
    if (lastEma9 !== undefined && lastEma21 !== undefined) {
      emaVote = lastEma9 > lastEma21 ? 'UP' : lastEma9 < lastEma21 ? 'DOWN' : 'neutral';
    }
  }

  // ── Voter 3: MACD line sign ─────────────────────────────────────────────
  // macdLine = EMA12 - EMA26. Positive = fast EMA above slow (bullish).
  // Negative = fast EMA below slow (bearish). We use the line, not the
  // histogram — the histogram is a derivative of the MACD line and turns
  // positive in steady-state downtrends as signal catches up to a
  // stabilized negative macdLine.
  const macdResult = computeMACDFromCandles(candles, 12, 26, 9);
  let macdVote: TrendVote = 'neutral';
  if (macdResult !== null) {
    macdVote = signVote(macdResult.macdLine);
  }

  // ── Voter 4: OBV slope ──────────────────────────────────────────────────
  const obvSlope = computeOBVSlope(candles);
  const obvVote = signVote(obvSlope);

  // ── Voter 5: Chaikin Money Flow ─────────────────────────────────────────
  const cmf = computeCMF(candles);
  const cmfVote = signVote(cmf);

  // ── Voter 6: ADX directional index (+DI vs -DI) ─────────────────────────
  // Suppressed when ADX is below ADX_MIN_FOR_DI_VOTE — +DI/-DI divergence is
  // unreliable in choppy / low-volatility regimes.
  const adxResult = computeADX(candles);
  let adxDIVote: TrendVote = 'neutral';
  let adxValue: number | null = null;
  if (adxResult !== null) {
    adxValue = adxResult.adx;
    if (adxResult.adx >= ADX_MIN_FOR_DI_VOTE) {
      adxDIVote =
        adxResult.plusDI > adxResult.minusDI
          ? 'UP'
          : adxResult.minusDI > adxResult.plusDI
            ? 'DOWN'
            : 'neutral';
    }
  }

  const voters: HlTrendVoters = {
    vwap: vwapVote,
    emaFastVsSlow: emaVote,
    macdLine: macdVote,
    obv: obvVote,
    cmf: cmfVote,
    adxDI: adxDIVote,
  };

  const upCount = Object.values(voters).filter((v) => v === 'UP').length;
  const downCount = Object.values(voters).filter((v) => v === 'DOWN').length;

  return { score: upCount - downCount, adx: adxValue, voters };
}
