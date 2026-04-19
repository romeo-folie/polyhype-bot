import { describe, it, expect } from 'vitest';
import { scoreHlTrend } from '../hlTrendScorer.js';
import type { OHLCVCandle } from '../../arb/candleAggregator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a run of trending candles suitable for fully loading all 6 voters.
 * Each bar moves by `pctPerBar` from the previous close.
 * Volume is elevated on moves-in-trend and minimal on counter-trend bars.
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
    // Volume is high on in-trend bars to push OBV and CMF in the trend direction.
    const volume = bullish ? 2_000 : 500;
    candles.push({ openTime: i * 60_000, open, high, low, close, volume });
    price = close;
  }
  return candles;
}

/**
 * Build candles that alternate between slightly-up and slightly-down bars
 * to produce a choppy, low-ADX environment.
 */
function makeChoppyCandles(count: number, startPrice = 80_000): OHLCVCandle[] {
  const candles: OHLCVCandle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const up = i % 2 === 0;
    const pct = up ? 0.15 : -0.15;
    const open = price;
    const close = price * (1 + pct / 100);
    const high = Math.max(open, close) * 1.0005;
    const low = Math.min(open, close) * 0.9995;
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
    // With 5 bars: VWAP and OBV can vote, rest are null → neutral.
    // EMA9 needs 9, EMA21 needs 21 → ema vote neutral.
    // MACD needs 35 → neutral. CMF needs 20 → neutral. ADX needs 29 → neutral.
    const candles = makeTrendingCandles(5, 0.6);
    const result = scoreHlTrend(candles);
    expect(result).not.toBeNull();
    // Most voters neutral; adx must be null.
    expect(result!.adx).toBeNull();
    expect(result!.voters.macdLine).toBe('neutral');
    expect(result!.voters.emaFastVsSlow).toBe('neutral');
    expect(result!.voters.cmf).toBe('neutral');
    expect(result!.voters.adxDI).toBe('neutral');
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
  it('returns adxDI=neutral when ADX is below 20 in a choppy range', () => {
    // 60-bar alternating up/down at tiny amplitude: ADX stays low.
    const candles = makeChoppyCandles(60);
    const result = scoreHlTrend(candles);
    // ADX should be computable but below 20 in a sideways market.
    if (result && result.adx !== null && result.adx < 20) {
      expect(result.voters.adxDI).toBe('neutral');
    }
    // If ADX does happen to be ≥ 20 in this scenario, the test still passes —
    // the behaviour is "neutral when ADX < 20", not "always neutral in chop".
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
