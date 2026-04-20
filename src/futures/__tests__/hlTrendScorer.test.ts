import { describe, it, expect } from 'vitest';
import { scoreHlTrend } from '../hlTrendScorer.js';
import type { OHLCVCandle } from '../../arb/candleAggregator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a run of trending candles suitable for fully loading all 6 voters.
 * Each bar moves by `pctPerBar` from the previous close.
 * Volume is constant at 2 000 for bullish series and 500 for bearish — both
 * are constant per-direction (not per-bar); OBV and CMF receive the bias from
 * volume being elevated relative to counter-trend scenarios, not within a series.
 */
function makeTrendingCandles(
  count: number,
  pctPerBar: number,
  startPrice = 80_000,
): OHLCVCandle[] {
  const candles: OHLCVCandle[] = [];
  let price = startPrice;
  const bullish = pctPerBar >= 0;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price * (1 + pctPerBar / 100);
    const high = Math.max(open, close) * 1.0005;
    const low = Math.min(open, close) * 0.9995;
    const volume = bullish ? 2_000 : 500;
    candles.push({ openTime: i * 60_000, open, high, low, close, volume });
    price = close;
  }
  return candles;
}

/**
 * Build candles that alternate ±0.15% bars to produce a choppy, low-ADX
 * environment (ADX ≈ 3-4 with these parameters).
 *
 * Uses asymmetric high/low per direction so that both +DM and -DM have
 * non-zero contributions from each bar transition, keeping DX (and therefore
 * ADX) low. If high were computed as max(open,close)*k for a constant k,
 * the open of each down bar would equal the close of the prior up bar, making
 * their highs identical and upMove always 0, which would force ADX=100.
 */
function makeChoppyCandles(count: number, startPrice = 80_000): OHLCVCandle[] {
  const candles: OHLCVCandle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const up = i % 2 === 0;
    const pct = up ? 0.15 : -0.15;
    const open = price;
    const close = price * (1 + pct / 100);
    const high = up ? close * 1.003 : open * 1.001;
    const low = up ? open * 0.999 : close * 0.997;
    candles.push({ openTime: i * 60_000, open, high, low, close, volume: 1_000 });
    price = close;
  }
  return candles;
}

// Minimum candle count to load all 6 voters:
//   MACD needs slowPeriod + signalPeriod = 26 + 9 = 35
//   ADX  needs 2 * 14 + 1 = 29
//   CMF  needs 20
//   EMA21 needs 21
// Use 60 for clear trend signal loading.
const FULL_CANDLES = 60;

// ---------------------------------------------------------------------------
// Full-trend scenarios (all 6 voters)
// ---------------------------------------------------------------------------

describe('scoreHlTrend — full bullish trend', () => {
  it('returns score=+6 on a sustained strong uptrend', () => {
    // 0.6% per bar over 60 bars: clear trend that loads all voters.
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    const result = scoreHlTrend(candles);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(6);
    expect(result!.voters.vwap).toBe('UP');
    expect(result!.voters.emaFastVsSlow).toBe('UP');
    expect(result!.voters.macdLine).toBe('UP');
    expect(result!.voters.obv).toBe('UP');
    expect(result!.voters.cmf).toBe('UP');
    expect(result!.voters.adxDI).toBe('UP');
  });

  it('reports a non-null ADX value in a strong trend', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    const result = scoreHlTrend(candles);
    expect(result!.adx).not.toBeNull();
    expect(result!.adx!).toBeGreaterThan(20);
  });
});

describe('scoreHlTrend — full bearish trend', () => {
  it('returns score=-6 on a sustained strong downtrend', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, -0.6);
    const result = scoreHlTrend(candles);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(-6);
    expect(result!.voters.vwap).toBe('DOWN');
    expect(result!.voters.emaFastVsSlow).toBe('DOWN');
    expect(result!.voters.macdLine).toBe('DOWN');
    expect(result!.voters.obv).toBe('DOWN');
    expect(result!.voters.cmf).toBe('DOWN');
    expect(result!.voters.adxDI).toBe('DOWN');
  });
});

