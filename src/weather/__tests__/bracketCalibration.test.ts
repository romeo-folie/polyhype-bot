import { describe, it, expect } from 'vitest';
import {
  classifyBracketShape,
  horizonBucket,
  normalizeSource,
  cellKey,
  interpolateCell,
  calibrateWeatherBracketProbability,
  loadCalibrationTable,
  type CalibrationTable,
} from '../bracketCalibration.js';

// Monotone rising 10-bin curves for synthetic tables.
const rise = (lo: number, hi: number): number[] =>
  Array.from({ length: 10 }, (_, i) => lo + ((hi - lo) * i) / 9);

function synthTable(over: Partial<CalibrationTable> = {}): CalibrationTable {
  return {
    _meta: { generatedAt: '', scoredPairs: 9000, binCount: 10, priorStrength: 20, minCellSamples: 80, version: 1 },
    byShapeSourceHorizon: {},
    byShapeSource: {},
    byShape: {},
    byMetric: { high: { n: 9000, bins: rise(0.2, 0.8) } },
    ...over,
  };
}

describe('classifyBracketShape', () => {
  it('classifies by bound structure', () => {
    expect(classifyBracketShape(24, 24)).toBe('exact');
    expect(classifyBracketShape(70, 71)).toBe('range');
    expect(classifyBracketShape(null, 39)).toBe('low_tail');
    expect(classifyBracketShape(58, null)).toBe('high_tail');
  });
});

describe('horizonBucket', () => {
  it('buckets days out', () => {
    expect(horizonBucket(0)).toBe('0-1');
    expect(horizonBucket(1)).toBe('0-1');
    expect(horizonBucket(2)).toBe('2-3');
    expect(horizonBucket(3)).toBe('2-3');
    expect(horizonBucket(4)).toBe('4+');
    expect(horizonBucket(10)).toBe('4+');
  });
});

describe('normalizeSource', () => {
  it('lowercases/trims, defaults unknown', () => {
    expect(normalizeSource('Open-Meteo')).toBe('open-meteo');
    expect(normalizeSource('  HRRR-Combined ')).toBe('hrrr-combined');
    expect(normalizeSource(null)).toBe('unknown');
    expect(normalizeSource('')).toBe('unknown');
  });
});

describe('cellKey', () => {
  it('builds the metric-prefixed lookup keys', () => {
    const k = cellKey({ shape: 'exact', source: 'Open-Meteo', daysOut: 1, metric: 'high' });
    expect(k.shapeSourceHorizon).toBe('high|exact|open-meteo|0-1');
    expect(k.shapeSource).toBe('high|exact|open-meteo');
    expect(k.shape).toBe('high|exact');
    expect(k.metric).toBe('high');
  });
  it('separates high and low into different keys', () => {
    const lo = cellKey({ shape: 'exact', source: 'open-meteo', daysOut: 1, metric: 'low' });
    expect(lo.shapeSourceHorizon).toBe('low|exact|open-meteo|0-1');
    expect(lo.metric).toBe('low');
  });
});

describe('interpolateCell', () => {
  it('returns pRaw when bins are empty (identity)', () => {
    expect(interpolateCell([], 0.42)).toBeCloseTo(0.42, 6);
  });
  it('clamps a single-bin curve to its value', () => {
    expect(interpolateCell([0.3], 0.9)).toBeCloseTo(0.3, 6);
  });
  it('maps to a bin value at that bin center', () => {
    const bins = rise(0.2, 0.8); // centers at pRaw = (i+0.5)/10
    expect(interpolateCell(bins, 0.05)).toBeCloseTo(bins[0]!, 6); // center of bin 0
    expect(interpolateCell(bins, 0.15)).toBeCloseTo(bins[1]!, 6); // center of bin 1
  });
  it('linearly interpolates between adjacent bin centers', () => {
    const bins = rise(0.2, 0.8);
    expect(interpolateCell(bins, 0.10)).toBeCloseTo((bins[0]! + bins[1]!) / 2, 6);
  });
  it('clamps below first / above last center, and clamps output to [0,1]', () => {
    const bins = rise(0.2, 0.8);
    expect(interpolateCell(bins, 0)).toBeCloseTo(bins[0]!, 6);
    expect(interpolateCell(bins, 1)).toBeCloseTo(bins[9]!, 6);
    expect(interpolateCell([2, 2, 2], 0.5)).toBe(1); // out-of-range bin value clamped
    expect(interpolateCell([-1, -1, -1], 0.5)).toBe(0);
  });
});

