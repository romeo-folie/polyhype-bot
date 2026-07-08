/**
 * Tests for conditionalOracle.ts — conditional weather oracle (Phases A-C).
 *
 * Covers:
 *  1. localHourFromUtc — hour derivation from UTC ISO8601 + IANA timezone
 *  2. bracketWinProbFromFinalMaxes — bracket math for all bracket types + directions
 *  3. ensembleFinalMaxDistribution — bias correction + spread inflation
 *  4. conditionalHeldProbability — degenerate invariants, ensemble estimator, climo
 *     fallback, staleness gate, null when no estimator available
 *  5. loadClimoTable — returns non-null object (empty cities table shipped by default)
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  localHourFromUtc,
  bracketWinProbFromFinalMaxes,
  ensembleFinalMaxDistribution,
  conditionalHeldProbability,
  loadClimoTable,
} = await import('../conditionalOracle.js');

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A timestamp whose UTC hour is 14:30 UTC (2:30 PM UTC). */
const UTC_14_30 = '2026-06-01T14:30:00Z';

/** Interior bracket 40-41°F. */
const INTERIOR_BRACKET = { low: 40, high: 41 };
/** High-tail bracket: 58°F or higher. */
const HIGH_TAIL_BRACKET = { low: 58, high: null };
/** Low-tail bracket: 39°F or below. */
const LOW_TAIL_BRACKET = { low: null, high: 39 };

/** Minimal member set where all members end at 45°F. */
function flatMembers(value: number, count = 20): number[][] {
  return Array.from({ length: count }, () => [value, value, value]);
}

/** Base ConditionalOracleInput without requiring observed crossing. */
function baseInput(overrides: Partial<Parameters<typeof conditionalHeldProbability>[0]> = {}) {
  return {
    city: 'chicago',
    direction: 'NO' as const,
    bracket: INTERIOR_BRACKET,
    observedMax: 38,   // below any degenerate boundary for interior [40,41]
    observedAt: new Date(Date.now() - 10 * 60_000).toISOString(), // 10 min ago, not stale
    tz: 'America/Chicago',
    remainingHourlyMembers: null,
    climoTable: null,
    biasCorrection: 0,
    spreadInflation: 1.0,
    minMembers: 10,
    maxObsAgeMin: 90,
    estimatorMaxGap: 0.25,
    ...overrides,
  };
}

// ── 1. localHourFromUtc ───────────────────────────────────────────────────────

describe('localHourFromUtc', () => {
  it('returns the local hour in America/Chicago (UTC-5 in winter)', () => {
    // 14:30 UTC → 08:30 CST (UTC-6 standard) — but June is CDT (UTC-5), so 09:30
    const hour = localHourFromUtc('2026-06-01T14:30:00Z', 'America/Chicago');
    expect(hour).toBe(9);
  });

  it('returns the local hour in Asia/Hong_Kong (UTC+8)', () => {
    // 14:30 UTC → 22:30 HKT
    const hour = localHourFromUtc(UTC_14_30, 'Asia/Hong_Kong');
    expect(hour).toBe(22);
  });

  it('returns 0 on invalid timezone', () => {
    const hour = localHourFromUtc(UTC_14_30, 'Invalid/Tz');
    expect(hour).toBe(0);
  });

  it('handles midnight UTC as 0', () => {
    const hour = localHourFromUtc('2026-06-01T00:00:00Z', 'UTC');
    expect(hour).toBe(0);
  });
});

// ── 2. bracketWinProbFromFinalMaxes ───────────────────────────────────────────