// ---------------------------------------------------------------------------
// Partial-data scenarios (null-safety)
// ---------------------------------------------------------------------------

describe('scoreHlTrend — insufficient candles', () => {
  it('returns null for 0 candles', () => {
    expect(scoreHlTrend([])).toBeNull();
  });

  it('returns null for 1 candle', () => {
    const candles = makeTrendingCandles(1, 0.5);
    expect(scoreHlTrend(candles)).toBeNull();
  });

  it('returns a result with neutral-heavy voters for 5 candles (most indicators insufficient)', () => {
    // With 5 bars: only VWAP can vote; OBV needs ≥11 (lookback+1), EMA needs
    // ≥21, MACD needs ≥35, CMF needs ≥20, ADX needs ≥29 — all neutral.
    const candles = makeTrendingCandles(5, 0.6);
    const result = scoreHlTrend(candles);
    expect(result).not.toBeNull();
    // Most voters neutral; adx must be null.
    expect(result!.adx).toBeNull();
    expect(result!.voters.macdLine).toBe('neutral');
    expect(result!.voters.emaFastVsSlow).toBe('neutral');
    expect(result!.voters.cmf).toBe('neutral');
    expect(result!.voters.adxDI).toBe('neutral');
    expect(result!.voters.obv).toBe('neutral');
    // The score is bounded by the voters that could actually compute.
    expect(Math.abs(result!.score)).toBeLessThanOrEqual(6);
  });

  it('never throws regardless of candle count', () => {
    for (let n = 0; n <= 40; n++) {
      const candles = makeTrendingCandles(n, 0.5);
      expect(() => scoreHlTrend(candles)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// ADX minimum for DI vote
// ---------------------------------------------------------------------------

describe('scoreHlTrend — adxDI suppression in choppy market', () => {
  it('returns adxDI=neutral and ADX < 20 for a balanced alternating range', () => {
    // makeChoppyCandles uses asymmetric high/low per bar direction so that both
    // +DM and -DM have non-zero contributions, keeping DX ≈ 0 and ADX ≈ 3-4.
    const candles = makeChoppyCandles(60);
    const result = scoreHlTrend(candles);
    expect(result).not.toBeNull();
    expect(result!.adx).not.toBeNull();
    expect(result!.adx!).toBeLessThan(20);
    expect(result!.voters.adxDI).toBe('neutral');
  });
});

// ---------------------------------------------------------------------------
// Score sign matches direction
// ---------------------------------------------------------------------------

describe('scoreHlTrend — score signs', () => {
  it('returns positive score for a bullish scenario with enough candles', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.4);
    const result = scoreHlTrend(candles);
    expect(result!.score).toBeGreaterThan(0);
  });

  it('returns negative score for a bearish scenario with enough candles', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, -0.4);
    const result = scoreHlTrend(candles);
    expect(result!.score).toBeLessThan(0);
  });

  it('score = upVotes - downVotes', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    const result = scoreHlTrend(candles)!;
    const upCount = Object.values(result.voters).filter((v) => v === 'UP').length;
    const downCount = Object.values(result.voters).filter((v) => v === 'DOWN').length;
    expect(result.score).toBe(upCount - downCount);
  });
});

// ---------------------------------------------------------------------------
// Funding-contra voter (issue #265 Sub-PR 1)
// ---------------------------------------------------------------------------

describe('scoreHlTrend — funding contra voter', () => {
  it('excludes the funding voter entirely when opts.fundingApr is omitted', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    const result = scoreHlTrend(candles);
    expect(result).not.toBeNull();
    expect(result!.voters.fundingContra).toBeUndefined();
    expect(result!.voterCount).toBe(6);
  });

  it('excludes the funding voter when opts.fundingApr is null', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    const result = scoreHlTrend(candles, { fundingApr: null });
    expect(result!.voters.fundingContra).toBeUndefined();
    expect(result!.voterCount).toBe(6);
  });

  it('casts DOWN when funding APR exceeds positive threshold (crowded longs)', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    // 120% APR > default 100% threshold → DOWN (contra the long crowd).
    const result = scoreHlTrend(candles, { fundingApr: 120 });
    expect(result!.voters.fundingContra).toBe('DOWN');
    expect(result!.voterCount).toBe(7);
    // Bullish trend score should be 6 - 1 = 5 after contra DOWN.
    expect(result!.score).toBe(5);
  });

  it('casts UP when funding APR is below negative threshold (crowded shorts)', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, -0.6);
    // -120% APR < -100% default threshold → UP (contra the short crowd).
    const result = scoreHlTrend(candles, { fundingApr: -120 });
    expect(result!.voters.fundingContra).toBe('UP');
    expect(result!.voterCount).toBe(7);
    // Bearish trend was -6, contra UP lifts to -5.
    expect(result!.score).toBe(-5);
  });

  it('casts neutral when funding APR sits inside the symmetric band', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    const result = scoreHlTrend(candles, { fundingApr: 25 });
    expect(result!.voters.fundingContra).toBe('neutral');
    expect(result!.voterCount).toBe(7);
    // Neutral funding vote does not shift the bullish score.
    expect(result!.score).toBe(6);
  });

  it('honours a caller-supplied fundingAprThreshold', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    // 60% APR is above the 50% caller threshold but below the 100% default.
    const tight = scoreHlTrend(candles, { fundingApr: 60, fundingAprThreshold: 50 });
    expect(tight!.voters.fundingContra).toBe('DOWN');
    const loose = scoreHlTrend(candles, { fundingApr: 60, fundingAprThreshold: 200 });
    expect(loose!.voters.fundingContra).toBe('neutral');
  });

  it('treats APR exactly equal to the threshold as neutral (strict > / <)', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    const positive = scoreHlTrend(candles, { fundingApr: 100 });
    expect(positive!.voters.fundingContra).toBe('neutral');
    const negative = scoreHlTrend(candles, { fundingApr: -100 });
    expect(negative!.voters.fundingContra).toBe('neutral');
  });

  it('voterCount is 7 with funding active and 8 with both HL-native voters active', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    const r7 = scoreHlTrend(candles, { fundingApr: 50 })!;
    expect(r7.voterCount).toBe(7);
    const r8 = scoreHlTrend(candles, { fundingApr: 50, oiPctChange: 8, pricePctChange: 1 })!;
    expect(r8.voterCount).toBe(8);
  });

  it('excludes the voter when fundingApr is NaN or Infinity (non-finite)', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    // NaN: comparisons always return false → would fall through to neutral
    // and incorrectly bump voterCount to 7. Guard must exclude the voter.
    const nan = scoreHlTrend(candles, { fundingApr: Number.NaN });
    expect(nan!.voters.fundingContra).toBeUndefined();
    expect(nan!.voterCount).toBe(6);
    // Infinity: would always vote DOWN (> threshold). Guard must exclude.
    const pos = scoreHlTrend(candles, { fundingApr: Number.POSITIVE_INFINITY });
    expect(pos!.voters.fundingContra).toBeUndefined();
    expect(pos!.voterCount).toBe(6);
    const neg = scoreHlTrend(candles, { fundingApr: Number.NEGATIVE_INFINITY });
    expect(neg!.voters.fundingContra).toBeUndefined();
    expect(neg!.voterCount).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// OI divergence voter (issue #265 Sub-PR 2)
// ---------------------------------------------------------------------------

describe('scoreHlTrend — OI divergence voter', () => {
  it('excludes the voter when both oiPctChange and pricePctChange are omitted', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    const result = scoreHlTrend(candles);
    expect(result!.voters.oiDivergence).toBeUndefined();
    expect(result!.voterCount).toBe(6);
  });

  it('excludes the voter when oiPctChange is null', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    const result = scoreHlTrend(candles, { oiPctChange: null, pricePctChange: 2 });
    expect(result!.voters.oiDivergence).toBeUndefined();
    expect(result!.voterCount).toBe(6);
  });

  it('excludes the voter when pricePctChange is null', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    const result = scoreHlTrend(candles, { oiPctChange: 8, pricePctChange: null });
    expect(result!.voters.oiDivergence).toBeUndefined();
    expect(result!.voterCount).toBe(6);
  });

  it('excludes the voter when oiPctChange is NaN or Infinity', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    expect(scoreHlTrend(candles, { oiPctChange: NaN, pricePctChange: 2 })!.voters.oiDivergence).toBeUndefined();
    expect(scoreHlTrend(candles, { oiPctChange: Infinity, pricePctChange: 2 })!.voters.oiDivergence).toBeUndefined();
  });

  it('votes neutral when |oiPctChange| is below threshold (default 5%)', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    const result = scoreHlTrend(candles, { oiPctChange: 3, pricePctChange: 2 });
    expect(result!.voters.oiDivergence).toBe('neutral');
    expect(result!.voterCount).toBe(7);
  });

  it('votes neutral when |oiPctChange| equals threshold exactly (strict >=)', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    const result = scoreHlTrend(candles, { oiPctChange: 5, pricePctChange: 2 });
    // 5 >= 5 → should vote (UP in this case)
    expect(result!.voters.oiDivergence).toBe('UP');
  });

  it('votes UP when OI expanding + price rising (trend confirmation — longs adding)', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    const result = scoreHlTrend(candles, { oiPctChange: 8, pricePctChange: 2 });
    expect(result!.voters.oiDivergence).toBe('UP');
    expect(result!.voterCount).toBe(7);
  });

  it('votes DOWN when OI expanding + price falling (trend confirmation — shorts adding)', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, -0.6);
    const result = scoreHlTrend(candles, { oiPctChange: 8, pricePctChange: -2 });
    expect(result!.voters.oiDivergence).toBe('DOWN');
  });

  it('votes DOWN when OI contracting + price rising (short covering = fake breakout)', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    const result = scoreHlTrend(candles, { oiPctChange: -7, pricePctChange: 2 });
    expect(result!.voters.oiDivergence).toBe('DOWN');
  });

  it('votes UP when OI contracting + price falling (long liquidation = forced selling)', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, -0.6);
    const result = scoreHlTrend(candles, { oiPctChange: -7, pricePctChange: -2 });
    expect(result!.voters.oiDivergence).toBe('UP');
  });

  it('votes neutral when price is flat (pricePctChange=0) regardless of OI move', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    const pos = scoreHlTrend(candles, { oiPctChange: 10, pricePctChange: 0 });
    expect(pos!.voters.oiDivergence).toBe('neutral');
    const neg = scoreHlTrend(candles, { oiPctChange: -10, pricePctChange: 0 });
    expect(neg!.voters.oiDivergence).toBe('neutral');
  });

  it('honours a caller-supplied oiDivergenceThreshold', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    // 3% OI is below default 5% but above caller threshold of 2%.
    const tight = scoreHlTrend(candles, { oiPctChange: 3, pricePctChange: 2, oiDivergenceThreshold: 2 });
    expect(tight!.voters.oiDivergence).toBe('UP');
    const loose = scoreHlTrend(candles, { oiPctChange: 3, pricePctChange: 2, oiDivergenceThreshold: 10 });
    expect(loose!.voters.oiDivergence).toBe('neutral');
  });

  it('score = upVotes - downVotes still holds with 8 voters', () => {
    const candles = makeTrendingCandles(FULL_CANDLES, 0.6);
    // Both HL-native voters active.
    const result = scoreHlTrend(candles, {
      fundingApr: 50,          // neutral (within 100% band)
      oiPctChange: 8,           // UP (OI expanding + price rising)
      pricePctChange: 2,
    })!;
    const upCount = Object.values(result.voters).filter((v) => v === 'UP').length;
    const downCount = Object.values(result.voters).filter((v) => v === 'DOWN').length;
    expect(result.score).toBe(upCount - downCount);
    expect(result.voterCount).toBe(8);
  });
});
