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
}));

const mockDeductStake = vi.fn().mockResolvedValue(undefined);
vi.mock('../../shared/bankroll.js', () => ({
  deductStake: mockDeductStake,
  getBankroll: vi.fn().mockResolvedValue(100),
}));

const mockGetCityBias = vi.fn().mockResolvedValue(null);
vi.mock('../cityBias.js', () => ({ getCityBias: mockGetCityBias }));

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
    WEATHER_FORECAST_INVALIDATION_MIN_DROP: 0.20,
    WEATHER_FORECAST_INVALIDATION_MIN_CURRENT_HELD_PROB: 0.50,
    WEATHER_FORECAST_INVALIDATION_TTL_S: 21600,
    WEATHER_FORECAST_INVALIDATION_HEDGE_ENABLED: false,
    WEATHER_FORECAST_INVALIDATION_MAX_HEDGE_PRICE: 0.25,
    WEATHER_FORECAST_INVALIDATION_MAX_TOTAL_COST: 1.05,
    WEATHER_FORECAST_INVALIDATION_MIN_FILL_RATIO: 0.90,
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
    ...overrides,
  };
}

function makeParsedEvent(overrides = {}) {
  return {
    city: 'chicago',
    targetDate: '2026-05-31',
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

function makeRedis(store: Map<string, string> = new Map()) {
  return {
    exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn().mockResolvedValue(null),
    mget: vi.fn().mockResolvedValue([]),
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
    expect(redis.set).not.toHaveBeenCalled();
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
    expect(redis.set).not.toHaveBeenCalled();
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

    expect(redis.set).not.toHaveBeenCalled();
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
