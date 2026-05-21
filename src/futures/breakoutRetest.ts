import type { OHLCVCandle } from '../arb/candleAggregator.js';

export interface BreakoutRetestMatch {
  level: number;
  breakoutBarOpenTime: number;
  retestBarOpenTime: number;
  holdBarOpenTime: number;
}

export interface BreakoutRetestOpts {
  /** Number of bars BEFORE the breakout bar used to compute the swing high/low level. */
  lookbackBars?: number;
  /** Maximum age (in bars) of the breakout bar relative to the hold bar. */
  freshBars?: number;
  /** Retest tolerance as a % of the level; acts as a floor when ATR is also provided. */
  retestPct?: number;
  /** Retest tolerance as an ATR multiple; combined with retestPct as max(atrMult×ATR, pct×level). */
  retestAtrMult?: number;
  /** Hold bar minimum distance beyond the broken level as an ATR multiple. */
  holdMinAtrMult?: number;
  /** Hold bar minimum distance beyond the broken level as a % of the level. */
  holdMinPct?: number;
  /** Pre-computed ATR value; null falls back to pct-only tolerance. */
  atr?: number | null;
}

/**
 * Detect a breakout → retest → hold pattern in the last few closed 15m bars.
 *
 * Pattern for LONG:
 *   1. Breakout bar: close > max(high[bIdx-lookbackBars .. bIdx-1])
 *   2. Retest bar:   low within [level − tol, level + tol]  (touches but does not break the level)
 *   3. Hold bar:     close > level  (the most recent closed bar)
 *
 * SHORT is the mirror (min of lows, close < level, high within [level − tol, level + tol]).
 *
 * Returns the first (most-recent) valid pattern, or null if none exists.
 * Stateless — no Redis required.
 */
export function detectBreakoutRetestHold(
  candles: OHLCVCandle[],
  direction: 'LONG' | 'SHORT',
  opts: BreakoutRetestOpts = {},
): BreakoutRetestMatch | null {
  const {
    lookbackBars = 12,
    freshBars = 6,
    retestPct = 0.3,
    retestAtrMult = 0.5,
    holdMinAtrMult = 0.25,
    holdMinPct = 0.1,
    atr = null,
  } = opts;

  const n = candles.length;
  // Minimum: lookbackBars (swing window) + 1 (breakout) + 1 (retest) + 1 (hold)
  if (n < lookbackBars + 3) return null;

  const holdBar = candles[n - 1]!;

  for (let offset = 0; offset < freshBars; offset++) {
    const bIdx = n - 2 - offset; // breakout candidate (never the hold bar)
    if (bIdx < lookbackBars) break; // not enough prior bars for the swing window

    const breakoutBar = candles[bIdx]!;
    const swingSlice = candles.slice(bIdx - lookbackBars, bIdx);

    let level: number;
    if (direction === 'LONG') {
      level = Math.max(...swingSlice.map((c) => c.high));
      if (breakoutBar.close <= level) continue;
    } else {
      level = Math.min(...swingSlice.map((c) => c.low));
      if (breakoutBar.close >= level) continue;
    }

    // Tolerance: ATR-mult primary, %-of-price floor.
    const tol = atr !== null
      ? Math.max(retestAtrMult * atr, (retestPct / 100) * level)
      : (retestPct / 100) * level;

    const holdMinDist = atr !== null
      ? Math.max(holdMinAtrMult * atr, (holdMinPct / 100) * level)
      : (holdMinPct / 100) * level;

    // Hold check — the most recent bar must close meaningfully beyond the level.
    if (direction === 'LONG' && holdBar.close < level + holdMinDist) continue;
    if (direction === 'SHORT' && holdBar.close > level - holdMinDist) continue;

    // Retest: any bar strictly between breakout bar and hold bar.
    const retestSlice = candles.slice(bIdx + 1, n - 1);
    if (retestSlice.length === 0) continue; // no room for a retest bar

    let retestBar: OHLCVCandle | null = null;
    for (const bar of retestSlice) {
      // Retest must touch within the tolerance band on both sides of the level —
      // a deep overshoot (far breakdown below level on LONG, far breakout above on SHORT)
      // is not a valid retest; it signals the level failed, not held.
      if (direction === 'LONG' && bar.low >= level - tol && bar.low <= level + tol) {
        retestBar = bar;
        break;
      }
      if (direction === 'SHORT' && bar.high <= level + tol && bar.high >= level - tol) {
        retestBar = bar;
        break;
      }
    }
    if (retestBar === null) continue;

    return {
      level,
      breakoutBarOpenTime: breakoutBar.openTime,
      retestBarOpenTime: retestBar.openTime,
      holdBarOpenTime: holdBar.openTime,
    };
  }

  return null;
}
