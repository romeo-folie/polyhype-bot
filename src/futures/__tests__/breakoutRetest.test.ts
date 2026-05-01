import { describe, it, expect } from 'vitest';
import { detectBreakoutRetestHold } from '../breakoutRetest.js';
import type { OHLCVCandle } from '../../arb/candleAggregator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandle(openTime: number, open: number, high: number, low: number, close: number): OHLCVCandle {
  return { openTime, open, high, low, close, volume: 1_000 };
}

/**
 * Build a minimal valid LONG breakout-retest-hold sequence.
 *
 * Layout (oldest → newest):
 *   [0..11]  swing-high baseline bars (flat at basePrice, high = basePrice)
 *   [12]     breakout bar: close = basePrice * (1 + breakoutPct/100)
 *   [13]     retest bar:  low = basePrice * (1 + retestTolPct/100)   (within tol above level)
 *   [14]     hold bar:    close = basePrice * (1 + holdPct/100)      (above level)
 *
 * retestTolPct is a small positive offset so the retest low sits just above level
 * (within tolerance band), simulating a price dip that touches but holds the broken level.
 */
function buildLongPattern(
  basePrice = 100,
  breakoutPct = 1.0,
  retestTolPct = 0.1,
  holdPct = 0.8,
): OHLCVCandle[] {
  const candles: OHLCVCandle[] = [];
  // 12 baseline bars, all at basePrice
  for (let i = 0; i < 12; i++) {
    candles.push(makeCandle(i * 900_000, basePrice, basePrice, basePrice * 0.99, basePrice));
  }
  const level = basePrice; // max(high[0..11]) = basePrice
  const breakoutClose = level * (1 + breakoutPct / 100);
  candles.push(makeCandle(12 * 900_000, level, breakoutClose, level, breakoutClose)); // breakout
  const retestLow = level * (1 + retestTolPct / 100); // just above level, within tolerance band
  candles.push(makeCandle(13 * 900_000, breakoutClose, breakoutClose, retestLow, level * 1.005)); // retest
  const holdClose = level * (1 + holdPct / 100);
  candles.push(makeCandle(14 * 900_000, level * 1.005, holdClose, level * 1.003, holdClose)); // hold
  return candles;
}

/**
 * Mirror of buildLongPattern for SHORT.
 */