describe('calibrateWeatherBracketProbability', () => {
  const feat = { shape: 'exact' as const, source: 'open-meteo', daysOut: 1, metric: 'high' as const };

  it('is the identity when no table is available', () => {
    expect(calibrateWeatherBracketProbability(0.3, feat, null)).toBeCloseTo(0.3, 6);
    expect(calibrateWeatherBracketProbability(1.5, feat, null)).toBe(1); // clamped
    expect(calibrateWeatherBracketProbability(-0.2, feat, null)).toBe(0);
  });

  it('prefers the most specific cell that meets minCellSamples', () => {
    const table = synthTable({
      byShapeSourceHorizon: { 'high|exact|open-meteo|0-1': { n: 100, bins: rise(0.4, 0.4) } }, // flat 0.4
      byShapeSource: { 'high|exact|open-meteo': { n: 500, bins: rise(0.6, 0.6) } },
      byShape: { 'high|exact': { n: 5000, bins: rise(0.7, 0.7) } },
    });
    // SSH cell present & n≥80 → 0.4 regardless of pRaw
    expect(calibrateWeatherBracketProbability(0.05, feat, table)).toBeCloseTo(0.4, 6);
  });

  it('falls back to a coarser cell when the specific one is too sparse', () => {
    const table = synthTable({
      byShapeSourceHorizon: { 'high|exact|open-meteo|0-1': { n: 10, bins: rise(0.4, 0.4) } }, // n<80 → skip
      byShapeSource: { 'high|exact|open-meteo': { n: 500, bins: rise(0.6, 0.6) } },
    });
    expect(calibrateWeatherBracketProbability(0.05, feat, table)).toBeCloseTo(0.6, 6);
  });

  it('falls back to the per-metric root, then identity', () => {
    const onlyMetric = synthTable(); // byMetric.high bins rise(0.2,0.8)
    expect(calibrateWeatherBracketProbability(0.05, feat, onlyMetric)).toBeCloseTo(0.2, 6);
    const noUsableCell = synthTable({ byMetric: { high: { n: 10, bins: rise(0.2, 0.8) } } }); // n<80
    expect(calibrateWeatherBracketProbability(0.05, feat, noUsableCell)).toBeCloseTo(0.05, 6); // identity
  });

  it('never blends across metrics — a low bracket misses the high curves', () => {
    const table = synthTable({
      byShape: { 'high|exact': { n: 5000, bins: rise(0.7, 0.7) } }, // high-only curve
      byMetric: { high: { n: 9000, bins: rise(0.7, 0.7) } },        // no low root
    });
    // low has no cell anywhere → identity, not the high 0.7 curve
    expect(calibrateWeatherBracketProbability(0.05, { ...feat, metric: 'low' }, table)).toBeCloseTo(0.05, 6);
  });

  it('output is bounded [0,1] and non-decreasing in pRaw (monotone map)', () => {
    const table = synthTable();
    let prev = -1;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const c = calibrateWeatherBracketProbability(p, feat, table);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
      expect(c).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = c;
    }
  });
});

// ── Integrity of the committed artifact (mirrors climoTable.test.ts) ─────────
describe('calibrationParams.json integrity', () => {
  const table = loadCalibrationTable();

  it('loads with a sane _meta block', () => {
    expect(table).not.toBeNull();
    expect(table!._meta.binCount).toBeGreaterThan(0);
    expect(table!._meta.scoredPairs).toBeGreaterThan(0);
    expect(table!._meta.minCellSamples).toBeGreaterThan(0);
    expect(Object.keys(table!.byMetric).length).toBeGreaterThan(0);
    expect(table!.byMetric.high).toBeDefined(); // highs always present
  });

  it('every cell has binCount bins, each in [0,1] and non-decreasing', () => {
    const binCount = table!._meta.binCount;
    const cells = [
      ...Object.entries(table!.byMetric),
      ...Object.entries(table!.byShape),
      ...Object.entries(table!.byShapeSource),
      ...Object.entries(table!.byShapeSourceHorizon),
    ];
    expect(cells.length).toBeGreaterThan(0);
    for (const [name, cell] of cells) {
      expect(cell.bins.length, name).toBe(binCount);
      let prev = -1;
      for (const v of cell.bins) {
        expect(v, name).toBeGreaterThanOrEqual(0);
        expect(v, name).toBeLessThanOrEqual(1);
        expect(v, `${name} monotone`).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v;
      }
      expect(cell.n, name).toBeGreaterThan(0);
    }
  });
});
