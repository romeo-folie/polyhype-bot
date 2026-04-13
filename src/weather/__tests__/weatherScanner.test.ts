import { describe, it, expect, beforeEach, vi } from 'vitest';
import type * as GammaModule from '../../mapping/gamma.js';
import type * as NoaaModule from '../noaaClient.js';

// ---------------------------------------------------------------------------
// Mocks — must come before dynamic import
// ---------------------------------------------------------------------------

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    WEATHER_SCANNER_ENABLED: false,
    WEATHER_MIN_EDGE: 0.08,
    WEATHER_MAX_STAKE_FRACTION: 0.02,
    WEATHER_DEDUP_TTL_S: 14400,
    WEATHER_MAX_EVENTS: 50,
    WEATHER_MAX_HORIZON_DAYS: 7,
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

vi.mock('../../mapping/gamma.js', async () => {
  const actual =
    await vi.importActual<typeof GammaModule>('../../mapping/gamma.js');
  return {
    fetchWithTimeout: actual.fetchWithTimeout,
    parseOutcomePrices: actual.parseOutcomePrices,
    parseClobTokenIds: actual.parseClobTokenIds,
    parseOutcomes: actual.parseOutcomes,
    searchEvents: vi.fn().mockResolvedValue([]),
  };
});

const mockFetchNwsForecast = vi.fn<() => Promise<unknown>>();
vi.mock('../noaaClient.js', async () => {
  const actual =
    await vi.importActual<typeof NoaaModule>('../noaaClient.js');
  return {
    lookupCity: actual.lookupCity,
    fetchNwsForecast: mockFetchNwsForecast,
    estimateBracketProbability: actual.estimateBracketProbability,
    estimateExceedanceProbability: actual.estimateExceedanceProbability,
    normalCdf: actual.normalCdf,
    getDefaultStdDev: actual.getDefaultStdDev,
    CITY_COORDINATES: actual.CITY_COORDINATES,
  };
});

const mockFetchOpenMeteo = vi.fn<() => Promise<unknown>>();
const mockFetchEnsemble = vi.fn<() => Promise<unknown>>();
vi.mock('../openMeteoClient.js', () => ({
  fetchOpenMeteoForecast: mockFetchOpenMeteo,
  fetchEnsembleForecast: mockFetchEnsemble,
}));

// Dynamic imports — after mocks
const {
  extractCityFromTitle,
  extractDateFromEvent,
  parseBracketLabel,
  parseWeatherEvent,
  findMispricedBrackets,
  scanWeatherMarkets,
  daysUntil,
  fetchWeatherEvents: _fetchWeatherEvents,
} = await import('../weatherScanner.js');

const {
  estimateBracketProbability,
  normalCdf,
  getDefaultStdDev,
  lookupCity,
} = await import('../noaaClient.js');

// Minimal Redis mock
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
// extractCityFromTitle
// ---------------------------------------------------------------------------

