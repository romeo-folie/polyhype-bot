/**
 * Behavioural tests for lowest-temperature ("Lowest temperature in <city>")
 * market support. These assert the NEW low-metric behaviour, not just that the
 * high path still type-checks:
 *   - classifyOracleState inverts correctly for a monotone-decreasing daily min
 *   - the conditional oracle reduces ensemble members by min and reads a fall table
 *   - sourcedFrom keys disambiguate high vs low (no collision) and round-trip
 *   - title/question parsing recognises "lowest"
 *   - ground-truth clients reduce by min (HKO reads the daily-min column row[4])
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { classifyOracleState } from '../liveObservation.js';
import {
  conditionalHeldProbability,
  ensembleFinalMaxDistribution,
  type ClimoExceedanceTable,
} from '../conditionalOracle.js';
import {
  extractMetricFromTitle,
  weatherSourcedFrom,
  parseWeatherSourcedFrom,
} from '../weatherScanner.js';
import { parseWeatherMetaFromQuestion, parseWeatherPositionMeta } from '../weatherThesis.js';
import { fetchHkoDailyLow } from '../hkoClient.js';
import { fetchWuHistoricalLow } from '../wuClient.js';
import { fetchMetarDailyLow } from '../metarClient.js';
import { fetchEnsembleForecast, fetchHistoricalHigh } from '../openMeteoClient.js';
import { weatherGroundTruthRowSchema } from '../../db/schemas/weather_ground_truth.js';

// ── classifyOracleState: low metric (running min only decreases) ──────────────

describe('classifyOracleState (metric=low)', () => {
  // High-tail "X or higher": YES = finalMin ≥ low.
  const highTail = { low: 25, high: null };
  it('high-tail YES impossible once running min drops below low − 0.5', () => {
    expect(classifyOracleState(24.4, 'YES', highTail, 'low')).toBe('oracle_impossible');
    expect(classifyOracleState(24.4, 'NO', highTail, 'low')).toBe('oracle_confirmed');
  });
  it('high-tail inconclusive while running min still at/above low − 0.5', () => {
    expect(classifyOracleState(24.6, 'YES', highTail, 'low')).toBeNull();
  });

  // Low-tail "X or below": YES = finalMin ≤ high.
  const lowTail = { low: null, high: 15 };
  it('low-tail YES confirmed once running min is below high + 0.5 (min only falls)', () => {
    expect(classifyOracleState(15.4, 'YES', lowTail, 'low')).toBe('oracle_confirmed');
    expect(classifyOracleState(15.4, 'NO', lowTail, 'low')).toBe('oracle_impossible');
  });
  it('low-tail inconclusive while running min still above high + 0.5', () => {
    expect(classifyOracleState(15.6, 'YES', lowTail, 'low')).toBeNull();
  });

  // Interior [low, high].
  const interior = { low: 20, high: 21 };
  it('interior YES impossible once running min drops below low − 0.5', () => {
    expect(classifyOracleState(19.4, 'YES', interior, 'low')).toBe('oracle_impossible');
    expect(classifyOracleState(19.4, 'NO', interior, 'low')).toBe('oracle_confirmed');
  });
  it('interior inconclusive while running min still in/above the bracket', () => {
    expect(classifyOracleState(20.5, 'YES', interior, 'low')).toBeNull();
    expect(classifyOracleState(25, 'YES', interior, 'low')).toBeNull();
  });

  it('default metric (high) is unchanged — a high running max kills a low-tail YES', () => {
    // Sanity that the existing high path still behaves (default arg).
    expect(classifyOracleState(15.6, 'YES', { low: null, high: 15 })).toBe('oracle_impossible');
  });
});

// ── conditionalHeldProbability: low metric ────────────────────────────────────

const FRESH_AT = new Date().toISOString();

function flatMembers(value: number, count = 10): number[][] {
  // Each member is a single remaining hour at `value`.
  return Array.from({ length: count }, () => [value]);
}

describe('conditionalHeldProbability (metric=low)', () => {
  it('ensemble reduces members by MIN: a member hour below observed pulls the final min down', () => {
    // observed running min 20; members each dip to 17 → finalMin ≈ 17.
    const finals = ensembleFinalMaxDistribution(20, flatMembers(17), 0, 1.0, 'low');
    expect(finals.every((v) => Math.abs(v - 17) < 1e-9)).toBe(true);
    // For metric=high the same inputs would keep 20 (max), proving direction matters.
    const finalsHigh = ensembleFinalMaxDistribution(20, flatMembers(17), 0, 1.0, 'high');
    expect(finalsHigh.every((v) => Math.abs(v - 20) < 1e-9)).toBe(true);
  });

  it('low-tail YES: members staying low → high win probability for "15 or below"', () => {
    const result = conditionalHeldProbability({
      city: 'seoul',
      direction: 'YES',
      bracket: { low: null, high: 15 },
      observedMax: 16, // running min still above ceiling
      metric: 'low',
      observedAt: FRESH_AT,
      tz: 'Asia/Seoul',
      remainingHourlyMembers: flatMembers(13), // all members drop to 13 → ≤ 15 → YES wins
      climoTable: null,
      biasCorrection: 0,
      spreadInflation: 1.0,
      minMembers: 5,
      maxObsAgeMin: 120,
      estimatorMaxGap: 0.5,
    });
    expect(result).not.toBeNull();
    expect(result!.estimator).toBe('ensemble');
    expect(result!.heldProb).toBeCloseTo(1.0, 5);
  });

  it('degenerate: high-tail YES already impossible once running min is far below the floor', () => {
    const result = conditionalHeldProbability({
      city: 'seoul',
      direction: 'YES',
      bracket: { low: 25, high: null },
      observedMax: 22, // running min already < 25 − 0.5 → impossible
      metric: 'low',
      observedAt: FRESH_AT,
      tz: 'Asia/Seoul',
      remainingHourlyMembers: flatMembers(21),
      climoTable: null,
      biasCorrection: 0,
      spreadInflation: 1.0,
      minMembers: 5,
      maxObsAgeMin: 120,
      estimatorMaxGap: 0.5,
    });
    expect(result).not.toBeNull();
    expect(result!.estimator).toBe('degenerate');
    expect(result!.heldProb).toBe(0);
  });

  it('climo fall table: low-tail YES probability rises as the running min nears the ceiling', () => {
    // Fall table: P(runningMin − finalMin > delta). For "15 or below" with
    // observed 17, YES needs finalMin < 15.5 → delta = 17 − 15.5 = 1.5.
    const fall: ClimoExceedanceTable = {
      seoul: {
        // month/hour keys must match the observation's local month/hour; use a
        // table covering all months/hours by reusing one curve.
      },
    };
    // Build a curve where exceedance(1.5) ≈ 0.4 (40% of days drop ≥1.5 more).
    const curve = [
      { delta: 0, exceedance: 1.0 },
      { delta: 1.5, exceedance: 0.4 },
      { delta: 5, exceedance: 0.0 },
    ];
    const localMonth = parseInt(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', month: '2-digit' }).format(new Date(FRESH_AT)),
      10,
    );
    const localHour = parseInt(
      new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: 'numeric', hour12: false }).format(new Date(FRESH_AT)),
      10,
    ) % 24;
    fall.seoul[localMonth] = { [localHour]: curve };

    const result = conditionalHeldProbability({
      city: 'seoul',
      direction: 'YES',
      bracket: { low: null, high: 15 },
      observedMax: 17,
      metric: 'low',
      observedAt: FRESH_AT,
      tz: 'Asia/Seoul',
      remainingHourlyMembers: null, // force climo-only
      climoTable: fall,
      biasCorrection: 0,
      spreadInflation: 1.0,
      minMembers: 5,
      maxObsAgeMin: 120,
      estimatorMaxGap: 0.5,
    });
    expect(result).not.toBeNull();
    expect(result!.estimator).toBe('climo');
    // P(YES) = P(finalMin < 15.5) = fallExceedance(1.5) ≈ 0.4.
    expect(result!.heldProb).toBeCloseTo(0.4, 2);
  });
});

// ── sourcedFrom keys: high vs low never collide and round-trip ────────────────

describe('weather sourcedFrom keys (metric disambiguation)', () => {
  it('high and low keys differ for the same city/date/bracket', () => {
    const high = weatherSourcedFrom('high', 'seoul', '2026-06-14', '20°C');
    const low = weatherSourcedFrom('low', 'seoul', '2026-06-14', '20°C');
    expect(high).toBe('weather:seoul:2026-06-14:20°C');
    expect(low).toBe('weather:low:seoul:2026-06-14:20°C');
    expect(high).not.toBe(low);
  });

  it('round-trips both forms through parseWeatherSourcedFrom (incl. multi-word city)', () => {
    const low = weatherSourcedFrom('low', 'new york', '2026-06-14', '60°F or higher');
    const parsed = parseWeatherSourcedFrom(low);
    expect(parsed).toEqual({
      metric: 'low',
      city: 'new york',
      targetDate: '2026-06-14',
      bracketLabel: '60°F or higher',
    });
    const high = weatherSourcedFrom('high', 'new york', '2026-06-14', '60°F or higher');
    expect(parseWeatherSourcedFrom(high)).toEqual({
      metric: 'high',
      city: 'new york',
      targetDate: '2026-06-14',
      bracketLabel: '60°F or higher',
    });
  });

  it('parseWeatherSourcedFrom returns null for non-weather keys', () => {
    expect(parseWeatherSourcedFrom('reconciled:weather:foo')).toBeNull();
    expect(parseWeatherSourcedFrom('news:btc')).toBeNull();
  });
});

// ── title / question parsing recognises "lowest" ──────────────────────────────

describe('lowest-temperature title and question parsing', () => {
  it('extractMetricFromTitle distinguishes highest vs lowest', () => {
    expect(extractMetricFromTitle('Lowest temperature in Seoul on June 14?')).toBe('low');
    expect(extractMetricFromTitle('Highest temperature in Seoul on June 14?')).toBe('high');
    expect(extractMetricFromTitle('Will it rain in Seoul?')).toBeNull();
  });

  it('parseWeatherMetaFromQuestion parses a lowest-temperature question with metric=low', () => {
    const meta = parseWeatherMetaFromQuestion(
      'Will the lowest temperature in Seoul be 20°C on June 14, 2026?',
    );
    expect(meta).toEqual({
      city: 'seoul',
      targetDate: '2026-06-14',
      bracketLabel: '20°C',
      metric: 'low',
    });
  });

  it('parseWeatherPositionMeta reads the metric from a weather:low: sourcedFrom', () => {
    const meta = parseWeatherPositionMeta('weather:low:seoul:2026-06-14:20°C');
    expect(meta).toEqual({
      city: 'seoul',
      targetDate: '2026-06-14',
      bracketLabel: '20°C',
      metric: 'low',
    });
    // High form stays metric=high.
    expect(parseWeatherPositionMeta('weather:seoul:2026-06-14:20°C')?.metric).toBe('high');
  });
});

// ── HKO ground truth: daily-min column is row[4], not row[3] (the mean) ────────

describe('fetchHkoDailyLow', () => {
  function hkoResponse() {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        stn: {
          data: [
            {
              month: 6,
              // [day, pressure, MAX, MEAN, MIN, dewpt, humidity, ...]
              dayData: [['01', '1008.9', '32.3', '29.2', '27.6', '24.2', '74']],
            },
          ],
        },
      }),
    } as unknown as Response;
  }

  it('reads the absolute daily minimum from column index 4 (27.6), not the mean at index 3', async () => {
    const low = await fetchHkoDailyLow('2026-06-01', (async () => hkoResponse()) as typeof fetch);
    expect(low).toBe(27.6);
  });
});

// ── ground-truth schema: low columns + invariants ────────────────────────────

describe('weatherGroundTruthRowSchema (low columns)', () => {
  const base = { city: 'seoul', targetDate: '2026-06-14', unit: 'celsius' as const };

  it('accepts an insert carrying both extremes (observed + resolution, high + low)', () => {
    const r = weatherGroundTruthRowSchema.safeParse({
      ...base, observedHigh: 28, observedLow: 19,
      resolutionHigh: 28, resolutionSource: 'wu', resolutionLow: 19, resolutionLowSource: 'wu',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a LOW-ONLY backfill (resolutionLow + source, no high pair)', () => {
    const r = weatherGroundTruthRowSchema.safeParse({
      ...base, backfillOnly: true, resolutionLow: 19, resolutionLowSource: 'wu',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a half low pair (resolutionLow without resolutionLowSource)', () => {
    const r = weatherGroundTruthRowSchema.safeParse({
      ...base, observedHigh: 28, resolutionLow: 19,
    });
    expect(r.success).toBe(false);
  });

  it('rejects a backfill carrying neither resolution pair', () => {
    const r = weatherGroundTruthRowSchema.safeParse({ ...base, backfillOnly: true });
    expect(r.success).toBe(false);
  });
});

// ── WU / METAR ground truth reduce by MIN ─────────────────────────────────────

describe('WU / METAR daily-low fetchers reduce by min', () => {
  it('fetchWuHistoricalLow returns min(observations)', async () => {
    const redis = {
      get: vi.fn(async () => 'a'.repeat(32)), // cached valid API key — skips page scrape
      set: vi.fn(async () => 'OK'),
    };
    const fetchFn = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ observations: [{ temp: 50 }, { temp: 31 }, { temp: 44 }] }),
    })) as unknown as typeof fetch;
    const low = await fetchWuHistoricalLow('KLGA', 'US', '2026-06-14', 'fahrenheit', redis as never, fetchFn);
    expect(low).toBe(31);
  });

  it('fetchMetarDailyLow returns min(temps) for the target UTC day', async () => {
    const fetchFn = (async () => ({
      ok: true,
      status: 200,
      json: async () => ([
        { reportTime: '2026-06-14 06:00:00', temp: 12 },
        { reportTime: '2026-06-14 14:00:00', temp: 23 },
        { reportTime: '2026-06-14 23:00:00', temp: 9 },
        { reportTime: '2026-06-13 23:00:00', temp: 2 }, // different day — excluded
      ]),
    })) as unknown as typeof fetch;
    const low = await fetchMetarDailyLow('LTFM', '2026-06-14', fetchFn);
    expect(low).toBe(9);
  });
});

// ── openMeteo ensemble + archive: min support ─────────────────────────────────

describe('openMeteo low-metric fetches', () => {
  it('fetchEnsembleForecast(metric=low) requests temperature_2m_min members and computes their spread', async () => {
    let calledUrl = '';
    const fetchFn = (async (url: string) => {
      calledUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          daily: {
            time: ['2026-06-14'],
            // Open-Meteo ensemble returns a flat base array (gates the parse) plus
            // per-member keys; parseEnsembleFlat collects the members.
            temperature_2m_min: [12],
            temperature_2m_min_member01: [10],
            temperature_2m_min_member02: [12],
            temperature_2m_min_member03: [14],
          },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const ens = await fetchEnsembleForecast(37.46, 126.44, '2026-06-14', 'celsius', fetchFn, false, 0, 'low');
    expect(calledUrl).toContain('temperature_2m_min');
    expect(calledUrl).not.toContain('temperature_2m_max');
    expect(ens).not.toBeNull();
    expect(ens!.meanLow).toBeCloseTo(12, 5);
    expect(ens!.stddevLow).toBeGreaterThan(0);
  });

  it('fetchHistoricalHigh returns observedLow from the archive temperature_2m_min', async () => {
    const fetchFn = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        daily: {
          time: ['2026-06-14'],
          temperature_2m_max: [71.4],
          temperature_2m_min: [54.6],
        },
      }),
    })) as unknown as typeof fetch;
    const result = await fetchHistoricalHigh(40.7, -74.0, '2026-06-14', 'fahrenheit', fetchFn);
    expect(result).not.toBeNull();
    expect(result!.observedHigh).toBeCloseTo(71.4, 1);
    expect(result!.observedLow).toBeCloseTo(54.6, 1);
  });
});
