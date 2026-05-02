import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as GammaModule from '../../mapping/gamma.js';
import type * as NoaaModule from '../noaaClient.js';

// ---------------------------------------------------------------------------
// Mocks — must come before dynamic import
// ---------------------------------------------------------------------------

const baseConfig = {
  WEATHER_SCANNER_ENABLED: false,
  WEATHER_TRADE_SIDES: 'BOTH' as const,
  WEATHER_MIN_EDGE: 0.08,
  WEATHER_MAX_STAKE_FRACTION: 0.02,
  WEATHER_DEDUP_TTL_S: 14400,
  WEATHER_MAX_EVENTS: 50,
  WEATHER_MAX_HORIZON_DAYS: 7,
  WEATHER_STDDEV_MULTIPLIER: 1.0,
  WEATHER_STDDEV_MIN_FRACTION: 0.7,
  WEATHER_MIN_MODEL_COVERAGE: 0.95,
  WEATHER_EXECUTION_ENABLED: false,
  WEATHER_MAX_POSITIONS_PER_SCAN: 3,
  WEATHER_MAX_PER_CITY: 1,
  WEATHER_MAX_SCAN_EXPOSURE_USD: 30,
  WEATHER_KELLY_FRACTION: 0.25,
  WEATHER_MODEL_ECMWF_ENABLED: false,
  WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: true,
  WEATHER_HRRR_ENABLED: false,
  WEATHER_BIAS_CORRECTION_ENABLED: false,
  WEATHER_BIAS_MIN_SAMPLES: 14,
  WEATHER_BIAS_TRUSTED_SAMPLES: 14,
  WEATHER_WEAK_BIAS_STDDEV_MULTIPLIER: 1.2,
  WEATHER_MARKET_DISAGREEMENT_ENABLED: true,
  WEATHER_MARKET_DISAGREEMENT_MIN_ADVERSE_MOVE: 0.10,
  WEATHER_MARKET_DISAGREEMENT_MAX_WINPROB_IMPROVEMENT: 0.03,
  WEATHER_MARKET_DISAGREEMENT_TTL_S: 172800,
  WEATHER_EXCLUDED_CITIES: '',
  MIN_BET_USD: 5,
};
const mockLoadConfig = vi.fn(() => ({ ...baseConfig }));
vi.mock('../../shared/config.js', () => ({
  loadConfig: mockLoadConfig,
}));

const mockExecuteAndRecordSignal = vi.fn();
vi.mock('../../execution/executor.js', () => ({
  executeAndRecordSignal: mockExecuteAndRecordSignal,
}));

