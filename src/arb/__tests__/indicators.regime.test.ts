import { describe, it, expect } from 'vitest';
import {
  computeADX,
  computeChoppinessIndex,
  computeBollingerBands,
} from '../indicators.js';
import type { OHLCVCandle } from '../candleAggregator.js';

function mkCandle(o: number, h: number, l: number, c: number, v = 1, t = 0): OHLCVCandle {
  return { openTime: t, open: o, high: h, low: l, close: c, volume: v };
}

/** Strong uptrend: each bar +1, range constant. */
function trendingUp(n: number): OHLCVCandle[] {
  const arr: OHLCVCandle[] = [];
  for (let i = 0; i < n; i++) {
    const base = 100 + i;
    arr.push(mkCandle(base, base + 0.5, base - 0.5, base + 0.4, 1, i));
  }
  return arr;
}

/** Sideways oscillation between 100 and 101. */
function ranging(n: number): OHLCVCandle[] {
  const arr: OHLCVCandle[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % 2 === 0 ? 100.2 : 100.8;
    arr.push(mkCandle(100.5, 101, 100, c, 1, i));
  }
  return arr;
}

describe('computeADX', () => {
  it('returns null when insufficient data', () => {
    expect(computeADX(trendingUp(10), 14)).toBeNull();
  });

  it('reports strong ADX and dominant +DI in a clean uptrend', () => {
    const result = computeADX(trendingUp(60), 14);
    expect(result).not.toBeNull();
    expect(result!.adx).toBeGreaterThan(40);
    expect(result!.plusDI).toBeGreaterThan(result!.minusDI);
  });

  it('reports weak ADX in a ranging market', () => {
    const result = computeADX(ranging(60), 14);
    expect(result).not.toBeNull();
    expect(result!.adx).toBeLessThan(25);
  });
});

describe('computeChoppinessIndex', () => {
  it('returns null when insufficient data', () => {
    expect(computeChoppinessIndex(trendingUp(5), 14)).toBeNull();
  });

  it('is low for trending markets', () => {
    const ci = computeChoppinessIndex(trendingUp(60), 14);
    expect(ci).not.toBeNull();
    expect(ci!).toBeLessThan(40);
  });

  it('is high for ranging markets', () => {
    const ci = computeChoppinessIndex(ranging(60), 14);
    expect(ci).not.toBeNull();
    expect(ci!).toBeGreaterThan(60);
  });
});

describe('computeBollingerBands', () => {
  it('returns null on insufficient data', () => {
    expect(computeBollingerBands(trendingUp(10), 20, 2)).toBeNull();
  });

  it('produces upper > mid > lower and a positive bandwidth', () => {
    const bb = computeBollingerBands(trendingUp(40), 20, 2);
    expect(bb).not.toBeNull();
    expect(bb!.upper).toBeGreaterThan(bb!.mid);
    expect(bb!.mid).toBeGreaterThan(bb!.lower);
    expect(bb!.bandwidth).toBeGreaterThan(0);
    expect(bb!.percentB).toBeGreaterThanOrEqual(0);
    expect(bb!.percentB).toBeLessThanOrEqual(1);
  });

  it('squeeze: bandwidth narrower for flat data than for trending', () => {
    const flat: OHLCVCandle[] = [];
    for (let i = 0; i < 40; i++) flat.push(mkCandle(100, 100.05, 99.95, 100, 1, i));
    const bbFlat = computeBollingerBands(flat, 20, 2);
    const bbTrend = computeBollingerBands(trendingUp(40), 20, 2);
    expect(bbFlat!.bandwidth).toBeLessThan(bbTrend!.bandwidth);
  });
});
