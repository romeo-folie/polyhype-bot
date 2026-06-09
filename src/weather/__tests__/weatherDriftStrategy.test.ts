/**
 * Tests for the Weather Drift Strategy scanner and supporting helpers.
 *
 * Covers:
 *  1. evaluateWeatherPositionThesis — pure function correctness
 *     a. stable when drop below watch threshold and modal supports
 *     b. watch on small held-prob drop
 *     c. thesis_weakened classification on >= THESIS_WEAKENED_DROP
 *     d. modal_against for interior NO when corrected forecast rounds into bracket
 *     e. modal_against for interior YES when corrected forecast rounds outside bracket
 *     f. tail brackets never trigger modal_against (forecastRoundsIntoBracket returns false)
 *     g. Redis write signals: shouldWriteModalStreak when inverting
 *     h. Redis write signals: shouldDeleteModalStreak when streak clears
 *     i. shouldRefreshSupportedMarker when modal supports thesis
 *     j. entryHeldProb uses entryPrice when consensusProbability is null
 *     k. hard invalidation gates compute correctly
 *
 *  2. classifyDriftState — state classification
 *     a. stable on small drop, modal supporting
 *     b. watch on held_prob_drop >= watchDrop
 *     c. watch on near_bracket_boundary (interior, exactEnabled)
 *     d. thesis_weakened on >= thesisWeakenedDrop
 *     e. modal_against on interior bracket with modalInversionRaw=true
 *     f. tail bracket capped at thesis_weakened (no modal_against)
 *     g. near_boundary NOT triggered when exactEnabled=false
 *     h. near_boundary NOT triggered for tail brackets
 *
 *  3. runWeatherDriftStrategy — integration
 *     a. no-op when WEATHER_DRIFT_SHADOW_ENABLED=false
 *     b. skips position with unparseable sourcedFrom
 *     c. skips position when no matching Gamma event found
 *     d. writes shadow_observations row with correct kind and payload
 *     e. logs correct state for stable position
 *     f. logs modal_against state for interior bracket with inverted modal
 *     g. uses cached forecast when live fetch fails
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockLoadConfig = vi.fn();
vi.mock('../../shared/config.js', () => ({ loadConfig: mockLoadConfig }));

vi.mock('../../db/writeQueue.js', () => ({ enqueueWrite: vi.fn() }));

const mockSql = vi.fn().mockResolvedValue([]);
vi.mock('../../db/client.js', () => ({ getSql: () => mockSql }));

const mockGetCityBias = vi.fn().mockResolvedValue(null);
vi.mock('../cityBias.js', () => ({ getCityBias: mockGetCityBias }));

const mockCacheForecast = vi.fn().mockResolvedValue(undefined);
const mockReadCachedForecast = vi.fn().mockResolvedValue(null);
vi.mock('../forecastCache.js', () => ({
  cacheForecast: mockCacheForecast,
  readCachedForecast: mockReadCachedForecast,
}));

const mockCityLocalDate = vi.fn().mockReturnValue('2026-06-01');
vi.mock('../resolutionTime.js', () => ({ cityLocalDate: mockCityLocalDate }));

const mockFetchWeatherEvents = vi.fn().mockResolvedValue([]);
const mockParseWeatherEvent = vi.fn().mockReturnValue(null);
const mockFetchForecast = vi.fn();
const mockDaysUntil = vi.fn().mockReturnValue(1);

vi.mock('../weatherScanner.js', () => ({
  fetchWeatherEvents: mockFetchWeatherEvents,
  parseWeatherEvent: mockParseWeatherEvent,
  fetchForecast: mockFetchForecast,
  daysUntil: mockDaysUntil,
  // Real pure helpers — mirrors the pattern in weatherInvalidation.test.ts
  forecastRoundsIntoBracket: (h: number, low: number | null, high: number | null) =>
    low === null || high === null ? false : Math.round(h) >= low && Math.round(h) <= high,
  parseBracketLabel: (label: string) => {
    let m = label.match(/^(\d+)\s*°\s*([FC])\s+or\s+below$/i);
    if (m?.[1] && m[2]) return { low: null, high: parseInt(m[1], 10), unit: m[2].toUpperCase() === 'F' ? 'fahrenheit' : 'celsius' };
    m = label.match(/^(\d+)\s*°\s*([FC])\s+or\s+higher$/i);
    if (m?.[1] && m[2]) return { low: parseInt(m[1], 10), high: null, unit: m[2].toUpperCase() === 'F' ? 'fahrenheit' : 'celsius' };
    m = label.match(/^(\d+)\s*-\s*(\d+)\s*°\s*F$/i);
    if (m?.[1] && m[2]) return { low: parseInt(m[1], 10), high: parseInt(m[2], 10), unit: 'fahrenheit' };
    m = label.match(/^(\d+)\s*°\s*C$/i);
    if (m?.[1]) { const v = parseInt(m[1], 10); return { low: v, high: v, unit: 'celsius' }; }
    return null;
  },
  computeBiasedProb: (
    low: number | null,
    high: number | null,
    _daysOut: number,
    forecast: { forecastHigh: number; stdDev: number },
  ) => ({
    modelProbability: 0.70,
    effectiveStdDev: forecast.stdDev,
    correctedForecastHigh: forecast.forecastHigh,
    biasMode: 'none' as const,
  }),
}));

// ── Dynamic imports ───────────────────────────────────────────────────────────

const {
  evaluateWeatherPositionThesis,
  fetchOpenWeatherPositions,
  parseWeatherPositionMeta,
} = await import('../weatherThesis.js');

const { classifyDriftState, runWeatherDriftStrategy } =
  await import('../weatherDriftStrategy.js');

const { enqueueWrite } = await import('../../db/writeQueue.js');

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    WEATHER_DRIFT_SHADOW_ENABLED: true,
    WEATHER_DRIFT_WATCH_DROP: 0.10,
    WEATHER_DRIFT_THESIS_WEAKENED_DROP: 0.20,
    WEATHER_DRIFT_EXACT_ENABLED: true,
    WEATHER_DRIFT_EXACT_BOUNDARY_BUFFER: 0.35,
    WEATHER_MAX_EVENTS: 50,
    WEATHER_STDDEV_MIN_FRACTION: 0.7,
    WEATHER_MODEL_ECMWF_ENABLED: false,
    WEATHER_HRRR_ENABLED: false,
    WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: false,
    WEATHER_HRRR_MAX_CROSS_SOURCE_SPREAD: 15,
    WEATHER_BIAS_CORRECTION_ENABLED: false,
    WEATHER_BIAS_MIN_SAMPLES: 14,
    WEATHER_BIAS_TRUSTED_SAMPLES: 14,
    WEATHER_WEAK_BIAS_STDDEV_MULTIPLIER: 1.2,
    WEATHER_STDDEV_MULTIPLIER: 1.0,
    WEATHER_FORECAST_RETRY_COUNT: 0,
    WEATHER_FORECAST_CACHE_TTL_S: 10_800,
    WEATHER_FORECAST_INVALIDATION_MODAL_ENABLED: true,
    WEATHER_FORECAST_INVALIDATION_MODAL_MIN_RUNS: 1,
    WEATHER_FORECAST_INVALIDATION_MODAL_MAX_HELD_PROB: 0.55,
    WEATHER_FORECAST_INVALIDATION_MIN_DROP: 0.20,
    WEATHER_FORECAST_INVALIDATION_MIN_CURRENT_HELD_PROB: 0.50,
    ...overrides,
  };
}

function makePos(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pos-1',
    marketId: 'mkt-1',
    direction: 'NO' as const,
    entryPrice: 0.65,
    sharesHeld: 10,
    consensusProbability: 0.30, // P(YES)=0.30 → entryHeldProb(NO) = 0.70
    sourcedFrom: 'weather:chicago:2026-06-01:39°F or below',
    question: null,
    ...overrides,
  };
}

function makeForecast(overrides: Record<string, unknown> = {}) {
  return {
    forecastHigh: 55,
    stdDev: 5,
    source: 'combined' as const,
    ensembleMembers: 50,
    ensembleModel: 'gfs' as const,
    shadowEnsemble: null,
    ...overrides,
  };
}

function makeRedis(store = new Map<string, string>()) {
  return {
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
    del: vi.fn(async (key: string) => { store.delete(key); return 1; }),
    _store: store,
  };
}

function makeThesisInput(overrides: Record<string, unknown> = {}) {
  return {
    pos: makePos(),
    bracket: { low: null, high: 39 } as { low: number | null; high: number | null },
    daysOut: 1,
    forecast: makeForecast(),
    cityBias: null,
    redisValues: { modalStreakRaw: null, modalSupportedMarkerRaw: null },
    stddevMultiplier: 1.0,
    biasCorrectionEnabled: false,
    biasMinSamples: 14,
    biasTrustedSamples: 14,
    weakBiasStddevMultiplier: 1.2,
    modalEnabled: true,
    modalMinRuns: 1,
    modalMaxHeldProb: 0.55,
    invalidationMinDrop: 0.20,
    invalidationMinCurrentHeldProb: 0.50,
    ...overrides,
  };
}

// ── evaluateWeatherPositionThesis tests ───────────────────────────────────────

describe('evaluateWeatherPositionThesis', () => {
  it('classifies stable when held prob and modal support intact', () => {
    // computeBiasedProb mock returns modelProbability=0.70, so currentHeldProb(NO)=0.30
    // entryHeldProb(NO) = 1-0.30 = 0.70; drop=0.70-0.30=0.40 → dropInvalidated fires
    // Override forecast to get a smaller drop: need currentHeldProb ≈ entryHeldProb
    // Use tail bracket (no modal) and small drop
    const input = makeThesisInput({
      bracket: { low: null, high: 39 },
      // Force entryHeldProb = currentHeldProb by using entryPrice as baseline
      pos: makePos({ consensusProbability: null, entryPrice: 0.30 }),
    });
    // computeBiasedProb returns modelProbability=0.70 → currentHeldProb(NO)=0.30
    // entryHeldProb = entryPrice = 0.30 (consensusProbability null)
    // drop = 0.30 - 0.30 = 0.00
    const result = evaluateWeatherPositionThesis(input);
    expect(result.drop).toBeCloseTo(0, 5);
    expect(result.dropInvalidated).toBe(false);
    expect(result.modalApplicable).toBe(false); // tail bracket
    expect(result.invalidated).toBe(false);
  });

  it('computes held-prob drop correctly for NO position', () => {
    // consensusProbability=0.30 → entryHeldProb(NO) = 1-0.30 = 0.70
    // computeBiasedProb returns modelProbability=0.70 → currentHeldProb(NO) = 0.30
    // drop = 0.70 - 0.30 = 0.40
    const result = evaluateWeatherPositionThesis(makeThesisInput());
    expect(result.entryHeldProb).toBeCloseTo(0.70, 5);
    expect(result.currentHeldProb).toBeCloseTo(0.30, 5);
    expect(result.drop).toBeCloseTo(0.40, 5);
  });

  it('uses entryPrice as entryHeldProb when consensusProbability is null', () => {
    const input = makeThesisInput({
      pos: makePos({ consensusProbability: null, entryPrice: 0.55 }),
    });
    const result = evaluateWeatherPositionThesis(input);
    // entryHeldProb = entryPrice = 0.55 (direction=NO, so no inversion)
    expect(result.entryHeldProb).toBeCloseTo(0.55, 5);
  });

  it('flags dropInvalidated when drop >= minDrop and currentHeldProb <= minCurrentHeldProb', () => {
    // drop=0.40, currentHeldProb=0.30 → both thresholds met with defaults (0.20, 0.50)
    const result = evaluateWeatherPositionThesis(makeThesisInput());
    expect(result.dropInvalidated).toBe(true);
  });

  it('does not flag dropInvalidated when drop is below threshold', () => {
    const input = makeThesisInput({
      pos: makePos({ consensusProbability: null, entryPrice: 0.30 }),
    });
    // drop ≈ 0.00 → below invalidationMinDrop=0.20
    const result = evaluateWeatherPositionThesis(input);
    expect(result.dropInvalidated).toBe(false);
  });

  it('modalApplicable is false for tail brackets', () => {
    const result = evaluateWeatherPositionThesis(makeThesisInput({ bracket: { low: null, high: 39 } }));
    expect(result.modalApplicable).toBe(false);
    expect(result.modalInversionRaw).toBe(false);
    expect(result.roundedForecast).toBeNull();
  });

  it('classifies modal_against for NO when corrected forecast rounds into bracket', () => {
    // Interior bracket [28, 28], direction=NO
    // computeBiasedProb mock returns correctedForecastHigh=55 (from forecast.forecastHigh=55)
    // Math.round(55)=55, 55 >= 28 && 55 <= 28 → false → forecastInBracket=false → NO: modalInversionRaw=false
    // To trigger inversion for NO: need forecast to round INTO [28,28]
    // forecast.forecastHigh=28.2 → Math.round=28 → 28>=28 && 28<=28 → true → NO: modalInversionRaw=true
    const input = makeThesisInput({
      pos: makePos({ direction: 'NO', consensusProbability: 0.20 }),
      bracket: { low: 28, high: 28 },
      forecast: makeForecast({ forecastHigh: 28.2 }),
      redisValues: { modalStreakRaw: null, modalSupportedMarkerRaw: '1' },
    });
    const result = evaluateWeatherPositionThesis(input);
    expect(result.modalApplicable).toBe(true);
    expect(result.modalInversionRaw).toBe(true);
    expect(result.modalSupportsThesis).toBe(false);
    expect(result.roundedForecast).toBe(28);
  });

  it('classifies modal_against for YES when corrected forecast rounds outside bracket', () => {
    // Interior bracket [28, 28], direction=YES
    // forecast.forecastHigh=29.8 → Math.round=30 → 30 >= 28 && 30 <= 28 → false → forecastInBracket=false
    // YES: modalInversionRaw = !forecastInBracket = true
    const input = makeThesisInput({
      pos: makePos({ direction: 'YES', consensusProbability: 0.80 }),
      bracket: { low: 28, high: 28 },
      forecast: makeForecast({ forecastHigh: 29.8 }),
      redisValues: { modalStreakRaw: null, modalSupportedMarkerRaw: '1' },
    });
    const result = evaluateWeatherPositionThesis(input);
    expect(result.modalApplicable).toBe(true);
    expect(result.modalInversionRaw).toBe(true);
    expect(result.modalSupportsThesis).toBe(false);
  });

  it('modal supports thesis for NO when forecast rounds outside bracket', () => {
    // forecast.forecastHigh=25 → Math.round=25 → 25 >= 28 && 25 <= 28 → false
    // NO: modalInversionRaw = forecastInBracket = false → modalSupportsThesis=true
    const input = makeThesisInput({
      pos: makePos({ direction: 'NO', consensusProbability: 0.20 }),
      bracket: { low: 28, high: 28 },
      forecast: makeForecast({ forecastHigh: 25 }),
    });
    const result = evaluateWeatherPositionThesis(input);
    expect(result.modalInversionRaw).toBe(false);
    expect(result.modalSupportsThesis).toBe(true);
    expect(result.shouldRefreshSupportedMarker).toBe(true);
  });

  it('returns shouldWriteModalStreak=true and incremented streak on inversion', () => {
    const input = makeThesisInput({
      pos: makePos({ direction: 'NO', consensusProbability: 0.20 }),
      bracket: { low: 28, high: 28 },
      forecast: makeForecast({ forecastHigh: 28.2 }),
      redisValues: { modalStreakRaw: '1', modalSupportedMarkerRaw: '1' },
    });
    const result = evaluateWeatherPositionThesis(input);
    expect(result.shouldWriteModalStreak).toBe(true);
    expect(result.modalStreak).toBe(2); // was 1, incremented to 2
    expect(result.shouldDeleteModalStreak).toBe(false);
  });

  it('returns shouldDeleteModalStreak=true when inversion clears', () => {
    // Prior streak exists but forecast now supports thesis
    const input = makeThesisInput({
      pos: makePos({ direction: 'NO', consensusProbability: 0.20 }),
      bracket: { low: 28, high: 28 },
      forecast: makeForecast({ forecastHigh: 25 }), // rounds to 25, not in [28,28]
      redisValues: { modalStreakRaw: '2', modalSupportedMarkerRaw: '1' },
    });
    const result = evaluateWeatherPositionThesis(input);
    expect(result.shouldDeleteModalStreak).toBe(true);
    expect(result.shouldWriteModalStreak).toBe(false);
    expect(result.modalStreak).toBe(0);
  });

  it('does not trigger modalInvalidated when modalWasEverSupported is false', () => {
    // No supported marker + inversion → born_inverted guard prevents invalidation
    const input = makeThesisInput({
      pos: makePos({ direction: 'NO', consensusProbability: 0.20 }),
      bracket: { low: 28, high: 28 },
      forecast: makeForecast({ forecastHigh: 28.2 }),
      redisValues: { modalStreakRaw: null, modalSupportedMarkerRaw: null }, // never supported
    });
    const result = evaluateWeatherPositionThesis(input);
    expect(result.modalInversionRaw).toBe(true);
    expect(result.modalWasEverSupported).toBe(false);
    expect(result.modalInvalidated).toBe(false);
  });

  it('does not trigger modalInvalidated when held prob above modal ceiling', () => {
    // currentHeldProb above MODAL_MAX_HELD_PROB=0.55 suppresses modal invalidation
    // Direction=YES, consensusProbability=0.85 → entryHeldProb=0.85
    // computeBiasedProb returns modelProbability=0.70 → currentHeldProb(YES)=0.70 > 0.55
    const input = makeThesisInput({
      pos: makePos({ direction: 'YES', consensusProbability: 0.85 }),
      bracket: { low: 28, high: 28 },
      forecast: makeForecast({ forecastHigh: 29.8 }),
      redisValues: { modalStreakRaw: '1', modalSupportedMarkerRaw: '1' },
      modalMaxHeldProb: 0.55,
    });
    const result = evaluateWeatherPositionThesis(input);
    expect(result.modalInversionRaw).toBe(true);
    expect(result.currentHeldProb).toBeCloseTo(0.70, 3);
    expect(result.modalInvalidated).toBe(false); // 0.70 > 0.55 ceiling
  });
});

// ── classifyDriftState tests ──────────────────────────────────────────────────

describe('classifyDriftState', () => {
  const baseOpts = {
    watchDrop: 0.10,
    thesisWeakenedDrop: 0.20,
    exactEnabled: true,
    boundaryBuffer: 0.35,
  };

  function baseResult(overrides: Partial<ReturnType<typeof evaluateWeatherPositionThesis>> = {}) {
    return {
      entryHeldProb: 0.70,
      currentModelProb: 0.70,
      currentHeldProb: 0.70,
      drop: 0.00,
      correctedForecastHigh: 25,
      effectiveStdDev: 5,
      biasMode: 'none' as const,
      modalApplicable: true,
      roundedForecast: 25,
      modalInversionRaw: false,
      modalSupportsThesis: true,
      modalStreak: 0,
      modalWasEverSupported: true,
      dropInvalidated: false,
      modalInvalidated: false,
      invalidated: false,
      invalidationReason: null,
      shouldWriteModalStreak: false,
      shouldDeleteModalStreak: false,
      shouldRefreshSupportedMarker: true,
      ...overrides,
    };
  }

  it('returns stable when drop is below watch threshold and modal supports', () => {
    const { state } = classifyDriftState(
      baseResult({ drop: 0.05 }),
      { low: 28, high: 28 },
      baseOpts,
    );
    expect(state).toBe('stable');
  });

  it('returns watch when held-prob drop >= watchDrop', () => {
    const { state, reason } = classifyDriftState(
      baseResult({ drop: 0.12 }),
      { low: 28, high: 28 },
      baseOpts,
    );
    expect(state).toBe('watch');
    expect(reason).toBe('held_prob_drop');
  });

  it('returns thesis_weakened when drop >= thesisWeakenedDrop', () => {
    const { state } = classifyDriftState(
      baseResult({ drop: 0.25 }),
      { low: 28, high: 28 },
      baseOpts,
    );
    expect(state).toBe('thesis_weakened');
  });

  it('returns modal_against for interior bracket when modalInversionRaw is true', () => {
    const { state } = classifyDriftState(
      baseResult({ drop: 0.05, modalInversionRaw: true, roundedForecast: 28, correctedForecastHigh: 28.2 }),
      { low: 28, high: 28 },
      baseOpts,
    );
    expect(state).toBe('modal_against');
  });

  it('modal_against takes priority over thesis_weakened for interior bracket', () => {
    const { state } = classifyDriftState(
      baseResult({ drop: 0.25, modalInversionRaw: true, roundedForecast: 28, correctedForecastHigh: 28.2 }),
      { low: 28, high: 28 },
      baseOpts,
    );
    expect(state).toBe('modal_against');
  });

  it('tail bracket capped at thesis_weakened — never modal_against', () => {
    // Tail brackets can't have modalInversionRaw=true (forecastRoundsIntoBracket returns false for tails)
    // but even if we pass modalInversionRaw=true, state classification should respect the tail guard
    const { state } = classifyDriftState(
      baseResult({ drop: 0.05, modalInversionRaw: true }),
      { low: null, high: 39 }, // tail bracket
      baseOpts,
    );
    // isTail=true → modal_against block skipped → stable (drop=0.05 < watchDrop=0.10)
    expect(state).toBe('stable');
  });

  it('returns watch for near_bracket_boundary on interior bracket', () => {
    // forecast at 27.2, bracket [28,28]: lowerBoundary=27.5, |27.2-27.5|=0.3 <= buffer=0.35
    const { state, reason } = classifyDriftState(
      baseResult({ drop: 0.05, correctedForecastHigh: 27.2 }),
      { low: 28, high: 28 },
      baseOpts,
    );
    expect(state).toBe('watch');
    expect(reason).toBe('near_bracket_boundary');
  });

  it('near_boundary NOT triggered when exactEnabled=false', () => {
    const { state } = classifyDriftState(
      baseResult({ drop: 0.05, correctedForecastHigh: 27.2 }),
      { low: 28, high: 28 },
      { ...baseOpts, exactEnabled: false },
    );
    expect(state).toBe('stable');
  });

  it('near_boundary NOT triggered for tail brackets', () => {
    const { state } = classifyDriftState(
      baseResult({ drop: 0.05, correctedForecastHigh: 27.2 }),
      { low: null, high: 28 }, // tail
      baseOpts,
    );
    expect(state).toBe('stable');
  });

  it('near_boundary NOT triggered when forecast is outside the buffer zone', () => {
    // forecast at 26.0, bracket [28,28]: lowerBoundary=27.5, |26.0-27.5|=1.5 > buffer=0.35
    const { state } = classifyDriftState(
      baseResult({ drop: 0.05, correctedForecastHigh: 26.0 }),
      { low: 28, high: 28 },
      baseOpts,
    );
    expect(state).toBe('stable');
  });
});

// ── runWeatherDriftStrategy tests ─────────────────────────────────────────────

describe('runWeatherDriftStrategy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(makeConfig());
    mockFetchWeatherEvents.mockResolvedValue([{}]);
    mockParseWeatherEvent.mockReturnValue({
      city: 'chicago',
      targetDate: '2026-06-01',
      coords: { tz: 'America/Chicago' },
      brackets: [
        { label: '39°F or below', low: null, high: 39, marketId: 'mkt-1' },
      ],
    });
    mockFetchForecast.mockResolvedValue(makeForecast());
  });

  it('exits early when WEATHER_DRIFT_SHADOW_ENABLED=false', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_DRIFT_SHADOW_ENABLED: false }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('exits early when no positions in DB', async () => {
    mockSql.mockResolvedValue([]);
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);
    expect(mockFetchWeatherEvents).not.toHaveBeenCalled();
  });

  it('skips position with unparseable sourcedFrom', async () => {
    mockSql.mockResolvedValue([
      makePos({ sourcedFrom: 'invalid:format' }),
    ]);
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);
    expect(enqueueWrite).not.toHaveBeenCalled();
  });

  it('skips position when no matching Gamma event found', async () => {
    mockSql.mockResolvedValue([makePos()]);
    // parseWeatherEvent returns an event for a different city
    mockParseWeatherEvent.mockReturnValue({
      city: 'miami',
      targetDate: '2026-06-01',
      coords: { tz: 'America/New_York' },
      brackets: [{ label: '39°F or below', low: null, high: 39, marketId: 'mkt-2' }],
    });
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);
    expect(enqueueWrite).not.toHaveBeenCalled();
  });

  it('skips position when forecast unavailable and no cache', async () => {
    mockSql.mockResolvedValue([makePos()]);
    mockFetchForecast.mockResolvedValue(null);
    mockReadCachedForecast.mockResolvedValue(null);
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);
    expect(enqueueWrite).not.toHaveBeenCalled();
  });

  it('uses cached forecast when live fetch fails', async () => {
    mockSql.mockResolvedValue([makePos()]);
    mockFetchForecast.mockResolvedValue(null);
    mockReadCachedForecast.mockResolvedValue(makeForecast({ source: 'cached-ensemble' }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);
    expect(enqueueWrite).toHaveBeenCalledWith('shadow_observations', expect.objectContaining({
      kind: 'weather_drift_decision',
      payload: expect.objectContaining({ forecastSource: 'cached-ensemble' }),
    }));
  });

  it('writes shadow_observations row with correct kind and fields', async () => {
    mockSql.mockResolvedValue([makePos()]);
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    expect(enqueueWrite).toHaveBeenCalledWith('shadow_observations', expect.objectContaining({
      kind: 'weather_drift_decision',
      source: 'arb',
      marketId: 'mkt-1',
      direction: 'NO',
      wouldBlock: false,
    }));

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload).toMatchObject({
      positionId: 'pos-1',
      city: 'chicago',
      targetDate: '2026-06-01',
      bracketLabel: '39°F or below',
      action: 'none',
    });
  });

  it('classifies stable position correctly in shadow row', async () => {
    // Position with entryPrice=0.30 (no consensusProbability) → entryHeldProb=0.30
    // computeBiasedProb mock returns modelProbability=0.70 → currentHeldProb(NO)=0.30
    // drop=0.00 → stable
    mockSql.mockResolvedValue([
      makePos({ consensusProbability: null, entryPrice: 0.30 }),
    ]);
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.state).toBe('stable');
  });

  it('classifies modal_against for interior bracket with inverted modal', async () => {
    // Interior bracket [28, 28] with forecastHigh=28.2 → rounds to 28 → forecastInBracket=true
    // direction=NO → modalInversionRaw=true → modal_against
    mockParseWeatherEvent.mockReturnValue({
      city: 'hong kong',
      targetDate: '2026-06-01',
      coords: { tz: 'Asia/Hong_Kong' },
      brackets: [
        { label: '28°C', low: 28, high: 28, marketId: 'mkt-1' },
      ],
    });
    mockSql.mockResolvedValue([
      makePos({
        sourcedFrom: 'weather:hong kong:2026-06-01:28°C',
        direction: 'NO',
        consensusProbability: 0.20,
      }),
    ]);
    mockFetchForecast.mockResolvedValue(makeForecast({ forecastHigh: 28.2 }));

    // Pre-seed the modal supported marker (guard B)
    const store = new Map<string, string>();
    store.set('weather:forecast_modal_supported:pos-1', '1');
    const redis = makeRedis(store);

    await runWeatherDriftStrategy(redis as any);

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.state).toBe('modal_against');
    expect(call.payload.modalInversionRaw).toBe(true);
  });

  it('classifies thesis_weakened on large held-prob drop for tail bracket', async () => {
    // entryHeldProb from consensusProbability=0.30 → 0.70
    // computeBiasedProb returns currentHeldProb(NO)=0.30 → drop=0.40 >= thesisWeakenedDrop=0.20
    mockSql.mockResolvedValue([makePos()]);
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    // drop=0.40 >= thesisWeakenedDrop=0.20 → thesis_weakened
    expect(call.payload.state).toBe('thesis_weakened');
  });

  it('processes a reconciled:weather position using question-text fallback', async () => {
    // reconciled:weather rows have no embedded city/date/bracket in sourcedFrom;
    // parseWeatherPositionMeta falls back to parseWeatherMetaFromQuestion.
    mockParseWeatherEvent.mockReturnValue({
      city: 'chicago',
      targetDate: '2026-06-01',
      coords: { tz: 'America/Chicago' },
      brackets: [
        { label: '39°F or below', low: null, high: 39, marketId: 'mkt-1' },
      ],
    });
    mockSql.mockResolvedValue([
      makePos({
        sourcedFrom: 'reconciled:weather:mkt-1',
        question: 'Will the highest temperature in Chicago be 39°F or below on June 1, 2026?',
        consensusProbability: null,
        entryPrice: 0.30,
      }),
    ]);
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    // Should have evaluated and written a shadow row (not skipped)
    expect(enqueueWrite).toHaveBeenCalledWith('shadow_observations', expect.objectContaining({
      kind: 'weather_drift_decision',
      payload: expect.objectContaining({
        city: 'chicago',
        targetDate: '2026-06-01',
        bracketLabel: '39°F or below',
      }),
    }));
  });

  it('skips reconciled:weather position with unparseable question', async () => {
    mockSql.mockResolvedValue([
      makePos({
        sourcedFrom: 'reconciled:weather:mkt-1',
        question: 'This is not a valid weather question format',
      }),
    ]);
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);
    expect(enqueueWrite).not.toHaveBeenCalled();
  });

  it('does not trigger modal_against for tail bracket even with inversion', async () => {
    // Tail bracket, mockComputeBiasedProb returns forecastHigh=28 for a NO position
    // Even if the NO position's held-prob drops, tail must not emit modal_against
    mockParseWeatherEvent.mockReturnValue({
      city: 'chicago',
      targetDate: '2026-06-01',
      coords: { tz: 'America/Chicago' },
      brackets: [
        { label: '39°F or below', low: null, high: 39, marketId: 'mkt-1' }, // tail
      ],
    });
    mockSql.mockResolvedValue([makePos({ consensusProbability: null, entryPrice: 0.30 })]);
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.state).not.toBe('modal_against');
  });
});
