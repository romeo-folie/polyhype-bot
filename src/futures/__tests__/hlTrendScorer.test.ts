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
