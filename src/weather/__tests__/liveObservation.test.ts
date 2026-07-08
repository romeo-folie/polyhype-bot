/**
 * Tests for liveObservation.ts — Phase 5 live observation clients and classifiers.
 *
 * Covers:
 *  1. classifyOracleState — boundary logic for interior, high-tail, and low-tail brackets
 *  2. classifyContradiction — market/oracle/model disagreement classifier
 *  3. fetchMetarIntradayHigh — against captured METAR payload
 *  4. fetchHkoIntradayHigh — against captured HKO rhrread payload
 *  5. fetchLiveObservation — routing logic (which client is called per resolutionSource)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock wuClient to avoid network calls in routing tests.
const mockFetchWuHistoricalExtremeWithTimestamp = vi.fn().mockResolvedValue(null);
vi.mock('../wuClient.js', () => ({
  fetchWuHistoricalExtremeWithTimestamp: mockFetchWuHistoricalExtremeWithTimestamp,
}));

// Mock noaaClient to provide CITY_COORDINATES without network dependency.
vi.mock('../noaaClient.js', () => ({
  lookupCity: (city: string) => {
    const cities: Record<string, object> = {
      chicago: { resolutionSource: 'wu', wuStation: 'KORD', isoCountry: 'US', unit: 'fahrenheit', tz: 'America/Chicago' },
      london: { resolutionSource: 'wu', wuStation: 'EGLC', isoCountry: 'GB', unit: 'celsius', tz: 'Europe/London' },
      'hong kong': { resolutionSource: 'hko', wuStation: 'HKO', unit: 'celsius', tz: 'Asia/Hong_Kong', bracketSemantics: 'floor' },
      teltest: { resolutionSource: 'metar', wuStation: 'LLBG', isoCountry: 'IL', unit: 'celsius', tz: 'Asia/Jerusalem' },
    };
    return cities[city.toLowerCase()] ?? null;
  },
}));

const {
  classifyOracleState,
  classifyContradiction,
  fetchMetarIntradayHigh,
  fetchHkoIntradayHigh,
  fetchHkoIntradayExtreme,
  fetchLiveObservation,
  parseHkoTextExtremes,
  oracleClassifyOptsForCity,
} = await import('../liveObservation.js');

// ── Helper ────────────────────────────────────────────────────────────────────

function makeRedis(store = new Map<string, string>()) {
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
    _store: store,
  };
}

// ── 1. classifyOracleState ────────────────────────────────────────────────────

describe('classifyOracleState', () => {
  describe('interior bracket (both low and high set)', () => {
    const interior = { low: 28, high: 28 }; // 28°C bracket

    it('returns null when observedMax is within the bracket rounding window', () => {
      // 28.0 is inside [27.5, 28.5) — still unresolved
      expect(classifyOracleState(28.0, 'YES', interior)).toBeNull();
      expect(classifyOracleState(28.0, 'NO', interior)).toBeNull();
    });

    it('returns null when observedMax is below the bracket (day not over)', () => {
      // 26.0 < 27.5 — max could still reach 28 before day end
      expect(classifyOracleState(26.0, 'YES', interior)).toBeNull();
      expect(classifyOracleState(26.0, 'NO', interior)).toBeNull();
    });

    it('returns oracle_impossible for YES when observedMax > bracket.high + 0.5', () => {
      // 28.6 > 28.5 → rounds to ≥29 → 28°C YES is impossible
      expect(classifyOracleState(28.6, 'YES', interior)).toBe('oracle_impossible');
    });

    it('returns oracle_confirmed for NO when observedMax > bracket.high + 0.5', () => {
      // same condition — NO is confirmed (the bracket 28°C has been passed)
      expect(classifyOracleState(28.6, 'NO', interior)).toBe('oracle_confirmed');
    });

    it('returns null exactly at the upper boundary (28.5 is not strictly above)', () => {
      expect(classifyOracleState(28.5, 'YES', interior)).toBeNull();
      expect(classifyOracleState(28.5, 'NO', interior)).toBeNull();
    });

    it('returns oracle_impossible/confirmed for a Fahrenheit interior bracket', () => {
      const fBracket = { low: 90, high: 92 }; // 90-92°F bracket
      // > 92.5 → rounds ≥ 93 → YES impossible
      expect(classifyOracleState(93.0, 'YES', fBracket)).toBe('oracle_impossible');
      expect(classifyOracleState(93.0, 'NO', fBracket)).toBe('oracle_confirmed');
    });
  });

  describe('high-tail bracket (low set, high = null)', () => {
    const highTail = { low: 34, high: null }; // "34°C or higher"

    it('returns oracle_confirmed for YES when observedMax >= low - 0.5', () => {
      // 33.5 >= 34 - 0.5 → rounds to >= 34 → YES confirmed (high tail reached)
      expect(classifyOracleState(33.5, 'YES', highTail)).toBe('oracle_confirmed');
    });

    it('returns oracle_impossible for NO when observedMax >= low - 0.5', () => {
      expect(classifyOracleState(34.0, 'NO', highTail)).toBe('oracle_impossible');
    });

    it('returns null when observedMax is below the tail threshold', () => {
      // 32.0 < 33.5 — high hasn't been reached yet
      expect(classifyOracleState(32.0, 'YES', highTail)).toBeNull();
      expect(classifyOracleState(32.0, 'NO', highTail)).toBeNull();
    });

    it('returns oracle_confirmed for YES exactly at the rounding boundary', () => {
      // 33.6 > 33.5 → YES confirmed
      expect(classifyOracleState(33.6, 'YES', highTail)).toBe('oracle_confirmed');
    });
  });

  describe('low-tail bracket (high set, low = null)', () => {
    const lowTail = { low: null, high: 24 }; // "24°C or below"

    it('returns oracle_impossible for YES when observedMax > high + 0.5', () => {
      // 24.6 > 24.5 → rounds ≥ 25 → YES (24 or below) is impossible
      expect(classifyOracleState(24.6, 'YES', lowTail)).toBe('oracle_impossible');
    });

    it('returns oracle_confirmed for NO when observedMax > high + 0.5', () => {
      expect(classifyOracleState(25.0, 'NO', lowTail)).toBe('oracle_confirmed');
    });

    it('returns null when observedMax is within the low tail', () => {
      // 24.0 ≤ 24.5 — still within the tail, day not over
      expect(classifyOracleState(24.0, 'YES', lowTail)).toBeNull();
      expect(classifyOracleState(23.0, 'YES', lowTail)).toBeNull();
    });

    it('returns null exactly at the upper boundary (24.5 is not strictly above)', () => {
      expect(classifyOracleState(24.5, 'YES', lowTail)).toBeNull();
    });
  });
});

// ── 2. classifyContradiction ──────────────────────────────────────────────────

describe('classifyContradiction', () => {
  const base = {
    entryPrice: 0.65,
    currentHeldProb: 0.95,
    oracleState: null as 'oracle_impossible' | 'oracle_confirmed' | null,
    oracleConfidence: 'settlement_aligned' as const,
    forecastState: 'stable' as const,
    marketDeadBid: 0.05,
    contradictionMinModelMarketGap: 0.55,
  };

  it('returns null when currentHeldBid is null', () => {
    expect(classifyContradiction({ ...base, currentHeldBid: null })).toBeNull();
  });

  it('returns null when no material disagreement', () => {
    // bid near entry price — no adverse move, no oracle impairment
    expect(classifyContradiction({ ...base, currentHeldBid: 0.62 })).toBeNull();
  });

  it('returns market_confirms_oracle when market moved AND oracle implies impairment', () => {
    // marketDrop = (0.65 - 0.01) / 0.65 = 0.985 ≥ 0.30 ✓; oracle = oracle_impossible ✓
    expect(classifyContradiction({
      ...base,
      currentHeldBid: 0.01,
      oracleState: 'oracle_impossible',
      oracleConfidence: 'settlement_aligned',
    })).toBe('market_confirms_oracle');
  });

  it('returns market_contradicts_model when market moved against us but forecast still high and oracle does not explain', () => {
    // marketDrop large, model 95%, oracle null → classic Istanbul case
    expect(classifyContradiction({
      ...base,
      currentHeldBid: 0.002,
      currentHeldProb: 0.99,
      oracleState: null,
    })).toBe('market_contradicts_model');
  });

  it('market_contradicts_model requires modelMarketGap >= threshold', () => {
    // modelMarketGap = 0.55 - 0.25 = 0.30 < 0.55 → does not qualify
    expect(classifyContradiction({
      ...base,
      currentHeldBid: 0.25,
      currentHeldProb: 0.55,
      oracleState: null,
    })).toBeNull();
  });

  it('returns oracle_contradicts_market when oracle implies impairment but market has not moved', () => {
    // marketDrop = (0.65 - 0.55) / 0.65 ≈ 0.15 < 0.30 → market has not moved
    expect(classifyContradiction({
      ...base,
      currentHeldBid: 0.55,
      oracleState: 'oracle_impossible',
      oracleConfidence: 'settlement_aligned',
    })).toBe('oracle_contradicts_market');
  });

  it('returns model_only when forecast drifted but no market move and no oracle', () => {
    expect(classifyContradiction({
      ...base,
      currentHeldBid: 0.60,
      forecastState: 'thesis_weakened',
      oracleState: null,
    })).toBe('model_only');
  });

  it('market_confirms_oracle takes priority over market_contradicts_model when oracle is present', () => {
    // Both conditions would fire; oracle present → market_confirms_oracle wins
    expect(classifyContradiction({
      ...base,
      currentHeldBid: 0.002,
      currentHeldProb: 0.99,
      oracleState: 'oracle_impossible',
      oracleConfidence: 'settlement_aligned',
    })).toBe('market_confirms_oracle');
  });

  it('does not classify oracle_contradicts_market when oracleConfidence is none', () => {
    expect(classifyContradiction({
      ...base,
      currentHeldBid: 0.55,
      oracleState: 'oracle_impossible',
      oracleConfidence: 'none',
    })).toBeNull();
  });
});

// ── 3. fetchMetarIntradayHigh ─────────────────────────────────────────────────

describe('fetchMetarIntradayHigh', () => {
  const TARGET_DATE = '2026-06-09';

  const CAPTURED_PAYLOAD: Array<{ reportTime: string; temp: number | null }> = [
    { reportTime: '2026-06-09 02:00:00', temp: 22.0 },
    { reportTime: '2026-06-09 05:00:00', temp: 23.5 },
    { reportTime: '2026-06-09 08:00:00', temp: 25.2 },
    { reportTime: '2026-06-09 11:00:00', temp: 27.8 },
    { reportTime: '2026-06-09 14:00:00', temp: 28.1 },
    { reportTime: '2026-06-08 23:00:00', temp: 21.0 }, // yesterday — must be excluded
  ];

  function makeMockFetch(payload: unknown, status = 200) {
    return vi.fn().mockResolvedValue({
      ok: status === 200,
      status,
      json: () => Promise.resolve(payload),
    } as Response);
  }

  it('returns max temp from today\'s observations', async () => {
    const fetchFn = makeMockFetch(CAPTURED_PAYLOAD);
    const result = await fetchMetarIntradayHigh('LLBG', TARGET_DATE, fetchFn);
    expect(result.observedMax).toBe(28.1);
    expect(result.observedAt).toBeDefined();
  });

  it('excludes observations from previous dates', async () => {
    // Only today's records — max is 28.1 (not 21.0 from yesterday)
    const fetchFn = makeMockFetch(CAPTURED_PAYLOAD);
    const result = await fetchMetarIntradayHigh('LLBG', TARGET_DATE, fetchFn);
    expect(result.observedMax).not.toBe(21.0);
  });

  it('returns null when no observations for target date', async () => {
    const onlyYesterday = CAPTURED_PAYLOAD.filter((o) => o.reportTime.startsWith('2026-06-08'));
    const fetchFn = makeMockFetch(onlyYesterday);
    const result = await fetchMetarIntradayHigh('LLBG', TARGET_DATE, fetchFn);
    expect(result.observedMax).toBeNull();
  });

  it('returns null on HTTP error', async () => {
    const fetchFn = makeMockFetch([], 500);
    const result = await fetchMetarIntradayHigh('LLBG', TARGET_DATE, fetchFn);
    expect(result.observedMax).toBeNull();
  });

  it('returns null when observations array is empty', async () => {
    const fetchFn = makeMockFetch([]);
    const result = await fetchMetarIntradayHigh('LLBG', TARGET_DATE, fetchFn);
    expect(result.observedMax).toBeNull();
  });

  it('ignores null temp values', async () => {
    const withNull = [
      ...CAPTURED_PAYLOAD,
      { reportTime: '2026-06-09 16:00:00', temp: null },
    ];
    const fetchFn = makeMockFetch(withNull);
    const result = await fetchMetarIntradayHigh('LLBG', TARGET_DATE, fetchFn);
    // null temp is filtered; max is still 28.1
    expect(result.observedMax).toBe(28.1);
  });

  it('returns the latest reportTime as observedAt', async () => {
    const fetchFn = makeMockFetch(CAPTURED_PAYLOAD);
    const result = await fetchMetarIntradayHigh('LLBG', TARGET_DATE, fetchFn);
    // Latest today's report = 2026-06-09 14:00:00 UTC
    expect(result.observedAt).toContain('2026-06-09');
  });
});

// ── 4. fetchHkoIntradayHigh ───────────────────────────────────────────────────

describe('fetchHkoIntradayHigh', () => {
  const TARGET_DATE = '2026-06-09';

  // Captured HKO rhrread payload. HKO returns all station readings for the
  // current hour; we extract only Hong Kong Observatory.
  const CAPTURED_RHRREAD = {
    temperature: {
      recordTime: '2026-06-09T14:00:00+08:00',
      data: [
        { place: 'Hong Kong Observatory', value: 31.5, unit: 'C' },
        { place: "King's Park", value: 32.0, unit: 'C' },
        { place: 'Sai Wan Ho', value: 30.8, unit: 'C' },
      ],
    },
  };

  function makeMockFetch(payload: unknown, status = 200) {
    return vi.fn().mockResolvedValue({
      ok: status === 200,
      status,
      json: () => Promise.resolve(payload),
    } as Response);
  }

  it('returns the HKO Observatory station temperature', async () => {
    const redis = makeRedis();
    const fetchFn = makeMockFetch(CAPTURED_RHRREAD);
    const result = await fetchHkoIntradayHigh(TARGET_DATE, redis as any, fetchFn);
    expect(result.observedMax).toBe(31.5);
  });

  it('returns the running max from Redis when current reading is lower', async () => {
    // Seed Redis with a higher prior reading (earlier observation today was hotter).
    const store = new Map([['weather:hko_intraday_max:2026-06-09', '33.0']]);
    const redis = makeRedis(store);
    const fetchFn = makeMockFetch(CAPTURED_RHRREAD); // current reading = 31.5
    const result = await fetchHkoIntradayHigh(TARGET_DATE, redis as any, fetchFn);
    // Running max should stay 33.0 (not overwrite with lower 31.5)
    expect(result.observedMax).toBe(33.0);
  });

  it('updates Redis running max when current reading is higher', async () => {
    const store = new Map([['weather:hko_intraday_max:2026-06-09', '29.0']]);
    const redis = makeRedis(store);
    const fetchFn = makeMockFetch(CAPTURED_RHRREAD); // reading 31.5 > 29.0
    await fetchHkoIntradayHigh(TARGET_DATE, redis as any, fetchFn);
    expect(store.get('weather:hko_intraday_max:2026-06-09')).toBe('31.5');
  });

  it('returns null when HKO station is not in the payload', async () => {
    const noHkoStation = {
      temperature: {
        recordTime: '2026-06-09T14:00:00+08:00',
        data: [{ place: "King's Park", value: 32.0, unit: 'C' }],
      },
    };
    const redis = makeRedis();
    const fetchFn = makeMockFetch(noHkoStation);
    const result = await fetchHkoIntradayHigh(TARGET_DATE, redis as any, fetchFn);
    expect(result.observedMax).toBeNull();
  });

  it('returns null on HTTP error', async () => {
    const redis = makeRedis();
    const fetchFn = makeMockFetch({}, 503);
    const result = await fetchHkoIntradayHigh(TARGET_DATE, redis as any, fetchFn);
    expect(result.observedMax).toBeNull();
  });

  it('returns null when temperature data is missing', async () => {
    const redis = makeRedis();
    const fetchFn = makeMockFetch({ temperature: {} });
    const result = await fetchHkoIntradayHigh(TARGET_DATE, redis as any, fetchFn);
    expect(result.observedMax).toBeNull();
  });

  it('includes an observedAt timestamp derived from the rhrread recordTime', async () => {
    const redis = makeRedis();
    const fetchFn = makeMockFetch(CAPTURED_RHRREAD);
    const result = await fetchHkoIntradayHigh(TARGET_DATE, redis as any, fetchFn);
    expect(result.observedAt).toBeDefined();
    // recordTime 2026-06-09T14:00:00+08:00 = 2026-06-09T06:00:00Z
    expect(result.observedAt).toContain('2026-06-09');
  });

  it('does NOT update Redis when recordTime belongs to a different HKT calendar day', async () => {
    // Scenario: position targetDate is June 9 but rhrread has already rolled to June 10 HKT
    // (e.g. 00:30 HKT June 10 = 16:30 UTC June 9). Must not contaminate June 9 accumulator.
    const nextDayPayload = {
      temperature: {
        recordTime: '2026-06-10T00:30:00+08:00', // June 10 HKT
        data: [{ place: 'Hong Kong Observatory', value: 28.0, unit: 'C' }],
      },
    };
    const store = new Map([['weather:hko_intraday_max:2026-06-09', '31.5']]);
    const redis = makeRedis(store);
    const fetchFn = makeMockFetch(nextDayPayload);
    await fetchHkoIntradayHigh(TARGET_DATE, redis as any, fetchFn);
    // Redis key for June 9 must remain unchanged
    expect(store.get('weather:hko_intraday_max:2026-06-09')).toBe('31.5');
  });

  it('does NOT update Redis when recordTime is absent', async () => {
    const noRecordTime = {
      temperature: {
        data: [{ place: 'Hong Kong Observatory', value: 35.0, unit: 'C' }],
        // recordTime intentionally omitted
      },
    };
    const store = new Map([['weather:hko_intraday_max:2026-06-09', '31.5']]);
    const redis = makeRedis(store);
    const fetchFn = makeMockFetch(noRecordTime);
    await fetchHkoIntradayHigh(TARGET_DATE, redis as any, fetchFn);
    // Without recordTime we cannot verify the date; leave accumulator untouched
    expect(store.get('weather:hko_intraday_max:2026-06-09')).toBe('31.5');
  });
});

// ── 5. fetchLiveObservation routing ──────────────────────────────────────────

describe('fetchLiveObservation routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchWuHistoricalExtremeWithTimestamp.mockResolvedValue(null);
  });

  it('calls WU for a wu resolutionSource city when wuEnabled=true', async () => {
    const redis = makeRedis();
    mockFetchWuHistoricalExtremeWithTimestamp.mockResolvedValue({
      observedMax: 22.0,
      observedAt: '2026-06-09T20:00:00.000Z',
    });
    await fetchLiveObservation('chicago', '2026-06-09', redis as any, {
      wuEnabled: true, metarEnabled: false, hkoEnabled: false, maxAgeMin: 30,
    });
    expect(mockFetchWuHistoricalExtremeWithTimestamp).toHaveBeenCalledWith(
      'KORD', 'US', '2026-06-09', 'fahrenheit', expect.anything(), 'high', expect.anything(),
    );
  });

  it('returns source:none for wu city when wuEnabled=false', async () => {
    const redis = makeRedis();
    const obs = await fetchLiveObservation('chicago', '2026-06-09', redis as any, {
      wuEnabled: false, metarEnabled: false, hkoEnabled: false, maxAgeMin: 30,
    });
    expect(obs.source).toBe('none');
    expect(obs.confidence).toBe('none');
  });

  it('returns source:none for unknown city', async () => {
    const redis = makeRedis();
    const obs = await fetchLiveObservation('atlantis', '2026-06-09', redis as any, {
      wuEnabled: true, metarEnabled: true, hkoEnabled: true, maxAgeMin: 30,
    });
    expect(obs.source).toBe('none');
  });

  it('returns cached obs when cache is still fresh', async () => {
    const redis = makeRedis();
    // Seed a fresh cache entry (metric-aware key: weather:live_obs:<metric>:<city>:<date>).
    const cached = {
      city: 'chicago', targetDate: '2026-06-09',
      observedMax: 25.0, metric: 'high', source: 'wu-live', confidence: 'settlement_aligned',
      observedAt: '2026-06-09T12:00:00Z',
      cachedAt: new Date().toISOString(),
    };
    redis._store.set('weather:live_obs:high:chicago:2026-06-09', JSON.stringify(cached));

    const obs = await fetchLiveObservation('chicago', '2026-06-09', redis as any, {
      wuEnabled: true, metarEnabled: false, hkoEnabled: false, maxAgeMin: 30,
    });
    expect(obs.observedMax).toBe(25.0);
    // Should not have called WU since cache was fresh.
    expect(mockFetchWuHistoricalExtremeWithTimestamp).not.toHaveBeenCalled();
  });

  it('re-fetches when cache has expired', async () => {
    const redis = makeRedis();
    // Seed a stale cache entry (cachedAt 2 hours ago, maxAgeMin=30).
    const stale = {
      city: 'chicago', targetDate: '2026-06-09',
      observedMax: 20.0, source: 'wu-live', confidence: 'settlement_aligned',
      observedAt: '2026-06-09T10:00:00Z',
      cachedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    };
    redis._store.set('weather:live_obs:chicago:2026-06-09', JSON.stringify(stale));
    mockFetchWuHistoricalExtremeWithTimestamp.mockResolvedValue({
      observedMax: 27.5,
      observedAt: '2026-06-09T21:00:00.000Z',
    });

    const obs = await fetchLiveObservation('chicago', '2026-06-09', redis as any, {
      wuEnabled: true, metarEnabled: false, hkoEnabled: false, maxAgeMin: 30,
    });
    expect(obs.observedMax).toBe(27.5);
    expect(mockFetchWuHistoricalExtremeWithTimestamp).toHaveBeenCalled();
  });

  it('WU result has settlement_aligned confidence', async () => {
    mockFetchWuHistoricalExtremeWithTimestamp.mockResolvedValue({
      observedMax: 26.0,
      observedAt: '2026-06-09T14:00:00.000Z',
    });
    const redis = makeRedis();
    const obs = await fetchLiveObservation('london', '2026-06-09', redis as any, {
      wuEnabled: true, metarEnabled: false, hkoEnabled: false, maxAgeMin: 30,
    });
    expect(obs.source).toBe('wu-live');
    expect(obs.confidence).toBe('settlement_aligned');
    expect(obs.observedMax).toBe(26.0);
  });

  // ── monotonic flag per source (lock-in safety) ──────────────────────────────
  const metarFetch = (temp: number, reportTime = '2026-06-09 14:00:00') => vi.fn().mockResolvedValue({
    ok: true, status: 200, json: () => Promise.resolve([{ reportTime, temp }]),
  });
  const hkoFetch = (value: number) => vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: () => Promise.resolve({ temperature: { recordTime: '2026-06-09T14:00:00+08:00', data: [{ place: 'Hong Kong Observatory', value, unit: 'C' }] } }),
  });

  it('WU is NOT monotonic (revisable historical endpoint)', async () => {
    mockFetchWuHistoricalExtremeWithTimestamp.mockResolvedValue({
      observedMax: 26.0,
      observedAt: '2026-06-09T14:00:00.000Z',
    });
    const redis = makeRedis();
    const obs = await fetchLiveObservation('chicago', '2026-06-09', redis as any, {
      wuEnabled: true, metarEnabled: false, hkoEnabled: false, maxAgeMin: 30,
    });
    expect(obs.source).toBe('wu-live');
    expect(obs.monotonic).toBe(false);
  });

  it('HKO IS monotonic (Redis-accumulated running extreme)', async () => {
    const redis = makeRedis();
    const obs = await fetchLiveObservation('hong kong', '2026-06-09', redis as any, {
      wuEnabled: false, metarEnabled: false, hkoEnabled: true, maxAgeMin: 30, fetchFn: hkoFetch(31.5) as any,
    });
    expect(obs.source).toBe('hko-live');
    expect(obs.confidence).toBe('settlement_aligned');
    expect(obs.monotonic).toBe(true);
  });

  it('METAR is monotonic + settlement_aligned (METAR IS the resolution source for metar cities)', async () => {
    const redis = makeRedis();
    const obs = await fetchLiveObservation('teltest', '2026-06-09', redis as any, {
      wuEnabled: false, metarEnabled: true, hkoEnabled: false, maxAgeMin: 30, fetchFn: metarFetch(30.0) as any,
    });
    expect(obs.source).toBe('metar-live');
    expect(obs.confidence).toBe('settlement_aligned'); // was 'proxy' before the accumulator
    expect(obs.monotonic).toBe(true);
    expect(obs.observedMax).toBe(30.0);
  });

  it('METAR running max does not revise down — a later lower reading keeps the accumulated max', async () => {
    const redis = makeRedis();
    // maxAgeMin: 0 disables the live_obs cache so each call re-runs the METAR branch;
    // the separate metar_intraday_max accumulator key persists in the mock store.
    const first = await fetchLiveObservation('teltest', '2026-06-09', redis as any, {
      wuEnabled: false, metarEnabled: true, hkoEnabled: false, maxAgeMin: 0, fetchFn: metarFetch(30.0, '2026-06-09 12:00:00') as any,
    });
    expect(first.observedMax).toBe(30.0);
    const second = await fetchLiveObservation('teltest', '2026-06-09', redis as any, {
      wuEnabled: false, metarEnabled: true, hkoEnabled: false, maxAgeMin: 0, fetchFn: metarFetch(28.0, '2026-06-09 14:00:00') as any,
    });
    expect(second.observedMax).toBe(30.0); // not 28.0 — the running max is preserved
  });

  it('METAR transient outage keeps the accumulated max with a non-null observedAt (lock-in not suppressed)', async () => {
    const redis = makeRedis();
    const emptyFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) });
    // Seed the accumulator with a confirmed prior max.
    const first = await fetchLiveObservation('teltest', '2026-06-09', redis as any, {
      wuEnabled: false, metarEnabled: true, hkoEnabled: false, maxAgeMin: 0, fetchFn: metarFetch(30.0, '2026-06-09 12:00:00') as any,
    });
    expect(first.observedMax).toBe(30.0);
    // Next scan: METAR returns no data. The accumulator still holds 30, and observedAt
    // must be non-null so the executeWeatherLockIns `observedAt == null` gate doesn't
    // suppress a lock-in on the already-confirmed running max.
    const outage = await fetchLiveObservation('teltest', '2026-06-09', redis as any, {
      wuEnabled: false, metarEnabled: true, hkoEnabled: false, maxAgeMin: 0, fetchFn: emptyFetch as any,
    });
    expect(outage.observedMax).toBe(30.0);
    expect(outage.observedAt).not.toBeNull();
  });

  it('WU result preserves the latest observation timestamp instead of fetch time', async () => {
    mockFetchWuHistoricalExtremeWithTimestamp.mockResolvedValue({
      observedMax: 26.0,
      observedAt: '2026-06-09T13:50:00.000Z',
    });
    const redis = makeRedis();
    const obs = await fetchLiveObservation('london', '2026-06-09', redis as any, {
      wuEnabled: true, metarEnabled: false, hkoEnabled: false, maxAgeMin: 30,
    });
    expect(obs.observedAt).toBe('2026-06-09T13:50:00.000Z');
  });
});

// ── HKO one-decimal source + floor semantics (2026-07-08 false-lock-in fix) ──

const HKO_TEXT_PAGE = `
                         Temperature   Humidity   Air Temperature   Temperature
                                                  Since Midnight    Difference
                                                  (9 Jun 2026)
                     (degree Celsius) (percent)   (degree Celsius)
Chek Lap Kok                   30.8       71        32.0 / 26.6       +0.9
HK Observatory                 30.4       77        31.8 / 25.3       +2.0
King's Park                    29.6       80        31.2 / 24.6       +1.3
`;

describe('parseHkoTextExtremes', () => {
  it('parses the HK Observatory one-decimal since-midnight extremes', () => {
    expect(parseHkoTextExtremes(HKO_TEXT_PAGE, '2026-06-09')).toEqual({ max: 31.8, min: 25.3 });
  });

  it('returns null when the page header date does not match targetDate (HKT rollover guard)', () => {
    expect(parseHkoTextExtremes(HKO_TEXT_PAGE, '2026-06-10')).toBeNull();
  });

  it('returns null when the HK Observatory row is missing', () => {
    const page = HKO_TEXT_PAGE.replace(/HK Observatory.*\n/, '');
    expect(parseHkoTextExtremes(page, '2026-06-09')).toBeNull();
  });

  it('returns null on implausible values', () => {
    const page = HKO_TEXT_PAGE.replace('31.8 / 25.3', '99.9 / 25.3');
    expect(parseHkoTextExtremes(page, '2026-06-09')).toBeNull();
  });
});

describe('fetchHkoIntradayExtreme — one-decimal path', () => {
  const TARGET_DATE = '2026-06-09';
  const RHRREAD = {
    temperature: {
      recordTime: '2026-06-09T14:00:00+08:00',
      data: [{ place: 'Hong Kong Observatory', value: 32, unit: 'C' }],
    },
  };

  /** Routes the text-readings URL to the fixture page, everything else to rhrread JSON. */
  function makeRoutingFetch(pageBody: string | null) {
    return vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('text_readings')) {
        if (pageBody == null) return Promise.resolve({ ok: false, status: 503 } as Response);
        return Promise.resolve({
          ok: true, status: 200, text: () => Promise.resolve(pageBody),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true, status: 200, json: () => Promise.resolve(RHRREAD),
      } as unknown as Response);
    });
  }

  it('prefers the one-decimal page: returns 31.8 with integerRounded=false (NOT the rounded 32)', async () => {
    const redis = makeRedis();
    const result = await fetchHkoIntradayExtreme(TARGET_DATE, redis as any, 'high', makeRoutingFetch(HKO_TEXT_PAGE));
    expect(result.observedMax).toBe(31.8);
    expect(result.integerRounded).toBe(false);
  });

  it('accumulates one-decimal values in a DEDICATED key so legacy rounded integers cannot mask them', async () => {
    // Legacy key already poisoned with a rounded 32 for a true 31.8.
    const store = new Map([['weather:hko_intraday_max:2026-06-09', '32']]);
    const redis = makeRedis(store);
    const result = await fetchHkoIntradayExtreme(TARGET_DATE, redis as any, 'high', makeRoutingFetch(HKO_TEXT_PAGE));
    expect(result.observedMax).toBe(31.8); // one-decimal wins; 32 in the legacy key is ignored
    expect(store.get('weather:hko_intraday_1dp_max:2026-06-09')).toBe('31.8');
  });

  it('metric=low uses the since-midnight minimum', async () => {
    const redis = makeRedis();
    const result = await fetchHkoIntradayExtreme(TARGET_DATE, redis as any, 'low', makeRoutingFetch(HKO_TEXT_PAGE));
    expect(result.observedMax).toBe(25.3);
    expect(result.integerRounded).toBe(false);
  });

  it('falls back to rhrread (integerRounded=true) when the text page is unavailable', async () => {
    const redis = makeRedis();
    const result = await fetchHkoIntradayExtreme(TARGET_DATE, redis as any, 'high', makeRoutingFetch(null));
    expect(result.observedMax).toBe(32);
    expect(result.integerRounded).toBe(true);
  });
});

