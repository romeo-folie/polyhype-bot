import { describe, it, expect, beforeEach, vi } from 'vitest';
import type * as GammaModule from '../../mapping/gamma.js';
import type * as NoaaModule from '../noaaClient.js';

// ---------------------------------------------------------------------------
// Mocks — must come before dynamic import
// ---------------------------------------------------------------------------

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    WEATHER_SCANNER_ENABLED: false,
    WEATHER_MIN_EDGE: 0.05,
    WEATHER_MAX_STAKE_FRACTION: 0.02,
    WEATHER_DEDUP_TTL_S: 3600,
    WEATHER_MAX_MARKETS: 20,
  })),
}));

vi.mock('../../shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockSearchEvents = vi.fn<() => Promise<unknown[]>>();
vi.mock('../../mapping/gamma.js', async () => {
  const actual =
    await vi.importActual<typeof GammaModule>('../../mapping/gamma.js');
  return {
    searchEvents: mockSearchEvents,
    parseOutcomePrices: actual.parseOutcomePrices,
    parseClobTokenIds: actual.parseClobTokenIds,
    parseOutcomes: actual.parseOutcomes,
  };
});

const mockFetchForecast = vi.fn<() => Promise<unknown>>();
vi.mock('../noaaClient.js', async () => {
  const actual =
    await vi.importActual<typeof NoaaModule>('../noaaClient.js');
  return {
    fetchNwsForecast: mockFetchForecast,
    lookupCity: actual.lookupCity,
    estimateExceedanceProbability: actual.estimateExceedanceProbability,
    normalCdf: actual.normalCdf,
    CITY_COORDINATES: actual.CITY_COORDINATES,
  };
});

// Dynamic imports — after mocks are set up
const { parseWeatherQuestion, scanWeatherMarkets, daysUntil } = await import(
  '../weatherScanner.js'
);
const { estimateExceedanceProbability, normalCdf, lookupCity } = await import(
  '../noaaClient.js'
);
const { logger } = await import('../../shared/logger.js');

// Minimal Redis mock — supports SET NX EX pattern
function createRedisMock() {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: string, _ex?: string, _ttl?: number, nx?: string) => {
      if (nx === 'NX' && store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    _store: store,
  };
}

// ---------------------------------------------------------------------------
// Question parsing tests
// ---------------------------------------------------------------------------

describe('parseWeatherQuestion', () => {
  it('parses "Will the high temperature in NYC exceed 80°F on April 15?"', () => {
    const result = parseWeatherQuestion(
      'Will the high temperature in NYC exceed 80\u00b0F on April 15?',
    );
    expect(result).not.toBeNull();
    expect(result!.city).toBe('nyc');
    expect(result!.tempThresholdF).toBe(80);
    expect(result!.direction).toBe('over');
    expect(result!.metric).toBe('high');
    expect(result!.targetDate).toMatch(/^\d{4}-04-15$/);
  });

  it('parses "Will the high temperature in Chicago exceed 90°F on July 4, 2030?"', () => {
    const result = parseWeatherQuestion(
      'Will the high temperature in Chicago exceed 90\u00b0F on July 4, 2030?',
    );
    expect(result).not.toBeNull();
    expect(result!.city).toBe('chicago');
    expect(result!.tempThresholdF).toBe(90);
    expect(result!.direction).toBe('over');
    expect(result!.targetDate).toBe('2030-07-04');
  });

  it('parses "Will the temperature in Miami drop below 32°F on January 10?"', () => {
    const result = parseWeatherQuestion(
      'Will the temperature in Miami drop below 32\u00b0F on January 10?',
    );
    expect(result).not.toBeNull();
    expect(result!.city).toBe('miami');
    expect(result!.tempThresholdF).toBe(32);
    expect(result!.direction).toBe('under');
  });

  it('parses "Will the overnight low temperature in Denver fall below 20 degrees F on March 5?"', () => {
    const result = parseWeatherQuestion(
      'Will the overnight low temperature in Denver fall below 20 degrees F on March 5?',
    );
    expect(result).not.toBeNull();
    expect(result!.city).toBe('denver');
    expect(result!.tempThresholdF).toBe(20);
    expect(result!.direction).toBe('under');
    expect(result!.metric).toBe('low');
  });

  it('parses question with "above" keyword', () => {
    const result = parseWeatherQuestion(
      'Will the temperature in Los Angeles be above 100\u00b0F on August 1?',
    );
    expect(result).not.toBeNull();
    expect(result!.city).toBe('los angeles');
    expect(result!.tempThresholdF).toBe(100);
    expect(result!.direction).toBe('over');
  });

  it('returns null for non-weather question', () => {
    const result = parseWeatherQuestion(
      'Will Bitcoin exceed $100,000 on December 31?',
    );
    expect(result).toBeNull();
  });

  it('returns null when no city is found', () => {
    const result = parseWeatherQuestion(
      'Will the temperature in Timbuktu exceed 110\u00b0F on June 1?',
    );
    expect(result).toBeNull();
  });

  it('returns null when no temperature is found', () => {
    const result = parseWeatherQuestion(
      'Will it rain in NYC on April 15?',
    );
    expect(result).toBeNull();
  });

  it('returns null when no date is found', () => {
    const result = parseWeatherQuestion(
      'Will the temperature in NYC exceed 80\u00b0F?',
    );
    expect(result).toBeNull();
  });

  it('does not false-match "la" inside "Dallas"', () => {
    const result = parseWeatherQuestion(
      'Will the high temperature in Dallas exceed 100\u00b0F on July 4, 2030?',
    );
    expect(result).not.toBeNull();
    expect(result!.city).toBe('dallas');
  });

  it('does not false-match "la" inside "Atlanta"', () => {
    const result = parseWeatherQuestion(
      'Will the high temperature in Atlanta exceed 95\u00b0F on August 1, 2030?',
    );
    expect(result).not.toBeNull();
    expect(result!.city).toBe('atlanta');
  });

  it('parses ISO date format', () => {
    const result = parseWeatherQuestion(
      'Will the temperature in Boston exceed 75\u00b0F on 2026-06-15?',
    );
    expect(result).not.toBeNull();
    expect(result!.targetDate).toBe('2026-06-15');
    expect(result!.city).toBe('boston');
  });
});

// ---------------------------------------------------------------------------
// Edge calculation tests (estimateExceedanceProbability)
// ---------------------------------------------------------------------------

describe('estimateExceedanceProbability', () => {
  it('returns ~0.5 when forecast equals threshold', () => {
    const p = estimateExceedanceProbability(80, 80, 1);
    expect(p).toBeCloseTo(0.5, 1);
  });

  it('returns high probability when forecast is well above threshold', () => {
    // Forecast 90F, threshold 80F, 1-day out (stddev=3)
    // z = (80-90)/3 = -3.33 -> P(X>80) ~ 0.9996
    const p = estimateExceedanceProbability(90, 80, 1);
    expect(p).toBeGreaterThan(0.95);
  });

  it('returns low probability when forecast is well below threshold', () => {
    // Forecast 70F, threshold 80F, 1-day out
    // z = (80-70)/3 = 3.33 -> P(X>80) ~ 0.0004
    const p = estimateExceedanceProbability(70, 80, 1);
    expect(p).toBeLessThan(0.05);
  });

  it('has wider uncertainty for longer horizons', () => {
    // Same temp, different horizons: longer horizon = more uncertainty = closer to 0.5
    const p1day = estimateExceedanceProbability(85, 80, 1); // stddev=3
    const p4day = estimateExceedanceProbability(85, 80, 4); // stddev=6

    expect(p1day).toBeGreaterThan(p4day);
    // Both should still be > 0.5 since forecast > threshold
    expect(p1day).toBeGreaterThan(0.5);
    expect(p4day).toBeGreaterThan(0.5);
  });

  it('returns high probability for 2.5 sigma above threshold at 1-day', () => {
    // Forecast 87.5F, threshold 80F, 1-day (stddev=3)
    // z = (80-87.5)/3 = -2.5 -> P(X>80) ~ 0.9938
    const p = estimateExceedanceProbability(87.5, 80, 1);
    expect(p).toBeGreaterThan(0.99);
  });
});

// ---------------------------------------------------------------------------
// normalCdf
// ---------------------------------------------------------------------------

describe('normalCdf', () => {
  it('returns 0.5 at z=0', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 4);
  });

  it('returns ~0.8413 at z=1', () => {
    expect(normalCdf(1)).toBeCloseTo(0.8413, 3);
  });

  it('returns ~0.1587 at z=-1', () => {
    expect(normalCdf(-1)).toBeCloseTo(0.1587, 3);
  });

  it('saturates near 0 for very negative z', () => {
    expect(normalCdf(-10)).toBe(0);
  });

  it('saturates near 1 for very positive z', () => {
    expect(normalCdf(10)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// lookupCity
// ---------------------------------------------------------------------------

describe('lookupCity', () => {
  it('finds NYC by alias', () => {
    const result = lookupCity('NYC');
    expect(result).not.toBeNull();
    expect(result!.lat).toBeCloseTo(40.7128, 2);
    expect(result!.noaaCoverage).toBe(true);
  });

  it('finds Chicago case-insensitively', () => {
    const result = lookupCity('CHICAGO');
    expect(result).not.toBeNull();
    expect(result!.noaaCoverage).toBe(true);
  });

  it('returns null for unknown city', () => {
    expect(lookupCity('Timbuktu')).toBeNull();
  });

  it('marks London as no NOAA coverage', () => {
    const result = lookupCity('London');
    expect(result).not.toBeNull();
    expect(result!.noaaCoverage).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// daysUntil
// ---------------------------------------------------------------------------

describe('daysUntil', () => {
  it('returns 0 for same-day when now is past noon target', () => {
    // target noon UTC, now 14:00 UTC → diff negative → clamped to 0
    const now = new Date('2026-04-13T14:00:00Z');
    expect(daysUntil('2026-04-13', now)).toBe(0);
  });

  it('returns 1 for same-day when now is before noon target (ceil rounds up)', () => {
    // target 2026-04-13T12:00:00Z, now 10:00 → 2h remaining → ceil(2/24) = 1
    const now = new Date('2026-04-13T10:00:00Z');
    expect(daysUntil('2026-04-13', now)).toBe(1);
  });

  it('returns 1 for tomorrow at exactly noon', () => {
    // target 2026-04-14T12:00:00Z, now 2026-04-13T12:00:00Z → exactly 1 day
    const now = new Date('2026-04-13T12:00:00Z');
    expect(daysUntil('2026-04-14', now)).toBe(1);
  });

  it('returns 7 for a week out at exactly noon', () => {
    const now = new Date('2026-04-13T12:00:00Z');
    expect(daysUntil('2026-04-20', now)).toBe(7);
  });

  it('returns 0 for past dates', () => {
    const now = new Date('2026-04-13T10:00:00Z');
    expect(daysUntil('2026-04-10', now)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// scanWeatherMarkets (integration-style tests with mocked externals)
// ---------------------------------------------------------------------------

describe('scanWeatherMarkets', () => {
  let redisMock: ReturnType<typeof createRedisMock>;

  beforeEach(() => {
    vi.clearAllMocks();
    redisMock = createRedisMock();
  });

  it('returns empty when no weather markets found', async () => {
    mockSearchEvents.mockResolvedValue([]);

    const results = await scanWeatherMarkets(redisMock as never);
    expect(results).toEqual([]);
  });

  it('shadow-logs opportunities even when scanner is disabled', async () => {
    // Set up a market that should produce an opportunity
    mockSearchEvents.mockResolvedValue([
      {
        id: 'event-1',
        title: 'NYC Weather',
        slug: 'nyc-weather',
        active: true,
        closed: false,
        markets: [
          {
            id: 'market-1',
            question: 'Will the high temperature in NYC exceed 80\u00b0F on July 15, 2030?',
            conditionId: 'cond-1',
            clobTokenIds: '["token-yes","token-no"]',
            outcomePrices: '["0.50","0.50"]',
            outcomes: '["Yes","No"]',
            active: true,
            closed: false,
            volume: '10000',
            liquidity: '5000',
            endDate: '2030-07-15T23:59:59Z',
            description: null,
          },
        ],
      },
    ]);

    // Forecast says 88F high -- strong edge for "exceed 80F"
    mockFetchForecast.mockResolvedValue({
      highF: 88,
      lowF: 65,
      precipProbability: 10,
      forecastDate: '2030-07-15',
      shortForecast: 'Mostly Sunny',
    });

    const results = await scanWeatherMarkets(redisMock as never);

    // Should have found the opportunity and shadow-logged it
    expect(logger.info).toHaveBeenCalledWith(
      '[weather] opportunity evaluated',
      expect.objectContaining({
        marketId: 'market-1',
        city: 'nyc',
        wouldTrade: false, // scanner disabled
      }),
    );

    // Edge should be positive (forecast 88 >> threshold 80)
    expect(results.length).toBeGreaterThan(0);
    if (results[0]) {
      expect(results[0].edge).toBeGreaterThan(0);
      expect(results[0].forecastHighF).toBe(88);
    }
  });

  it('skips deduped markets', async () => {
    mockSearchEvents.mockResolvedValue([
      {
        id: 'event-1',
        title: 'NYC Weather',
        slug: 'nyc-weather',
        active: true,
        closed: false,
        markets: [
          {
            id: 'market-dedup',
            question: 'Will the high temperature in NYC exceed 80\u00b0F on July 15, 2030?',
            conditionId: 'cond-1',
            clobTokenIds: '["token-yes","token-no"]',
            outcomePrices: '["0.50","0.50"]',
            outcomes: '["Yes","No"]',
            active: true,
            closed: false,
            volume: '10000',
            liquidity: '5000',
            endDate: '2030-07-15T23:59:59Z',
            description: null,
          },
        ],
      },
    ]);

    // Pre-set the dedup key
    redisMock._store.set('weather:attempted:market-dedup', '1');

    const results = await scanWeatherMarkets(redisMock as never);
    expect(results).toEqual([]);

    // Forecast should never have been fetched
    expect(mockFetchForecast).not.toHaveBeenCalled();
  });

  it('skips non-US cities', async () => {
    mockSearchEvents.mockResolvedValue([
      {
        id: 'event-1',
        title: 'London Weather',
        slug: 'london-weather',
        active: true,
        closed: false,
        markets: [
          {
            id: 'market-london',
            question: 'Will the high temperature in London exceed 30\u00b0F on July 15, 2030?',
            conditionId: 'cond-1',
            clobTokenIds: '["token-yes","token-no"]',
            outcomePrices: '["0.50","0.50"]',
            outcomes: '["Yes","No"]',
            active: true,
            closed: false,
            volume: '10000',
            liquidity: '5000',
            endDate: '2030-07-15T23:59:59Z',
            description: null,
          },
        ],
      },
    ]);

    const results = await scanWeatherMarkets(redisMock as never);
    expect(results).toEqual([]);
    expect(mockFetchForecast).not.toHaveBeenCalled();

    expect(logger.info).toHaveBeenCalledWith(
      '[weather] scan summary',
      expect.objectContaining({ noUsCity: 1 }),
    );
  });

  it('includes opportunities above minimum edge', async () => {
    mockSearchEvents.mockResolvedValue([
      {
        id: 'event-1',
        title: 'NYC Weather',
        slug: 'nyc-weather',
        active: true,
        closed: false,
        markets: [
          {
            id: 'market-low-edge',
            question: 'Will the high temperature in NYC exceed 80\u00b0F on July 15, 2030?',
            conditionId: 'cond-1',
            clobTokenIds: '["token-yes","token-no"]',
            outcomePrices: '["0.50","0.50"]',
            outcomes: '["Yes","No"]',
            active: true,
            closed: false,
            volume: '10000',
            liquidity: '5000',
            endDate: '2030-07-15T23:59:59Z',
            description: null,
          },
        ],
      },
    ]);

    // Forecast says 81F -- barely above threshold
    mockFetchForecast.mockResolvedValue({
      highF: 81,
      lowF: 65,
      precipProbability: 10,
      forecastDate: '2030-07-15',
      shortForecast: 'Partly Cloudy',
    });

    const results = await scanWeatherMarkets(redisMock as never);

    // The shadow log should have been emitted regardless
    expect(logger.info).toHaveBeenCalledWith(
      '[weather] opportunity evaluated',
      expect.objectContaining({ marketId: 'market-low-edge' }),
    );

    // With forecast of 81 and threshold of 80 at 4+ days out (stddev=6):
    // z = (80-81)/6 = -0.167, P(X>80) ~ 0.566
    // edge = 0.566 - 0.50 = 0.066 > 0.05 min edge -- included in results
    expect(results.length).toBe(1);
    expect(results[0]!.edge).toBeCloseTo(0.066, 1);
  });

  it('handles Gamma API errors gracefully', async () => {
    mockSearchEvents.mockRejectedValue(new Error('Gamma timeout'));

    const results = await scanWeatherMarkets(redisMock as never);
    expect(results).toEqual([]);

    expect(logger.warn).toHaveBeenCalledWith(
      '[weather] Gamma API search failed',
      expect.objectContaining({ error: 'Gamma timeout' }),
    );
  });

  it('deduplicates markets from both search queries', async () => {
    const sharedMarket = {
      id: 'market-shared',
      question: 'Will the high temperature in Chicago exceed 95\u00b0F on July 4, 2030?',
      conditionId: 'cond-1',
      clobTokenIds: '["token-yes","token-no"]',
      outcomePrices: '["0.40","0.60"]',
      outcomes: '["Yes","No"]',
      active: true,
      closed: false,
      volume: '10000',
      liquidity: '5000',
      endDate: '2030-07-04T23:59:59Z',
      description: null,
    };

    // Same market appears in both "weather" and "temperature" results
    mockSearchEvents.mockResolvedValue([
      {
        id: 'event-1',
        title: 'Chicago Heat',
        slug: 'chicago-heat',
        active: true,
        closed: false,
        markets: [sharedMarket],
      },
    ]);

    mockFetchForecast.mockResolvedValue({
      highF: 98,
      lowF: 75,
      precipProbability: 5,
      forecastDate: '2030-07-04',
      shortForecast: 'Hot',
    });

    const results = await scanWeatherMarkets(redisMock as never);

    // Should only process the market once even though searchEvents is called twice
    // (both queries return the same market)
    const forecastCalls = mockFetchForecast.mock.calls.length;
    expect(forecastCalls).toBe(1);

    // Should find an opportunity (forecast 98 >> threshold 95)
    expect(results.length).toBe(1);
  });
});