describe('bracketWinProbFromFinalMaxes', () => {
  it('returns 0.5 for empty array', () => {
    expect(bracketWinProbFromFinalMaxes([], 'YES', INTERIOR_BRACKET)).toBe(0.5);
  });

  describe('interior bracket [40, 41]', () => {
    it('YES wins when fm rounds into [40-0.5, 41+0.5) → [39.5, 41.5)', () => {
      // fm=40.0: in range [39.5, 41.5) → YES wins
      expect(bracketWinProbFromFinalMaxes([40], 'YES', INTERIOR_BRACKET)).toBeCloseTo(1.0);
    });
    it('YES loses when fm rounds outside [40-0.5, 41+0.5)', () => {
      expect(bracketWinProbFromFinalMaxes([42], 'YES', INTERIOR_BRACKET)).toBeCloseTo(0.0);
    });
    it('NO wins when fm rounds outside bracket', () => {
      expect(bracketWinProbFromFinalMaxes([42], 'NO', INTERIOR_BRACKET)).toBeCloseTo(1.0);
    });
    it('NO loses when fm rounds inside bracket', () => {
      expect(bracketWinProbFromFinalMaxes([40], 'NO', INTERIOR_BRACKET)).toBeCloseTo(0.0);
    });
    it('boundary: fm=39.5 still rounds into bracket (YES wins)', () => {
      expect(bracketWinProbFromFinalMaxes([39.5], 'YES', INTERIOR_BRACKET)).toBeCloseTo(1.0);
    });
    it('boundary: fm=41.5 rounds outside bracket (YES loses)', () => {
      expect(bracketWinProbFromFinalMaxes([41.5], 'YES', INTERIOR_BRACKET)).toBeCloseTo(0.0);
    });
    it('computes correct fraction for mixed members', () => {
      // 6 in range, 4 out of range → P=0.6 for YES
      const finalMaxes = [...Array(6).fill(40.5), ...Array(4).fill(42.0)];
      expect(bracketWinProbFromFinalMaxes(finalMaxes, 'YES', INTERIOR_BRACKET)).toBeCloseTo(0.6);
    });
  });

  describe('high-tail bracket {low: 58, high: null}', () => {
    it('YES wins when fm >= 57.5 (rounds to ≥ 58)', () => {
      expect(bracketWinProbFromFinalMaxes([58], 'YES', HIGH_TAIL_BRACKET)).toBeCloseTo(1.0);
    });
    it('YES loses when fm < 57.5', () => {
      expect(bracketWinProbFromFinalMaxes([57], 'YES', HIGH_TAIL_BRACKET)).toBeCloseTo(0.0);
    });
    it('NO wins when fm < 57.5', () => {
      expect(bracketWinProbFromFinalMaxes([57], 'NO', HIGH_TAIL_BRACKET)).toBeCloseTo(1.0);
    });
  });

  describe('low-tail bracket {low: null, high: 39}', () => {
    it('YES wins when fm < 39.5 (rounds to ≤ 39)', () => {
      expect(bracketWinProbFromFinalMaxes([39], 'YES', LOW_TAIL_BRACKET)).toBeCloseTo(1.0);
    });
    it('YES loses when fm >= 39.5', () => {
      expect(bracketWinProbFromFinalMaxes([39.5], 'YES', LOW_TAIL_BRACKET)).toBeCloseTo(0.0);
    });
    it('NO wins when fm >= 39.5', () => {
      expect(bracketWinProbFromFinalMaxes([40], 'NO', LOW_TAIL_BRACKET)).toBeCloseTo(1.0);
    });
  });
});

// ── 3. ensembleFinalMaxDistribution ──────────────────────────────────────────