function buildShortPattern(
  basePrice = 100,
  breakdownPct = 1.0,
  retestRisePct = 0.1,
  holdPct = 0.8,
): OHLCVCandle[] {
  const candles: OHLCVCandle[] = [];
  for (let i = 0; i < 12; i++) {
    candles.push(makeCandle(i * 900_000, basePrice, basePrice * 1.01, basePrice, basePrice));
  }
  const level = basePrice; // min(low[0..11]) = basePrice
  const breakdownClose = level * (1 - breakdownPct / 100);
  candles.push(makeCandle(12 * 900_000, level, level, breakdownClose, breakdownClose));
  const retestHigh = level * (1 - retestRisePct / 100);
  candles.push(makeCandle(13 * 900_000, breakdownClose, retestHigh, breakdownClose, level * 0.995));
  const holdClose = level * (1 - holdPct / 100);
  candles.push(makeCandle(14 * 900_000, level * 0.995, level * 0.997, holdClose, holdClose));
  return candles;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectBreakoutRetestHold', () => {
  it('returns a match for a valid LONG pattern', () => {
    const candles = buildLongPattern(100, 1.0, 0.1, 0.8);
    const result = detectBreakoutRetestHold(candles, 'LONG', {
      lookbackBars: 12, freshBars: 6, retestPct: 0.3, retestAtrMult: 0.5, atr: null,
    });
    expect(result).not.toBeNull();
    expect(result!.level).toBeCloseTo(100, 5);
    expect(result!.breakoutBarOpenTime).toBe(12 * 900_000);
    expect(result!.retestBarOpenTime).toBe(13 * 900_000);
    expect(result!.holdBarOpenTime).toBe(14 * 900_000);
  });

  it('returns a match for a valid SHORT pattern', () => {
    const candles = buildShortPattern(100, 1.0, 0.1, 0.8);
    const result = detectBreakoutRetestHold(candles, 'SHORT', {
      lookbackBars: 12, freshBars: 6, retestPct: 0.3, retestAtrMult: 0.5, atr: null,
    });
    expect(result).not.toBeNull();
    expect(result!.level).toBeCloseTo(100, 5);
    expect(result!.breakoutBarOpenTime).toBe(12 * 900_000);
    expect(result!.retestBarOpenTime).toBe(13 * 900_000);
    expect(result!.holdBarOpenTime).toBe(14 * 900_000);
  });

  it('returns null when no breakout bar exists within freshBars', () => {
    // All baseline bars, current bar is just more baseline (no close above prior high)
    const candles: OHLCVCandle[] = [];
    for (let i = 0; i < 15; i++) {
      candles.push(makeCandle(i * 900_000, 100, 100, 99, 100));
    }
    const result = detectBreakoutRetestHold(candles, 'LONG', {
      lookbackBars: 12, freshBars: 6, retestPct: 0.3, retestAtrMult: 0.5, atr: null,
    });
    expect(result).toBeNull();
  });

  it('returns null when breakout exists but retest bar is missing', () => {
    const candles = buildLongPattern();
    // Remove the retest bar (index 13) — collapse to [baseline×12, breakout, hold]
    const withoutRetest = [...candles.slice(0, 13), candles[14]!];
    const result = detectBreakoutRetestHold(withoutRetest, 'LONG', {
      lookbackBars: 12, freshBars: 6, retestPct: 0.3, retestAtrMult: 0.5, atr: null,
    });
    // Only 2 bars after the breakout bar but one is the hold and no room for a separate retest
    expect(result).toBeNull();
  });

  it('returns null when retest exists but hold bar closes below the level', () => {
    const candles = buildLongPattern();
    // Replace hold bar with a bar that closes below the level (99)
    const badHold = makeCandle(14 * 900_000, 100.5, 100.8, 98.5, 99.0);
    const withBadHold = [...candles.slice(0, 14), badHold];
    const result = detectBreakoutRetestHold(withBadHold, 'LONG', {
      lookbackBars: 12, freshBars: 6, retestPct: 0.3, retestAtrMult: 0.5, atr: null,
    });
    expect(result).toBeNull();
  });

  it('returns null when breakout is older than freshBars', () => {
    // Pattern: 12 baseline + breakout + retest + 5 middle + hold = 20 bars.
    // Breakout bar is at index 12; with n=20 and freshBars=6, it sits at offset 6 — just
    // outside the scan window (offsets 0..5 → bIdx 17..12 checked, so bIdx=12 = offset 6 is missed).
    const basePrice = 100;
    const candles: OHLCVCandle[] = [];
    for (let i = 0; i < 12; i++) {
      candles.push(makeCandle(i * 900_000, basePrice, basePrice, basePrice * 0.99, basePrice));
    }
    const level = basePrice;
    // breakout bar (index 12)
    candles.push(makeCandle(12 * 900_000, level, level * 1.02, level, level * 1.02));
    // retest bar (index 13)
    candles.push(makeCandle(13 * 900_000, level * 1.02, level * 1.02, level * 1.001, level * 1.005));
    // 5 middle bars (indices 14-18): close/high below breakout close (102), so they don't create a new breakout
    for (let i = 14; i <= 18; i++) {
      candles.push(makeCandle(i * 900_000, level * 1.005, level * 1.007, level * 1.002, level * 1.005));
    }
    // hold bar (index 19, n=20)
    candles.push(makeCandle(19 * 900_000, level * 1.005, level * 1.01, level * 1.003, level * 1.008));

    const result = detectBreakoutRetestHold(candles, 'LONG', {
      lookbackBars: 12, freshBars: 6, retestPct: 0.3, retestAtrMult: 0.5, atr: null,
    });
    expect(result).toBeNull();
  });

  it('returns null when there are too few candles for the minimum pattern', () => {
    const candles = buildLongPattern().slice(0, 14); // only lookbackBars+2, no room for retest+hold
    const result = detectBreakoutRetestHold(candles, 'LONG', {
      lookbackBars: 12, freshBars: 6, retestPct: 0.3, retestAtrMult: 0.5, atr: null,
    });
    expect(result).toBeNull();
  });

  it('returns null when retest bar overshoots far below the level (LONG)', () => {
    // Retest bar's low is well below level - tol, i.e. the level failed — not a valid hold.
    const basePrice = 100;
    const candles: OHLCVCandle[] = [];
    for (let i = 0; i < 12; i++) {
      candles.push(makeCandle(i * 900_000, basePrice, basePrice, basePrice * 0.99, basePrice));
    }
    const level = basePrice;
    candles.push(makeCandle(12 * 900_000, level, level * 1.02, level, level * 1.02)); // breakout
    // retest bar low = 98.5, which is 1.5 below level (>> tol of 0.3)
    candles.push(makeCandle(13 * 900_000, level * 1.01, level * 1.01, 98.5, level * 1.01));
    candles.push(makeCandle(14 * 900_000, level * 1.01, level * 1.02, level * 1.005, level * 1.015)); // hold
    const result = detectBreakoutRetestHold(candles, 'LONG', {
      lookbackBars: 12, freshBars: 6, retestPct: 0.3, retestAtrMult: 0.5, atr: null,
    });
    expect(result).toBeNull();
  });

  it('uses ATR-mult tolerance when ATR is large (ATR-mult > pct-floor)', () => {
    // Build pattern where the retest low is 0.6 ATR above the level (would fail pct-only 0.3%)
    const basePrice = 100;
    const atr = 2.0; // large ATR — 0.5 × ATR = 1.0, which is 1% of level (> 0.3%)
    const candles: OHLCVCandle[] = [];
    for (let i = 0; i < 12; i++) {
      candles.push(makeCandle(i * 900_000, basePrice, basePrice, basePrice * 0.99, basePrice));
    }
    const level = basePrice;
    const breakoutClose = level * 1.015;
    candles.push(makeCandle(12 * 900_000, level, breakoutClose, level, breakoutClose));
    // retest low = level + 0.6 (0.6% above — fails 0.3% pct but passes 0.5 × 2.0 = 1.0 ATR)
    const retestLow = level + 0.6;
    candles.push(makeCandle(13 * 900_000, breakoutClose, breakoutClose, retestLow, level + 0.8));
    candles.push(makeCandle(14 * 900_000, level + 0.8, level + 1.2, level + 0.7, level + 1.0));

    const withAtr = detectBreakoutRetestHold(candles, 'LONG', {
      lookbackBars: 12, freshBars: 6, retestPct: 0.3, retestAtrMult: 0.5, atr,
    });
    expect(withAtr).not.toBeNull(); // passes with ATR-based tol

    const withoutAtr = detectBreakoutRetestHold(candles, 'LONG', {
      lookbackBars: 12, freshBars: 6, retestPct: 0.3, retestAtrMult: 0.5, atr: null,
    });
    expect(withoutAtr).toBeNull(); // fails without ATR (pct-only tol = 0.3)
  });
});