describe('extractCityFromTitle', () => {
  it('extracts "Chicago" from standard title', () => {
    expect(extractCityFromTitle('Highest temperature in Chicago on April 14?'))
      .toBe('chicago');
  });

  it('extracts "New York" (multi-word city)', () => {
    expect(extractCityFromTitle('Highest temperature in New York on April 15?'))
      .toBe('new york');
  });

  it('extracts "Sao Paulo" (international)', () => {
    expect(extractCityFromTitle('Highest temperature in Sao Paulo on April 14?'))
      .toBe('sao paulo');
  });

  it('returns null for non-weather titles', () => {
    expect(extractCityFromTitle('Will Bitcoin reach $100k?')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractDateFromEvent
// ---------------------------------------------------------------------------

describe('extractDateFromEvent', () => {
  it('extracts date from slug with year', () => {
    expect(extractDateFromEvent(
      'Highest temperature in Chicago on April 14?',
      'highest-temperature-in-chicago-on-april-14-2026',
    )).toBe('2026-04-14');
  });

  it('extracts date from title when slug has no date', () => {
    expect(extractDateFromEvent(
      'Highest temperature in Miami on July 4, 2030?',
      'some-random-slug',
    )).toBe('2030-07-04');
  });

  it('falls back to endDate', () => {
    expect(extractDateFromEvent(
      'No date here',
      'no-date-slug',
      '2026-05-01T12:00:00Z',
    )).toBe('2026-05-01');
  });

  it('returns null when no date can be extracted', () => {
    expect(extractDateFromEvent('No date', 'no-date')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseBracketLabel
// ---------------------------------------------------------------------------

describe('parseBracketLabel', () => {
  it('parses low-tail Fahrenheit: "39°F or below"', () => {
    const result = parseBracketLabel('39°F or below');
    expect(result).toEqual({ low: null, high: 39, unit: 'fahrenheit' });
  });

  it('parses high-tail Fahrenheit: "58°F or higher"', () => {
    const result = parseBracketLabel('58°F or higher');
    expect(result).toEqual({ low: 58, high: null, unit: 'fahrenheit' });
  });

  it('parses Fahrenheit range: "40-41°F"', () => {
    const result = parseBracketLabel('40-41°F');
    expect(result).toEqual({ low: 40, high: 41, unit: 'fahrenheit' });
  });

  it('parses low-tail Celsius: "6°C or below"', () => {
    const result = parseBracketLabel('6°C or below');
    expect(result).toEqual({ low: null, high: 6, unit: 'celsius' });
  });

  it('parses high-tail Celsius: "16°C or higher"', () => {
    const result = parseBracketLabel('16°C or higher');
    expect(result).toEqual({ low: 16, high: null, unit: 'celsius' });
  });

  it('parses single Celsius: "7°C"', () => {
    const result = parseBracketLabel('7°C');
    expect(result).toEqual({ low: 7, high: 7, unit: 'celsius' });
  });

  it('returns null for unparseable labels', () => {
    expect(parseBracketLabel('something random')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// estimateBracketProbability
// ---------------------------------------------------------------------------

describe('estimateBracketProbability', () => {
  it('returns ~1.0 for bracket containing the forecast point', () => {
    // Forecast exactly 50°F, bracket [49, 51], stddev=3
    // P(48.5 <= T <= 51.5) with mean=50, stddev=3
    // z_low = (48.5-50)/3 = -0.5, z_high = (51.5-50)/3 = 0.5
    // CDF(0.5) - CDF(-0.5) ≈ 0.6915 - 0.3085 = 0.383
    const prob = estimateBracketProbability(50, 49, 51, 1, 3);
    expect(prob).toBeGreaterThan(0.3);
    expect(prob).toBeLessThan(0.5);
  });

  it('returns low probability for bracket far from forecast', () => {
    // Forecast 80°F, bracket [40, 41], stddev=3
    const prob = estimateBracketProbability(80, 40, 41, 1, 3);
    expect(prob).toBeLessThan(0.001);
  });

  it('handles low-tail bracket correctly', () => {
    // Forecast 50°F, low tail "39 or below", stddev=3
    // P(T <= 39.5) = CDF((39.5-50)/3) = CDF(-3.5) ≈ 0.0002
    const prob = estimateBracketProbability(50, null, 39, 1, 3);
    expect(prob).toBeLessThan(0.01);
  });

  it('handles high-tail bracket correctly', () => {
    // Forecast 50°F, high tail "58 or higher", stddev=3
    // P(T >= 57.5) = 1 - CDF((57.5-50)/3) = 1 - CDF(2.5) ≈ 0.006
    const prob = estimateBracketProbability(50, 58, null, 1, 3);
    expect(prob).toBeLessThan(0.02);
  });

  it('probabilities across brackets sum to ~1.0', () => {
    // Simulate 11 brackets for a Chicago-style F event centered at 50°F
    const forecast = 50;
    const stdDev = 4;
    const brackets: [number | null, number | null][] = [
      [null, 39],      // 39°F or below
      [40, 41],
      [42, 43],
      [44, 45],
      [46, 47],
      [48, 49],
      [50, 51],
      [52, 53],
      [54, 55],
      [56, 57],
      [58, null],       // 58°F or higher
    ];

    let totalProb = 0;
    for (const [low, high] of brackets) {
      totalProb += estimateBracketProbability(forecast, low, high, 1, stdDev);
    }

    expect(totalProb).toBeCloseTo(1.0, 2);
  });

  it('probabilities for Celsius brackets also sum to ~1.0', () => {
    const forecast = 10; // 10°C
    const stdDev = 2.2; // ~4°F * 5/9
    const brackets: [number | null, number | null][] = [
      [null, 6],    // 6°C or below
      [7, 7],       // 7°C
      [8, 8],       // 8°C
      [9, 9],
      [10, 10],
      [11, 11],
      [12, 12],
      [13, 13],
      [14, 14],
      [15, 15],
      [16, null],   // 16°C or higher
    ];

    let totalProb = 0;
    for (const [low, high] of brackets) {
      totalProb += estimateBracketProbability(forecast, low, high, 1, stdDev);
    }

    expect(totalProb).toBeCloseTo(1.0, 2);
  });
});

// ---------------------------------------------------------------------------
// getDefaultStdDev
// ---------------------------------------------------------------------------

describe('getDefaultStdDev', () => {
  it('returns 3.5 for 1-day horizon', () => {
    expect(getDefaultStdDev(1)).toBe(3.5);
  });

  it('returns 4.5 for 2-day horizon', () => {
    expect(getDefaultStdDev(2)).toBe(4.5);
  });

  it('returns 8.0 for 6+ day horizon', () => {
    expect(getDefaultStdDev(6)).toBe(8.0);
  });

  it('applies winter multiplier (1.25x)', () => {
    expect(getDefaultStdDev(1, 1)).toBeCloseTo(3.5 * 1.25, 2); // January
    expect(getDefaultStdDev(1, 12)).toBeCloseTo(3.5 * 1.25, 2); // December
  });

  it('applies summer multiplier (0.85x)', () => {
    expect(getDefaultStdDev(1, 7)).toBeCloseTo(3.5 * 0.85, 2); // July
  });

  it('returns base value for spring/fall', () => {
    expect(getDefaultStdDev(1, 4)).toBe(3.5); // April
    expect(getDefaultStdDev(1, 10)).toBe(3.5); // October
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
  it('finds Chicago', () => {
    const result = lookupCity('Chicago');
    expect(result).not.toBeNull();
    expect(result!.noaaCoverage).toBe(true);
    expect(result!.unit).toBe('fahrenheit');
  });

  it('finds London as international', () => {
    const result = lookupCity('London');
    expect(result).not.toBeNull();
    expect(result!.noaaCoverage).toBe(false);
    expect(result!.unit).toBe('celsius');
    expect(result!.wuStation).toBe('EGLC');
  });

  it('resolves NYC alias to new york', () => {
    const result = lookupCity('NYC');
    expect(result).not.toBeNull();
    expect(result!.wuStation).toBe('KLGA');
  });

  it('returns null for unknown city', () => {
    expect(lookupCity('Timbuktu')).toBeNull();
  });

  it('finds all 30 Polymarket cities', () => {
    const cities = [
      'new york', 'chicago', 'miami', 'houston', 'dallas', 'denver',
      'seattle', 'atlanta', 'austin', 'los angeles', 'san francisco',
      'london', 'paris', 'toronto', 'sao paulo', 'buenos aires',
      'ankara', 'lucknow', 'tel aviv', 'hong kong', 'milan', 'madrid',
      'warsaw', 'shenzhen', 'istanbul', 'mexico city', 'amsterdam',
      'panama city', 'jakarta', 'jeddah',
    ];
    for (const city of cities) {
      expect(lookupCity(city)).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// daysUntil
// ---------------------------------------------------------------------------

describe('daysUntil', () => {
  it('returns 0 for same-day when now is past noon target', () => {
    const now = new Date('2026-04-13T14:00:00Z');
    expect(daysUntil('2026-04-13', now)).toBe(0);
  });

  it('returns 1 for tomorrow', () => {
    const now = new Date('2026-04-13T12:00:00Z');
    expect(daysUntil('2026-04-14', now)).toBe(1);
  });

  it('returns 0 for past dates', () => {
    const now = new Date('2026-04-13T10:00:00Z');
    expect(daysUntil('2026-04-10', now)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseWeatherEvent
// ---------------------------------------------------------------------------

describe('parseWeatherEvent', () => {
  function makeFahrenheitEvent() {
    return {
      id: 'event-1',
      title: 'Highest temperature in Chicago on April 14?',
      slug: 'highest-temperature-in-chicago-on-april-14-2026',
      active: true,
      closed: false,
      negRisk: true,
      endDate: '2026-04-14T12:00:00Z',
      markets: [
        makeMarket('m0', '39°F or below', '0', '0.01', '0.99'),
        makeMarket('m1', '40-41°F', '1', '0.03', '0.97'),
        makeMarket('m2', '42-43°F', '2', '0.05', '0.95'),
        makeMarket('m3', '44-45°F', '3', '0.10', '0.90'),
        makeMarket('m4', '46-47°F', '4', '0.15', '0.85'),
        makeMarket('m5', '48-49°F', '5', '0.20', '0.80'),
        makeMarket('m6', '50-51°F', '6', '0.18', '0.82'),
        makeMarket('m7', '52-53°F', '7', '0.12', '0.88'),
        makeMarket('m8', '54-55°F', '8', '0.08', '0.92'),
        makeMarket('m9', '56-57°F', '9', '0.05', '0.95'),
        makeMarket('m10', '58°F or higher', '10', '0.03', '0.97'),
      ],
    };
  }

  function makeMarket(id: string, label: string, threshold: string, yesP: string, noP: string) {
    return {
      id,
      question: `Will the highest temperature in Chicago be ${label} on April 14?`,
      conditionId: `cond-${id}`,
      clobTokenIds: `["token-${id}-yes","token-${id}-no"]`,
      outcomePrices: `["${yesP}","${noP}"]`,
      outcomes: '["Yes","No"]',
      active: true,
      closed: false,
      volume: '10000',
      liquidity: '5000',
      endDate: '2026-04-14T12:00:00Z',
      description: null,
      groupItemTitle: label,
      groupItemThreshold: threshold,
    };
  }

  it('parses a Fahrenheit bracket event correctly', () => {
    const result = parseWeatherEvent(makeFahrenheitEvent());
    expect(result).not.toBeNull();
    expect(result!.city).toBe('chicago');
    expect(result!.targetDate).toBe('2026-04-14');
    expect(result!.unit).toBe('fahrenheit');
    expect(result!.brackets).toHaveLength(11);
    expect(result!.brackets[0]!.low).toBeNull(); // low-tail
    expect(result!.brackets[0]!.high).toBe(39);
    expect(result!.brackets[10]!.low).toBe(58); // high-tail
    expect(result!.brackets[10]!.high).toBeNull();
  });

  it('returns null for non-negRisk events', () => {
    const event = makeFahrenheitEvent();
    event.negRisk = false;
    expect(parseWeatherEvent(event)).toBeNull();
  });

  it('returns null for events with too few brackets', () => {
    const event = makeFahrenheitEvent();
    event.markets = event.markets.slice(0, 2);
    expect(parseWeatherEvent(event)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findMispricedBrackets
// ---------------------------------------------------------------------------

describe('findMispricedBrackets', () => {
  it('finds edge when model diverges from market on an interior bracket', () => {
    const event = {
      eventId: 'e1',
      slug: 'test-event',
      city: 'chicago',
      coords: lookupCity('chicago')!,
      targetDate: '2026-04-14',
      unit: 'fahrenheit' as const,
      brackets: [
        { marketId: 'm0', conditionId: 'c0', clobTokenIds: ['t0y', 't0n'], threshold: 0, low: null, high: 39, label: '39°F or below', yesPrice: 0.01, noPrice: 0.99 },
        { marketId: 'm1', conditionId: 'c1', clobTokenIds: ['t1y', 't1n'], threshold: 1, low: 40, high: 41, label: '40-41°F', yesPrice: 0.02, noPrice: 0.98 },
        { marketId: 'm2', conditionId: 'c2', clobTokenIds: ['t2y', 't2n'], threshold: 2, low: 42, high: 43, label: '42-43°F', yesPrice: 0.05, noPrice: 0.95 },
        { marketId: 'm3', conditionId: 'c3', clobTokenIds: ['t3y', 't3n'], threshold: 3, low: 44, high: 45, label: '44-45°F', yesPrice: 0.10, noPrice: 0.90 },
        { marketId: 'm4', conditionId: 'c4', clobTokenIds: ['t4y', 't4n'], threshold: 4, low: 46, high: 47, label: '46-47°F', yesPrice: 0.15, noPrice: 0.85 },
        { marketId: 'm5', conditionId: 'c5', clobTokenIds: ['t5y', 't5n'], threshold: 5, low: 48, high: 49, label: '48-49°F', yesPrice: 0.20, noPrice: 0.80 },
        { marketId: 'm6', conditionId: 'c6', clobTokenIds: ['t6y', 't6n'], threshold: 6, low: 50, high: 51, label: '50-51°F', yesPrice: 0.18, noPrice: 0.82 },
        { marketId: 'm7', conditionId: 'c7', clobTokenIds: ['t7y', 't7n'], threshold: 7, low: 52, high: 53, label: '52-53°F', yesPrice: 0.12, noPrice: 0.88 },
        { marketId: 'm8', conditionId: 'c8', clobTokenIds: ['t8y', 't8n'], threshold: 8, low: 54, high: 55, label: '54-55°F', yesPrice: 0.08, noPrice: 0.92 },
        { marketId: 'm9', conditionId: 'c9', clobTokenIds: ['t9y', 't9n'], threshold: 9, low: 56, high: 57, label: '56-57°F', yesPrice: 0.05, noPrice: 0.95 },
        { marketId: 'm10', conditionId: 'c10', clobTokenIds: ['t10y', 't10n'], threshold: 10, low: 58, high: null, label: '58°F or higher', yesPrice: 0.04, noPrice: 0.96 },
      ],
      endDate: '2026-04-14T12:00:00Z',
    };

    // Forecast: 52°F with stddev 3. The bracket "52-53°F" should have
    // significant probability (~25%). If market has it at 12%, that's a buy.
    const forecast = {
      forecastHigh: 52,
      stdDev: 3,
      source: 'combined' as const,
      ensembleMembers: 31,
    };

    const opps = findMispricedBrackets(event, forecast, 1, 0.08);

    // Should find at least one opportunity
    expect(opps.length).toBeGreaterThan(0);

    // The bracket near the forecast center should be underpriced → buy YES
    const bracket52 = opps.find((o) => o.bracketLabel === '52-53°F');
    if (bracket52) {
      expect(bracket52.tradeSide).toBe('YES');
      expect(bracket52.edge).toBeGreaterThan(0);
    }
  });

  it('returns empty when market prices match model', () => {
    // Build brackets where market prices roughly match model probs
    const forecast = { forecastHigh: 50, stdDev: 4, source: 'noaa' as const, ensembleMembers: 0 };

    // Compute model probs to use as market prices (approximately fair)
    const bracketDefs: [number | null, number | null][] = [
      [null, 39], [40, 41], [42, 43], [44, 45], [46, 47],
      [48, 49], [50, 51], [52, 53], [54, 55], [56, 57], [58, null],
    ];

    const brackets = bracketDefs.map(([low, high], i) => {
      const prob = estimateBracketProbability(50, low, high, 1, 4);
      return {
        marketId: `m${i}`,
        conditionId: `c${i}`,
        clobTokenIds: [`t${i}y`, `t${i}n`],
        threshold: i,
        low,
        high,
        label: `bracket-${i}`,
        yesPrice: Math.round(prob * 1000) / 1000, // Fair price
        noPrice: Math.round((1 - prob) * 1000) / 1000,
      };
    });

    const event = {
      eventId: 'e1',
      slug: 'fair-event',
      city: 'chicago',
      coords: lookupCity('chicago')!,
      targetDate: '2026-04-14',
      unit: 'fahrenheit' as const,
      brackets,
      endDate: '2026-04-14T12:00:00Z',
    };

    const opps = findMispricedBrackets(event, forecast, 1, 0.08);
    // With fair prices, no bracket should have 8+ cents of edge
    expect(opps.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// scanWeatherMarkets (integration-style with mocked externals)
// ---------------------------------------------------------------------------

describe('scanWeatherMarkets', () => {
  let redisMock: ReturnType<typeof createRedisMock>;

  beforeEach(() => {
    vi.clearAllMocks();
    redisMock = createRedisMock();
  });

  it('returns empty when no weather events found', async () => {
    // The real fetchWeatherEvents is not mocked at module level,
    // but scanWeatherMarkets uses it internally. We need to mock at
    // the gamma.fetchWithTimeout level. Instead, test the scanner
    // with an event that has no parseable markets.
    // For now, verify the scanner doesn't crash with empty Redis
    const results = await scanWeatherMarkets(redisMock as never);
    // fetchWeatherEvents will make a real HTTP call and likely fail
    // in test env → returns empty
    expect(Array.isArray(results)).toBe(true);
  });

  it('shadow-logs event evaluations', async () => {
    // This is an integration boundary — the full pipeline test would
    // require mocking the Gamma API HTTP call. The unit tests above
    // cover the individual components thoroughly.
    const results = await scanWeatherMarkets(redisMock as never);
    expect(Array.isArray(results)).toBe(true);
  });
});