describe('ensembleFinalMaxDistribution', () => {
  it('returns empty array when no members', () => {
    expect(ensembleFinalMaxDistribution(40, [], 0, 1.0)).toEqual([]);
  });

  it('uses observedMax as floor — member trajectory below it yields observedMax', () => {
    // observedMax=50, all members stay at 40 → finalMax = 50 for each
    const result = ensembleFinalMaxDistribution(50, flatMembers(40), 0, 1.0);
    expect(result.every((v) => v === 50)).toBe(true);
  });

  it('produces final max above observedMax when member exceeds it', () => {
    // observedMax=40, all members at 55 → finalMax ≈ 55 for each
    const result = ensembleFinalMaxDistribution(40, flatMembers(55), 0, 1.0);
    expect(result.every((v) => v > 40)).toBe(true);
    expect(result[0]).toBeCloseTo(55);
  });

  it('applies bias correction — corrected values below observedMax floor stay at floor', () => {
    // members=35, biasCorrection=5 → corrected=30 < observedMax=40 → finalMax stays at 40 (floor).
    // This verifies bias correction reduces member values, pushing some below the observedMax floor.
    const result = ensembleFinalMaxDistribution(40, flatMembers(35), 5, 1.0);
    expect(result.every((v) => v === 40)).toBe(true);
  });

  it('spread inflation > 1 amplifies deviation from ensemble mean', () => {
    // Members: two groups at 42 and 58, mean ≈ 50.
    // With inflation=2, the spread doubles: 42→34, 58→66.
    // With inflation=1 (no inflation): members stay at their corrected values.
    const members = [
      ...Array(10).fill(null).map(() => [42]),
      ...Array(10).fill(null).map(() => [58]),
    ];
    const inflated = ensembleFinalMaxDistribution(30, members, 0, 2.0);
    const noInflation = ensembleFinalMaxDistribution(30, members, 0, 1.0);
    // Standard deviation of inflated > standard deviation of no-inflation
    const std = (arr: number[]) => {
      const m = arr.reduce((s, v) => s + v, 0) / arr.length;
      return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
    };
    expect(std(inflated)).toBeGreaterThan(std(noInflation));
  });

  it('returns one final max per ensemble member', () => {
    const result = ensembleFinalMaxDistribution(40, flatMembers(45, 50), 0, 1.0);
    expect(result).toHaveLength(50);
  });
});

// ── 4. conditionalHeldProbability ─────────────────────────────────────────────

