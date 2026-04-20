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
  /**
   * HL-native funding-rate contra voter (issue #265 Sub-PR 1).
   * Only present when scoreHlTrend is called with `opts.fundingApr` set to a
   * finite number (both `undefined` and `null` exclude the voter entirely).
   * Extreme positive APR (crowded longs) → DOWN; extreme negative APR
   * (crowded shorts) → UP; within the symmetric threshold band → neutral.
   */
  fundingContra?: TrendVote;
  /**
   * HL-native OI divergence voter (issue #265 Sub-PR 2).
   * Only present when scoreHlTrend is called with both `opts.oiPctChange` and
   * `opts.pricePctChange` set to finite numbers. Interprets whether open
   * interest expansion/contraction confirms or contradicts the price move:
   * - OI expanding + price rising → UP (real trend, longs adding)
   * - OI expanding + price falling → DOWN (real trend, shorts adding)
   * - OI contracting + price rising → DOWN (fake breakout — short covering only)
   * - OI contracting + price falling → UP (fake breakdown — forced long liq)
   * - |OI change| below threshold → neutral
   */
  oiDivergence?: TrendVote;
}

export interface HlTrendScoreOpts {
  /**
   * Annualized funding-rate APR as a percentage (e.g. 120 = 120% APR). When
   * omitted or null the funding contra voter is excluded from the score
   * entirely (voter count stays at 6).
   */
  fundingApr?: number | null;
  /**
   * Symmetric APR threshold for the funding contra voter. An APR above this
   * triggers DOWN; below negative this triggers UP. Defaults to 100 (i.e.
   * 100% annualized).
   */
  fundingAprThreshold?: number;
  /**
   * OI percent change vs baseline (e.g. 7.5 = +7.5%). Both oiPctChange and
   * pricePctChange must be finite to activate the voter; either being null /
   * undefined / non-finite leaves voterCount at its previous value.
   */
  oiPctChange?: number | null;
  /** Price percent change vs the same OI baseline window. */
  pricePctChange?: number | null;
  /**
   * Absolute OI % threshold. If |oiPctChange| is below this the voter is
   * neutral regardless of price direction. Defaults to 5 (5%).
   */
  oiDivergenceThreshold?: number;
}

export interface HlTrendScore {
  /** Signed directional score: upVotes - downVotes. Range: [-6,+6] base, [-7,+7] with funding voter, [-8,+8] with both HL-native voters active. */
  score: number;
  /** Raw ADX value for the momentum-gate (independent of the adxDI direction vote). */
  adx: number | null;
  voters: HlTrendVoters;
  /** Number of active voters contributing to the score (6–8 depending on which optional HL-native voters are active). */
  voterCount: number;
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
 * Score = upVotes - downVotes. The range scales with the number of active
 * voters: [-6, +6] base, [-7, +7] with the funding-contra voter active,
 * [-8, +8] with both HL-native voters active (funding + OI divergence).
 * Null voters contribute 0 so partial-data candle arrays don't throw.
 *
 * Returns null only when the candle array is too short to compute anything
 * meaningful (< 2 bars). With 2+ bars the scorer returns a result, but
 * individual indicators remain neutral until they have enough data:
 * OBV needs ≥ lookback+1 candles (11 with the default lookback of 10),
 * VWAP returns null if total volume is 0, EMA21 needs ≥ 21, CMF ≥ 20,
 * ADX ≥ 29, MACD ≥ 35.
 */
export function scoreHlTrend(
  candles: OHLCVCandle[],
  opts: HlTrendScoreOpts = {},
): HlTrendScore | null {
  if (candles.length < 2) return null;

  const lastClose = candles[candles.length - 1]!.close;

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

  // ── Voter 7 (optional): HL funding-rate contra (issue #265 Sub-PR 1) ────
  // Only active when a funding APR is supplied. Adds a DOWN vote when funding
  // is extremely positive (crowded longs paying a premium → mean-revert bias)
  // and an UP vote when funding is extremely negative (crowded shorts).
  let fundingVote: TrendVote | undefined;
  if (opts.fundingApr !== undefined && opts.fundingApr !== null
      && Number.isFinite(opts.fundingApr)) {
    const threshold = opts.fundingAprThreshold ?? 100;
    if (opts.fundingApr > threshold) fundingVote = 'DOWN';
    else if (opts.fundingApr < -threshold) fundingVote = 'UP';
    else fundingVote = 'neutral';
  }

  // ── Voter 8 (optional): HL OI divergence (issue #265 Sub-PR 2) ──────────
  // Interprets whether OI expansion/contraction confirms or contradicts the
  // price move over the same baseline window. Requires both oiPctChange and
  // pricePctChange to be finite numbers — otherwise the voter is absent.
  let oiDivergenceVote: TrendVote | undefined;
  if (
    opts.oiPctChange !== undefined && opts.oiPctChange !== null && Number.isFinite(opts.oiPctChange) &&
    opts.pricePctChange !== undefined && opts.pricePctChange !== null && Number.isFinite(opts.pricePctChange)
  ) {
    const oiThreshold = opts.oiDivergenceThreshold ?? 5;
    if (Math.abs(opts.oiPctChange) >= oiThreshold) {
      const oiExpanding = opts.oiPctChange > 0;
      const priceRising = opts.pricePctChange > 0;
      const priceFalling = opts.pricePctChange < 0;
      if (oiExpanding && priceRising) oiDivergenceVote = 'UP';
      else if (oiExpanding && priceFalling) oiDivergenceVote = 'DOWN';
      else if (!oiExpanding && priceRising) oiDivergenceVote = 'DOWN'; // short covering = fake breakout
      else if (!oiExpanding && priceFalling) oiDivergenceVote = 'UP';  // long liq = forced selling
      else oiDivergenceVote = 'neutral'; // price flat
    } else {
      oiDivergenceVote = 'neutral';
    }
  }

  const voters: HlTrendVoters = {
    vwap: vwapVote,
    emaFastVsSlow: emaVote,
    macdLine: macdVote,
    obv: obvVote,
    cmf: cmfVote,
    adxDI: adxDIVote,
    ...(fundingVote !== undefined ? { fundingContra: fundingVote } : {}),
    ...(oiDivergenceVote !== undefined ? { oiDivergence: oiDivergenceVote } : {}),
  };

  const voterValues = Object.values(voters);
  const upCount = voterValues.filter((v) => v === 'UP').length;
  const downCount = voterValues.filter((v) => v === 'DOWN').length;

  return {
    score: upCount - downCount,
    adx: adxValue,
    voters,
    voterCount: voterValues.length,
  };
}
