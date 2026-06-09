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
const mockCancelRestingWeatherOrder = vi.fn().mockResolvedValue('terminal' as const);

vi.mock('../weatherScanner.js', () => ({
  fetchWeatherEvents: mockFetchWeatherEvents,
  parseWeatherEvent: mockParseWeatherEvent,
  fetchForecast: mockFetchForecast,
  daysUntil: mockDaysUntil,
  cancelRestingWeatherOrder: mockCancelRestingWeatherOrder,
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

const mockDedup = vi.fn().mockResolvedValue(true);
vi.mock('../../shared/redis.js', () => ({ dedup: mockDedup }));

const mockGetPendingOrder = vi.fn().mockResolvedValue(null);
vi.mock('../../execution/pendingMakerOrders.js', () => ({
  getPendingOrder: mockGetPendingOrder,
}));

const mockGetMarket = vi.fn().mockResolvedValue({ clobTokenIds: '["tok-yes","tok-no"]', outcomePrices: '["0.35","0.65"]' });
const mockParseClobTokenIds = vi.fn().mockReturnValue(['tok-yes', 'tok-no']);
// Default: NO price = 0.65 (= entryPrice) → marketDrop = 0 → no market_against tier fires.
// Tests that need a crashed price override this.
const mockParseOutcomePrices = vi.fn().mockReturnValue(['0.35', '0.65']);
vi.mock('../../mapping/gamma.js', () => ({
  getMarket: mockGetMarket,
  parseClobTokenIds: mockParseClobTokenIds,
  parseOutcomePrices: mockParseOutcomePrices,
}));

// Default: no resting bid (market price unavailable) — tests that need a bid override this.
const mockGetClobOrderBook = vi.fn().mockResolvedValue(null);
vi.mock('../../shared/clob.js', () => ({ getClobOrderBook: mockGetClobOrderBook }));

const mockGetBookTouchLevels = vi.fn().mockReturnValue({ bestBid: null, bestAsk: null });
vi.mock('../../shared/bookTouch.js', () => ({ getBookTouchLevels: mockGetBookTouchLevels }));

const mockNotifyWeatherDrift = vi.fn().mockResolvedValue(undefined);
vi.mock('../../execution/telegram.js', () => ({
  notifyWeatherDrift: mockNotifyWeatherDrift,
}));

const mockTryWeatherExit = vi.fn().mockResolvedValue(false);
vi.mock('../weatherExit.js', () => ({
  tryWeatherExit: mockTryWeatherExit,
}));

const mockFetchLiveObservation = vi.fn().mockResolvedValue({
  city: 'chicago',
  targetDate: '2026-06-01',
  observedMax: null,
  source: 'none' as const,
  confidence: 'none' as const,
  observedAt: null,
});
const mockClassifyOracleState = vi.fn().mockReturnValue(null);
const mockClassifyContradiction = vi.fn().mockReturnValue(null);
vi.mock('../liveObservation.js', () => ({
  fetchLiveObservation: mockFetchLiveObservation,
  classifyOracleState: mockClassifyOracleState,
  classifyContradiction: mockClassifyContradiction,
}));

const mockClassifyFlipCandidate = vi.fn().mockReturnValue(null);
const mockTryWeatherFlip = vi.fn().mockResolvedValue({ executed: false, amountUsd: 0, reason: 'no_flip' });
vi.mock('../weatherFlip.js', () => ({
  classifyFlipCandidate: mockClassifyFlipCandidate,
  tryWeatherFlip: mockTryWeatherFlip,
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
    WEATHER_FORECAST_INVALIDATION_TTL_S: 21600,
    // Phase 3+4 live action knobs — all off by default
    WEATHER_DRIFT_ENABLED: false,
    WEATHER_DRIFT_BLOCK_SIZE_UP_ENABLED: false,
    WEATHER_DRIFT_CANCEL_RESTING_ENABLED: false,
    WEATHER_DRIFT_EXIT_ENABLED: false,
    WEATHER_DRIFT_SEVERE_DROP: 0.30,
    WEATHER_DRIFT_EXIT_MIN_BID: 0.10,
    WEATHER_DRIFT_EXIT_MAX_SLIPPAGE: 0.15,
    WEATHER_DRIFT_EXIT_MIN_DEPTH_RATIO: 0.90,
    WEATHER_DRIFT_EXIT_COOLDOWN_S: 1800,
    WEATHER_DRIFT_NOTIFY_DEDUP_S: 3600,
    WEATHER_DRIFT_MARKET_ADVERSE_DROP_EXIT: 0.50,
    WEATHER_DRIFT_MARKET_ADVERSE_DROP_NOTIFY: 0.65,
    WEATHER_DRIFT_MARKET_DIVERGENCE_NOTIFY: 0.55,
    // Phase 5/6 defaults
    WEATHER_DRIFT_LIVE_OBS_ENABLED: false,
    WEATHER_DRIFT_WU_LIVE_ENABLED: false,
    WEATHER_DRIFT_METAR_LIVE_ENABLED: false,
    WEATHER_DRIFT_HKO_LIVE_ENABLED: false,
    WEATHER_DRIFT_LIVE_OBS_MAX_AGE_MIN: 30,
    WEATHER_DRIFT_CONTRADICTION_AUDIT_ENABLED: false,
    WEATHER_DRIFT_CONTRADICTION_MIN_MODEL_MARKET_GAP: 0.55,
    WEATHER_DRIFT_MARKET_DEAD_BID: 0.05,
    WEATHER_DRIFT_FLIP_ENABLED: false,
    WEATHER_DRIFT_FLIP_CONFIRMED_ONLY: true,
    WEATHER_DRIFT_FLIP_MIN_EDGE_BPS: 500,
    WEATHER_DRIFT_FLIP_MAX_OPPOSITE_PRICE: 0.95,
    WEATHER_DRIFT_FLIP_MAX_CITY_NOTIONAL: 25,
    WEATHER_DRIFT_FLIP_MAX_SCAN_NOTIONAL: 50,
    WEATHER_DRIFT_EXACT_MODAL_MIN_RUNS: 1,
    WEATHER_DRIFT_EXACT_EXIT_MODAL_MIN_RUNS: 2,
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

  it('skipModalStreakAdvance: returns current Redis streak without incrementing', () => {
    // Simulates the drift scanner reading a streak that invalidation already wrote (=1).
    // Without the flag the helper would compute 1+1=2, corrupting shadow data.
    const input = makeThesisInput({
      pos: makePos({ direction: 'NO', consensusProbability: 0.20 }),
      bracket: { low: 28, high: 28 },
      forecast: makeForecast({ forecastHigh: 28.2 }), // rounds into bracket → inversion
      redisValues: { modalStreakRaw: '1', modalSupportedMarkerRaw: '1' },
      skipModalStreakAdvance: true,
    });
    const result = evaluateWeatherPositionThesis(input);
    // Streak must reflect the stored value (1), not 1+1=2.
    expect(result.modalStreak).toBe(1);
    expect(result.shouldWriteModalStreak).toBe(false);
    expect(result.shouldDeleteModalStreak).toBe(false);
    expect(result.shouldRefreshSupportedMarker).toBe(false);
    // Inversion is still detected correctly; only the advance is suppressed.
    expect(result.modalInversionRaw).toBe(true);
  });

  it('skipModalStreakAdvance: returns 0 streak when no prior streak exists', () => {
    const input = makeThesisInput({
      pos: makePos({ direction: 'NO', consensusProbability: 0.20 }),
      bracket: { low: 28, high: 28 },
      forecast: makeForecast({ forecastHigh: 28.2 }),
      redisValues: { modalStreakRaw: null, modalSupportedMarkerRaw: null },
      skipModalStreakAdvance: true,
    });
    const result = evaluateWeatherPositionThesis(input);
    expect(result.modalStreak).toBe(0);
    expect(result.shouldWriteModalStreak).toBe(false);
    expect(result.shouldDeleteModalStreak).toBe(false);
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

    // Default position: drop=0.40 ≥ severeDrop=0.30 → isActionable=true; DRIFT_ENABLED=false → wouldBlock=true
    expect(enqueueWrite).toHaveBeenCalledWith('shadow_observations', expect.objectContaining({
      kind: 'weather_drift_decision',
      source: 'arb',
      marketId: 'mkt-1',
      direction: 'NO',
      wouldBlock: true,
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

// ── Phase 3+4 live action tests ───────────────────────────────────────────────

describe('runWeatherDriftStrategy — Phase 3+4 live actions', () => {
  // Default: tail-bracket position → thesis_weakened (drop=0.40 ≥ severeDrop=0.30)
  // consensusProbability=0.30 → entryHeldProb(NO)=0.70; mock returns modelProb=0.70
  // → currentHeldProb(NO)=0.30; drop=0.40

  function setupThesisWeakenedPosition() {
    mockFetchWeatherEvents.mockResolvedValue([{}]);
    mockParseWeatherEvent.mockReturnValue({
      city: 'chicago',
      targetDate: '2026-06-01',
      coords: { tz: 'America/Chicago' },
      brackets: [{ label: '39°F or below', low: null, high: 39, marketId: 'mkt-1' }],
    });
    mockSql.mockResolvedValue([makePos()]);
    mockFetchForecast.mockResolvedValue(makeForecast());
  }

  // Interior bracket + NO position + forecast rounds into bracket + streak pre-seeded
  function setupModalAgainstPosition(redis: ReturnType<typeof makeRedis>) {
    mockFetchWeatherEvents.mockResolvedValue([{}]);
    mockParseWeatherEvent.mockReturnValue({
      city: 'hong kong',
      targetDate: '2026-06-01',
      coords: { tz: 'Asia/Hong_Kong' },
      brackets: [{ label: '28°C', low: 28, high: 28, marketId: 'mkt-1' }],
    });
    mockSql.mockResolvedValue([
      makePos({
        sourcedFrom: 'weather:hong kong:2026-06-01:28°C',
        direction: 'NO',
        consensusProbability: 0.20,
      }),
    ]);
    mockFetchForecast.mockResolvedValue(makeForecast({ forecastHigh: 28.2 }));
    // Pre-seed streak=1 (minRuns=1) and supported marker (guard B)
    redis._store.set('weather:forecast_modal_streak:pos-1', '1');
    redis._store.set('weather:forecast_modal_supported:pos-1', '1');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockDedup.mockResolvedValue(true); // first occurrence
    mockCityLocalDate.mockReturnValue('2026-06-01'); // matches event targetDate → isResolutionDay=true by default
    mockLoadConfig.mockReturnValue(makeConfig());
    setupThesisWeakenedPosition();
  });

  // ── Gate ────────────────────────────────────────────────────────────────────

  it('exits early when both WEATHER_DRIFT_SHADOW_ENABLED and WEATHER_DRIFT_ENABLED are false', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_SHADOW_ENABLED: false,
      WEATHER_DRIFT_ENABLED: false,
    }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('does NOT exit early when WEATHER_DRIFT_ENABLED=true even if WEATHER_DRIFT_SHADOW_ENABLED=false', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_SHADOW_ENABLED: false,
      WEATHER_DRIFT_ENABLED: true,
    }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);
    expect(mockSql).toHaveBeenCalled();
  });

  // ── wouldBlock ───────────────────────────────────────────────────────────────

  it('sets wouldBlock=true in shadow row when actionable but WEATHER_DRIFT_ENABLED=false', async () => {
    // thesis_weakened (drop=0.40 ≥ 0.30) + DRIFT_ENABLED=false → wouldBlock=true
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_DRIFT_ENABLED: false }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.wouldBlock).toBe(true);
    expect(call.payload.wouldBlock).toBe(true);
    expect(call.payload.isActionable).toBe(true);
  });

  it('sets wouldBlock=false when actionable and WEATHER_DRIFT_ENABLED=true', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_DRIFT_ENABLED: true }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.wouldBlock).toBe(false);
    expect(call.payload.wouldBlock).toBe(false);
  });

  it('sets wouldBlock=true for non-severe thesis_weakened (isBlockable but !isActionable)', async () => {
    // drop=0.40, SEVERE_DROP=0.50 → isActionable=false, but isBlockable=true (thesis_weakened)
    // wouldBlock must reflect the wider isBlockable gate, not just isActionable
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: false,
      WEATHER_DRIFT_SEVERE_DROP: 0.50,
    }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.isActionable).toBe(false);
    expect(call.wouldBlock).toBe(true);
    expect(call.payload.wouldBlock).toBe(true);
  });

  it('sets wouldBlock=false when state is stable (not actionable)', async () => {
    // entryPrice=0.30, consensusProbability=null → entryHeldProb=0.30
    // mockComputeBiasedProb returns currentHeldProb(NO)=0.30 → drop=0.00 < any threshold
    mockSql.mockResolvedValue([makePos({ consensusProbability: null, entryPrice: 0.30 })]);
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_DRIFT_ENABLED: false }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.isActionable).toBe(false);
    expect(call.wouldBlock).toBe(false);
  });

  // ── Notify ───────────────────────────────────────────────────────────────────

  it('calls notifyWeatherDrift on first actionable occurrence regardless of DRIFT_ENABLED', async () => {
    // Notify fires even when live actions are off — user always stays in the loop.
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_DRIFT_ENABLED: false }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    expect(mockNotifyWeatherDrift).toHaveBeenCalledOnce();
    const notifyArgs = mockNotifyWeatherDrift.mock.calls[0]![0] as any;
    expect(notifyArgs.positionId).toBe('pos-1');
    expect(notifyArgs.state).toBe('thesis_weakened');
    expect(notifyArgs.direction).toBe('NO');
    expect(notifyArgs.city).toBe('chicago');
  });

  it('does not re-notify when dedup key is already set', async () => {
    mockDedup.mockResolvedValue(false); // key already exists — not first occurrence
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_DRIFT_ENABLED: false }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    expect(mockNotifyWeatherDrift).not.toHaveBeenCalled();
  });

  it('notifyWeatherDrift action reflects actual live action taken', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_BLOCK_SIZE_UP_ENABLED: true,
    }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const notifyArgs = mockNotifyWeatherDrift.mock.calls[0]![0] as any;
    expect(notifyArgs.action).toBe('block_size_up');
  });

  it('notifyWeatherDrift action is notify when enabled but no sub-action fires', async () => {
    // All sub-actions disabled; only notify fires.
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_DRIFT_ENABLED: true }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const notifyArgs = mockNotifyWeatherDrift.mock.calls[0]![0] as any;
    expect(notifyArgs.action).toBe('notify');
  });

  it('does not notify when position is not actionable', async () => {
    // drop ≈ 0 → stable → isActionable=false
    mockSql.mockResolvedValue([makePos({ consensusProbability: null, entryPrice: 0.30 })]);
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    expect(mockNotifyWeatherDrift).not.toHaveBeenCalled();
    expect(mockDedup).not.toHaveBeenCalled();
  });

  // ── Block size-up ────────────────────────────────────────────────────────────

  it('writes forecast_invalidated key when WEATHER_DRIFT_BLOCK_SIZE_UP_ENABLED=true', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_BLOCK_SIZE_UP_ENABLED: true,
    }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const setCalls = vi.mocked(redis.set).mock.calls;
    const blockCall = setCalls.find((c) => c[0] === 'weather:forecast_invalidated:mkt-1:NO');
    expect(blockCall).toBeTruthy();
    // Payload should include driftState
    const stored = JSON.parse(blockCall![1] as string);
    expect(stored.driftState).toBe('thesis_weakened');
  });

  it('records action=block_size_up in shadow payload', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_BLOCK_SIZE_UP_ENABLED: true,
    }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.action).toBe('block_size_up');
  });

  it('does not write forecast_invalidated key when WEATHER_DRIFT_ENABLED=false', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: false,
      WEATHER_DRIFT_BLOCK_SIZE_UP_ENABLED: true,
    }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const setCalls = vi.mocked(redis.set).mock.calls;
    expect(setCalls.find((c) => c[0].startsWith('weather:forecast_invalidated:'))).toBeUndefined();
  });

  it('writes forecast_invalidated key for non-severe thesis_weakened (drop below SEVERE_DROP)', async () => {
    // Raise SEVERE_DROP above the default drop (0.40) → thesis_weakened but not actionable.
    // block_size_up uses the wider isBlockable gate and should still fire.
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_BLOCK_SIZE_UP_ENABLED: true,
      WEATHER_DRIFT_SEVERE_DROP: 0.50,  // drop=0.40 < 0.50 → not actionable, but isBlockable=true
    }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const setCalls = vi.mocked(redis.set).mock.calls;
    expect(setCalls.find((c) => c[0] === 'weather:forecast_invalidated:mkt-1:NO')).toBeTruthy();
  });

  it('writes forecast_invalidated key for first-scan modal_against with streak below minRuns', async () => {
    // streak=1 < MODAL_MIN_RUNS=2 → modal_against but not actionable (isBlockable=true, isActionable=false).
    // block_size_up should fire; notify/cancel/exit should not.
    const redis = makeRedis();
    setupModalAgainstPosition(redis); // seeds streak=1
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_BLOCK_SIZE_UP_ENABLED: true,
      WEATHER_FORECAST_INVALIDATION_MODAL_MIN_RUNS: 2,  // streak=1 < 2 → not actionable
    }));

    await runWeatherDriftStrategy(redis as any);

    // block_size_up key written
    const setCalls = vi.mocked(redis.set).mock.calls;
    expect(setCalls.find((c) => c[0].startsWith('weather:forecast_invalidated:'))).toBeTruthy();
    // Not actionable → no notification, no cancel attempt
    expect(mockNotifyWeatherDrift).not.toHaveBeenCalled();
    expect(mockCancelRestingWeatherOrder).not.toHaveBeenCalled();
    // action=block_size_up in shadow row
    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.action).toBe('block_size_up');
  });

  // ── Cancel resting ───────────────────────────────────────────────────────────

  it('cancels resting maker order for modal_against position', async () => {
    const redis = makeRedis();
    setupModalAgainstPosition(redis);
    const fakePendingOrder = { orderId: 'ord-1', price: 0.30, sourcedFrom: 'weather:hong kong:2026-06-01:28°C' };
    mockGetPendingOrder.mockResolvedValue(fakePendingOrder);
    mockCancelRestingWeatherOrder.mockResolvedValue('cancelled' as const);
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_CANCEL_RESTING_ENABLED: true,
    }));

    await runWeatherDriftStrategy(redis as any);

    expect(mockCancelRestingWeatherOrder).toHaveBeenCalledWith(
      expect.anything(),
      'mkt-1',
      'NO',
      fakePendingOrder,
      expect.objectContaining({ rule: 'drift_modal_against' }),
    );
    // Idempotency marker written
    const setCalls = vi.mocked(redis.set).mock.calls;
    expect(setCalls.find((c) => c[0] === 'weather:drift_cancelled_resting:pos-1')).toBeTruthy();
    // Action recorded
    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.action).toBe('cancel_resting');
  });

  it('does not re-cancel when idempotency marker is already set', async () => {
    const store = new Map<string, string>();
    store.set('weather:drift_cancelled_resting:pos-1', '1');
    const redis = makeRedis(store);
    setupModalAgainstPosition(redis);
    mockGetPendingOrder.mockResolvedValue({ orderId: 'ord-1', price: 0.30 });
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_CANCEL_RESTING_ENABLED: true,
    }));

    await runWeatherDriftStrategy(redis as any);

    expect(mockCancelRestingWeatherOrder).not.toHaveBeenCalled();
  });

  it('writes idempotency marker when cancelRestingWeatherOrder returns terminal', async () => {
    // 'terminal' = filled/partial/not-found — order is gone, no retry needed
    const redis = makeRedis();
    setupModalAgainstPosition(redis);
    mockGetPendingOrder.mockResolvedValue({ orderId: 'ord-1', price: 0.30 });
    mockCancelRestingWeatherOrder.mockResolvedValue('terminal' as const);
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_CANCEL_RESTING_ENABLED: true,
    }));

    await runWeatherDriftStrategy(redis as any);

    const setCalls = vi.mocked(redis.set).mock.calls;
    expect(setCalls.find((c) => c[0] === 'weather:drift_cancelled_resting:pos-1')).toBeTruthy();
  });

  it('does NOT write idempotency marker when cancelRestingWeatherOrder returns retry', async () => {
    // 'retry' = cancel API unconfirmed, order still live — must not suppress next scan
    const redis = makeRedis();
    setupModalAgainstPosition(redis);
    mockGetPendingOrder.mockResolvedValue({ orderId: 'ord-1', price: 0.30 });
    mockCancelRestingWeatherOrder.mockResolvedValue('retry' as const);
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_CANCEL_RESTING_ENABLED: true,
    }));

    await runWeatherDriftStrategy(redis as any);

    const setCalls = vi.mocked(redis.set).mock.calls;
    expect(setCalls.find((c) => c[0] === 'weather:drift_cancelled_resting:pos-1')).toBeUndefined();
  });

  it('skips cancel_resting when no resting maker order found', async () => {
    const redis = makeRedis();
    setupModalAgainstPosition(redis);
    mockGetPendingOrder.mockResolvedValue(null);
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_CANCEL_RESTING_ENABLED: true,
    }));

    await runWeatherDriftStrategy(redis as any);

    expect(mockCancelRestingWeatherOrder).not.toHaveBeenCalled();
  });

  it('does not call cancel_resting for thesis_weakened (not modal_against)', async () => {
    // Default position → thesis_weakened, not modal_against
    mockGetPendingOrder.mockResolvedValue({ orderId: 'ord-1', price: 0.60 });
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_CANCEL_RESTING_ENABLED: true,
    }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    expect(mockCancelRestingWeatherOrder).not.toHaveBeenCalled();
  });

  // ── Exit ─────────────────────────────────────────────────────────────────────

  it('calls tryWeatherExit on resolution day when WEATHER_DRIFT_EXIT_ENABLED=true', async () => {
    // isResolutionDay = (event.targetDate === cityLocalDate(tz))
    // mockCityLocalDate returns '2026-06-01' and targetDate is '2026-06-01' → true
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_EXIT_ENABLED: true,
    }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    expect(mockTryWeatherExit).toHaveBeenCalledOnce();
    const exitArgs = mockTryWeatherExit.mock.calls[0]![0] as any;
    expect(exitArgs.pos.id).toBe('pos-1');
    expect(exitArgs.isResolutionDay).toBe(true);
    expect(exitArgs.useMarketFloor).toBe(true);
    expect(exitArgs.exitReason).toBe('weather_drift');
    expect(exitArgs.shadowKind).toBe('weather_drift_exit');
    expect(exitArgs.logMarker).toBe('[weather-drift]');
    expect(exitArgs.exitedKey).toBe('weather:forecast_exited:pos-1');
    expect(exitArgs.exitCooldownKey).toBe('weather:drift_exit_cooldown:pos-1');
    expect(exitArgs.minDepthRatio).toBe(0.90);
  });

  it('does not call tryWeatherExit when not resolution day', async () => {
    mockCityLocalDate.mockReturnValue('2026-06-02'); // different from targetDate
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_EXIT_ENABLED: true,
    }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    expect(mockTryWeatherExit).not.toHaveBeenCalled();
  });

  it('records action=exit in shadow payload when tryWeatherExit succeeds', async () => {
    mockTryWeatherExit.mockResolvedValue(true);
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_EXIT_ENABLED: true,
    }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.action).toBe('exit');
  });

  it('exit takes priority over cancel_resting in action field', async () => {
    // Both enabled; exit fires first and sets action='exit' — cancel should not run.
    mockTryWeatherExit.mockResolvedValue(true);
    const redis = makeRedis();
    setupModalAgainstPosition(redis);
    mockGetPendingOrder.mockResolvedValue({ orderId: 'ord-1', price: 0.30 });
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_EXIT_ENABLED: true,
      WEATHER_DRIFT_CANCEL_RESTING_ENABLED: true,
    }));

    await runWeatherDriftStrategy(redis as any);

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.action).toBe('exit');
    // cancel_resting is skipped because action was already set to 'exit'
    expect(mockCancelRestingWeatherOrder).not.toHaveBeenCalled();
  });

  it('does not write forecast_invalidated key when exit already succeeded', async () => {
    // block_size_up is redundant after a successful exit — position is sold
    mockTryWeatherExit.mockResolvedValue(true);
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_EXIT_ENABLED: true,
      WEATHER_DRIFT_BLOCK_SIZE_UP_ENABLED: true,
    }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const setCalls = vi.mocked(redis.set).mock.calls;
    expect(setCalls.find((c) => c[0].startsWith('weather:forecast_invalidated:'))).toBeUndefined();
  });

  // ── market_against ────────────────────────────────────────────────────────
  // Uses the default thesis_weakened position (entryPrice=0.65, drop=0.40).
  // Tests override getClobOrderBook/getBookTouchLevels to simulate various bid levels.

  it('classifies market_against (Tier 2) when bid drops > NOTIFY threshold and model-market gap > DIVERGENCE', async () => {
    // entryPrice=0.65, currentHeldBid=0.10 → marketDrop=(0.65-0.10)/0.65≈0.846 ≥ 0.65
    // currentHeldProb=0.30 (from computeBiasedProb mock), modelMarketGap=0.30-0.10=0.20 < 0.55
    // → Tier 2 NOT met on default drop (0.40) position alone.
    // Override: model stays high (entryPrice=0.50, consensusProbability=null → entryHeldProb=0.50)
    // but use a stable (low-drop) position with a very high model prob to trigger divergence.
    mockSql.mockResolvedValue([makePos({ consensusProbability: null, entryPrice: 0.50 })]);
    // computeBiasedProb returns modelProbability=0.70 → currentHeldProb(NO)=1-0.30=0.70... wait
    // Actually: for NO, currentHeldProb = 1 - modelProbability = 1 - 0.70 = 0.30 based on mock.
    // We need high currentHeldProb. Change: set direction=YES so currentHeldProb=modelProbability=0.70.
    mockSql.mockResolvedValue([makePos({ direction: 'YES', consensusProbability: null, entryPrice: 0.50,
      sourcedFrom: 'weather:chicago:2026-06-01:39°F or below' })]);
    mockGetClobOrderBook.mockResolvedValue({ bids: [], asks: [] });
    // Bid at 0.05: entryPrice=0.50, marketDrop=(0.50-0.05)/0.50=0.90 ≥ 0.65 ✓
    // currentHeldProb=0.70 (YES, modelProb=0.70), modelMarketGap=0.70-0.05=0.65 ≥ 0.55 ✓
    // drop = entryHeldProb(0.50) - currentHeldProb(0.70) = -0.20 (model improved) < SEVERE → Tier 1 NOT met
    mockGetBookTouchLevels.mockReturnValue({ bestBid: { price: 0.05 }, bestAsk: null });
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_DRIFT_SHADOW_ENABLED: true }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.state).toBe('market_against');
    expect(call.payload.marketAgainstTier).toBe(2);
  });

  it('classifies market_against (Tier 1) when bid and model both drop enough', async () => {
    // thesis_weakened default: entryPrice=0.65, direction=NO, drop=0.40 ≥ severeDrop=0.30
    // Provide a bid that gives marketDrop ≥ 0.50: bid=0.20 → (0.65-0.20)/0.65≈0.692 ≥ 0.50 ✓
    // drop=0.40 ≥ SEVERE_DROP=0.30 ✓  →  Tier 1 met
    mockGetClobOrderBook.mockResolvedValue({ bids: [], asks: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestBid: { price: 0.20 }, bestAsk: null });
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.state).toBe('market_against');
    expect(call.payload.marketAgainstTier).toBe(1);
  });

  it('does NOT classify market_against when bid drop is below NOTIFY threshold', async () => {
    // entryPrice=0.65, bid=0.40 → marketDrop=(0.65-0.40)/0.65≈0.385 — below both 0.50 and 0.65
    mockGetClobOrderBook.mockResolvedValue({ bids: [], asks: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestBid: { price: 0.40 }, bestAsk: null });
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    // thesis_weakened from forecast (drop=0.40 ≥ thesisWeakenedDrop=0.20) but NOT market_against
    expect(call.payload.state).toBe('thesis_weakened');
    expect(call.payload.marketAgainstTier).toBeNull();
  });

  it('market_against Tier 2 fires notify on any day (not just resolution day)', async () => {
    // Tier 2 should notify pre-resolution — simulate daysOut=1
    mockCityLocalDate.mockReturnValue('2026-05-31'); // differs from targetDate '2026-06-01'
    mockSql.mockResolvedValue([makePos({ direction: 'YES', consensusProbability: null, entryPrice: 0.50,
      sourcedFrom: 'weather:chicago:2026-06-01:39°F or below' })]);
    mockGetClobOrderBook.mockResolvedValue({ bids: [], asks: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestBid: { price: 0.05 }, bestAsk: null });
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_SHADOW_ENABLED: true,
    }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    expect(mockNotifyWeatherDrift).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'market_against', marketAgainstTier: 2 }),
    );
  });

  it('market_against Tier 2 does NOT attempt exit (notify-only)', async () => {
    // Tier 2 only: market moved but model stable (no severe drop) → exit should not fire
    mockSql.mockResolvedValue([makePos({ direction: 'YES', consensusProbability: null, entryPrice: 0.50,
      sourcedFrom: 'weather:chicago:2026-06-01:39°F or below' })]);
    mockGetClobOrderBook.mockResolvedValue({ bids: [], asks: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestBid: { price: 0.05 }, bestAsk: null });
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_EXIT_ENABLED: true,
    }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    expect(mockTryWeatherExit).not.toHaveBeenCalled();
    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.action).toBe('notify');
  });

  it('market_against Tier 1 attempts exit on resolution day when EXIT_ENABLED', async () => {
    // Tier 1: marketDrop ≥ 0.50 AND drop ≥ SEVERE_DROP — exit should fire
    mockTryWeatherExit.mockResolvedValue(true);
    mockGetClobOrderBook.mockResolvedValue({ bids: [], asks: [] });
    // entryPrice=0.65, bid=0.20 → marketDrop≈0.692 ≥ 0.50 ✓; drop=0.40 ≥ 0.30 ✓
    mockGetBookTouchLevels.mockReturnValue({ bestBid: { price: 0.20 }, bestAsk: null });
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_EXIT_ENABLED: true,
    }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    expect(mockTryWeatherExit).toHaveBeenCalledWith(
      expect.objectContaining({ exitReason: 'weather_drift', extraContext: expect.objectContaining({ driftState: 'market_against', marketAgainstTier: 1 }) }),
    );
    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.action).toBe('exit');
    expect(call.payload.marketAgainstTier).toBe(1);
  });

  it('market_against shadow row includes currentHeldBid and marketDrop fields', async () => {
    mockGetClobOrderBook.mockResolvedValue({ bids: [], asks: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestBid: { price: 0.20 }, bestAsk: null });
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.currentHeldBid).toBeCloseTo(0.20, 4);
    expect(call.payload.marketDrop).toBeCloseTo((0.65 - 0.20) / 0.65, 2);
  });

  it('uses Gamma outcomePrices as fallback bid when CLOB returns no bid', async () => {
    // CLOB book exists but has no resting bid (crashed position).
    // Gamma outcomePrices for direction=NO (index 1) = '0.05' → bid fallback = 0.05.
    // entryPrice=0.65 (default pos), marketDrop=(0.65-0.05)/0.65≈0.923 ≥ 0.50 ✓
    // drop=0.40 ≥ SEVERE_DROP=0.30 ✓ → Tier 1
    mockGetClobOrderBook.mockResolvedValue({ bids: [], asks: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestBid: null, bestAsk: null });
    // Override outcomePrices: NO (index 1) = 0.05
    mockParseOutcomePrices.mockReturnValue(['0.95', '0.05']);
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.state).toBe('market_against');
    expect(call.payload.marketAgainstTier).toBe(1);
    expect(call.payload.bidSource).toBe('gamma');
  });

  it('does not classify market_against when CLOB returns no bid AND Gamma price is above DROP_EXIT threshold', async () => {
    // CLOB no bid; Gamma NO price = 0.50 → marketDrop=(0.65-0.50)/0.65≈0.23 — below 0.50
    mockGetClobOrderBook.mockResolvedValue({ bids: [], asks: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestBid: null, bestAsk: null });
    mockParseOutcomePrices.mockReturnValue(['0.50', '0.50']);
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.state).toBe('thesis_weakened'); // falls back to forecast state
    expect(call.payload.marketAgainstTier).toBeNull();
    expect(call.payload.bidSource).toBe('gamma');
  });

  it('uses Gamma fallback when getClobOrderBook throws', async () => {
    // Network error on CLOB fetch → catch block falls back to gammaBidFallback.
    // Gamma NO price = 0.05 → Tier 1 fires same as the no-bid path.
    mockGetClobOrderBook.mockRejectedValue(new Error('CLOB timeout'));
    mockParseOutcomePrices.mockReturnValue(['0.95', '0.05']);
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.state).toBe('market_against');
    expect(call.payload.marketAgainstTier).toBe(1);
    expect(call.payload.bidSource).toBe('gamma');
  });

  it('market_against Tier 1 uses dedup key containing market_against:t1', async () => {
    mockGetClobOrderBook.mockResolvedValue({ bids: [], asks: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestBid: { price: 0.20 }, bestAsk: null });
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_DRIFT_SHADOW_ENABLED: true }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const dedupCalls = vi.mocked(mockDedup).mock.calls;
    expect(dedupCalls.some((c) => String(c[0]).includes('market_against:t1'))).toBe(true);
  });

  it('market_against Tier 2 uses dedup key containing market_against:t2', async () => {
    // Tier 2: model stable (drop < SEVERE), large market+divergence
    mockSql.mockResolvedValue([makePos({ direction: 'YES', consensusProbability: null, entryPrice: 0.50,
      sourcedFrom: 'weather:chicago:2026-06-01:39°F or below' })]);
    mockGetClobOrderBook.mockResolvedValue({ bids: [], asks: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestBid: { price: 0.05 }, bestAsk: null });
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_DRIFT_SHADOW_ENABLED: true }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const dedupCalls = vi.mocked(mockDedup).mock.calls;
    expect(dedupCalls.some((c) => String(c[0]).includes('market_against:t2'))).toBe(true);
  });

  // ── Phase 5: live observation + oracle state ────────────────────────────────

  it('does not fetch live observation when all per-source flags are off', async () => {
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);
    expect(mockFetchLiveObservation).not.toHaveBeenCalled();
  });

  it('fetches live observation when WU_LIVE_ENABLED is true', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_DRIFT_WU_LIVE_ENABLED: true }));
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);
    expect(mockFetchLiveObservation).toHaveBeenCalledWith(
      'chicago',
      '2026-06-01',
      expect.anything(),
      expect.objectContaining({ wuEnabled: true }),
    );
  });

  it('shadow_observations payload includes observedMax and observedSource when live obs available', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_DRIFT_WU_LIVE_ENABLED: true }));
    mockFetchLiveObservation.mockResolvedValue({
      city: 'chicago', targetDate: '2026-06-01',
      observedMax: 32, source: 'wu-live', confidence: 'settlement_aligned', observedAt: '2026-06-01T12:00:00Z',
    });
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    // The weather_live_observation shadow row.
    const liveObsCall = vi.mocked(enqueueWrite).mock.calls.find(
      (c) => (c[1] as any).kind === 'weather_live_observation',
    );
    expect(liveObsCall).toBeDefined();
    expect((liveObsCall![1] as any).payload.observedMax).toBe(32);
    expect((liveObsCall![1] as any).payload.source).toBe('wu-live');

    // The main drift_decision row also has observedMax.
    const driftCall = vi.mocked(enqueueWrite).mock.calls.find(
      (c) => (c[1] as any).kind === 'weather_drift_decision',
    );
    expect((driftCall![1] as any).payload.observedMax).toBe(32);
    expect((driftCall![1] as any).payload.observedSource).toBe('wu-live');
  });

  it('writes weather_live_observation row even when WEATHER_DRIFT_LIVE_OBS_ENABLED=false', async () => {
    // shadow rows are always written when a fetch succeeds
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_WU_LIVE_ENABLED: true,
      WEATHER_DRIFT_LIVE_OBS_ENABLED: false,
    }));
    mockFetchLiveObservation.mockResolvedValue({
      city: 'chicago', targetDate: '2026-06-01',
      observedMax: 30, source: 'wu-live', confidence: 'settlement_aligned', observedAt: '2026-06-01T10:00:00Z',
    });
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const liveObsCall = vi.mocked(enqueueWrite).mock.calls.find(
      (c) => (c[1] as any).kind === 'weather_live_observation',
    );
    expect(liveObsCall).toBeDefined();
  });

  it('oracle state overrides forecast state when LIVE_OBS_ENABLED=true and classifyOracleState returns oracle_impossible', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_WU_LIVE_ENABLED: true,
      WEATHER_DRIFT_LIVE_OBS_ENABLED: true,
    }));
    mockFetchLiveObservation.mockResolvedValue({
      city: 'chicago', targetDate: '2026-06-01',
      observedMax: 45, source: 'wu-live', confidence: 'settlement_aligned', observedAt: '2026-06-01T14:00:00Z',
    });
    mockClassifyOracleState.mockReturnValue('oracle_impossible');
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const driftCall = vi.mocked(enqueueWrite).mock.calls.find(
      (c) => (c[1] as any).kind === 'weather_drift_decision',
    );
    expect((driftCall![1] as any).payload.state).toBe('oracle_impossible');
    expect((driftCall![1] as any).payload.oracleState).toBe('oracle_impossible');
  });

  it('oracle state does NOT override forecast state when LIVE_OBS_ENABLED=false', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_WU_LIVE_ENABLED: true,
      WEATHER_DRIFT_LIVE_OBS_ENABLED: false,  // disabled
    }));
    mockFetchLiveObservation.mockResolvedValue({
      city: 'chicago', targetDate: '2026-06-01',
      observedMax: 45, source: 'wu-live', confidence: 'settlement_aligned', observedAt: '2026-06-01T14:00:00Z',
    });
    mockClassifyOracleState.mockReturnValue('oracle_impossible');
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const driftCall = vi.mocked(enqueueWrite).mock.calls.find(
      (c) => (c[1] as any).kind === 'weather_drift_decision',
    );
    // forecast state should apply (stable/watch/etc), not oracle
    expect((driftCall![1] as any).payload.state).not.toBe('oracle_impossible');
  });

  it('writes weather_market_oracle_contradiction row when CONTRADICTION_AUDIT_ENABLED and classifyContradiction returns non-null', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_CONTRADICTION_AUDIT_ENABLED: true,
    }));
    mockClassifyContradiction.mockReturnValue('market_contradicts_model');
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const contradictionCall = vi.mocked(enqueueWrite).mock.calls.find(
      (c) => (c[1] as any).kind === 'weather_market_oracle_contradiction',
    );
    expect(contradictionCall).toBeDefined();
    expect((contradictionCall![1] as any).payload.contradictionClass).toBe('market_contradicts_model');
    expect((contradictionCall![1] as any).payload.requiresOracleAudit).toBe(true);
  });

  it('does not write contradiction row when classifyContradiction returns null', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_CONTRADICTION_AUDIT_ENABLED: true,
    }));
    mockClassifyContradiction.mockReturnValue(null);
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    const contradictionCalls = vi.mocked(enqueueWrite).mock.calls.filter(
      (c) => (c[1] as any).kind === 'weather_market_oracle_contradiction',
    );
    expect(contradictionCalls).toHaveLength(0);
  });

  // ── Phase 6: flip strategy ──────────────────────────────────────────────────

  it('classifyFlipCandidate is called when action is still none after earlier gates', async () => {
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);
    expect(mockClassifyFlipCandidate).toHaveBeenCalled();
  });

  it('classifyFlipCandidate is called but tryWeatherFlip is NOT executed when exit already fired', async () => {
    mockTryWeatherExit.mockResolvedValue(true);
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_EXIT_ENABLED: true,
      WEATHER_DRIFT_FLIP_ENABLED: true,
    }));
    // market_against Tier 1 triggers exit on resolution day
    mockGetClobOrderBook.mockResolvedValue({ bids: [], asks: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestBid: { price: 0.20 }, bestAsk: null });
    // Classify returns a candidate to ensure tryWeatherFlip would be called IF the gate passed
    mockClassifyFlipCandidate.mockReturnValue('confirmed_flip');
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    // Flip classification runs unconditionally for shadow data, but execution is gated.
    expect(mockClassifyFlipCandidate).toHaveBeenCalled();
    // Position was already exited — action=exit means tryWeatherFlip must NOT fire.
    expect(mockTryWeatherFlip).not.toHaveBeenCalled();
  });

  it('does not execute flip when WEATHER_DRIFT_FLIP_ENABLED=false', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_FLIP_ENABLED: false,
    }));
    mockClassifyFlipCandidate.mockReturnValue('confirmed_flip');
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    expect(mockTryWeatherFlip).not.toHaveBeenCalled();
  });

  it('executes flip when FLIP_ENABLED=true and classifyFlipCandidate returns confirmed_flip', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_FLIP_ENABLED: true,
    }));
    mockClassifyFlipCandidate.mockReturnValue('confirmed_flip');
    mockTryWeatherFlip.mockResolvedValue({ executed: true, amountUsd: 7.5, reason: 'flip_executed' });
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    expect(mockTryWeatherFlip).toHaveBeenCalledWith(
      expect.objectContaining({
        flipCandidateClass: 'confirmed_flip',
        confirmedOnly: true,
      }),
    );
    const driftCall = vi.mocked(enqueueWrite).mock.calls.find(
      (c) => (c[1] as any).kind === 'weather_drift_decision',
    );
    expect((driftCall![1] as any).payload.action).toBe('flip');
    expect((driftCall![1] as any).payload.flipCandidateClass).toBe('confirmed_flip');
  });

  it('flip action does not fire when heldTokenId is null (market fetch failed)', async () => {
    mockGetMarket.mockRejectedValue(new Error('market unavailable'));
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_FLIP_ENABLED: true,
    }));
    mockClassifyFlipCandidate.mockReturnValue('confirmed_flip');
    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    expect(mockTryWeatherFlip).not.toHaveBeenCalled();
  });

  it('scan notional used accumulates across positions in a single scan', async () => {
    // Two positions in one scan — verify second position gets reduced notional budget.
    // Set up two positions.
    const pos1 = makePos({ id: 'pos-1' });
    const pos2 = makePos({ id: 'pos-2', marketId: 'mkt-2' });
    mockSql.mockResolvedValue([pos1, pos2]);
    mockGetMarket.mockResolvedValue({ clobTokenIds: '["tok-yes","tok-no"]', outcomePrices: '["0.35","0.65"]' });
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_FLIP_ENABLED: true,
      WEATHER_DRIFT_FLIP_MAX_SCAN_NOTIONAL: 10,
    }));
    mockClassifyFlipCandidate.mockReturnValue('confirmed_flip');
    mockTryWeatherFlip
      .mockResolvedValueOnce({ executed: true, amountUsd: 7.5, reason: 'flip_executed' })
      .mockResolvedValueOnce({ executed: false, amountUsd: 0, reason: 'scan_notional_cap' });

    const redis = makeRedis();
    await runWeatherDriftStrategy(redis as any);

    // Second tryWeatherFlip call should have remainingScanNotional = 10 - 7.5 = 2.5
    const secondCall = mockTryWeatherFlip.mock.calls[1]!;
    expect(secondCall[0].remainingScanNotional).toBeCloseTo(2.5, 2);
  });

  it('cancel_resting still fires when forecastState=modal_against and state=market_against', async () => {
    // modal_against position (forecastState) + Tier 1 market signal active but exit disabled
    // cancel_resting is gated on forecastState=modal_against, not final state,
    // so it should still execute even though final state = market_against.
    const redis = makeRedis();
    setupModalAgainstPosition(redis);
    // Tier 1: entryPrice=0.65, bid=0.20 → marketDrop≈0.692 ≥ 0.50; drop=0.40 ≥ 0.30 (biased mock)
    // Actually modal_against position has consensusProbability=0.20 (direction=NO)
    // → currentHeldProb(NO) = 1 - modelProbability(0.70) = 0.30; entryHeldProb = 1 - 0.20 = 0.80
    // → drop = 0.80 - 0.30 = 0.50 ≥ severeDrop=0.30 ✓
    // The mock for computeBiasedProb returns modelProbability=0.70 regardless.
    // entryPrice from makePos default = 0.65; bid=0.20 → marketDrop≈0.692 ≥ 0.50 ✓
    mockGetClobOrderBook.mockResolvedValue({ bids: [], asks: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestBid: { price: 0.20 }, bestAsk: null });
    mockGetPendingOrder.mockResolvedValue({ orderId: 'ord-1', price: 0.30 });
    mockCancelRestingWeatherOrder.mockResolvedValue('cancelled' as const);
    mockLoadConfig.mockReturnValue(makeConfig({
      WEATHER_DRIFT_ENABLED: true,
      WEATHER_DRIFT_CANCEL_RESTING_ENABLED: true,
      WEATHER_DRIFT_EXIT_ENABLED: false,
    }));

    await runWeatherDriftStrategy(redis as any);

    expect(mockCancelRestingWeatherOrder).toHaveBeenCalled();
    const call = vi.mocked(enqueueWrite).mock.calls[0]![1] as any;
    expect(call.payload.state).toBe('market_against');
    expect(call.payload.action).toBe('cancel_resting');
  });
});