describe('conditionalHeldProbability', () => {
  describe('degenerate invariants', () => {
    it('returns heldProb=0 (degenerate) when observedMax crosses oracle_impossible for NO', () => {
      // Interior [40,41] NO: observedMax > 41.5 → oracle_impossible for YES → oracle_confirmed for NO
      // Actually: for interior NO, oracle_impossible fires when observedMax > 41.5 (NO can't win once day is too hot)?
      // NO: wait. classifyOracleState returns oracle_impossible for NO means NO CANNOT WIN.
      // For interior NO: oracle_impossible fires when observedMax is INSIDE the bracket already
      //   confirmed → meaning YES already won → NO is impossible.
      // Let's use high-tail YES direction where observedMax already cleared the tail:
      // High-tail YES {low:58}: observedMax=58 → oracle_confirmed for YES → heldProb=1
      const result = conditionalHeldProbability(baseInput({
        direction: 'YES',
        bracket: HIGH_TAIL_BRACKET,
        observedMax: 58,  // ≥ 57.5 → oracle_confirmed for YES
      }));
      expect(result).not.toBeNull();
      expect(result!.heldProb).toBe(1);
      expect(result!.estimator).toBe('degenerate');
    });

    it('returns heldProb=1 (degenerate) when oracle_confirmed for held direction', () => {
      // High-tail NO {low:58}: observedMax=58 → oracle_confirmed for YES → oracle_impossible for NO
      // Wait — classifyOracleState is for the direction we hold.
      // For direction=YES with HIGH_TAIL_BRACKET and observedMax=58 → oracle_confirmed → heldProb=1
      // Already tested above.
      // For direction=NO with HIGH_TAIL_BRACKET: observedMax=58 → oracle_impossible for NO → heldProb=0
      const result = conditionalHeldProbability(baseInput({
        direction: 'NO',
        bracket: HIGH_TAIL_BRACKET,
        observedMax: 58,  // ≥ 57.5 → oracle_confirmed for YES → oracle_impossible for NO
      }));
      expect(result!.heldProb).toBe(0);
      expect(result!.estimator).toBe('degenerate');
    });

    it('degenerate result matches classifyOracleState: interior NO, day max exceeded bracket high', () => {
      // Interior [40,41] NO: observedMax=42 > 41.5 → day definitely went hotter than bracket
      // → YES is impossible → NO is confirmed → heldProb=1
      const result = conditionalHeldProbability(baseInput({
        direction: 'NO',
        bracket: INTERIOR_BRACKET,
        observedMax: 42,  // > 41.5 → oracle_confirmed for NO
      }));
      expect(result!.heldProb).toBe(1);
      expect(result!.estimator).toBe('degenerate');
    });
  });

  describe('ensemble estimator', () => {
    it('uses ensemble when minMembers are available', () => {
      // All 20 members produce finalMax=45 — well above interior [40,41] → NO wins
      const result = conditionalHeldProbability(baseInput({
        direction: 'NO',
        bracket: INTERIOR_BRACKET,
        observedMax: 38,
        remainingHourlyMembers: flatMembers(45, 20),
      }));
      expect(result).not.toBeNull();
      expect(result!.estimator).toBe('ensemble');
      expect(result!.members).toBe(20);
      expect(result!.heldProb).toBeCloseTo(1.0, 2);
    });

    it('all members finishing inside bracket → NO held prob near 0', () => {
      const result = conditionalHeldProbability(baseInput({
        direction: 'NO',
        bracket: INTERIOR_BRACKET,
        observedMax: 38,
        remainingHourlyMembers: flatMembers(40, 20), // all in [39.5, 41.5)
      }));
      expect(result!.heldProb).toBeCloseTo(0.0, 2);
    });

    it('mixed members → intermediate P for NO', () => {
      // 10 members ending at 40 (in bracket), 10 ending at 45 (outside) → P(NO)=0.5
      const members = [
        ...Array(10).fill(null).map(() => [40]),
        ...Array(10).fill(null).map(() => [45]),
      ];
      const result = conditionalHeldProbability(baseInput({
        direction: 'NO',
        bracket: INTERIOR_BRACKET,
        observedMax: 38,
        remainingHourlyMembers: members,
      }));
      expect(result!.heldProb).toBeCloseTo(0.5, 2);
    });
  });

  describe('estimator degradation', () => {
    it('returns null when no ensemble members and no climo table', () => {
      const result = conditionalHeldProbability(baseInput({
        remainingHourlyMembers: null,
        climoTable: null,
      }));
      expect(result).toBeNull();
    });

    it('falls back to climo when fewer than minMembers available', () => {
      // Build a table that covers all 24 local hours so the lookup always succeeds
      // regardless of when the test runs (observedAt is ~now → local hour is runtime-dependent).
      const hourEntries = [
        { delta: -5, exceedance: 0.95 },
        { delta: 0, exceedance: 0.80 },
        { delta: 5, exceedance: 0.40 },
      ];
      const allHours: Record<number, typeof hourEntries> = {};
      for (let h = 0; h < 24; h++) allHours[h] = hourEntries;
      const allMonths: Record<number, typeof allHours> = {};
      for (let m = 1; m <= 12; m++) allMonths[m] = allHours;
      const climoTable = { chicago: allMonths };
      const result = conditionalHeldProbability(baseInput({
        remainingHourlyMembers: flatMembers(40, 5), // only 5 members < minMembers=10
        climoTable: climoTable as never,
        minMembers: 10,
      }));
      expect(result!.estimator).toBe('climo');
      expect(result!.members).toBe(0);
    });
  });

  describe('staleness gate', () => {
    it('isStale=false when obs is recent', () => {
      const result = conditionalHeldProbability(baseInput({
        observedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        maxObsAgeMin: 90,
        remainingHourlyMembers: flatMembers(45, 20),
      }));
      expect(result!.isStale).toBe(false);
    });

    it('isStale=true when obs exceeds maxObsAgeMin', () => {
      const result = conditionalHeldProbability(baseInput({
        observedAt: new Date(Date.now() - 120 * 60_000).toISOString(), // 2h ago
        maxObsAgeMin: 90,
        remainingHourlyMembers: flatMembers(45, 20),
      }));
      expect(result!.isStale).toBe(true);
    });

    it('uses latest/as-of observedAt for low-metric staleness, not the dawn minimum time', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-09T18:30:00.000Z'));
      try {
        const result = conditionalHeldProbability(baseInput({
          metric: 'low',
          direction: 'YES',
          bracket: { low: null, high: 49 },
          observedMax: 52,
          observedAt: '2026-06-09T18:00:00.000Z',
          maxObsAgeMin: 90,
          remainingHourlyMembers: flatMembers(55, 20),
        }));
        expect(result!.isStale).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('climo fallback interpolation', () => {
    it('returns climoHeldProb when ensemble unavailable and city is in table', () => {
      // HIGH_TAIL YES {low:58}: observedMax=50, need finalMax ≥ 57.5 → delta=7.5
      // exceedance at delta=7.5 = 0.35 → P(YES wins) = 0.35
      // Build table covering all 24 local hours so the test passes regardless of runtime hour.
      const hourEntries = [
        { delta: 0, exceedance: 0.90 },
        { delta: 5, exceedance: 0.70 },
        { delta: 7.5, exceedance: 0.35 },
        { delta: 15, exceedance: 0.10 },
      ];
      const allHours: Record<number, typeof hourEntries> = {};
      for (let h = 0; h < 24; h++) allHours[h] = hourEntries;
      const allMonths: Record<number, typeof allHours> = {};
      for (let m = 1; m <= 12; m++) allMonths[m] = allHours;
      const climoTable = { chicago: allMonths };

      const result = conditionalHeldProbability({
        city: 'chicago',
        direction: 'YES',
        bracket: HIGH_TAIL_BRACKET,
        observedMax: 50,
        observedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        tz: 'America/Chicago',
        remainingHourlyMembers: null,
        climoTable: climoTable as never,
        biasCorrection: 0,
        spreadInflation: 1.0,
        minMembers: 10,
        maxObsAgeMin: 90,
        estimatorMaxGap: 0.25,
      });
      expect(result).not.toBeNull();
      expect(result!.estimator).toBe('climo');
      expect(result!.climoHeldProb).not.toBeNull();
      // delta=7.5 (=57.5-50) → exceedance=0.35 → P(YES)=0.35
      expect(result!.heldProb).toBeCloseTo(0.35, 2);
    });

    it('returns null when city not in climo table', () => {
      const climoTable = { unknown_city: {} };
      const result = conditionalHeldProbability(baseInput({
        city: 'chicago', // not in this mini table
        remainingHourlyMembers: null,
        climoTable: climoTable as never,
      }));
      expect(result).toBeNull();
    });
  });

  describe('conservative clamp (estimatorMaxGap)', () => {
    it('uses less favorable estimate when gap exceeds threshold', () => {
      // Ensemble: all 20 members at 45 → interior NO [40,41] → P(NO)=1.0 (all outside bracket).
      // Climo table designed to give climoHeldProb_NO ≈ 0.50 so gap = |1.0 - 0.50| = 0.50 > 0.25.
      // Interior NO bracket [40,41], observedMax=38 (below bracket):
      //   deltaLow = (40-0.5)-38 = 1.5; deltaHigh = (41+0.5)-38 = 3.5
      //   excLow ≈ 0.90 (very likely to exceed low threshold), excHigh ≈ 0.40 (less likely to exceed high)
      //   pYes = excLow - excHigh = 0.50 → climoHeldProb_NO = 1 - 0.50 = 0.50
      //   gap = |1.0 - 0.50| = 0.50 > estimatorMaxGap=0.25 → clamp to 0.50 (worse for NO)
      const entries = [
        { delta: 0, exceedance: 0.95 },
        { delta: 2, exceedance: 0.90 },  // ~deltaLow=1.5 → exc≈0.90 after interpolation
        { delta: 4, exceedance: 0.40 },  // ~deltaHigh=3.5 → exc≈0.40 after interpolation
        { delta: 10, exceedance: 0.10 },
      ];
      const allHours: Record<number, typeof entries> = {};
      for (let h = 0; h < 24; h++) allHours[h] = entries;
      const allMonths: Record<number, typeof allHours> = {};
      for (let m = 1; m <= 12; m++) allMonths[m] = allHours;
      const climoTable = { chicago: allMonths };

      const result = conditionalHeldProbability(baseInput({
        direction: 'NO',
        bracket: INTERIOR_BRACKET,
        observedMax: 38,
        remainingHourlyMembers: flatMembers(45, 20),
        climoTable: climoTable as never,
        estimatorMaxGap: 0.25,
      }));
      expect(result).not.toBeNull();
      expect(result!.clampedByClimo).toBe(true);
      expect(result!.estimatorGap).not.toBeNull();
      expect(result!.estimatorGap).toBeGreaterThan(0.25);
      // Conservative clamp: heldProb should be less than 1.0 (climo pulled it down).
      expect(result!.heldProb).toBeLessThan(1.0);
    });
  });
});

// ── 5. loadClimoTable ─────────────────────────────────────────────────────────

describe('loadClimoTable', () => {
  it('returns a non-null object (at least the empty cities table)', () => {
    const table = loadClimoTable();
    // The shipped table has an empty cities object; loadClimoTable returns raw.cities.
    // An empty {} is still non-null and is a valid (empty) table.
    expect(table).not.toBeNull();
    expect(typeof table).toBe('object');
  });
});

// ── Floor semantics (one-decimal cities, e.g. HKO) ────────────────────────────

describe('floor semantics — probabilistic estimators respect classifyOpts', () => {
  it('bracketWinProbFromFinalMaxes with a +0.5-pre-shifted bracket lands on floor boundaries', () => {
    // Floor "31°C" = [31.0, 32.0). Pre-shifted bracket {31.5, 31.5} makes the
    // round formulas produce exactly those boundaries: 31.6/31.8 are YES, 32.2 is NO.
    const p = bracketWinProbFromFinalMaxes([31.6, 31.8, 32.2], 'NO', { low: 31.5, high: 31.5 });
    expect(p).toBeCloseTo(1 / 3, 10);
    // Un-shifted (round) bracket wrongly calls all three NO wins (none in [30.5, 31.5)).
    expect(bracketWinProbFromFinalMaxes([31.6, 31.8, 32.2], 'NO', { low: 31, high: 31 })).toBe(1);
  });

  it('conditionalHeldProbability threads floor semantics into the ENSEMBLE estimator', () => {
    // 20 members flat at 31.6 → every final max = 31.6. Floor "31°C" contains
    // 31.6 → NO loses in every member → heldProb(NO) = 0. Under round semantics
    // 31.6 rounds to 32 → NO wins every member → heldProb(NO) = 1. The exact
    // half-degree flip that mispriced HK exits/hold-guards.
    const mk = (classifyOpts?: { semantics: 'round' | 'floor' }) => conditionalHeldProbability({
      city: 'hong kong',
      direction: 'NO',
      bracket: { low: 31, high: 31 },
      observedMax: 31,
      metric: 'high',
      ...(classifyOpts ? { classifyOpts } : {}),
      observedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      tz: 'Asia/Hong_Kong',
      remainingHourlyMembers: flatMembers(31.6, 20),
      climoTable: null,
      biasCorrection: 0,
      spreadInflation: 1.0,
      minMembers: 10,
      maxObsAgeMin: 90,
      estimatorMaxGap: 0.25,
    });
    const floor = mk({ semantics: 'floor' });
    const round = mk();
    expect(floor!.estimator).toBe('ensemble');
    expect(floor!.heldProb).toBeCloseTo(0, 6); // bracket contains 31.6 → NO dead
    expect(round!.heldProb).toBeCloseTo(1, 6); // old behavior: 31.6 "rounds out"
  });
});

describe('floor semantics — CLIMO estimator paths', () => {
  function tableFor(entries: { delta: number; exceedance: number }[]) {
    const allHours: Record<number, typeof entries> = {};
    for (let h = 0; h < 24; h++) allHours[h] = entries;
    const allMonths: Record<number, typeof allHours> = {};
    for (let m = 1; m <= 12; m++) allMonths[m] = allHours;
    return { chicago: allMonths };
  }

  it('HIGH-metric climo path uses floor boundaries (delta shifts by +0.5)', () => {
    // bracket "31", observedMax 31, NO. In-bracket branch → NO = exc(boundary − obs).
    // Round: boundary 31.5 → delta 0.5 → exc 0.6. Floor: boundary 32.0 → delta 1.0 → exc 0.3.
    const climoTable = tableFor([
      { delta: 0, exceedance: 0.8 }, { delta: 0.5, exceedance: 0.6 },
      { delta: 1.0, exceedance: 0.3 }, { delta: 2.0, exceedance: 0.1 },
    ]);
    const mk = (classifyOpts?: { semantics: 'round' | 'floor' }) => conditionalHeldProbability({
      city: 'chicago', direction: 'NO', bracket: { low: 31, high: 31 },
      observedMax: 31, metric: 'high',
      ...(classifyOpts ? { classifyOpts } : {}),
      observedAt: new Date(Date.now() - 5 * 60_000).toISOString(), tz: 'America/Chicago',
      remainingHourlyMembers: null, climoTable: climoTable as never,
      biasCorrection: 0, spreadInflation: 1.0, minMembers: 10, maxObsAgeMin: 90, estimatorMaxGap: 0.25,
    });
    const round = mk();
    const floor = mk({ semantics: 'floor' });
    expect(round!.estimator).toBe('climo');
    expect(round!.heldProb).toBeCloseTo(0.6, 6);
    expect(floor!.heldProb).toBeCloseTo(0.3, 6);
  });

  it('LOW-metric climo path uses floor boundaries too', () => {
    // Lowest-temp bracket "25", running min 25.4, YES. Inside-from-above branch →
    // P(YES) = 1 − exc(observedMin − lower boundary).
    // Round: boundary 24.5 → delta 0.9 → exc 0.2 → YES 0.8.
    // Floor: boundary 25.0 → delta 0.4 → exc 0.5 → YES 0.5.
    const climoTable = tableFor([
      { delta: 0, exceedance: 0.7 }, { delta: 0.4, exceedance: 0.5 },
      { delta: 0.9, exceedance: 0.2 }, { delta: 2.0, exceedance: 0.05 },
    ]);
    const mk = (classifyOpts?: { semantics: 'round' | 'floor' }) => conditionalHeldProbability({
      city: 'chicago', direction: 'YES', bracket: { low: 25, high: 25 },
      observedMax: 25.4, metric: 'low',
      ...(classifyOpts ? { classifyOpts } : {}),
      observedAt: new Date(Date.now() - 5 * 60_000).toISOString(), tz: 'America/Chicago',
      remainingHourlyMembers: null, climoTable: climoTable as never,
      biasCorrection: 0, spreadInflation: 1.0, minMembers: 10, maxObsAgeMin: 90, estimatorMaxGap: 0.25,
    });
    const round = mk();
    const floor = mk({ semantics: 'floor' });
    expect(round!.estimator).toBe('climo');
    expect(round!.heldProb).toBeCloseTo(0.8, 6);
    expect(floor!.heldProb).toBeCloseTo(0.5, 6);
  });
});