describe('classifyOracleState — floor semantics + certainty slack', () => {
  const bracket31 = { low: 31, high: 31 };

  it('REGRESSION (the HK false lock-in): 31.8 on a floor "31°C" bracket is NOT a verdict', () => {
    // Round semantics (the old default) wrongly calls 31.8 > 31.5 an exceedance…
    expect(classifyOracleState(31.8, 'NO', bracket31, 'high')).toBe('oracle_confirmed');
    // …floor semantics knows the bracket spans [31.0, 31.9]: no verdict until 32.0.
    expect(classifyOracleState(31.8, 'NO', bracket31, 'high', { semantics: 'floor' })).toBeNull();
    expect(classifyOracleState(32.0, 'NO', bracket31, 'high', { semantics: 'floor' })).toBe('oracle_confirmed');
    expect(classifyOracleState(32.0, 'YES', bracket31, 'high', { semantics: 'floor' })).toBe('oracle_impossible');
  });

  it('certaintySlack makes an integer-rounded 32 inconclusive under floor semantics', () => {
    const opts = { semantics: 'floor' as const, certaintySlack: 0.5 };
    expect(classifyOracleState(32, 'NO', bracket31, 'high', opts)).toBeNull();     // displayed 32 = true ≥31.5 only
    expect(classifyOracleState(32.5, 'NO', bracket31, 'high', opts)).toBe('oracle_confirmed');
  });

  it('floor high-tail: "32°C or higher" confirms YES at exactly 32.0, not 31.5', () => {
    const tail = { low: 32, high: null };
    expect(classifyOracleState(31.6, 'YES', tail, 'high', { semantics: 'floor' })).toBeNull();
    expect(classifyOracleState(31.6, 'YES', tail, 'high')).toBe('oracle_confirmed'); // round: 31.6 ≥ 31.5
    expect(classifyOracleState(32.0, 'YES', tail, 'high', { semantics: 'floor' })).toBe('oracle_confirmed');
  });

  it('floor low-metric interior: running min escapes below the bracket at low, not low−0.5', () => {
    const bracket25 = { low: 25, high: 25 };
    expect(classifyOracleState(24.9, 'YES', bracket25, 'low', { semantics: 'floor' })).toBe('oracle_impossible');
    expect(classifyOracleState(24.9, 'YES', bracket25, 'low')).toBeNull(); // round needs < 24.5
  });

  it('defaults (no opts) preserve the original round behavior exactly', () => {
    expect(classifyOracleState(31.6, 'YES', bracket31, 'high')).toBe('oracle_impossible');
    expect(classifyOracleState(31.4, 'YES', bracket31, 'high')).toBeNull();
  });
});

describe('oracleClassifyOptsForCity', () => {
  it('derives floor semantics for Hong Kong and round for others', () => {
    expect(oracleClassifyOptsForCity('hong kong')).toEqual({ semantics: 'floor', certaintySlack: 0 });
    expect(oracleClassifyOptsForCity('chicago')).toEqual({ semantics: 'round', certaintySlack: 0 });
  });

  it('adds 0.5° certainty slack for integer-rounded observations', () => {
    expect(oracleClassifyOptsForCity('hong kong', true)).toEqual({ semantics: 'floor', certaintySlack: 0.5 });
  });
});