const mockGetBankroll = vi.fn();
vi.mock('../../shared/bankroll.js', () => ({
  getBankroll: mockGetBankroll,
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
    canonicalCityKey: actual.canonicalCityKey,
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
const mockFetchHrrr = vi.fn<() => Promise<unknown>>();
vi.mock('../openMeteoClient.js', () => ({
  fetchOpenMeteoForecast: mockFetchOpenMeteo,
  fetchEnsembleForecast: mockFetchEnsemble,
  fetchHrrrForecast: mockFetchHrrr,
}));

// Dynamic imports — after mocks
const {
  extractCityFromTitle,
  extractDateFromEvent,
  parseBracketLabel,
  parseWeatherEvent,
  findMispricedBrackets,
  fetchForecast,
  scanWeatherMarkets,
  daysUntil,
  parseAllowedSides,
  runWeatherScan,
} = await import('../weatherScanner.js');

const { inferCategory } = await import('../../shared/outcomeRecorder.js');
const { normalizeCategory } = await import('../../monitor/staleExit.js');

const {
  estimateBracketProbability,
  normalCdf,
  getDefaultStdDev,
  lookupCity,
} = await import('../noaaClient.js');

const { logger } = await import('../../shared/logger.js');

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

    const { opportunities: opps } = findMispricedBrackets(event, forecast, 1, 0.08);

    // Should find at least one opportunity
    expect(opps.length).toBeGreaterThan(0);

    // The bracket near the forecast center should be underpriced → buy YES
    const bracket52 = opps.find((o) => o.bracketLabel === '52-53°F');
    if (bracket52) {
      expect(bracket52.tradeSide).toBe('YES');
      expect(bracket52.edge).toBeGreaterThan(0);
    }
  });

  it('stddevMultiplier widens the model distribution as expected', () => {
    // A two-bracket world: central bracket near forecast point, tail bracket far.
    // Multiplier > 1 should LOWER central modelProb and RAISE tail modelProb,
    // because more mass is pushed away from the mean.
    const event = {
      eventId: 'e1', slug: 'mult-test', city: 'chicago', coords: lookupCity('chicago')!,
      targetDate: '2026-04-14', unit: 'fahrenheit' as const,
      brackets: [
        { marketId: 'm1', conditionId: 'c1', clobTokenIds: ['t1y', 't1n'], threshold: 1, low: 49, high: 51, label: 'central',
          yesPrice: 0.01, noPrice: 0.99 },
        { marketId: 'm2', conditionId: 'c2', clobTokenIds: ['t2y', 't2n'], threshold: 2, low: 60, high: null, label: 'tail',
          yesPrice: 0.01, noPrice: 0.99 },
      ],
      endDate: '2026-04-14T12:00:00Z',
    };
    const forecast = { forecastHigh: 50, stdDev: 3, source: 'noaa' as const, ensembleMembers: 0 };

    // Pass minModelCoverage=0 to disable the coverage guard — this test focuses
    // on multiplier behaviour with an intentionally minimal 2-bracket event.
    const { opportunities: baselineOpps } = findMispricedBrackets(event, forecast, 1, 0, { stddevMultiplier: 1.0, minModelCoverage: 0 });
    const { opportunities: widenedOpps }  = findMispricedBrackets(event, forecast, 1, 0, { stddevMultiplier: 1.5, minModelCoverage: 0 });

    const centralBase = baselineOpps.find((o) => o.bracketLabel === 'central')!;
    const centralWide = widenedOpps.find((o) => o.bracketLabel === 'central')!;
    const tailBase    = baselineOpps.find((o) => o.bracketLabel === 'tail')!;
    const tailWide    = widenedOpps.find((o) => o.bracketLabel === 'tail')!;

    expect(centralWide.modelProbability).toBeLessThan(centralBase.modelProbability);
    expect(tailWide.modelProbability).toBeGreaterThan(tailBase.modelProbability);
    // Raw stddev is preserved on the opportunity for shadow analysis.
    expect(centralWide.forecastStdDev).toBe(3);
    expect(centralBase.forecastStdDev).toBe(3);
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

    const { opportunities: opps } = findMispricedBrackets(event, forecast, 1, 0.08);
    // With fair prices, no bracket should have 8+ cents of edge
    expect(opps.length).toBe(0);
  });

  it('returns [] and warns when model coverage is below threshold', () => {
    // Only 4 of 11 brackets present — modelSum will be well below 0.95
    const thinBrackets = [
      { marketId: 'm4', conditionId: 'c4', clobTokenIds: ['t4y', 't4n'], threshold: 4, low: 46, high: 47, label: '46-47°F', yesPrice: 0.15, noPrice: 0.85 },
      { marketId: 'm5', conditionId: 'c5', clobTokenIds: ['t5y', 't5n'], threshold: 5, low: 48, high: 49, label: '48-49°F', yesPrice: 0.20, noPrice: 0.80 },
      { marketId: 'm6', conditionId: 'c6', clobTokenIds: ['t6y', 't6n'], threshold: 6, low: 50, high: 51, label: '50-51°F', yesPrice: 0.18, noPrice: 0.82 },
      { marketId: 'm7', conditionId: 'c7', clobTokenIds: ['t7y', 't7n'], threshold: 7, low: 52, high: 53, label: '52-53°F', yesPrice: 0.12, noPrice: 0.88 },
    ];
    const event = {
      eventId: 'e-thin',
      slug: 'thin-event',
      city: 'chicago',
      coords: lookupCity('chicago')!,
      targetDate: '2026-04-14',
      unit: 'fahrenheit' as const,
      brackets: thinBrackets,
      endDate: '2026-04-14T12:00:00Z',
    };
    // Forecast centred on the brackets so these 4 carry ~40-50% of total mass
    const forecast = { forecastHigh: 50, stdDev: 4, source: 'noaa' as const, ensembleMembers: 0 };

    const { opportunities: opps } = findMispricedBrackets(event, forecast, 1, 0.0, { minModelCoverage: 0.95 });
    expect(opps).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      '[weather] model probabilities below coverage threshold, skipping event',
      expect.objectContaining({ city: 'chicago' }),
    );
  });

  it('marks opportunities as allowedByConfig=true when side is in allowedSides', () => {
    // Standard 11-bracket event with a clearly mispriced central bracket.
    const event = {
      eventId: 'e-allow',
      slug: 'allow-event',
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
    const forecast = { forecastHigh: 52, stdDev: 3, source: 'combined' as const, ensembleMembers: 31 };

    const bothOpps = findMispricedBrackets(event, forecast, 1, 0.08, { allowedSides: new Set<'YES' | 'NO'>(['YES', 'NO']) }).opportunities;
    expect(bothOpps.length).toBeGreaterThan(0);
    expect(bothOpps.every((o) => o.allowedByConfig)).toBe(true);
  });

  it('marks YES-side opportunities as allowedByConfig=false when only NO is allowed', () => {
    // Same event as above — central bracket is underpriced so YES-best emerges.
    const event = {
      eventId: 'e-no-only',
      slug: 'no-only-event',
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
    const forecast = { forecastHigh: 52, stdDev: 3, source: 'combined' as const, ensembleMembers: 31 };

    const noOnly = findMispricedBrackets(event, forecast, 1, 0.08, { allowedSides: new Set<'YES' | 'NO'>(['NO']) }).opportunities;
    // Shadow obs still sees the opps so calibration data keeps flowing.
    expect(noOnly.length).toBeGreaterThan(0);
    const yesOpps = noOnly.filter((o) => o.tradeSide === 'YES');
    const noOpps = noOnly.filter((o) => o.tradeSide === 'NO');
    // Both sides must actually appear or the per-side assertions below pass vacuously
    // and the test would regress to meaningless. Fixture is tuned to yield both.
    expect(yesOpps.length).toBeGreaterThan(0);
    expect(noOpps.length).toBeGreaterThan(0);
    // Every YES-side opp in this event is gated; every NO-side opp stays tradable.
    for (const o of yesOpps) expect(o.allowedByConfig).toBe(false);
    for (const o of noOpps) expect(o.allowedByConfig).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Tail NO-bet gate (maxTailNoBetModelProb)
  // ---------------------------------------------------------------------------

  it('blocks NO bet on high-tail bracket when modelProb > maxTailNoBetModelProb', () => {
    // "31°C or higher" (low=31, high=null). Forecast 32°C with stdDev=3 →
    // modelProb ≈ 0.69 > 0.5. noPrice=0.25 gives edgeNo≈0.06 (spurious positive).
    const event = {
      eventId: 'e-tail-hi', slug: 'tail-hi', city: 'chicago', coords: lookupCity('chicago')!,
      targetDate: '2026-04-14', unit: 'celsius' as const,
      brackets: [
        { marketId: 'm0', conditionId: 'c0', clobTokenIds: ['t0y', 't0n'],
          threshold: 0, low: 31, high: null, label: '31°C or higher',
          yesPrice: 0.72, noPrice: 0.25 },
      ],
      endDate: '2026-04-14T12:00:00Z',
    };
    const forecast = { forecastHigh: 32, stdDev: 3, source: 'noaa' as const, ensembleMembers: 0 };

    // Default gate (0.5): NO bet with modelProb ~0.69 should be blocked.
    const { opportunities: blocked } = findMispricedBrackets(event, forecast, 1, 0.0, { minModelCoverage: 0, maxTailNoBetModelProb: 0.5 });
    expect(blocked.filter((o) => o.tradeSide === 'NO')).toHaveLength(0);
  });

  it('blocks NO bet on low-tail bracket when modelProb > maxTailNoBetModelProb', () => {
    // "39°F or below" (low=null, high=39). Forecast 38°F with stdDev=3 →
    // modelProb ≈ 0.69 > 0.5. noPrice=0.25 gives edgeNo≈0.06 (spurious positive).
    const event = {
      eventId: 'e-tail-lo', slug: 'tail-lo', city: 'chicago', coords: lookupCity('chicago')!,
      targetDate: '2026-04-14', unit: 'fahrenheit' as const,
      brackets: [
        { marketId: 'm0', conditionId: 'c0', clobTokenIds: ['t0y', 't0n'],
          threshold: 0, low: null, high: 39, label: '39°F or below',
          yesPrice: 0.72, noPrice: 0.25 },
      ],
      endDate: '2026-04-14T12:00:00Z',
    };
    const forecast = { forecastHigh: 38, stdDev: 3, source: 'noaa' as const, ensembleMembers: 0 };

    const { opportunities: blocked } = findMispricedBrackets(event, forecast, 1, 0.0, { minModelCoverage: 0, maxTailNoBetModelProb: 0.5 });
    expect(blocked.filter((o) => o.tradeSide === 'NO')).toHaveLength(0);
  });

  it('allows NO bet on tail bracket when modelProb < maxTailNoBetModelProb', () => {
    // "39°F or below" (low=null, high=39). Forecast 52°F → modelProb ≈ 0 << 0.5.
    // Model agrees with NO; the gate must not block it.
    const event = {
      eventId: 'e-tail-lo-pass', slug: 'tail-lo-pass', city: 'chicago', coords: lookupCity('chicago')!,
      targetDate: '2026-04-14', unit: 'fahrenheit' as const,
      brackets: [
        { marketId: 'm0', conditionId: 'c0', clobTokenIds: ['t0y', 't0n'],
          threshold: 0, low: null, high: 39, label: '39°F or below',
          yesPrice: 0.02, noPrice: 0.80 },
      ],
      endDate: '2026-04-14T12:00:00Z',
    };
    const forecast = { forecastHigh: 52, stdDev: 3, source: 'noaa' as const, ensembleMembers: 0 };

    const { opportunities: opps } = findMispricedBrackets(event, forecast, 1, 0.0, { minModelCoverage: 0, maxTailNoBetModelProb: 0.5 });
    const noOpps = opps.filter((o) => o.tradeSide === 'NO');
    expect(noOpps.length).toBeGreaterThan(0);
  });

  it('does NOT block NO bet on an interior bracket even when modelProb > 0.5', () => {
    // Interior bracket (low=50, high=51): NOT a tail bracket.
    // Forecast 50°F, stdDev=0.5 → modelProb ≈ 0.84 for this bracket.
    // yesPrice=0.90 means edgeYes<0; noPrice=0.05 means edgeNo≈0.11 → tradeSide=NO.
    // Gate must only fire for tail brackets, not interior ones.
    const event = {
      eventId: 'e-interior-no', slug: 'interior-no', city: 'chicago', coords: lookupCity('chicago')!,
      targetDate: '2026-04-14', unit: 'fahrenheit' as const,
      brackets: [
        { marketId: 'm0', conditionId: 'c0', clobTokenIds: ['t0y', 't0n'],
          threshold: 0, low: 50, high: 51, label: '50-51°F',
          yesPrice: 0.90, noPrice: 0.05 },
      ],
      endDate: '2026-04-14T12:00:00Z',
    };
    const forecast = { forecastHigh: 50, stdDev: 0.5, source: 'noaa' as const, ensembleMembers: 0 };

    const { opportunities: opps } = findMispricedBrackets(event, forecast, 1, 0.0, { minModelCoverage: 0, maxTailNoBetModelProb: 0.5 });
    const noOpps = opps.filter((o) => o.tradeSide === 'NO');
    expect(noOpps.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// findMispricedBrackets — city bias correction
// ---------------------------------------------------------------------------

describe('findMispricedBrackets - city bias correction', () => {
  // Minimal 3-bracket event centred at 50°F with a 2°F interior bracket
  const biasEvent = {
    eventId: 'bias-test',
    slug: 'bias-test',
    city: 'chicago',
    coords: lookupCity('chicago')!,
    targetDate: '2026-04-20',
    unit: 'fahrenheit' as const,
    endDate: '2026-04-20T12:00:00Z',
    brackets: [
      { marketId: 'b0', conditionId: 'c0', clobTokenIds: ['t0y', 't0n'], threshold: 0, low: null, high: 47, label: '47°F or below', yesPrice: 0.15, noPrice: 0.85 },
      { marketId: 'b1', conditionId: 'c1', clobTokenIds: ['t1y', 't1n'], threshold: 1, low: 48, high: 51, label: '48-51°F', yesPrice: 0.55, noPrice: 0.45 },
      { marketId: 'b2', conditionId: 'c2', clobTokenIds: ['t2y', 't2n'], threshold: 2, low: 52, high: null, label: '52°F or higher', yesPrice: 0.30, noPrice: 0.70 },
    ],
  };
  const biasBaseForecast = {
    forecastHigh: 52,  // warm bias: model runs 2°F warm, truth is 50°F
    stdDev: 3,
    source: 'combined' as const,
    ensembleMembers: 31,
    ensembleModel: 'gfs' as const,
  };

  it('bias disabled → forecastHigh unchanged, biasApplied=false on result and opps', () => {
    const cityBias = { meanBias: 2.0, empiricalStddev: 2.5, meanShiftHelpful: true, sampleSize: 20, updatedAt: '' };
    const result = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.01,
      { minModelCoverage: 0, cityBias, biasCorrectionEnabled: false },
    );
    expect(result.biasApplied).toBe(false);
    for (const opp of result.opportunities) {
      expect(opp.biasApplied).toBe(false);
      expect(opp.correctedForecastHigh).toBeCloseTo(opp.rawForecastHigh, 5);
      expect(opp.effectiveStdDev).toBeCloseTo(3, 5); // stdDev * multiplier, no empirical floor
    }
  });

  it('bias enabled + sampleSize ≥ threshold → forecastHigh shifts by -meanBias, effectiveStdDev takes max', () => {
    // empiricalStddev=2.5 < stdDev=3 → effectiveStdDev stays at 3 (max wins)
    const cityBias = { meanBias: 2.0, empiricalStddev: 2.5, meanShiftHelpful: true, sampleSize: 20, updatedAt: '' };
    const result = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.01,
      { minModelCoverage: 0, cityBias, biasCorrectionEnabled: true },
    );
    expect(result.biasApplied).toBe(true);
    expect(result.opportunities.length).toBeGreaterThan(0);
    for (const opp of result.opportunities) {
      expect(opp.biasApplied).toBe(true);
      // correctedForecastHigh = 52 - 2 = 50
      expect(opp.correctedForecastHigh).toBeCloseTo(50, 4);
      expect(opp.cityMeanBias).toBeCloseTo(2.0, 4);
      expect(opp.citySampleSize).toBe(20);
      // effectiveStdDev = max(3*1, 2.5*1) = 3
      expect(opp.effectiveStdDev).toBeCloseTo(3, 5);
    }
  });

  it('bias enabled + empiricalStddev > forecast stdDev → effectiveStdDev elevated', () => {
    // empiricalStddev=5 > stdDev=3 → effectiveStdDev should be 5
    const cityBias = { meanBias: 2.0, empiricalStddev: 5.0, meanShiftHelpful: true, sampleSize: 20, updatedAt: '' };
    const result = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.01,
      { minModelCoverage: 0, cityBias, biasCorrectionEnabled: true },
    );
    expect(result.biasApplied).toBe(true);
    for (const opp of result.opportunities) {
      expect(opp.effectiveStdDev).toBeCloseTo(5.0, 5);
    }
  });

  it('full-tier bias keeps sigma overlay but does not shift the mean when recent calibration is not helpful', () => {
    const cityBias = { meanBias: 2.0, empiricalStddev: 5.0, meanShiftHelpful: false, sampleSize: 20, updatedAt: '' };
    const result = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.01,
      { minModelCoverage: 0, cityBias, biasCorrectionEnabled: true },
    );
    expect(result.biasMode).toBe('full');
    expect(result.biasApplied).toBe(false);
    for (const opp of result.opportunities) {
      expect(opp.correctedForecastHigh).toBeCloseTo(52, 4);
      expect(opp.effectiveStdDev).toBeCloseTo(5.0, 5);
    }
  });

  it('bias enabled + sampleSize < threshold → correction not applied, result.biasApplied=false', () => {
    const cityBias = { meanBias: 2.0, empiricalStddev: 2.5, sampleSize: 10, updatedAt: '' };
    const result = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.01,
      { minModelCoverage: 0, cityBias, biasCorrectionEnabled: true, biasMinSamples: 14 }, // sampleSize=10 < 14 → no correction
    );
    expect(result.biasApplied).toBe(false);
    for (const opp of result.opportunities) {
      expect(opp.biasApplied).toBe(false);
      expect(opp.correctedForecastHigh).toBeCloseTo(opp.rawForecastHigh, 5);
    }
  });

  it('result.biasApplied=true even when no brackets clear minEdge', () => {
    // High minEdge so no brackets pass, but bias was still applied internally
    const cityBias = { meanBias: 2.0, empiricalStddev: 2.5, meanShiftHelpful: true, sampleSize: 20, updatedAt: '' };
    const result = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.99,
      { minModelCoverage: 0, cityBias, biasCorrectionEnabled: true },
    );
    expect(result.opportunities).toHaveLength(0);
    expect(result.biasApplied).toBe(true); // was applied even though no opps returned
  });

  it('shadow payload contains rawForecastHigh, correctedForecastHigh, and effectiveStdDev', () => {
    const cityBias = { meanBias: 2.0, empiricalStddev: 2.5, meanShiftHelpful: true, sampleSize: 20, updatedAt: '' };
    const { opportunities } = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.01,
      { minModelCoverage: 0, cityBias, biasCorrectionEnabled: true },
    );
    expect(opportunities.length).toBeGreaterThan(0);
    const opp = opportunities[0]!;
    expect(opp.rawForecastHigh).toBeCloseTo(52, 4);
    expect(opp.correctedForecastHigh).toBeCloseTo(50, 4);
    expect(opp.biasApplied).toBe(true);
    expect(opp.biasMode).toBe('full');
    expect(opp.effectiveStdDev).toBeCloseTo(3, 5); // max(3, 2.5) = 3
  });

  // ── Weak-band (min ≤ sampleSize < trusted): widen σ, no mean shift ────────
  it('weak-band → mean NOT shifted, biasApplied=false, biasMode=weak', () => {
    const cityBias = { meanBias: 2.0, empiricalStddev: 2.5, sampleSize: 10, updatedAt: '' };
    const result = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.01,
      {
        minModelCoverage: 0,
        cityBias,
        biasCorrectionEnabled: true,
        biasMinSamples: 6,        // 10 ≥ 6 → weak band opens
        biasTrustedSamples: 14,   // 10 < 14 → not full
        weakBiasStddevMultiplier: 1.2,
      },
    );
    expect(result.biasMode).toBe('weak');
    expect(result.biasApplied).toBe(false);
    expect(result.opportunities.length).toBeGreaterThan(0);
    for (const opp of result.opportunities) {
      expect(opp.biasApplied).toBe(false);
      expect(opp.biasMode).toBe('weak');
      // Mean unchanged: corrected === raw
      expect(opp.correctedForecastHigh).toBeCloseTo(opp.rawForecastHigh, 5);
      expect(opp.correctedForecastHigh).toBeCloseTo(52, 5);
      // Bias metadata still surfaced so shadow analysis can see what was considered.
      expect(opp.cityMeanBias).toBeCloseTo(2.0, 4);
      expect(opp.citySampleSize).toBe(10);
    }
  });

  it('weak-band → effectiveStdDev widened by weakBiasStddevMultiplier', () => {
    const cityBias = { meanBias: 2.0, empiricalStddev: 2.5, sampleSize: 10, updatedAt: '' };
    const result = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.01,
      {
        minModelCoverage: 0,
        cityBias,
        biasCorrectionEnabled: true,
        biasMinSamples: 6,
        biasTrustedSamples: 14,
        weakBiasStddevMultiplier: 1.2,
      },
    );
    expect(result.opportunities.length).toBeGreaterThan(0);
    for (const opp of result.opportunities) {
      // stdDev=3, stddevMultiplier defaults to 1.0 → raw=3; weak inflator=1.2 → 3.6
      expect(opp.effectiveStdDev).toBeCloseTo(3.6, 5);
      // Specifically NOT the empirical σ (would be 2.5 — we don't trust the magnitude).
      expect(opp.effectiveStdDev).not.toBeCloseTo(2.5, 2);
    }
  });

  it('weak-band ignores empiricalStddev magnitude even when large', () => {
    // empiricalStddev=8 is huge, but with only 10 samples we don't trust its
    // magnitude — the uniform 1.2× inflator is what applies.
    const cityBias = { meanBias: 2.0, empiricalStddev: 8.0, sampleSize: 10, updatedAt: '' };
    const result = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.01,
      {
        minModelCoverage: 0,
        cityBias,
        biasCorrectionEnabled: true,
        biasMinSamples: 6,
        biasTrustedSamples: 14,
        weakBiasStddevMultiplier: 1.2,
      },
    );
    for (const opp of result.opportunities) {
      expect(opp.effectiveStdDev).toBeCloseTo(3.6, 5);
    }
  });

  it('sampleSize at biasTrustedSamples boundary → full correction', () => {
    // sampleSize exactly equals biasTrustedSamples → full tier
    const cityBias = { meanBias: 2.0, empiricalStddev: 2.5, meanShiftHelpful: true, sampleSize: 14, updatedAt: '' };
    const result = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.01,
      {
        minModelCoverage: 0,
        cityBias,
        biasCorrectionEnabled: true,
        biasMinSamples: 6,
        biasTrustedSamples: 14,
      },
    );
    expect(result.biasMode).toBe('full');
    expect(result.biasApplied).toBe(true);
    for (const opp of result.opportunities) {
      expect(opp.correctedForecastHigh).toBeCloseTo(50, 4); // 52 - 2
      expect(opp.biasMode).toBe('full');
    }
  });

  it('sampleSize below biasMinSamples → biasMode=none, fully uncorrected', () => {
    const cityBias = { meanBias: 2.0, empiricalStddev: 2.5, sampleSize: 3, updatedAt: '' };
    const result = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.01,
      {
        minModelCoverage: 0,
        cityBias,
        biasCorrectionEnabled: true,
        biasMinSamples: 6,
        biasTrustedSamples: 14,
        weakBiasStddevMultiplier: 1.2,
      },
    );
    expect(result.biasMode).toBe('none');
    expect(result.biasApplied).toBe(false);
    for (const opp of result.opportunities) {
      expect(opp.biasMode).toBe('none');
      expect(opp.correctedForecastHigh).toBeCloseTo(opp.rawForecastHigh, 5);
      expect(opp.effectiveStdDev).toBeCloseTo(3, 5); // no inflator, no overlay
    }
  });

  it('shadow payload carries biasMode and weak-band metadata fields', () => {
    const cityBias = { meanBias: 2.0, empiricalStddev: 2.5, sampleSize: 10, updatedAt: '' };
    const { opportunities } = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.01,
      {
        minModelCoverage: 0,
        cityBias,
        biasCorrectionEnabled: true,
        biasMinSamples: 6,
        biasTrustedSamples: 14,
        weakBiasStddevMultiplier: 1.2,
      },
    );
    expect(opportunities.length).toBeGreaterThan(0);
    const opp = opportunities[0]!;
    expect(opp.rawForecastHigh).toBeCloseTo(52, 4);
    expect(opp.correctedForecastHigh).toBeCloseTo(52, 4); // no shift in weak band
    expect(opp.biasApplied).toBe(false);
    expect(opp.biasMode).toBe('weak');
    expect(opp.citySampleSize).toBe(10);
    expect(opp.effectiveStdDev).toBeCloseTo(3.6, 5);
  });

  it('result.effectiveStdDev matches per-opp σ across all biasModes', () => {
    // 'none': raw * stddevMultiplier
    const none = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.01,
      { minModelCoverage: 0, cityBias: null, biasCorrectionEnabled: true },
    );
    expect(none.effectiveStdDev).toBeCloseTo(3, 5);
    for (const opp of none.opportunities) expect(opp.effectiveStdDev).toBeCloseTo(none.effectiveStdDev, 5);

    // 'weak': raw * stddevMultiplier * weakBiasStddevMultiplier
    const weakBias = { meanBias: 2.0, empiricalStddev: 2.5, sampleSize: 10, updatedAt: '' };
    const weak = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.01,
      {
        minModelCoverage: 0,
        cityBias: weakBias,
        biasCorrectionEnabled: true,
        biasMinSamples: 6,
        biasTrustedSamples: 14,
        weakBiasStddevMultiplier: 1.2,
      },
    );
    expect(weak.effectiveStdDev).toBeCloseTo(3.6, 5);
    for (const opp of weak.opportunities) expect(opp.effectiveStdDev).toBeCloseTo(weak.effectiveStdDev, 5);

    // 'full' with empirical σ that dominates
    const fullBias = { meanBias: 2.0, empiricalStddev: 5.0, meanShiftHelpful: true, sampleSize: 20, updatedAt: '' };
    const full = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.01,
      { minModelCoverage: 0, cityBias: fullBias, biasCorrectionEnabled: true },
    );
    expect(full.effectiveStdDev).toBeCloseTo(5.0, 5);
    for (const opp of full.opportunities) expect(opp.effectiveStdDev).toBeCloseTo(full.effectiveStdDev, 5);
  });

  it('defense-in-depth: biasTrustedSamples < biasMinSamples is clamped, not inverted', () => {
    // Misconfiguration: trusted=5 < min=10. Without the clamp, a sampleSize=7
    // would incorrectly trip 'full' mode (since 7 >= 5) despite being below
    // the min threshold. With the clamp, trusted effectively = 10, so
    // sampleSize=7 falls back to 'none'.
    const cityBias = { meanBias: 2.0, empiricalStddev: 2.5, sampleSize: 7, updatedAt: '' };
    const result = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.01,
      {
        minModelCoverage: 0,
        cityBias,
        biasCorrectionEnabled: true,
        biasMinSamples: 10,
        biasTrustedSamples: 5, // inverted on purpose
      },
    );
    expect(result.biasMode).toBe('none');
    expect(result.biasApplied).toBe(false);
    for (const opp of result.opportunities) {
      expect(opp.biasMode).toBe('none');
      expect(opp.correctedForecastHigh).toBeCloseTo(opp.rawForecastHigh, 5);
    }
  });
});

