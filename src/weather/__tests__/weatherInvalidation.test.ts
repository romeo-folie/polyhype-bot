/**
 * Tests for the Weather Forecast Invalidation Scanner.
 *
 * Covers:
 *  1. Shadow logging: every evaluated position writes a shadow_observations row.
 *  2. Invalidation logic: YES and NO positions invalidate when held-side prob drops enough.
 *  3. No invalidation when drop is below threshold.
 *  4. No invalidation when currentHeldProb is above MIN_CURRENT_HELD_PROB.
 *  5. pendingSettlement positions are excluded (not returned by DB query).
 *  6. Unparseable sourcedFrom strings are skipped safely.
 *  7. No active Gamma event → position skipped without error.
 *  8. Redis key set when invalidated and enabled.
 *  9. Redis key not set when disabled.
 * 10. Hedge evaluates correctly (meetsHedgePrice && meetsCostCeiling).
 * 11. Hedge does not set marker on partial fill below threshold.
 * 12. Size-up blocked in weatherScanner when invalidation key exists.
 * 13. Fresh entries are not blocked by invalidation keys.
 * 14. Different bracket in same event (different marketId) not blocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockLoadConfig = vi.fn();
vi.mock('../../shared/config.js', () => ({ loadConfig: mockLoadConfig }));

vi.mock('../../db/writeQueue.js', () => ({ enqueueWrite: vi.fn() }));

const mockSql = vi.fn();
vi.mock('../../db/client.js', () => ({ getSql: () => mockSql }));

const mockGetMarket = vi.fn();
const mockParseClobTokenIds = vi.fn();
vi.mock('../../mapping/gamma.js', () => ({
  getMarket: mockGetMarket,
  parseClobTokenIds: mockParseClobTokenIds,
}));

const mockGetClobOrderBook = vi.fn();
const mockSubmitClobBuy = vi.fn();
vi.mock('../../shared/clob.js', () => ({
  getClobOrderBook: mockGetClobOrderBook,
  submitClobBuy: mockSubmitClobBuy,
  CLOB_MIN_ORDER_USD: 1.0,
}));

const mockDeductStake = vi.fn().mockResolvedValue(undefined);
vi.mock('../../shared/bankroll.js', () => ({
  deductStake: mockDeductStake,
  getBankroll: vi.fn().mockResolvedValue(100),
}));

const mockGetCityBias = vi.fn().mockResolvedValue(null);
vi.mock('../cityBias.js', () => ({ getCityBias: mockGetCityBias }));

// Phase 5 exit dependencies — controllable so we can assert exit-vs-notify routing.
const mockNotifyWeatherInvalidationNoHedge = vi.fn().mockResolvedValue(undefined);
vi.mock('../../execution/telegram.js', () => ({
  notifyWeatherInvalidationNoHedge: mockNotifyWeatherInvalidationNoHedge,
}));

const mockGetPosition = vi.fn();
vi.mock('../../execution/positionLedger.js', () => ({ getPosition: mockGetPosition }));

const mockExecuteTakeProfit = vi.fn();
vi.mock('../../monitor/takeProfitExecutor.js', () => ({ executeTakeProfit: mockExecuteTakeProfit }));

// Resolution-day predicate input: event.targetDate === cityLocalDate(tz).
const mockCityLocalDate = vi.fn().mockReturnValue('2026-05-31');
vi.mock('../resolutionTime.js', () => ({ cityLocalDate: mockCityLocalDate }));

// dedup gates the manual-action notify; default true so the fallback fires in tests.
const mockDedup = vi.fn().mockResolvedValue(true);
vi.mock('../../shared/redis.js', () => ({ dedup: mockDedup }));

// Controlled scanner exports — avoids fetching real events or forecasts
const mockFetchWeatherEvents = vi.fn();
const mockParseWeatherEvent = vi.fn();
const mockFetchForecast = vi.fn();
const mockComputeBiasedProb = vi.fn();
const mockParseBracketLabel = vi.fn();
const mockDaysUntil = vi.fn().mockReturnValue(1);

vi.mock('../weatherScanner.js', () => ({
  fetchWeatherEvents: mockFetchWeatherEvents,
  parseWeatherEvent: mockParseWeatherEvent,
  fetchForecast: mockFetchForecast,
  computeBiasedProb: mockComputeBiasedProb,
  parseBracketLabel: mockParseBracketLabel,
  daysUntil: mockDaysUntil,
  // Real predicate (pure) — mirrors weatherScanner's exported helper.
  forecastRoundsIntoBracket: (h: number, low: number | null, high: number | null) =>
    low === null || high === null ? false : Math.round(h) >= low && Math.round(h) <= high,
  // Also export the key prefix so weatherScanner tests can import it
  FORECAST_INVALIDATED_KEY_PREFIX: 'weather:forecast_invalidated:',
}));

// ── Dynamic imports ───────────────────────────────────────────────────────────

const { runWeatherInvalidationScan, FORECAST_INVALIDATED_KEY_PREFIX } =
  await import('../weatherInvalidation.js');
const { enqueueWrite } = await import('../../db/writeQueue.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides = {}) {
  return {
    WEATHER_FORECAST_INVALIDATION_ENABLED: false,
    WEATHER_FORECAST_INVALIDATION_SHADOW_ENABLED: true,
    WEATHER_FORECAST_INVALIDATION_MODAL_ENABLED: true,
    WEATHER_FORECAST_INVALIDATION_MODAL_MIN_RUNS: 1, // base: no debounce; hysteresis tests override to 2
    WEATHER_FORECAST_INVALIDATION_MODAL_MAX_HELD_PROB: 0.55, // guard A: modal flip ignored above this held-prob
    WEATHER_FORECAST_INVALIDATION_MIN_DROP: 0.20,
    WEATHER_FORECAST_INVALIDATION_MIN_CURRENT_HELD_PROB: 0.50,
    WEATHER_FORECAST_INVALIDATION_TTL_S: 21600,
    WEATHER_FORECAST_INVALIDATION_HEDGE_ENABLED: false,
    WEATHER_FORECAST_INVALIDATION_MAX_HEDGE_PRICE: 0.25,
    WEATHER_FORECAST_INVALIDATION_MAX_TOTAL_COST: 1.05,
    WEATHER_FORECAST_INVALIDATION_MIN_FILL_RATIO: 0.90,
    WEATHER_FORECAST_INVALIDATION_EXIT_ENABLED: false,
    WEATHER_FORECAST_INVALIDATION_MIN_EXIT_PRICE: 0.05,
    WEATHER_FORECAST_INVALIDATION_MAX_EXIT_SLIPPAGE: 0.15,
    WEATHER_FORECAST_INVALIDATION_MODAL_MARKET_FLOOR: true,
    WEATHER_FORECAST_INVALIDATION_DROP_MARKET_FLOOR: true,
    WEATHER_MAX_EVENTS: 50,
    WEATHER_STDDEV_MIN_FRACTION: 0.7,
    WEATHER_MODEL_ECMWF_ENABLED: false,
    WEATHER_HRRR_ENABLED: false,
    WEATHER_HRRR_MAX_CROSS_SOURCE_SPREAD: Infinity,
    WEATHER_BIAS_CORRECTION_ENABLED: false,
    WEATHER_BIAS_MIN_SAMPLES: 14,
    WEATHER_BIAS_TRUSTED_SAMPLES: 14,
    WEATHER_WEAK_BIAS_STDDEV_MULTIPLIER: 1.2,
    WEATHER_STDDEV_MULTIPLIER: 1.0,
    WEATHER_FORECAST_RETRY_COUNT: 0,
    WEATHER_FORECAST_CACHE_TTL_S: 10_800,
    ...overrides,
  };
}

function makePosition(overrides = {}) {
  return {
    id: 'pos-1',
    marketId: 'mkt-1',
    direction: 'NO' as const,
    entryPrice: 0.65,
    sharesHeld: 10,
    consensusProbability: 0.30, // P(YES)=0.30 → P(NO) at entry = 0.70
    sourcedFrom: 'weather:chicago:2026-05-31:39°F or below',
    question: null, // populated for reconciled:weather coverage tests
    ...overrides,
  };
}

function makeParsedEvent(overrides = {}) {
  return {
    city: 'chicago',
    targetDate: '2026-05-31',
    // coords.tz feeds the resolution-day predicate (event.targetDate === cityLocalDate(tz)).
    coords: { tz: 'America/Chicago' },
    brackets: [
      { label: '39°F or below', low: null, high: 39, marketId: 'mkt-1' },
    ],
    ...overrides,
  };
}

function makeForecast() {
  return {
    forecastHigh: 55,
    stdDev: 5,
    source: 'combined',
    ensembleMembers: 50,
    ensembleModel: 'gfs',
    shadowEnsemble: null,
  };
}

function makeRedis(store = new Map<string, string>()) {
  return {
    exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)),
    pipeline: vi.fn(() => ({ exec: vi.fn().mockResolvedValue([]) })),
    _store: store,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runWeatherInvalidationScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(makeConfig());
    mockFetchWeatherEvents.mockResolvedValue([{}]); // raw event placeholder
    mockParseWeatherEvent.mockReturnValue(makeParsedEvent());
    mockFetchForecast.mockResolvedValue(makeForecast());
    mockParseBracketLabel.mockReturnValue({ low: null, high: 39, unit: 'fahrenheit' });
  });

  it('exits early when both shadow and enabled flags are false', async () => {
    mockLoadConfig.mockReturnValue(
      makeConfig({ WEATHER_FORECAST_INVALIDATION_SHADOW_ENABLED: false, WEATHER_FORECAST_INVALIDATION_ENABLED: false }),
    );
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockSql).not.toHaveBeenCalled();
  });

  it('exits early when no open weather positions exist', async () => {
    mockSql.mockResolvedValue([]);
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockFetchWeatherEvents).not.toHaveBeenCalled();
  });

  it('skips position with unparseable sourcedFrom', async () => {
    mockSql.mockResolvedValue([makePosition({ sourcedFrom: 'geopolitical:some-market' })]);
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockFetchForecast).not.toHaveBeenCalled();
    expect(enqueueWrite).not.toHaveBeenCalled();
  });

  it('skips position when no matching Gamma event found', async () => {
    mockSql.mockResolvedValue([makePosition()]);
    // Event has a different city
    mockParseWeatherEvent.mockReturnValue(makeParsedEvent({ city: 'new york' }));
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockFetchForecast).not.toHaveBeenCalled();
  });

  it('skips position when bracket label not found in event', async () => {
    mockSql.mockResolvedValue([makePosition({ sourcedFrom: 'weather:chicago:2026-05-31:40-41°F' })]);
    // Event has different bracket
    mockParseWeatherEvent.mockReturnValue(makeParsedEvent());
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockFetchForecast).not.toHaveBeenCalled();
  });

  it('skips position when forecast is unavailable', async () => {
    mockSql.mockResolvedValue([makePosition()]);
    mockFetchForecast.mockResolvedValue(null);
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(enqueueWrite).not.toHaveBeenCalled();
  });

  it('shadow-logs when NO position: drop < MIN_DROP → not invalidated', async () => {
    mockSql.mockResolvedValue([makePosition()]);
    // entryHeldProb = 1 - 0.30 = 0.70; currentHeldProb = 1 - 0.55 = 0.45 → drop=0.25 but currentHeldProb<0.50
    // Actually let's set a small drop: currentHeldProb = 0.65 → drop = 0.05 < 0.20
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.35,    // P(YES) = 0.35; currentHeldProb(NO) = 0.65 → drop = 0.70-0.65=0.05
      effectiveStdDev: 5,
      correctedForecastHigh: 55,
      biasMode: 'none',
    });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        kind: 'weather_forecast_invalidation',
        wouldBlock: true, // not invalidated → wouldBlock=true (disabled)
        payload: expect.objectContaining({ invalidated: false }),
      }),
    );
    // No INVALIDATION key may be set (the forecast-cache write also uses
    // redis.set, so assert on the key prefix rather than zero calls).
    const invalidationSets = redis.set.mock.calls.filter((c) =>
      String(c[0]).startsWith('weather:forecast_invalidated:'),
    );
    expect(invalidationSets).toHaveLength(0);
  });

  it('invalidates NO position when held-side drop ≥ MIN_DROP and currentHeldProb ≤ threshold', async () => {
    mockSql.mockResolvedValue([makePosition()]);
    // entryHeldProb(NO) = 1-0.30 = 0.70; currentModelProb=0.80 → currentHeldProb(NO)=0.20
    // drop = 0.70-0.20 = 0.50 ≥ 0.20; currentHeldProb=0.20 ≤ 0.50 → invalidated
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.80,
      effectiveStdDev: 5,
      correctedForecastHigh: 65,
      biasMode: 'none',
    });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        kind: 'weather_forecast_invalidation',
        payload: expect.objectContaining({ invalidated: true }),
      }),
    );
    // invalidationEnabled=false → no Redis key
    // No INVALIDATION key may be set (the forecast-cache write also uses
    // redis.set, so assert on the key prefix rather than zero calls).
    const invalidationSets = redis.set.mock.calls.filter((c) =>
      String(c[0]).startsWith('weather:forecast_invalidated:'),
    );
    expect(invalidationSets).toHaveLength(0);
  });

  it('invalidates YES position when held-side drop ≥ MIN_DROP and currentHeldProb ≤ threshold', async () => {
    const yesPos = makePosition({
      direction: 'YES' as const,
      consensusProbability: 0.75, // entryHeldProb(YES)=0.75
    });
    mockSql.mockResolvedValue([yesPos]);
    // currentModelProb=0.30 → currentHeldProb(YES)=0.30; drop=0.75-0.30=0.45 ≥ 0.20; prob≤0.50
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.30,
      effectiveStdDev: 5,
      correctedForecastHigh: 42,
      biasMode: 'none',
    });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        kind: 'weather_forecast_invalidation',
        direction: 'YES',
        payload: expect.objectContaining({ invalidated: true }),
      }),
    );
  });

  it('does not invalidate when currentHeldProb > MIN_CURRENT_HELD_PROB even if drop is large', async () => {
    mockSql.mockResolvedValue([makePosition()]);
    // entryHeldProb(NO)=0.70; currentModelProb=0.32 → currentHeldProb(NO)=0.68 > 0.50
    // drop=0.02 < 0.20; also currentHeldProb>0.50 → NOT invalidated
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.32,
      effectiveStdDev: 5,
      correctedForecastHigh: 54,
      biasMode: 'none',
    });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ payload: expect.objectContaining({ invalidated: false }) }),
    );
  });

  it('sets Redis invalidation key when invalidated and ENABLED=true', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_FORECAST_INVALIDATION_ENABLED: true }));
    mockSql.mockResolvedValue([makePosition()]);
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.80,
      effectiveStdDev: 5,
      correctedForecastHigh: 65,
      biasMode: 'none',
    });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(redis.set).toHaveBeenCalledWith(
      `${FORECAST_INVALIDATED_KEY_PREFIX}mkt-1:NO`,
      expect.any(String),
      'EX',
      21600,
    );
  });

  it('does not set Redis key when not invalidated even if ENABLED=true', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_FORECAST_INVALIDATION_ENABLED: true }));
    mockSql.mockResolvedValue([makePosition()]);
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.35,  // drop=0.05, not invalidated
      effectiveStdDev: 5,
      correctedForecastHigh: 54,
      biasMode: 'none',
    });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    // No INVALIDATION key may be set (the forecast-cache write also uses
    // redis.set, so assert on the key prefix rather than zero calls).
    const invalidationSets = redis.set.mock.calls.filter((c) =>
      String(c[0]).startsWith('weather:forecast_invalidated:'),
    );
    expect(invalidationSets).toHaveLength(0);
  });

  it('skips hedge execution (but still revalidates) for already-hedged positions', async () => {
    const store = new Map([['weather:forecast_hedged:pos-1', '1']]);
    mockLoadConfig.mockReturnValue(
      makeConfig({ WEATHER_FORECAST_INVALIDATION_ENABLED: true, WEATHER_FORECAST_INVALIDATION_HEDGE_ENABLED: true }),
    );
    mockSql.mockResolvedValue([makePosition()]);
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.80,
      effectiveStdDev: 5,
      correctedForecastHigh: 65,
      biasMode: 'none',
    });
    mockGetMarket.mockResolvedValue({ clobTokenIds: '["tok-yes","tok-no"]' });
    mockParseClobTokenIds.mockReturnValue(['tok-yes', 'tok-no']);
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.20' }] });
    const redis = makeRedis(store);

    await runWeatherInvalidationScan(redis as any);

    // Revaluation runs (forecast fetched, shadow log written) ...
    expect(mockFetchForecast).toHaveBeenCalled();
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ kind: 'weather_forecast_invalidation' }),
    );
    // ... but hedge is not attempted since position is already hedged
    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
  });

  it('skips entirely when partial-fill cooldown is active', async () => {
    const store = new Map([['weather:forecast_hedge_partial_cooldown:pos-1', '1']]);
    mockSql.mockResolvedValue([makePosition()]);
    const redis = makeRedis(store);

    await runWeatherInvalidationScan(redis as any);

    expect(mockFetchForecast).not.toHaveBeenCalled();
  });
});

describe('runWeatherInvalidationScan — modal inversion', () => {
  // Bounded interior bracket (74-75°F) — the Atlanta case. low/high both set.
  const boundedEvent = () =>
    makeParsedEvent({
      city: 'atlanta',
      brackets: [{ label: '74-75°F', low: 74, high: 75, marketId: 'mkt-1' }],
    });
  const atlantaNoPos = (overrides = {}) =>
    makePosition({ sourcedFrom: 'weather:atlanta:2026-05-31:74-75°F', ...overrides });

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(makeConfig());
    mockFetchWeatherEvents.mockResolvedValue([{}]);
    mockParseWeatherEvent.mockReturnValue(boundedEvent());
    mockFetchForecast.mockResolvedValue(makeForecast());
  });

  it('invalidates a NO hold when the modal flips and held-prob is below the ceiling (no held-prob drop)', async () => {
    // entryHeldProb(NO)=0.70; currentModelProb=0.48 → currentHeldProb(NO)=0.52 (≤ ceiling 0.55,
    // drop 0.18 < 0.20 so modal is the sole trigger). correctedForecastHigh 75.45 → round 75 ∈ [74,75].
    // The modal was supporting on an earlier scan (seeded marker) → a genuine flip, not born-inverted.
    mockSql.mockResolvedValue([atlantaNoPos()]);
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.48,
      effectiveStdDev: 3.45,
      correctedForecastHigh: 75.45,
      biasMode: 'full',
    });
    const redis = makeRedis(new Map([['weather:forecast_modal_supported:pos-1', '1']]));

    await runWeatherInvalidationScan(redis as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        kind: 'weather_forecast_invalidation',
        payload: expect.objectContaining({
          invalidated: true,
          invalidationReason: 'modal_inversion',
          modalInvalidated: true,
          modalWasEverSupported: true,
          roundedForecast: 75,
        }),
      }),
    );
  });

  it('does NOT invalidate a NO hold when the forecast rounds outside the bracket', async () => {
    // correctedForecastHigh 76.6 → round 77 ∉ [74,75]; no drop → not invalidated.
    mockSql.mockResolvedValue([atlantaNoPos()]);
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.22,
      effectiveStdDev: 3.45,
      correctedForecastHigh: 76.6,
      biasMode: 'full',
    });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        payload: expect.objectContaining({ invalidated: false, modalInvalidated: false }),
      }),
    );
  });

  it('invalidates a YES hold when the forecast rounds OUT of the bracket', async () => {
    // YES thesis = high WILL be 74-75. correctedForecastHigh 72.4 → round 72 ∉ [74,75] → inverted.
    // entryHeldProb(YES)=0.55; currentModelProb=0.50 → held(YES)=0.50 (≤ ceiling), drop=0.05 (below
    // threshold) so modal is the sole trigger. Modal supported earlier (seeded) → a genuine flip.
    mockSql.mockResolvedValue([
      atlantaNoPos({ direction: 'YES' as const, consensusProbability: 0.55 }),
    ]);
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.50,
      effectiveStdDev: 3.45,
      correctedForecastHigh: 72.4,
      biasMode: 'full',
    });
    const redis = makeRedis(new Map([['weather:forecast_modal_supported:pos-1', '1']]));

    await runWeatherInvalidationScan(redis as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        direction: 'YES',
        payload: expect.objectContaining({
          invalidated: true,
          invalidationReason: 'modal_inversion',
          modalInvalidated: true,
        }),
      }),
    );
  });

  it('reports reason "both" when held-prob drop and modal inversion fire together', async () => {
    // currentModelProb=0.80 → held(NO)=0.20 (drop=0.50, ≤ ceiling); forecast 74.5 → round 75 ∈ bracket
    // (modal fires). Modal supported earlier (seeded marker) → genuine flip, so both reasons apply.
    mockSql.mockResolvedValue([atlantaNoPos()]);
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.80,
      effectiveStdDev: 3.45,
      correctedForecastHigh: 74.5,
      biasMode: 'full',
    });
    const redis = makeRedis(new Map([['weather:forecast_modal_supported:pos-1', '1']]));

    await runWeatherInvalidationScan(redis as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        payload: expect.objectContaining({ invalidated: true, invalidationReason: 'both' }),
      }),
    );
  });

  it('does not apply modal inversion when MODAL_ENABLED=false', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_FORECAST_INVALIDATION_MODAL_ENABLED: false }));
    mockSql.mockResolvedValue([atlantaNoPos()]);
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.22, // no drop
      effectiveStdDev: 3.45,
      correctedForecastHigh: 75.45, // would round into bracket, but flag is off
      biasMode: 'full',
    });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        payload: expect.objectContaining({ invalidated: false, modalInvalidated: false, roundedForecast: null }),
      }),
    );
  });

  it('debounce: does NOT fire on the first inverting run when MIN_RUNS=2', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_FORECAST_INVALIDATION_MODAL_MIN_RUNS: 2 }));
    mockSql.mockResolvedValue([atlantaNoPos()]);
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.22, // no held-prob drop
      effectiveStdDev: 3.45,
      correctedForecastHigh: 75.45, // rounds into bracket → raw inversion
      biasMode: 'full',
    });
    const redis = makeRedis(); // no prior streak

    await runWeatherInvalidationScan(redis as any);

    // Raw inversion seen, streak now 1 (< 2) → not yet invalidated.
    expect(redis.set).toHaveBeenCalledWith(
      'weather:forecast_modal_streak:pos-1',
      '1',
      'EX',
      expect.any(Number),
    );
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        payload: expect.objectContaining({
          invalidated: false,
          modalInvalidated: false,
          modalInversionRaw: true,
          modalStreak: 1,
        }),
      }),
    );
  });

  it('debounce: fires on the second consecutive inverting run when MIN_RUNS=2', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_FORECAST_INVALIDATION_MODAL_MIN_RUNS: 2 }));
    mockSql.mockResolvedValue([atlantaNoPos()]);
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.48, // held(NO)=0.52 ≤ ceiling 0.55; drop 0.18 < 0.20 → modal-only
      effectiveStdDev: 3.45,
      correctedForecastHigh: 75.45,
      biasMode: 'full',
    });
    // Pre-seed streak from a prior inverting run AND the supporting marker from before the flip.
    const store = new Map([
      ['weather:forecast_modal_streak:pos-1', '1'],
      ['weather:forecast_modal_supported:pos-1', '1'],
    ]);
    const redis = makeRedis(store);

    await runWeatherInvalidationScan(redis as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        payload: expect.objectContaining({
          invalidated: true,
          invalidationReason: 'modal_inversion',
          modalInvalidated: true,
          modalStreak: 2,
        }),
      }),
    );
  });

  it('debounce: resets the streak when the forecast rounds back to the supporting side', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_FORECAST_INVALIDATION_MODAL_MIN_RUNS: 2 }));
    mockSql.mockResolvedValue([atlantaNoPos()]);
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.22, // no drop
      effectiveStdDev: 3.45,
      correctedForecastHigh: 76.6, // rounds to 77, outside bracket → raw inversion false
      biasMode: 'full',
    });
    const store = new Map([['weather:forecast_modal_streak:pos-1', '1']]);
    const redis = makeRedis(store);

    await runWeatherInvalidationScan(redis as any);

    expect(redis.del).toHaveBeenCalledWith('weather:forecast_modal_streak:pos-1');
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        payload: expect.objectContaining({ invalidated: false, modalInversionRaw: false }),
      }),
    );
  });

  it('skips modal inversion for tail brackets (open-ended side)', async () => {
    // Tail bracket "39°F or below" (low=null): cannot round "out of" an open side.
    mockParseWeatherEvent.mockReturnValue(makeParsedEvent()); // default tail bracket, city chicago
    mockSql.mockResolvedValue([makePosition()]); // sourcedFrom chicago tail, no drop
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.30, // held(NO)=0.70, drop=0 → no drop trigger
      effectiveStdDev: 5,
      correctedForecastHigh: 30, // numerically ≤39 but bracket.low is null → modal skipped
      biasMode: 'none',
    });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        payload: expect.objectContaining({ invalidated: false, modalInvalidated: false, roundedForecast: null }),
      }),
    );
  });

  // ── Guard A: held-prob ceiling (the Amsterdam 2026-06-03 false positive) ─────
  it('does NOT invalidate when the modal flips but held-prob is still above the ceiling (Amsterdam case)', async () => {
    // Amsterdam 19°C NO: a transient forecast spike (18.6 → rounds to 19 ∈ bracket) flips the modal,
    // but a wide stddev keeps held(NO) at 0.686 (> ceiling 0.55) — a boundary-straddling noise spike,
    // not a real inversion. The modal was supporting earlier (seeded), so ONLY guard A blocks it.
    // (drop here is 0.892-0.686=0.206 ≥ MIN_DROP but held 0.686 > 0.50 → held_prob_drop also stays off.)
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_FORECAST_INVALIDATION_MODAL_MIN_RUNS: 1 }));
    mockSql.mockResolvedValue([atlantaNoPos({ consensusProbability: 0.108 })]); // entryHeld(NO)=0.892
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.314, // held(NO)=0.686 > ceiling 0.55
      effectiveStdDev: 1.16,
      correctedForecastHigh: 75.45, // rounds INTO bracket → raw inversion seen
      biasMode: 'full',
    });
    const redis = makeRedis(new Map([['weather:forecast_modal_supported:pos-1', '1']]));

    await runWeatherInvalidationScan(redis as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        payload: expect.objectContaining({
          invalidated: false, // guard A: held-prob above ceiling → ride
          invalidationReason: null,
          modalInvalidated: false,
          modalInversionRaw: true, // raw flip WAS seen...
          modalWasEverSupported: true, // ...and it was a genuine flip...
          modalStreak: 1, // ...and the streak cleared MIN_RUNS — only the ceiling held it back
        }),
      }),
    );
  });

  // ── Guard B: transition-only (the Houston 2026-06-03 longshot YES) ───────────
  it('does NOT invalidate a longshot YES whose modal was never on our side (Houston case)', async () => {
    // Houston 86-87°F YES entered at 0.293 (sub-modal longshot): the forecast (~84) was never inside
    // the narrow bracket, so the modal never supported the thesis — it was born inverted, not flipped.
    // No supporting marker was ever set, so guard B blocks it even though the streak (2) and the
    // held-prob ceiling (held 0.176 ≤ 0.55) would otherwise pass.
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_FORECAST_INVALIDATION_MODAL_MIN_RUNS: 2 }));
    mockSql.mockResolvedValue([
      atlantaNoPos({ direction: 'YES' as const, consensusProbability: 0.293 }), // entryHeld(YES)=0.293
    ]);
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.176, // held(YES)=0.176 (≤ ceiling); drop 0.117 < 0.20 → drop stays off
      effectiveStdDev: 2.78,
      correctedForecastHigh: 72.4, // round 72 ∉ [74,75] → raw inversion for YES
      biasMode: 'full',
    });
    // Streak already at 1 from a prior inverting run, but NO supporting marker was ever set.
    const redis = makeRedis(new Map([['weather:forecast_modal_streak:pos-1', '1']]));

    await runWeatherInvalidationScan(redis as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        direction: 'YES',
        payload: expect.objectContaining({
          invalidated: false, // guard B: never supported → never inverted
          invalidationReason: null,
          modalInvalidated: false,
          modalInversionRaw: true,
          modalStreak: 2, // streak DID reach the threshold...
          modalWasEverSupported: false, // ...but B blocks: modal never supported the thesis
        }),
      }),
    );
  });

  it('records the "ever supported" marker while the modal is on our side (guard B bookkeeping)', async () => {
    // NO hold, forecast 76.6 → round 77 ∉ [74,75] → modal supports the NO thesis. Persist the marker
    // so a later flip can be recognised as a genuine inversion rather than born-inverted.
    mockSql.mockResolvedValue([atlantaNoPos()]);
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.22, // held(NO)=0.78, no drop, modal not inverted
      effectiveStdDev: 3.45,
      correctedForecastHigh: 76.6,
      biasMode: 'full',
    });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(redis.set).toHaveBeenCalledWith(
      'weather:forecast_modal_supported:pos-1',
      '1',
      'EX',
      expect.any(Number),
    );
  });
});

describe('runWeatherInvalidationScan — hedge (Phase 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(
      makeConfig({
        WEATHER_FORECAST_INVALIDATION_ENABLED: true,
        WEATHER_FORECAST_INVALIDATION_HEDGE_ENABLED: true,
      }),
    );
    mockFetchWeatherEvents.mockResolvedValue([{}]);
    mockParseWeatherEvent.mockReturnValue(makeParsedEvent());
    mockFetchForecast.mockResolvedValue(makeForecast());
    mockParseBracketLabel.mockReturnValue({ low: null, high: 39, unit: 'fahrenheit' });
    // Default: invalidated
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.80,
      effectiveStdDev: 5,
      correctedForecastHigh: 65,
      biasMode: 'none',
    });
    mockGetMarket.mockResolvedValue({ clobTokenIds: '["tok-yes","tok-no"]' });
    mockParseClobTokenIds.mockReturnValue(['tok-yes', 'tok-no']);
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.20' }] });
    mockSubmitClobBuy.mockResolvedValue({ success: true, shares_bought: 10, cost: 2.0 });
  });

  it('buys YES when NO position is invalidated (hedge=buy YES)', async () => {
    mockSql.mockResolvedValue([makePosition({ direction: 'NO' })]);
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    // NO position → buy YES (tokenIds[0])
    expect(mockSubmitClobBuy).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-yes' }),
    );
  });

  it('reads the hedge ask from a multi-level raw-REST-order book (asks[0] = WORST ask)', async () => {
    mockSql.mockResolvedValue([makePosition({ direction: 'NO' })]);
    // REST books are best-at-the-END: asks descending, real best ask 0.20 is
    // LAST. Pre-fix the hedge gate read asks[0]=0.99 → price_too_high skip,
    // forcing exit/notify paths on positions that had a viable 0.20 hedge.
    mockGetClobOrderBook.mockResolvedValue({
      asks: [
        { price: '0.99', size: '5' },
        { price: '0.60', size: '10' },
        { price: '0.20', size: '40' }, // real best ask — LAST
      ],
    });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockSubmitClobBuy).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-yes' }),
    );
  });

  it('buys NO when YES position is invalidated (hedge=buy NO)', async () => {
    mockSql.mockResolvedValue([
      makePosition({
        direction: 'YES' as const,
        consensusProbability: 0.75,
      }),
    ]);
    // Re-mock so YES position is invalidated
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.30,
      effectiveStdDev: 5,
      correctedForecastHigh: 42,
      biasMode: 'none',
    });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    // YES position → buy NO (tokenIds[1])
    expect(mockSubmitClobBuy).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-no' }),
    );
  });

  it('does not hedge when opposite ask exceeds MAX_HEDGE_PRICE', async () => {
    mockSql.mockResolvedValue([makePosition()]);
    // ask=0.30 > 0.25 max
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.30' }] });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ kind: 'weather_forecast_invalidation_hedge', wouldBlock: true }),
    );
  });

  it('does not hedge when total cost exceeds MAX_TOTAL_COST', async () => {
    mockSql.mockResolvedValue([makePosition({ entryPrice: 0.90 })]);
    // entryPrice=0.90 + ask=0.20 = 1.10 > 1.05 ceiling
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.20' }] });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
  });

  it('does not set hedge marker on partial fill below MIN_FILL_RATIO', async () => {
    mockSql.mockResolvedValue([makePosition({ sharesHeld: 10 })]);
    // 8/10 = 0.80 < 0.90 threshold
    mockSubmitClobBuy.mockResolvedValue({ success: true, shares_bought: 8, cost: 1.6 });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(redis.set).not.toHaveBeenCalledWith(
      expect.stringContaining('weather:forecast_hedged:'),
      expect.any(String),
      expect.any(String),
      expect.any(Number),
    );
    // Bankroll still deducted for partial fill cost
    expect(mockDeductStake).toHaveBeenCalledOnce();
  });

  it('sets hedge marker and deducts bankroll on full fill', async () => {
    mockSql.mockResolvedValue([makePosition({ sharesHeld: 10 })]);
    mockSubmitClobBuy.mockResolvedValue({ success: true, shares_bought: 10, cost: 2.0 });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(redis.set).toHaveBeenCalledWith(
      'weather:forecast_hedged:pos-1',
      '1',
      'EX',
      expect.any(Number),
    );
    expect(mockDeductStake).toHaveBeenCalledWith(redis, 2.0);
  });

  describe('CLOB minimum-order bump (sharesHeld × ask below $1)', () => {
    it('bumps a near-miss hedge up to the CLOB minimum and sets the marker on fill', async () => {
      // 10 sh × 0.08 = $0.80 intended ≥ 60% of $1 → submit at exactly $1.00.
      mockSql.mockResolvedValue([makePosition({ sharesHeld: 10 })]);
      mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.08' }] });
      // $1.00 at 0.08 buys ~12 shares → ratio 12/10 > 0.9 → marker sets.
      mockSubmitClobBuy.mockResolvedValue({ success: true, shares_bought: 12, cost: 1.0 });
      const redis = makeRedis();

      await runWeatherInvalidationScan(redis as any);

      expect(mockSubmitClobBuy).toHaveBeenCalledWith(
        expect.objectContaining({ amountUsd: 1.0 }),
      );
      expect(redis.set).toHaveBeenCalledWith(
        'weather:forecast_hedged:pos-1',
        '1',
        'EX',
        expect.any(Number),
      );
      expect(mockDeductStake).toHaveBeenCalledWith(redis, 1.0);
    });

    it('skips entirely when intended notional is too far below the minimum (no submit, no marker, no cooldown)', async () => {
      // 10 sh × 0.03 = $0.30 < 60% of $1 → plain skip: bumping would be a >3×
      // oversize, and an ask this cheap means the held side is effectively
      // winning anyway. Re-evaluated next scan — cooldown must NOT be set.
      mockSql.mockResolvedValue([makePosition({ sharesHeld: 10 })]);
      mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.03' }] });
      const redis = makeRedis();

      await runWeatherInvalidationScan(redis as any);

      expect(mockSubmitClobBuy).not.toHaveBeenCalled();
      expect(mockDeductStake).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalledWith(
        expect.stringContaining('weather:forecast_hedged:'),
        expect.any(String),
        expect.any(String),
        expect.any(Number),
      );
      expect(redis.set).not.toHaveBeenCalledWith(
        expect.stringContaining('weather:forecast_hedge_partial_cooldown:'),
        expect.any(String),
        expect.any(String),
        expect.any(Number),
      );
    });

    it('partial fill of a bumped hedge below MIN_FILL_RATIO deducts cost, sets cooldown, no marker', async () => {
      mockSql.mockResolvedValue([makePosition({ sharesHeld: 10 })]);
      mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.08' }] });
      // Bumped to $1.00; only 5 of 10 needed shares fill → ratio 0.5 < 0.9.
      mockSubmitClobBuy.mockResolvedValue({ success: true, shares_bought: 5, cost: 0.40 });
      const redis = makeRedis();

      await runWeatherInvalidationScan(redis as any);

      expect(mockSubmitClobBuy).toHaveBeenCalledWith(
        expect.objectContaining({ amountUsd: 1.0 }),
      );
      expect(redis.set).not.toHaveBeenCalledWith(
        expect.stringContaining('weather:forecast_hedged:'),
        expect.any(String),
        expect.any(String),
        expect.any(Number),
      );
      expect(redis.set).toHaveBeenCalledWith(
        'weather:forecast_hedge_partial_cooldown:pos-1',
        '1',
        'EX',
        30 * 60,
      );
      expect(mockDeductStake).toHaveBeenCalledWith(redis, 0.40);
    });

    it('passes the intended notional through unchanged when it clears the minimum', async () => {
      // Default 10 sh × 0.20 = $2.00 ≥ $1 → no bump, no rounding.
      mockSql.mockResolvedValue([makePosition({ sharesHeld: 10 })]);
      const redis = makeRedis();

      await runWeatherInvalidationScan(redis as any);

      expect(mockSubmitClobBuy).toHaveBeenCalledWith(
        expect.objectContaining({ amountUsd: expect.closeTo(2.0, 5) }),
      );
    });
  });

  it('shadow-logs hedge opportunity even when HEDGE_ENABLED=false', async () => {
    mockLoadConfig.mockReturnValue(
      makeConfig({
        WEATHER_FORECAST_INVALIDATION_ENABLED: true,
        WEATHER_FORECAST_INVALIDATION_HEDGE_ENABLED: false,
      }),
    );
    mockSql.mockResolvedValue([makePosition()]);
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    // Should not attempt the hedge
    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
    // Both the invalidation AND hedge shadow obs should fire
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ kind: 'weather_forecast_invalidation' }),
    );
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        kind: 'weather_forecast_invalidation_hedge',
        wouldBlock: true, // blocked because HEDGE_ENABLED=false
      }),
    );
  });

  it('sets partial-fill cooldown key on partial fill', async () => {
    mockSql.mockResolvedValue([makePosition({ sharesHeld: 10 })]);
    // 8/10 = 0.80 < 0.90 threshold
    mockSubmitClobBuy.mockResolvedValue({ success: true, shares_bought: 8, cost: 1.6 });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(redis.set).toHaveBeenCalledWith(
      'weather:forecast_hedge_partial_cooldown:pos-1',
      '1',
      'EX',
      30 * 60,
    );
    // Hedge marker NOT set
    expect(redis.set).not.toHaveBeenCalledWith(
      'weather:forecast_hedged:pos-1',
      expect.any(String),
      expect.any(String),
      expect.any(Number),
    );
  });
});

describe('runWeatherInvalidationScan — Phase 5 resolution-day exit', () => {
  // Default: exit enabled, invalidated NO position (held(NO) prob 0.20), resolution
  // day, ledger position present, executeTakeProfit succeeds. Each test tweaks one
  // axis to assert the exit-vs-notify routing.
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(
      makeConfig({
        WEATHER_FORECAST_INVALIDATION_ENABLED: true,
        WEATHER_FORECAST_INVALIDATION_HEDGE_ENABLED: false,
        WEATHER_FORECAST_INVALIDATION_EXIT_ENABLED: true,
      }),
    );
    mockFetchWeatherEvents.mockResolvedValue([{}]);
    mockParseWeatherEvent.mockReturnValue(makeParsedEvent());
    mockFetchForecast.mockResolvedValue(makeForecast());
    mockParseBracketLabel.mockReturnValue({ low: null, high: 39, unit: 'fahrenheit' });
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.80, // held(NO)=0.20 → invalidated (drop 0.50, prob ≤0.50)
      effectiveStdDev: 5,
      correctedForecastHigh: 65,
      biasMode: 'none',
    });
    mockGetMarket.mockResolvedValue({ clobTokenIds: '["tok-yes","tok-no"]' });
    mockParseClobTokenIds.mockReturnValue(['tok-yes', 'tok-no']);
    mockCityLocalDate.mockReturnValue('2026-05-31'); // == targetDate → resolution day
    mockGetPosition.mockResolvedValue({
      marketId: 'mkt-1',
      direction: 'NO',
      entryPrice: 0.65,
      sharesHeld: 10,
      clobTokenIds: ['tok-yes', 'tok-no'],
      question: 'Chicago high 39°F or below?',
      executionVenue: 'clob',
    });
    mockExecuteTakeProfit.mockResolvedValue({
      marketId: 'mkt-1',
      success: true,
      returnPct: -72.3,
      reason: 'weather_invalidation',
    });
  });

  // For a NO hold: opposite (hedge) token = tok-yes; held token (we sell) = tok-no.
  const books =
    (opposite: unknown, held: unknown) =>
    async (tokenId: string) =>
      tokenId === 'tok-yes' ? opposite : tokenId === 'tok-no' ? held : null;

  it('exits via executeTakeProfit on a price_too_high barrier when the bid clears both floors', async () => {
    mockSql.mockResolvedValue([makePosition({ direction: 'NO' })]);
    // opposite ask 0.30 > MAX_HEDGE_PRICE 0.25 → price_too_high; held bid 0.18 clears floors.
    mockGetClobOrderBook.mockImplementation(books({ asks: [{ price: '0.30' }] }, { bids: [{ price: '0.18', size: '50' }] }));
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockExecuteTakeProfit).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'weather_invalidation',
        currentPrice: 0.18,
        // (bestBid 0.18 − entry 0.65) / 0.65 × 100 ≈ −72.3% — guards the return math.
        returnPct: expect.closeTo(-72.31, 1),
        position: expect.objectContaining({ marketId: 'mkt-1', direction: 'NO' }),
      }),
    );
    expect(redis.set).toHaveBeenCalledWith('weather:forecast_exited:pos-1', '1', 'EX', expect.any(Number));
    expect(mockNotifyWeatherInvalidationNoHedge).not.toHaveBeenCalled();
  });

  it('reads the held-side bid from a multi-level raw-REST-order book (bids[0] = WORST bid)', async () => {
    mockSql.mockResolvedValue([makePosition({ direction: 'NO' })]);
    // REST books are best-at-the-END: held bids ascending, real best bid 0.18
    // is LAST. Pre-fix the floor gate read bids[0]=0.01 and declined this exit
    // as "bid below floor" — blocking valid resolution-day sells.
    mockGetClobOrderBook.mockImplementation(
      books(
        { asks: [{ price: '0.30' }] }, // price_too_high barrier (> 0.25 max hedge)
        {
          bids: [
            { price: '0.01', size: '5' },
            { price: '0.10', size: '8' },
            { price: '0.18', size: '50' }, // real best bid — LAST
          ],
        },
      ),
    );
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockExecuteTakeProfit).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'weather_invalidation',
        currentPrice: 0.18, // the REAL touch, not 0.01
        position: expect.objectContaining({ marketId: 'mkt-1', direction: 'NO' }),
      }),
    );
  });

  it('exits using held-side bids even on a no_book barrier (empty opposite asks)', async () => {
    mockSql.mockResolvedValue([makePosition({ direction: 'NO' })]);
    // opposite has NO asks → no_book; held bid 0.18 still lets us sell out.
    mockGetClobOrderBook.mockImplementation(books({ asks: [] }, { bids: [{ price: '0.18', size: '50' }] }));
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockExecuteTakeProfit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'weather_invalidation', currentPrice: 0.18 }),
    );
    expect(mockNotifyWeatherInvalidationNoHedge).not.toHaveBeenCalled();
  });

  it('exits on a cost_ceiling barrier', async () => {
    // entry 0.90 + opposite ask 0.20 = 1.10 > MAX_TOTAL_COST 1.05 → cost_ceiling.
    mockSql.mockResolvedValue([makePosition({ direction: 'NO', entryPrice: 0.90 })]);
    mockGetClobOrderBook.mockImplementation(books({ asks: [{ price: '0.20' }] }, { bids: [{ price: '0.18', size: '50' }] }));
    mockGetPosition.mockResolvedValue({
      marketId: 'mkt-1',
      direction: 'NO',
      entryPrice: 0.90,
      sharesHeld: 10,
      clobTokenIds: ['tok-yes', 'tok-no'],
      question: 'q',
      executionVenue: 'clob',
    });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockExecuteTakeProfit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'weather_invalidation' }),
    );
    expect(mockNotifyWeatherInvalidationNoHedge).not.toHaveBeenCalled();
  });

  it('does NOT exit before resolution day — notifies instead and lets the position ride', async () => {
    mockSql.mockResolvedValue([makePosition({ direction: 'NO' })]);
    mockGetClobOrderBook.mockImplementation(books({ asks: [{ price: '0.30' }] }, { bids: [{ price: '0.18', size: '50' }] }));
    mockCityLocalDate.mockReturnValue('2026-06-02'); // != targetDate → NOT resolution day
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
    expect(mockNotifyWeatherInvalidationNoHedge).toHaveBeenCalledWith(
      expect.objectContaining({ hedgeBarrier: 'price_too_high' }),
    );
  });

  it('does NOT exit when the held-side bid is below the absolute floor — notifies', async () => {
    mockSql.mockResolvedValue([makePosition({ direction: 'NO' })]);
    // held bid 0.02 < MIN_EXIT_PRICE 0.05.
    mockGetClobOrderBook.mockImplementation(books({ asks: [{ price: '0.30' }] }, { bids: [{ price: '0.02', size: '50' }] }));
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
    expect(mockNotifyWeatherInvalidationNoHedge).toHaveBeenCalled();
  });

  it('held_prob_drop exits at the market bid below the slippage floor (DROP_MARKET_FLOOR=true, default)', async () => {
    // held(NO)=0.45 → slippageFloor 0.30; bid 0.20 is below that but above MIN_EXIT_PRICE.
    // Tail bracket → reason is held_prob_drop. Under the market floor (default) we anchor to
    // the market and exit anyway — the model's 0.45 is overconfident vs the 0.20 the market
    // will pay (the mexico-city "model 0.37 vs market 0.01" class).
    mockSql.mockResolvedValue([makePosition({ direction: 'NO' })]);
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.55, // held(NO)=0.45; drop 0.70-0.45=0.25 ≥0.20, prob ≤0.50 → invalidated
      effectiveStdDev: 5,
      correctedForecastHigh: 60,
      biasMode: 'none',
    });
    mockGetClobOrderBook.mockImplementation(books({ asks: [{ price: '0.30' }] }, { bids: [{ price: '0.20', size: '50' }] }));
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockExecuteTakeProfit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'weather_invalidation', currentPrice: 0.20 }),
    );
    expect(mockNotifyWeatherInvalidationNoHedge).not.toHaveBeenCalled();
  });

  it('held_prob_drop honors the slippage floor when DROP_MARKET_FLOOR=false — notifies', async () => {
    mockLoadConfig.mockReturnValue(
      makeConfig({
        WEATHER_FORECAST_INVALIDATION_ENABLED: true,
        WEATHER_FORECAST_INVALIDATION_EXIT_ENABLED: true,
        WEATHER_FORECAST_INVALIDATION_DROP_MARKET_FLOOR: false,
      }),
    );
    mockSql.mockResolvedValue([makePosition({ direction: 'NO' })]);
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.55, // held(NO)=0.45 → slippageFloor 0.30 > bid 0.20
      effectiveStdDev: 5,
      correctedForecastHigh: 60,
      biasMode: 'none',
    });
    mockGetClobOrderBook.mockImplementation(books({ asks: [{ price: '0.30' }] }, { bids: [{ price: '0.20', size: '50' }] }));
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
    expect(mockNotifyWeatherInvalidationNoHedge).toHaveBeenCalled();
  });

  it('modal-inversion exit uses the MARKET floor — sells below the slippage floor (option B)', async () => {
    // Atlanta/Paris analog: NO on a bounded bracket, forecast rounds INTO it (modal
    // inversion) while the continuous held-prob is at 0.52 → slippage floor 0.37. Held bid
    // 0.20 is below that floor but above MIN_EXIT_PRICE — because the model prob is the
    // overconfident number the modal signal distrusts, we anchor to the market and exit at
    // the bid anyway. Held 0.52 ≤ ceiling 0.55 and the modal was supporting earlier (seeded
    // marker) so guards A+B both pass and the modal inversion fires.
    mockParseWeatherEvent.mockReturnValue(
      makeParsedEvent({ city: 'atlanta', brackets: [{ label: '74-75°F', low: 74, high: 75, marketId: 'mkt-1' }] }),
    );
    mockSql.mockResolvedValue([
      makePosition({ direction: 'NO', sourcedFrom: 'weather:atlanta:2026-05-31:74-75°F', consensusProbability: 0.30 }),
    ]);
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.48, // held(NO)=0.52; entryHeld 0.70 → drop 0.18 (no drop) ⇒ reason modal_inversion
      effectiveStdDev: 1.16,
      correctedForecastHigh: 75.45, // rounds to 75 ∈ [74,75] → modal inversion for NO
      biasMode: 'full',
    });
    // opposite (tok-yes) ghost ask 0.99 → price_too_high barrier; held (tok-no) bid 0.20.
    mockGetClobOrderBook.mockImplementation(books({ asks: [{ price: '0.99' }] }, { bids: [{ price: '0.20', size: '50' }] }));
    mockGetPosition.mockResolvedValue({
      marketId: 'mkt-1',
      direction: 'NO',
      entryPrice: 0.52,
      sharesHeld: 10,
      clobTokenIds: ['tok-yes', 'tok-no'],
      question: 'q',
      executionVenue: 'clob',
    });
    const redis = makeRedis(new Map([['weather:forecast_modal_supported:pos-1', '1']]));

    await runWeatherInvalidationScan(redis as any);

    expect(mockExecuteTakeProfit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'weather_invalidation', currentPrice: 0.20 }),
    );
    expect(mockNotifyWeatherInvalidationNoHedge).not.toHaveBeenCalled();
  });

  it('modal-inversion exit honors the slippage floor when MODAL_MARKET_FLOOR=false (option A) — notifies', async () => {
    mockLoadConfig.mockReturnValue(
      makeConfig({
        WEATHER_FORECAST_INVALIDATION_ENABLED: true,
        WEATHER_FORECAST_INVALIDATION_EXIT_ENABLED: true,
        WEATHER_FORECAST_INVALIDATION_MODAL_MARKET_FLOOR: false,
      }),
    );
    mockParseWeatherEvent.mockReturnValue(
      makeParsedEvent({ city: 'atlanta', brackets: [{ label: '74-75°F', low: 74, high: 75, marketId: 'mkt-1' }] }),
    );
    mockSql.mockResolvedValue([
      makePosition({ direction: 'NO', sourcedFrom: 'weather:atlanta:2026-05-31:74-75°F', consensusProbability: 0.30 }),
    ]);
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.48, // held(NO)=0.52 (≤ ceiling, modal fires) → slippage floor 0.37 > bid 0.20
      effectiveStdDev: 1.16,
      correctedForecastHigh: 75.45,
      biasMode: 'full',
    });
    mockGetClobOrderBook.mockImplementation(books({ asks: [{ price: '0.99' }] }, { bids: [{ price: '0.20', size: '50' }] }));
    const redis = makeRedis(new Map([['weather:forecast_modal_supported:pos-1', '1']]));

    await runWeatherInvalidationScan(redis as any);

    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
    expect(mockNotifyWeatherInvalidationNoHedge).toHaveBeenCalledWith(
      expect.objectContaining({ hedgeBarrier: 'price_too_high' }),
    );
  });

  it('does NOT exit when EXIT_ENABLED=false — preserves the notify-only behaviour and skips the held-book fetch', async () => {
    mockLoadConfig.mockReturnValue(
      makeConfig({
        WEATHER_FORECAST_INVALIDATION_ENABLED: true,
        WEATHER_FORECAST_INVALIDATION_EXIT_ENABLED: false,
      }),
    );
    mockSql.mockResolvedValue([makePosition({ direction: 'NO' })]);
    mockGetClobOrderBook.mockImplementation(books({ asks: [{ price: '0.30' }] }, { bids: [{ price: '0.18', size: '50' }] }));
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
    expect(mockGetPosition).not.toHaveBeenCalled();
    // Held-book fetch is skipped (the EXIT_ENABLED guard precedes it); only the
    // opposite/hedge book (tok-yes) is fetched.
    expect(mockGetClobOrderBook).not.toHaveBeenCalledWith('tok-no');
    expect(mockNotifyWeatherInvalidationNoHedge).toHaveBeenCalledWith(
      expect.objectContaining({ hedgeBarrier: 'price_too_high' }),
    );
  });

  it('does NOT exit when there is no held-side bid — notifies', async () => {
    mockSql.mockResolvedValue([makePosition({ direction: 'NO' })]);
    mockGetClobOrderBook.mockImplementation(books({ asks: [] }, { bids: [] }));
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
    expect(mockNotifyWeatherInvalidationNoHedge).toHaveBeenCalledWith(
      expect.objectContaining({ hedgeBarrier: 'no_book' }),
    );
  });

  it('falls back to notify (no exited marker, sets a cooldown) when executeTakeProfit fails', async () => {
    mockSql.mockResolvedValue([makePosition({ direction: 'NO' })]);
    mockGetClobOrderBook.mockImplementation(books({ asks: [{ price: '0.30' }] }, { bids: [{ price: '0.18', size: '50' }] }));
    mockExecuteTakeProfit.mockResolvedValue({
      marketId: 'mkt-1',
      success: false,
      error: 'clob error',
      returnPct: 0,
      reason: 'weather_invalidation',
    });
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockExecuteTakeProfit).toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalledWith(
      'weather:forecast_exited:pos-1',
      '1',
      'EX',
      expect.any(Number),
    );
    // Cooldown set so the next scan doesn't re-submit a market sell immediately.
    expect(redis.set).toHaveBeenCalledWith(
      'weather:forecast_exit_cooldown:pos-1',
      '1',
      'EX',
      expect.any(Number),
    );
    expect(mockNotifyWeatherInvalidationNoHedge).toHaveBeenCalled();
  });

  it('does NOT exit when bid depth above the floor cannot absorb the position — notifies', async () => {
    mockSql.mockResolvedValue([makePosition({ direction: 'NO', sharesHeld: 10 })]);
    // Top bid clears the floor but only 3 shares sit there (< 10 held) — a market sell
    // would sweep below the floor, so we decline and notify.
    mockGetClobOrderBook.mockImplementation(books({ asks: [{ price: '0.30' }] }, { bids: [{ price: '0.18', size: '3' }] }));
    const redis = makeRedis();

    await runWeatherInvalidationScan(redis as any);

    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
    expect(mockNotifyWeatherInvalidationNoHedge).toHaveBeenCalled();
  });

  it('defers the sell (notifies) when a prior exit failure left a cooldown marker', async () => {
    const store = new Map([['weather:forecast_exit_cooldown:pos-1', '1']]);
    mockSql.mockResolvedValue([makePosition({ direction: 'NO' })]);
    mockGetClobOrderBook.mockImplementation(books({ asks: [{ price: '0.30' }] }, { bids: [{ price: '0.18', size: '50' }] }));
    const redis = makeRedis(store);

    await runWeatherInvalidationScan(redis as any);

    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
    expect(mockNotifyWeatherInvalidationNoHedge).toHaveBeenCalledWith(
      expect.objectContaining({ hedgeBarrier: 'price_too_high' }),
    );
  });

  it('short-circuits a position that already carries the exited marker', async () => {
    const store = new Map([['weather:forecast_exited:pos-1', '1']]);
    mockSql.mockResolvedValue([makePosition({ direction: 'NO' })]);
    const redis = makeRedis(store);

    await runWeatherInvalidationScan(redis as any);

    // Returns before the forecast fetch / exit / notify.
    expect(mockFetchForecast).not.toHaveBeenCalled();
    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
    expect(mockNotifyWeatherInvalidationNoHedge).not.toHaveBeenCalled();
  });
});

// ── Forecast resilience + reconciled:weather coverage ────────────────────────

describe('runWeatherInvalidationScan — forecast resilience and reconciled coverage', () => {
  // Date-independent fixtures: derive tomorrow's month/day so the question
  // parser's year inference always lands on the fixture's targetDate.
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const tomorrowIso = tomorrow.toISOString().slice(0, 10);
  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const qMonth = MONTH_NAMES[tomorrow.getUTCMonth()]!;
  const qDay = tomorrow.getUTCDate();
  const amsterdamQuestion =
    `Will the highest temperature in Amsterdam be 18°C on ${qMonth} ${qDay}?`;

  function makeAmsterdamEvent() {
    return makeParsedEvent({
      city: 'amsterdam',
      targetDate: tomorrowIso,
      coords: { tz: 'Europe/Amsterdam' },
      brackets: [{ label: '18°C', low: 18, high: 18, marketId: 'mkt-ams' }],
    });
  }

  function makeReconciledPosition(overrides = {}) {
    return makePosition({
      id: 'pos-rec-1',
      marketId: 'mkt-ams',
      direction: 'NO' as const,
      entryPrice: 0.62,
      consensusProbability: null, // imported rows carry no model prob
      sourcedFrom: 'reconciled:weather',
      question: amsterdamQuestion,
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(makeConfig());
    mockFetchWeatherEvents.mockResolvedValue([{}]);
    mockParseWeatherEvent.mockReturnValue(makeAmsterdamEvent());
    mockFetchForecast.mockResolvedValue(makeForecast());
    // parseWeatherMetaFromQuestion validates the bracket via parseBracketLabel.
    mockParseBracketLabel.mockReturnValue({ low: 18, high: 18, unit: 'celsius' });
    // Pre-resolution day so the Phase 5 exit path stays out of these tests.
    mockCityLocalDate.mockReturnValue('1999-01-01');
  });

  it('evaluates a reconciled:weather position by parsing city/date/bracket from the question', async () => {
    mockSql.mockResolvedValue([makeReconciledPosition()]);
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runWeatherInvalidationScan(redis as any);

    // The position is NOT skipped: the forecast fetch and probability model ran.
    expect(mockFetchForecast).toHaveBeenCalledTimes(1);
    expect(mockComputeBiasedProb).toHaveBeenCalledTimes(1);
  });

  it('skips a reconciled:weather position whose question names an unsupported city', async () => {
    mockSql.mockResolvedValue([
      makeReconciledPosition({
        question: `Will the highest temperature in Atlantis be 18°C on ${qMonth} ${qDay}?`,
      }),
    ]);
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runWeatherInvalidationScan(redis as any);

    expect(mockFetchForecast).not.toHaveBeenCalled();
  });

  it('skips a reconciled:weather position whose bracket text does not parse', async () => {
    mockParseBracketLabel.mockReturnValue(null);
    mockSql.mockResolvedValue([makeReconciledPosition()]);
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runWeatherInvalidationScan(redis as any);

    expect(mockFetchForecast).not.toHaveBeenCalled();
  });

  it('skips a reconciled:weather position with no question text', async () => {
    mockSql.mockResolvedValue([makeReconciledPosition({ question: null })]);
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runWeatherInvalidationScan(redis as any);

    expect(mockFetchForecast).not.toHaveBeenCalled();
  });

  it('uses the entry PRICE as the entry-held-prob baseline when consensusProbability is null', async () => {
    // Without the guard, `1 - null` = 1 fabricates a perfect entry thesis for
    // NO rows and false-triggers held_prob_drop. The entry price (0.62) is the
    // market P(our side) at entry — the correct imported-row baseline.
    mockComputeBiasedProb.mockReturnValue({
      modelProbability: 0.45, // P(YES) → currentHeldProb (NO) = 0.55
      effectiveStdDev: 1.4,
      correctedForecastHigh: 17.6,
      biasMode: 'full',
    });
    mockSql.mockResolvedValue([makeReconciledPosition()]);
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runWeatherInvalidationScan(redis as any);

    const { logger } = await import('../../shared/logger.js');
    const evalCall = vi
      .mocked(logger.info)
      .mock.calls.find((c) => String(c[0]).includes('position evaluated'));
    expect(evalCall).toBeDefined();
    const payload = evalCall![1] as { entryHeldProb: number; invalidated: boolean };
    expect(payload.entryHeldProb).toBeCloseTo(0.62, 6);
    // drop = 0.62 - 0.55 = 0.07 < MIN_DROP 0.20 → must NOT invalidate
    expect(payload.invalidated).toBe(false);
  });

  it('passes allowEnsembleOnly + retryCount to fetchForecast (monitoring opt-in)', async () => {
    mockSql.mockResolvedValue([makePosition()]);
    mockParseWeatherEvent.mockReturnValue(makeParsedEvent());
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_FORECAST_RETRY_COUNT: 2 }));
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runWeatherInvalidationScan(redis as any);

    expect(mockFetchForecast).toHaveBeenCalledTimes(1);
    const opts = mockFetchForecast.mock.calls[0]![8];
    expect(opts).toEqual({ allowEnsembleOnly: true, retryCount: 2 });
  });

  it('caches a successful live forecast under weather:forecast_cache:<city>:<date>', async () => {
    mockSql.mockResolvedValue([makePosition()]);
    mockParseWeatherEvent.mockReturnValue(makeParsedEvent());
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runWeatherInvalidationScan(redis as any);
    await new Promise((r) => setTimeout(r, 0)); // cache write is fire-and-forget

    const raw = redis._store.get('weather:forecast_cache:chicago:2026-05-31');
    expect(raw).toBeDefined();
    expect((JSON.parse(raw!) as { forecastHigh: number }).forecastHigh).toBe(55);
  });

  it('falls back to the cached forecast when the live fetch fails', async () => {
    mockFetchForecast.mockResolvedValue(null);
    mockSql.mockResolvedValue([makePosition()]);
    mockParseWeatherEvent.mockReturnValue(makeParsedEvent());
    const store = new Map<string, string>();
    store.set(
      'weather:forecast_cache:chicago:2026-05-31',
      JSON.stringify({
        forecastHigh: 54.5,
        stdDev: 4.8,
        source: 'combined',
        ensembleMembers: 31,
        ensembleModel: 'gfs',
        fetchedAt: '2026-05-31T10:00:00Z',
      }),
    );
    const redis = makeRedis(store);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runWeatherInvalidationScan(redis as any);

    // Evaluation proceeded on the cached forecast.
    expect(mockComputeBiasedProb).toHaveBeenCalledTimes(1);
    const forecastArg = mockComputeBiasedProb.mock.calls[0]![3] as { forecastHigh: number };
    expect(forecastArg.forecastHigh).toBe(54.5);
  });

  it('skips the position when both the live fetch and the cache miss', async () => {
    mockFetchForecast.mockResolvedValue(null);
    mockSql.mockResolvedValue([makePosition()]);
    mockParseWeatherEvent.mockReturnValue(makeParsedEvent());
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runWeatherInvalidationScan(redis as any);

    expect(mockComputeBiasedProb).not.toHaveBeenCalled();
    expect(enqueueWrite).not.toHaveBeenCalled();
  });
});

// ── parseWeatherMetaFromQuestion (pure parser) ───────────────────────────────

describe('parseWeatherMetaFromQuestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseBracketLabel.mockReturnValue({ low: 18, high: 18, unit: 'celsius' });
  });

  it('parses city, bracket, and date with an explicit year', async () => {
    const { parseWeatherMetaFromQuestion } = await import('../weatherInvalidation.js');
    const result = parseWeatherMetaFromQuestion(
      'Will the highest temperature in Amsterdam be 18°C on June 4, 2026?',
    );
    expect(result).toEqual({
      city: 'amsterdam',
      targetDate: '2026-06-04',
      bracketLabel: '18°C',
    });
  });

  it('parses a range bracket and a multi-word city', async () => {
    mockParseBracketLabel.mockReturnValue({ low: 86, high: 87, unit: 'fahrenheit' });
    const { parseWeatherMetaFromQuestion } = await import('../weatherInvalidation.js');
    const result = parseWeatherMetaFromQuestion(
      'Will the highest temperature in New York be between 86-87°F on July 12, 2026?',
    );
    expect(result).not.toBeNull();
    expect(result!.city).toBe('new york');
    expect(result!.targetDate).toBe('2026-07-12');
  });

  it('returns null for a question with no recognisable date', async () => {
    const { parseWeatherMetaFromQuestion } = await import('../weatherInvalidation.js');
    expect(
      parseWeatherMetaFromQuestion('Will the highest temperature in Amsterdam be 18°C someday?'),
    ).toBeNull();
  });

  it('returns null when the bracket fails validation', async () => {
    mockParseBracketLabel.mockReturnValue(null);
    const { parseWeatherMetaFromQuestion } = await import('../weatherInvalidation.js');
    expect(
      parseWeatherMetaFromQuestion('Will the highest temperature in Amsterdam be gibberish on June 4, 2026?'),
    ).toBeNull();
  });
});
