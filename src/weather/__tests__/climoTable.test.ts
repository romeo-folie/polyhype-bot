/**
 * Integrity tests for the committed climatological exceedance table
 * (src/weather/data/climoExceedance.json) against the runtime city table
 * (CITY_COORDINATES in noaaClient.ts).
 *
 * These tests intentionally fail when CITY_COORDINATES changes (cities added
 * or coordinates corrected) without regenerating the table:
 *
 *   npx tsx scripts/build-climo-exceedance.ts --all
 *
 * That friction is the point — the table silently drifted from the runtime
 * list twice (wrong 'hongkong' key; 25 stale coordinates + 17 missing cities
 * after PRs #485/#488), which contaminated the conditional-oracle estimator-gap
 * shadow data and left new cities without the fallback estimator and clamp.
 */

import { describe, it, expect } from 'vitest';
import { CITY_COORDINATES } from '../noaaClient.js';
import { loadClimoTable } from '../conditionalOracle.js';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

const runtimeCities = Object.keys(CITY_COORDINATES);
const table = loadClimoTable();
// Guarded: a missing/corrupt JSON must surface as test failures with real
// messages (loadClimoTable returns null), not a module-eval throw that
// prevents every test in this file from registering.
let meta: { cityProvenance?: Record<string, { lat: number; lon: number }> } | undefined;
try {
  meta = (_require('../data/climoExceedance.json') as {
    _meta?: { cityProvenance?: Record<string, { lat: number; lon: number }> };
  })._meta;
} catch {
  meta = undefined;
}

describe('climoExceedance.json integrity vs runtime CITY_COORDINATES', () => {
  it('loads and is non-empty', () => {
    expect(table).not.toBeNull();
    expect(Object.keys(table!).length).toBeGreaterThan(0);
  });

  it('covers every runtime city under its canonical key', () => {
    const missing = runtimeCities.filter((c) => !table?.[c]);
    expect(missing, `cities missing from climo table — run scripts/build-climo-exceedance.ts --all: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no orphan cities that are not in the runtime table', () => {
    const orphans = Object.keys(table ?? {}).filter((c) => !runtimeCities.includes(c));
    expect(orphans, `climo cities not in CITY_COORDINATES (stale or non-canonical keys): ${orphans.join(', ')}`).toEqual([]);
  });

  it('covers all 12 months × 24 hours for every runtime city', () => {
    const gaps: string[] = [];
    for (const city of runtimeCities) {
      const cityTable = table?.[city];
      if (!cityTable) continue; // reported by the coverage test above
      for (let m = 1; m <= 12; m++) {
        const monthTable = cityTable[m];
        if (!monthTable) {
          gaps.push(`${city}/m${m}`);
          continue;
        }
        for (let h = 0; h <= 23; h++) {
          const entries = monthTable[h];
          if (!Array.isArray(entries) || entries.length === 0) gaps.push(`${city}/m${m}/h${h}`);
        }
      }
    }
    expect(gaps.slice(0, 20), `month/hour gaps (first 20 shown; ${gaps.length} total)`).toEqual([]);
  });

  it('every cell is a valid exceedance curve (deltas ascending ≥ 0, exceedance non-increasing in [0,1])', () => {
    const bad: string[] = [];
    for (const [city, cityTable] of Object.entries(table ?? {})) {
      for (const [m, monthTable] of Object.entries(cityTable)) {
        for (const [h, entries] of Object.entries(monthTable)) {
          let prevDelta = -Infinity;
          let prevExc = Infinity;
          for (const e of entries) {
            if (
              typeof e.delta !== 'number' || typeof e.exceedance !== 'number' ||
              e.delta < 0 || e.delta < prevDelta ||
              e.exceedance < 0 || e.exceedance > 1 || e.exceedance > prevExc + 1e-9
            ) {
              bad.push(`${city}/m${m}/h${h}`);
              break;
            }
            prevDelta = e.delta;
            prevExc = e.exceedance;
          }
        }
      }
    }
    expect(bad.slice(0, 20), `invalid curves (first 20 shown; ${bad.length} total)`).toEqual([]);
  });

  it('per-city provenance coordinates match the runtime CITY_COORDINATES (drift guard)', () => {
    expect(meta?.cityProvenance, 'table predates per-city provenance — regenerate with --all').toBeDefined();
    const drifted: string[] = [];
    for (const city of runtimeCities) {
      const prov = meta?.cityProvenance?.[city];
      if (!prov) {
        drifted.push(`${city} (no provenance)`);
        continue;
      }
      const rt = CITY_COORDINATES[city]!;
      if (Math.abs(prov.lat - rt.lat) > 0.005 || Math.abs(prov.lon - rt.lon) > 0.005) {
        drifted.push(`${city} (table ${prov.lat},${prov.lon} vs runtime ${rt.lat},${rt.lon})`);
      }
    }
    expect(drifted, `coordinate drift — regenerate with --all: ${drifted.join('; ')}`).toEqual([]);
  });
});