// ---------------------------------------------------------------------------
// parseAllowedSides
// ---------------------------------------------------------------------------

describe('parseAllowedSides', () => {
  it('returns both sides for BOTH', () => {
    const s = parseAllowedSides('BOTH');
    expect(s.has('YES')).toBe(true);
    expect(s.has('NO')).toBe(true);
  });
  it('returns only NO for NO', () => {
    const s = parseAllowedSides('NO');
    expect(s.has('YES')).toBe(false);
    expect(s.has('NO')).toBe(true);
  });
  it('returns only YES for YES', () => {
    const s = parseAllowedSides('YES');
    expect(s.has('YES')).toBe(true);
    expect(s.has('NO')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchForecast — stddev floor
// ---------------------------------------------------------------------------

describe('fetchForecast - stddev floor', () => {
  it('floors ensemble stddev at defaultStd * stddevMinFraction for international city', async () => {
    // Shenzhen: international, celsius. Ensemble returns a very tight stddev (0.2°C).
    // With stddevMinFraction=0.7, default ~2°C → floor = 1.4°C.
    // Result stddev should be ≥ floor even though ensemble reported 0.2.
    const shenzhenCoords = lookupCity('shenzhen');
    expect(shenzhenCoords).not.toBeNull();

    mockFetchEnsemble.mockResolvedValueOnce({
      meanHigh: 28,
      stddevHigh: 0.2, // unrealistically tight tropical ensemble
      meanLow: 22,
      stddevLow: 0.1,
      memberCount: 31,
      forecastDate: '2026-04-20',
    });
    mockFetchOpenMeteo.mockResolvedValueOnce({
      highTemp: 28,
      lowTemp: 22,
      precipProbability: 40,
      forecastDate: '2026-04-20',
    });

    const mockEvent = {
      eventId: 'szx-test',
      slug: 'shenzhen-test',
      city: 'shenzhen',
      coords: shenzhenCoords!,
      targetDate: '2026-04-20',
      unit: 'celsius' as const,
      brackets: [],
      endDate: '2026-04-20T12:00:00Z',
    };

    // daysOut=3, April (month 4) — spring, base stddev × 5/9 for Celsius
    const defaultStdCelsius = getDefaultStdDev(3, 4) * (5 / 9);
    const result = await fetchForecast(mockEvent, 3, undefined, 0.7);
    expect(result).not.toBeNull();
    // Floor kicks in: stdDev must be ≥ defaultStdCelsius * 0.7
    expect(result!.stdDev).toBeGreaterThanOrEqual(defaultStdCelsius * 0.7 - 0.01);
    // And it should be strictly greater than the raw ensemble value
    expect(result!.stdDev).toBeGreaterThan(0.2);
  });
});

// ---------------------------------------------------------------------------
// fetchForecast — WEATHER_MODEL_ECMWF_ENABLED flag wiring
// ---------------------------------------------------------------------------

describe('fetchForecast - ECMWF flag wiring', () => {
  it('dual shadow logging fetches both ensemble models and keeps alternate model in shadowEnsemble', async () => {
    const londonCoords = lookupCity('london');
    expect(londonCoords).not.toBeNull();

    mockFetchEnsemble.mockReset();
    mockFetchOpenMeteo.mockReset();
    mockFetchEnsemble
      .mockResolvedValueOnce({
        meanHigh: 15,
        stddevHigh: 1.5,
        meanLow: 9,
        stddevLow: 0.9,
        memberCount: 31,
        forecastDate: '2026-04-20',
        ensembleModel: 'gfs',
      })
      .mockResolvedValueOnce({
        meanHigh: 15,
        stddevHigh: 1.1,
        meanLow: 9,
        stddevLow: 0.7,
        memberCount: 51,
        forecastDate: '2026-04-20',
        ensembleModel: 'ecmwf',
      });
    mockFetchOpenMeteo.mockResolvedValueOnce({
      highTemp: 15,
      lowTemp: 9,
      precipProbability: 50,
      forecastDate: '2026-04-20',
    });

    const mockEvent = {
      eventId: 'lon-dual',
      slug: 'london-dual-test',
      city: 'london',
      coords: londonCoords!,
      targetDate: '2026-04-20',
      unit: 'celsius' as const,
      brackets: [],
      endDate: '2026-04-20T12:00:00Z',
    };

    const result = await fetchForecast(mockEvent, 1, undefined, 0.7, false, false, true);
    expect(result).not.toBeNull();
    expect(result!.ensembleModel).toBe('gfs');
    expect(result!.shadowEnsemble).toEqual({
      stdDev: 1.361111111111111, // floored by stddevMinFraction for Celsius 1-day default
      ensembleMembers: 51,
      ensembleModel: 'ecmwf',
    });
    expect(mockFetchEnsemble).toHaveBeenNthCalledWith(
      1,
      londonCoords!.lat,
      londonCoords!.lon,
      '2026-04-20',
      'celsius',
      undefined,
      false,
    );
    expect(mockFetchEnsemble).toHaveBeenNthCalledWith(
      2,
      londonCoords!.lat,
      londonCoords!.lon,
      '2026-04-20',
      'celsius',
      undefined,
      true,
    );
  });

  it('passes useEcmwf=true to fetchEnsembleForecast and propagates ensembleModel=ecmwf', async () => {
    const shenzhenCoords = lookupCity('shenzhen');
    expect(shenzhenCoords).not.toBeNull();

    mockFetchEnsemble.mockResolvedValueOnce({
      meanHigh: 29,
      stddevHigh: 1.2,
      meanLow: 23,
      stddevLow: 0.8,
      memberCount: 51,
      forecastDate: '2026-04-20',
      ensembleModel: 'ecmwf',
    });
    mockFetchOpenMeteo.mockResolvedValueOnce({
      highTemp: 29,
      lowTemp: 23,
      precipProbability: 30,
      forecastDate: '2026-04-20',
    });

    const mockEvent = {
      eventId: 'szx-ecmwf',
      slug: 'shenzhen-ecmwf-test',
      city: 'shenzhen',
      coords: shenzhenCoords!,
      targetDate: '2026-04-20',
      unit: 'celsius' as const,
      brackets: [],
      endDate: '2026-04-20T12:00:00Z',
    };

    const result = await fetchForecast(mockEvent, 1, undefined, 0.7, true);
    expect(result).not.toBeNull();
    expect(result!.ensembleModel).toBe('ecmwf');
    expect(result!.ensembleMembers).toBe(51);
    // Verify the 6th arg (useEcmwf=true) was forwarded to fetchEnsembleForecast
    expect(mockFetchEnsemble).toHaveBeenCalledWith(
      shenzhenCoords!.lat,
      shenzhenCoords!.lon,
      '2026-04-20',
      'celsius',
      undefined,
      true,
    );
  });

  it('passes useEcmwf=false when flag is disabled and propagates ensembleModel=gfs', async () => {
    const londonCoords = lookupCity('london');
    expect(londonCoords).not.toBeNull();

    mockFetchEnsemble.mockResolvedValueOnce({
      meanHigh: 15,
      stddevHigh: 1.5,
      meanLow: 9,
      stddevLow: 0.9,
      memberCount: 31,
      forecastDate: '2026-04-20',
      ensembleModel: 'gfs',
    });
    mockFetchOpenMeteo.mockResolvedValueOnce({
      highTemp: 15,
      lowTemp: 9,
      precipProbability: 50,
      forecastDate: '2026-04-20',
    });

    const mockEvent = {
      eventId: 'lon-gfs',
      slug: 'london-gfs-test',
      city: 'london',
      coords: londonCoords!,
      targetDate: '2026-04-20',
      unit: 'celsius' as const,
      brackets: [],
      endDate: '2026-04-20T12:00:00Z',
    };

    const result = await fetchForecast(mockEvent, 1, undefined, 0.7, false);
    expect(result).not.toBeNull();
    expect(result!.ensembleModel).toBe('gfs');
    expect(result!.ensembleMembers).toBe(31);
    expect(mockFetchEnsemble).toHaveBeenCalledWith(
      londonCoords!.lat,
      londonCoords!.lon,
      '2026-04-20',
      'celsius',
      undefined,
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// fetchForecast — HRRR flag wiring
// ---------------------------------------------------------------------------

describe('fetchForecast - HRRR flag wiring', () => {
  function makeUsEvent(city: string, targetDate: string) {
    const coords = lookupCity(city);
    expect(coords).not.toBeNull();
    return {
      eventId: `${city}-hrrr-test`,
      slug: `${city}-hrrr-test`,
      city,
      coords: coords!,
      targetDate,
      unit: 'fahrenheit' as const,
      brackets: [],
      endDate: `${targetDate}T12:00:00Z`,
    };
  }

  const ensembleMock = {
    meanHigh: 72,
    stddevHigh: 2.0,
    meanLow: 58,
    stddevLow: 1.5,
    memberCount: 31,
    forecastDate: '2026-04-20',
    ensembleModel: 'gfs',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchEnsemble.mockResolvedValue(ensembleMock);
  });

  it('US city + daysOut=1 + useHrrr=true → 3-way average, source=hrrr-combined', async () => {
    const mockEvent = makeUsEvent('chicago', '2026-04-20');
    mockFetchNwsForecast.mockResolvedValueOnce({ highF: 70, lowF: 55, forecastDate: '2026-04-20' });
    mockFetchOpenMeteo.mockResolvedValueOnce({ highTemp: 72, lowTemp: 57, precipProbability: 20, forecastDate: '2026-04-20' });
    mockFetchHrrr.mockResolvedValueOnce({ highTemp: 74, lowTemp: 58, precipProbability: 18, forecastDate: '2026-04-20' });

    const result = await fetchForecast(mockEvent, 1, undefined, 0.7, false, true);
    expect(result).not.toBeNull();
    // Mean of 70 + 72 + 74 = 72
    expect(result!.forecastHigh).toBeCloseTo(72, 1);
    expect(result!.source).toBe('hrrr-combined');
  });

  it('US city + daysOut=2 → HRRR skipped, source=combined', async () => {
    const mockEvent = makeUsEvent('chicago', '2026-04-21');
    mockFetchEnsemble.mockResolvedValue({ ...ensembleMock, forecastDate: '2026-04-21' });
    mockFetchNwsForecast.mockResolvedValueOnce({ highF: 70, lowF: 55, forecastDate: '2026-04-21' });
    mockFetchOpenMeteo.mockResolvedValueOnce({ highTemp: 72, lowTemp: 57, precipProbability: 20, forecastDate: '2026-04-21' });

    const result = await fetchForecast(mockEvent, 2, undefined, 0.7, false, true);
    expect(result).not.toBeNull();
    expect(result!.source).not.toBe('hrrr-combined');
    expect(mockFetchHrrr).not.toHaveBeenCalled();
  });

  it('HRRR fetch fails → falls back to NOAA + OM 2-way average', async () => {
    const mockEvent = makeUsEvent('chicago', '2026-04-20');
    mockFetchNwsForecast.mockResolvedValueOnce({ highF: 70, lowF: 55, forecastDate: '2026-04-20' });
    mockFetchOpenMeteo.mockResolvedValueOnce({ highTemp: 72, lowTemp: 57, precipProbability: 20, forecastDate: '2026-04-20' });
    mockFetchHrrr.mockResolvedValueOnce(null);

    const result = await fetchForecast(mockEvent, 1, undefined, 0.7, false, true);
    expect(result).not.toBeNull();
    expect(result!.forecastHigh).toBeCloseTo(71, 1); // (70 + 72) / 2
    expect(result!.source).toBe('combined');
  });

  it('international city → HRRR skipped even when useHrrr=true', async () => {
    const londonCoords = lookupCity('london');
    expect(londonCoords).not.toBeNull();
    const mockEvent = {
      eventId: 'lon-hrrr-skip',
      slug: 'london-hrrr-skip',
      city: 'london',
      coords: londonCoords!,
      targetDate: '2026-04-20',
      unit: 'celsius' as const,
      brackets: [],
      endDate: '2026-04-20T12:00:00Z',
    };
    mockFetchEnsemble.mockResolvedValueOnce({ ...ensembleMock, forecastDate: '2026-04-20' });
    mockFetchOpenMeteo.mockResolvedValueOnce({ highTemp: 15, lowTemp: 9, precipProbability: 40, forecastDate: '2026-04-20' });

    const result = await fetchForecast(mockEvent, 1, undefined, 0.7, false, true);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('open-meteo');
    expect(mockFetchHrrr).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// parseWeatherEvent — canonical city key
// ---------------------------------------------------------------------------

describe('parseWeatherEvent - canonical city key', () => {
  function makeNycMarket(id: string, label: string, threshold: string, yesP: string, noP: string) {
    return {
      id,
      question: `Will the highest temperature in NYC be ${label} on April 17?`,
      conditionId: `cond-${id}`,
      clobTokenIds: `["token-${id}-yes","token-${id}-no"]`,
      outcomePrices: `["${yesP}","${noP}"]`,
      outcomes: '["Yes","No"]',
      active: true,
      closed: false,
      volume: '10000',
      liquidity: '5000',
      endDate: '2026-04-17T12:00:00Z',
      description: null,
      groupItemTitle: label,
      groupItemThreshold: threshold,
    };
  }

  it('stores canonical "new york" city key when event title uses "NYC"', () => {
    const event = {
      id: 'evt-nyc',
      title: 'Highest temperature in NYC on April 17?',
      slug: 'highest-temperature-in-nyc-on-april-17-2026',
      active: true,
      closed: false,
      negRisk: true,
      endDate: '2026-04-17T12:00:00Z',
      markets: [
        makeNycMarket('m0', '39°F or below', '0', '0.01', '0.99'),
        makeNycMarket('m1', '40-41°F', '1', '0.03', '0.97'),
        makeNycMarket('m2', '42-43°F', '2', '0.05', '0.95'),
        makeNycMarket('m3', '44-45°F', '3', '0.10', '0.90'),
        makeNycMarket('m4', '46-47°F', '4', '0.15', '0.85'),
        makeNycMarket('m5', '48-49°F', '5', '0.20', '0.80'),
        makeNycMarket('m6', '50-51°F', '6', '0.18', '0.82'),
        makeNycMarket('m7', '52-53°F', '7', '0.12', '0.88'),
        makeNycMarket('m8', '54-55°F', '8', '0.08', '0.92'),
        makeNycMarket('m9', '56-57°F', '9', '0.05', '0.95'),
        makeNycMarket('m10', '58°F or higher', '10', '0.03', '0.97'),
      ],
    };
    const result = parseWeatherEvent(event);
    expect(result).not.toBeNull();
    expect(result!.city).toBe('new york');
  });
});

// ---------------------------------------------------------------------------
// scanWeatherMarkets (integration-style with mocked externals)
// ---------------------------------------------------------------------------

describe('scanWeatherMarkets', () => {
  let redisMock: ReturnType<typeof createRedisMock>;
  let originalFetch: typeof globalThis.fetch;

  // Target a date two days in the future so the scanner's same-day skip
  // (daysOut === 0) and max-horizon skip (daysOut > 7) both pass regardless
  // of when the test runs.
  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const targetDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const targetYear = targetDate.getUTCFullYear();
  const targetMonth = targetDate.getUTCMonth() + 1;
  const targetDay = targetDate.getUTCDate();
  const targetIso = `${targetYear.toString()}-${targetMonth.toString().padStart(2, '0')}-${targetDay.toString().padStart(2, '0')}`;
  const monthName = MONTH_NAMES[targetMonth - 1] ?? 'April';
  const titleDate = `${monthName} ${targetDay.toString()}`;
  const slugDate = `${monthName.toLowerCase()}-${targetDay.toString()}-${targetYear.toString()}`;
  const endDateIso = `${targetIso}T12:00:00Z`;

  function makeMockGammaEvent() {
    return {
      id: 'event-1',
      title: `Highest temperature in Chicago on ${titleDate}?`,
      slug: `highest-temperature-in-chicago-on-${slugDate}`,
      active: true,
      closed: false,
      negRisk: true,
      endDate: endDateIso,
      markets: Array.from({ length: 11 }, (_, i) => {
        const labels = [
          '39°F or below', '40-41°F', '42-43°F', '44-45°F', '46-47°F',
          '48-49°F', '50-51°F', '52-53°F', '54-55°F', '56-57°F', '58°F or higher',
        ];
        const yesPrices = [0.01, 0.03, 0.05, 0.10, 0.15, 0.20, 0.18, 0.12, 0.08, 0.05, 0.03];
        return {
          id: `m${i}`,
          question: `Will the highest temperature in Chicago be ${labels[i]} on ${titleDate}?`,
          conditionId: `cond-${i}`,
          clobTokenIds: `["t${i}y","t${i}n"]`,
          outcomePrices: `["${(yesPrices[i] ?? 0).toFixed(2)}","${(1 - (yesPrices[i] ?? 0)).toFixed(2)}"]`,
          outcomes: '["Yes","No"]',
          active: true,
          closed: false,
          volume: '10000',
          liquidity: '5000',
          endDate: endDateIso,
          description: null,
          groupItemTitle: labels[i],
          groupItemThreshold: i.toString(),
        };
      }),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    redisMock = createRedisMock();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns empty when no weather events found', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    }) as unknown as typeof fetch;

    const results = await scanWeatherMarkets(redisMock as never);
    expect(results).toEqual([]);
  });

  it('discovers and evaluates bracket events', async () => {
    const gammaEvent = makeMockGammaEvent();

    // Mock global.fetch for Gamma API (fetchWeatherEvents uses fetch directly)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([gammaEvent]),
    }) as unknown as typeof fetch;

    // Mock the module-level forecast functions
    mockFetchNwsForecast.mockResolvedValue({
      highF: 52,
      lowF: 38,
      precipProbability: 10,
      forecastDate: targetIso,
      shortForecast: 'Mostly Cloudy',
    });
    mockFetchOpenMeteo.mockResolvedValue({
      highTemp: 52,
      lowTemp: 38,
      precipProbability: 10,
      forecastDate: targetIso,
    });
    mockFetchEnsemble.mockResolvedValue({
      meanHigh: 52,
      stddevHigh: 3.2,
      meanLow: 38,
      stddevLow: 2.8,
      memberCount: 31,
      forecastDate: targetIso,
    });

    const results = await scanWeatherMarkets(redisMock as never);

    expect(Array.isArray(results)).toBe(true);
    // Should have evaluated the event and logged it
    expect(logger.info).toHaveBeenCalledWith(
      '[weather] event evaluated',
      expect.objectContaining({
        city: 'chicago',
        targetDate: targetIso,
      }),
    );
  });

  it('skips deduped events', async () => {
    const gammaEvent = makeMockGammaEvent();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([gammaEvent]),
    }) as unknown as typeof fetch;

    // Pre-set the dedup key
    redisMock._store.set(`weather:event:highest-temperature-in-chicago-on-${slugDate}`, '1');

    const results = await scanWeatherMarkets(redisMock as never);
    expect(results).toEqual([]);

    // NOAA/Open-Meteo should never have been called (dedup skipped the event)
    expect(mockFetchNwsForecast).not.toHaveBeenCalled();
    expect(mockFetchOpenMeteo).not.toHaveBeenCalled();
    expect(mockFetchEnsemble).not.toHaveBeenCalled();
  });

  it('blocks stale weather theses after adverse repricing with little model improvement', async () => {
    const gammaEvent = makeMockGammaEvent();
    // Make the top tradable bracket the high tail so tradeSide=NO on market m10.
    gammaEvent.markets[10]!.outcomePrices = '["0.45","0.55"]';

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([gammaEvent]),
    }) as unknown as typeof fetch;

    mockFetchNwsForecast.mockResolvedValue({
      highF: 52,
      lowF: 38,
      precipProbability: 10,
      forecastDate: targetIso,
      shortForecast: 'Mostly Cloudy',
    });
    mockFetchOpenMeteo.mockResolvedValue({
      highTemp: 52,
      lowTemp: 38,
      precipProbability: 10,
      forecastDate: targetIso,
    });
    mockFetchEnsemble.mockResolvedValue({
      meanHigh: 52,
      stddevHigh: 3.2,
      meanLow: 38,
      stddevLow: 2.8,
      memberCount: 31,
      forecastDate: targetIso,
    });

    redisMock._store.set(
      'weather:market_state:m10:NO',
      JSON.stringify({
        tradeSide: 'NO',
        outcomePrice: 0.70,
        winProbability: 0.94,
        observedAt: new Date().toISOString(),
      }),
    );

    const results = await scanWeatherMarkets(redisMock as never);
    const blocked = results.find((o) => o.marketId === 'm10');
    expect(blocked).toBeDefined();
    expect(blocked!.blockedByMarketDisagreement).toBe(true);
    expect(blocked!.previousOutcomePrice).toBe(0.70);
    expect(blocked!.previousWinProbability).toBe(0.94);
  });

  // -------------------------------------------------------------------------
  // runWeatherScan — execution gating, caps, signal construction
  // -------------------------------------------------------------------------

  describe('runWeatherScan execution', () => {
    function wireMockGammaAndForecast(yesPrices?: number[]) {
      const evt = makeMockGammaEvent();
      if (yesPrices) {
        evt.markets.forEach((m, i) => {
          const y = yesPrices[i] ?? 0.01;
          m.outcomePrices = `["${y.toFixed(2)}","${(1 - y).toFixed(2)}"]`;
        });
      }
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([evt]),
      }) as unknown as typeof fetch;
      // Forecast tight around 52F — creates strong NO edges on tail brackets
      // (low NO prices on e.g. "39°F or below" when model says near-zero YES).
      mockFetchNwsForecast.mockResolvedValue({
        highF: 52, lowF: 38, precipProbability: 10, forecastDate: targetIso, shortForecast: 'Cloudy',
      });
      mockFetchOpenMeteo.mockResolvedValue({
        highTemp: 52, lowTemp: 38, precipProbability: 10, forecastDate: targetIso,
      });
      mockFetchEnsemble.mockResolvedValue({
        meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8, memberCount: 31, forecastDate: targetIso,
      });
    }

    it('does not call executeAndRecordSignal when WEATHER_EXECUTION_ENABLED=false', async () => {
      mockLoadConfig.mockReturnValueOnce({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: false,
      });
      wireMockGammaAndForecast();
      mockGetBankroll.mockResolvedValue(1000);

      await runWeatherScan(redisMock as never);

      expect(mockExecuteAndRecordSignal).not.toHaveBeenCalled();
      expect(mockGetBankroll).not.toHaveBeenCalled();
    });

    it('executes with correct TradeSignal shape when enabled', async () => {
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
      });
      wireMockGammaAndForecast();
      mockGetBankroll.mockResolvedValue(1000);
      mockExecuteAndRecordSignal.mockResolvedValue({
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob', entryPrice: 0.9, sharesFilled: 10,
      });

      await runWeatherScan(redisMock as never);

      expect(mockExecuteAndRecordSignal).toHaveBeenCalled();
      const signal = mockExecuteAndRecordSignal.mock.calls[0]![0] as {
        direction: string; consensusProbability: number; outcomePrice: number;
        stakeUsd: number; source: string; question: string; clobTokenIds: string[];
      };
      // consensusProbability is always P(YES) — executor flips to (1-p) for NO internally
      expect(signal.consensusProbability).toBeGreaterThan(0);
      expect(signal.consensusProbability).toBeLessThan(1);
      expect(['YES', 'NO']).toContain(signal.direction);
      expect(signal.source).toBe('weather');
      expect(signal.question).toMatch(/Chicago/);
      expect(signal.clobTokenIds).toHaveLength(2);
      expect(signal.stakeUsd).toBeGreaterThan(0);
    });

    it('respects WEATHER_MAX_POSITIONS_PER_SCAN cap', async () => {
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
        WEATHER_MAX_POSITIONS_PER_SCAN: 2,
        WEATHER_MAX_PER_CITY: 5, // relax so per-city doesn't bind first
      });
      wireMockGammaAndForecast();
      mockGetBankroll.mockResolvedValue(10000);
      mockExecuteAndRecordSignal.mockResolvedValue({
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob',
      });

      await runWeatherScan(redisMock as never);

      expect(mockExecuteAndRecordSignal.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('respects WEATHER_MAX_PER_CITY cap', async () => {
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
        WEATHER_MAX_POSITIONS_PER_SCAN: 10,
        WEATHER_MAX_PER_CITY: 1,
      });
      wireMockGammaAndForecast();
      mockGetBankroll.mockResolvedValue(10000);
      mockExecuteAndRecordSignal.mockResolvedValue({
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob',
      });

      await runWeatherScan(redisMock as never);

      // Only one city in fixture (Chicago) — cap=1 means ≤1 execution
      expect(mockExecuteAndRecordSignal.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('respects WEATHER_MAX_SCAN_EXPOSURE_USD cap', async () => {
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
        WEATHER_MAX_POSITIONS_PER_SCAN: 10,
        WEATHER_MAX_PER_CITY: 10,
        WEATHER_MAX_SCAN_EXPOSURE_USD: 5, // tight cap — first trade alone should exhaust it
      });
      wireMockGammaAndForecast();
      mockGetBankroll.mockResolvedValue(10000); // large bankroll → each Kelly stake > $5
      mockExecuteAndRecordSignal.mockResolvedValue({
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob',
      });

      await runWeatherScan(redisMock as never);

      // Stake ≥ $5 blocks the *first* opp (proposed+0 > cap). But more likely first trade
      // fires at <$5 then second exceeds. Either way ≤1 call under a $5 cap.
      expect(mockExecuteAndRecordSignal.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('skips when bankroll is zero', async () => {
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
      });
      wireMockGammaAndForecast();
      mockGetBankroll.mockResolvedValue(0);

      await runWeatherScan(redisMock as never);

      expect(mockExecuteAndRecordSignal).not.toHaveBeenCalled();
    });

    it('suppresses execution for cities listed in WEATHER_EXCLUDED_CITIES', async () => {
      // Fixture city is Chicago — excluding it should block executeAndRecordSignal
      // while shadow observations still flow (wouldTrade is unaffected upstream).
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
        WEATHER_EXCLUDED_CITIES: 'chicago',
      });
      wireMockGammaAndForecast();
      mockGetBankroll.mockResolvedValue(1000);

      await runWeatherScan(redisMock as never);

      expect(mockExecuteAndRecordSignal).not.toHaveBeenCalled();
    });

    it('canonicalises WEATHER_EXCLUDED_CITIES aliases before matching', async () => {
      // "NYC" is an alias for "new york" — should resolve and block the fixture
      // city if the fixture were new york, but here we verify it does NOT suppress
      // Chicago (alias mismatch), so execution still fires.
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
        WEATHER_EXCLUDED_CITIES: 'NYC',
      });
      wireMockGammaAndForecast();
      mockGetBankroll.mockResolvedValue(1000);
      mockExecuteAndRecordSignal.mockResolvedValue({
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob', entryPrice: 0.9, sharesFilled: 10,
      });

      await runWeatherScan(redisMock as never);

      // NYC exclusion should not suppress the Chicago fixture
      expect(mockExecuteAndRecordSignal).toHaveBeenCalled();
    });

    it('blocks opportunities beyond WEATHER_MAX_LOOKAHEAD_HOURS', async () => {
      // endDateIso is 48h out; gate set to 28h should filter all opportunities
      mockLoadConfig.mockReturnValueOnce({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
        WEATHER_MAX_LOOKAHEAD_HOURS: 28,
      });
      wireMockGammaAndForecast();
      mockGetBankroll.mockResolvedValue(1000);

      await runWeatherScan(redisMock as never);

      expect(mockExecuteAndRecordSignal).not.toHaveBeenCalled();
    });

    it('allows opportunities within WEATHER_MAX_LOOKAHEAD_HOURS', async () => {
      // endDateIso is 48h out; gate set to 72h should pass
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
        WEATHER_MAX_LOOKAHEAD_HOURS: 72,
      });
      wireMockGammaAndForecast();
      mockGetBankroll.mockResolvedValue(1000);
      mockExecuteAndRecordSignal.mockResolvedValue({
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob', entryPrice: 0.9, sharesFilled: 10,
      });

      await runWeatherScan(redisMock as never);

      expect(mockExecuteAndRecordSignal).toHaveBeenCalled();
    });

    it('disables the lookahead gate when WEATHER_MAX_LOOKAHEAD_HOURS is 0', async () => {
      // Gate value 0 means disabled — events at any horizon should execute
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
        WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      });
      wireMockGammaAndForecast();
      mockGetBankroll.mockResolvedValue(1000);
      mockExecuteAndRecordSignal.mockResolvedValue({
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob', entryPrice: 0.9, sharesFilled: 10,
      });

      await runWeatherScan(redisMock as never);

      expect(mockExecuteAndRecordSignal).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Category wiring — inferCategory('Highest temperature…') → 'weather'
// ---------------------------------------------------------------------------

describe('weather category wiring', () => {
  it('inferCategory matches highest temperature questions', () => {
    expect(inferCategory('Highest temperature in Chicago on April 20, 2026?')).toBe('weather');
  });
  it('inferCategory matches lowest temperature questions', () => {
    expect(inferCategory('Lowest temperature in NYC on April 20, 2026?')).toBe('weather');
  });
  it('normalizeCategory passes weather through', () => {
    expect(normalizeCategory('weather')).toBe('weather');
  });
});
