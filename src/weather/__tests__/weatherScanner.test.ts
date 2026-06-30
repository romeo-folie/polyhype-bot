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
  WEATHER_KELLY_SHRINK_WEIGHT: 0.5,
  WEATHER_MODEL_ECMWF_ENABLED: false,
  WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: true,
  WEATHER_DUAL_ENSEMBLE_VETO_ENABLED: false,
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
  WEATHER_MAX_STAKE_USD: 0,
  WEATHER_HRRR_MAX_CROSS_SOURCE_SPREAD: Infinity,
  MIN_BET_USD: 5,
  // Forecast resilience knobs — alert disabled in the base config so existing
  // scan tests are unaffected; outage-alert tests override explicitly.
  WEATHER_FORECAST_RETRY_COUNT: 0,
  WEATHER_FORECAST_CACHE_TTL_S: 10_800,
  WEATHER_OUTAGE_ALERT_ENABLED: false,
  WEATHER_OUTAGE_FAIL_RATE: 0.5,
  WEATHER_OUTAGE_ALERT_DEDUP_TTL_S: 14_400,
  // Resting-order revalidation + bracket cancel — mirror the config.ts schema
  // defaults so tests never rely on `undefined` happening to be falsy.
  WEATHER_RESTING_REVALIDATION_ENABLED: false,
  WEATHER_BRACKET_CANCEL_ENABLED: false,
  WEATHER_BRACKET_CANCEL_LOCAL_HOUR: 18,
  WEATHER_BRACKET_CANCEL_PRIMARY_PRICE: 0.95,
  WEATHER_FAR_NO_LADDER_ENABLED: false,
  WEATHER_FAR_NO_MIN_WIN_PROB: 0.975,
  WEATHER_FAR_NO_MIN_EDGE: 0.03,
  WEATHER_FAR_NO_MAX_BID: 0.95,
  WEATHER_FAR_NO_MIN_BID: 0.50,
  WEATHER_FAR_NO_MIN_DISTANCE_DEGREES: 2,
  WEATHER_ADJACENT_NO_LADDER_ENABLED: false,
  WEATHER_ADJACENT_NO_MIN_WIN_PROB: 0.88,
  WEATHER_ADJACENT_NO_MIN_EDGE: 0.06,
  WEATHER_ADJACENT_NO_MAX_BID: 0.80,
  WEATHER_ADJACENT_NO_MIN_BID: 0.50,
  WEATHER_ADJACENT_NO_MIN_DISTANCE_DEGREES: 0.5,
  WEATHER_ADJACENT_NO_MAX_DISTANCE_DEGREES: 2,
  // Lowest-temperature feature off by default in the base config so legacy scan
  // tests never trigger the second (lowest-temperature) Gamma fetch; the
  // dedicated lowest-temp tests override these explicitly.
  WEATHER_LOWEST_TEMP_ENABLED: false,
  WEATHER_LOWEST_TEMP_SHADOW_ENABLED: false,
  // NO-bias model-safety gates (2026-06-19). Test-safe values preserve legacy
  // scan behaviour (fallback on, no σ inflation, strict interior gate, modal
  // veto off); production config.ts defaults differ (false/1.25/1/true). The
  // dedicated NO-bias tests override these explicitly.
  WEATHER_YES_GATE_NO_FALLBACK_ENABLED: true,
  WEATHER_OPEN_METEO_STDDEV_MULTIPLIER: 1.0,
  WEATHER_INTERIOR_NO_FORECAST_MARGIN: 0,
  // Confluence gates default "off" in baseConfig so existing tests are unaffected;
  // dedicated tests enable them. (Production defaults: veto on, confluence-shadow on.)
  WEATHER_INTERIOR_NO_MARGIN_MAE_MULT: 0,
  WEATHER_MARKET_FAVORITE_NO_VETO_ENABLED: false,
  WEATHER_MARKET_FAVORITE_NO_MAX_YESPRICE: 0.85,
  WEATHER_CONFLUENCE_YES_SHADOW_ENABLED: false,
  // Res-day-only entry gate off in baseConfig (mirrors schema default) so legacy scan
  // tests — which use ~2-day-out fixtures — still execute; dedicated tests enable it.
  WEATHER_RES_DAY_ENTRY_ONLY: false,
  // Shadow-ensemble cache TTL + fail-open on null shadow (mirror schema defaults).
  WEATHER_SHADOW_ENSEMBLE_CACHE_TTL_S: 86_400,
  WEATHER_RES_DAY_ENTRY_FAIL_OPEN_ON_NULL_SHADOW: false,
  // Res-day lock-in (off in baseConfig; dedicated tests enable).
  WEATHER_LOCKIN_ENABLED: false,
  WEATHER_LOCKIN_MARGIN: 1.0,
  WEATHER_LOCKIN_MONOTONIC_SOURCES_ONLY: true,
  WEATHER_LOCKIN_STAKE_USD: 10,
  WEATHER_LOCKIN_MODEL_WIN: 0.97,
  WEATHER_MODAL_MASS_VETO_ENABLED: false,
  WEATHER_INTERIOR_NO_MODAL_MASS_VETO: 0.65,
  // Evaluate the modal-mass veto on every horizon in tests (events target ~2
  // days out, not res-day). Production defaults this true (res-day only).
  WEATHER_MODAL_MASS_VETO_RES_DAY_ONLY: false,
  // Calibration shadow off in the base config so legacy scan assertions are
  // unaffected; the dedicated calibration tests enable it explicitly.
  WEATHER_CALIBRATION_SHADOW_ENABLED: false,
  // Full-bracket shadow census off in base config; the dedicated PR2 tests enable it.
  WEATHER_FULL_BRACKET_SHADOW_ENABLED: false,
  // Proven-loser cohort blocks default to no-op (block nothing / edge ceiling above any
  // achievable edge); the dedicated block tests set them explicitly.
  WEATHER_BLOCKED_STRATEGY_FAMILIES: '',
  WEATHER_NO_MAX_EDGE: 1.0,
  // Calibration-live (PR2b) off in base config; dedicated tests enable + inject a table.
  WEATHER_CALIBRATION_LIVE_ENABLED: false,
  WEATHER_REQUIRE_CALIBRATION_COHORT_FOR_ENTRY: false,
  WEATHER_CALIBRATION_LIVE_COHORTS: 'high|range|hrrr-combined',
  WEATHER_CALIBRATION_YES_MIN_PRICE: 0.15,
  WEATHER_BLOCK_EXACT_OPEN_METEO_NO_WITHOUT_LIVE_CONFIRMATION: false,
  WEATHER_RES_DAY_LIVE_CONFIRMATION_REQUIRED: false,
};
const mockLoadConfig = vi.fn(() => ({ ...baseConfig }));
vi.mock('../../shared/config.js', () => ({
  loadConfig: mockLoadConfig,
}));

const mockExecuteAndRecordSignal = vi.fn();
vi.mock('../../execution/executor.js', () => ({
  executeAndRecordSignal: mockExecuteAndRecordSignal,
}));

const mockListPendingOrders = vi.fn();
const mockDeletePendingOrder = vi.fn().mockResolvedValue(undefined);
vi.mock('../../execution/pendingMakerOrders.js', () => ({
  listPendingOrders: mockListPendingOrders,
  deletePendingOrder: mockDeletePendingOrder,
}));

const mockGetClobOrder = vi.fn();
const mockCancelClobOrder = vi.fn();
vi.mock('../../shared/clob.js', () => ({
  getClobOrder: mockGetClobOrder,
  cancelClobOrder: mockCancelClobOrder,
  // weatherLockIn + weatherInvalidation load REAL in this suite and import these;
  // their config gates are off in baseConfig so they are never invoked.
  getClobOrderBook: vi.fn().mockResolvedValue(null),
  submitClobBuy: vi.fn().mockResolvedValue({ success: false, error: 'mocked' }),
  CLOB_MIN_ORDER_USD: 1.0,
}));

// cityLocalHour drives the late-res-day bracket cancel arm — mocked so tests
// control the clock; everything else in resolutionTime stays real (the scanner
// relies on cityLocalDate for res-day detection).
const mockCityLocalHour = vi.fn();
vi.mock('../resolutionTime.js', async () => {
  const actual =
    await vi.importActual<typeof import('../resolutionTime.js')>('../resolutionTime.js');
  return { ...actual, cityLocalHour: mockCityLocalHour };
});

const mockGetBankroll = vi.fn();
vi.mock('../../shared/bankroll.js', () => ({
  getBankroll: mockGetBankroll,
}));

// Capture shadow_observations writes so tests can assert the shadow stream's
// wouldTrade/wouldBlock/blockedBy* reflect the active config (not just the model).
const mockEnqueueWrite = vi.fn().mockResolvedValue(undefined);
vi.mock('../../db/writeQueue.js', () => ({
  enqueueWrite: mockEnqueueWrite,
}));

// Outage alert + invalidation notify both route through telegram. The mock
// must export every symbol any module loaded in this suite imports:
// weatherScanner (notify) and weatherInvalidation (notifyWeatherInvalidationNoHedge).
const mockNotify = vi.fn().mockResolvedValue(undefined);
vi.mock('../../execution/telegram.js', () => ({
  notify: mockNotify,
  notifyWeatherInvalidationNoHedge: vi.fn().mockResolvedValue(undefined),
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
// Defaults to null so the modal-mass veto is a no-op unless a test configures it.
const mockFetchEnsembleHourly = vi.fn<() => Promise<unknown>>(() => Promise.resolve(null));
vi.mock('../openMeteoClient.js', () => ({
  fetchOpenMeteoForecast: mockFetchOpenMeteo,
  fetchEnsembleForecast: mockFetchEnsemble,
  fetchHrrrForecast: mockFetchHrrr,
  fetchEnsembleHourly: mockFetchEnsembleHourly,
}));

const mockFetchLiveObservation = vi.fn<() => Promise<unknown>>();
vi.mock('../liveObservation.js', () => ({
  fetchLiveObservation: mockFetchLiveObservation,
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
  buildWeatherFillShadow,
  shrinkTowardMarket,
  partitionTradableByEntryCap,
  revalidateRestingWeatherOrders,
  isWeatherHighLockedIn,
  isWeatherLowLockedIn,
  executeWeatherLockIns,
} = await import('../weatherScanner.js');

const { computeHalfKelly } = await import('../../mapping/divergenceCalculator.js');
const { inferCategory } = await import('../../shared/outcomeRecorder.js');
const { normalizeCategory } = await import('../../monitor/staleExit.js');

const {
  estimateBracketProbability,
  normalCdf,
  getDefaultStdDev,
  lookupCity,
} = await import('../noaaClient.js');

const { _setCalibrationTableForTest } = await import('../bracketCalibration.js');

const { logger } = await import('../../shared/logger.js');

// Minimal Redis mock
function createRedisMock() {
  const store = new Map<string, string>();
  const pipelineOps: (() => void)[] = [];
  const pipelineMock = {
    set: vi.fn((key: string, value: string, _ex?: string, _ttl?: number) => {
      pipelineOps.push(() => store.set(key, value));
      return pipelineMock;
    }),
    exec: vi.fn(() => {
      for (const op of pipelineOps.splice(0)) op();
      return Promise.resolve([]);
    }),
  };
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    mget: vi.fn((...keys: string[]) => Promise.resolve(keys.map((k) => store.get(k) ?? null))),
    set: vi.fn((key: string, value: string, _ex?: string, _ttl?: number, nx?: string) => {
      if (nx === 'NX' && store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    exists: vi.fn((...keys: string[]) =>
      Promise.resolve(keys.filter((k) => store.has(k)).length),
    ),
    pipeline: vi.fn(() => pipelineMock),
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

  it('lowest-temp tail-NO base-rate gate uses daily LOWS, not highs', () => {
    // High-tail "58°F or higher" on a LOWEST-temperature market: YES = daily MIN ≥ 58.
    // Forecast low 50 → model says min well below 58 → NO has large edge.
    // cityActuals.highs all ≥ 58 (would block NO if the gate wrongly used highs);
    // cityActuals.lows all < 58 (correctly does NOT block — daily mins rarely ≥ 58).
    const lowEvent = {
      eventId: 'el', slug: 'low-event', city: 'chicago', coords: lookupCity('chicago')!,
      targetDate: '2026-06-14', unit: 'fahrenheit' as const, metric: 'low' as const,
      brackets: [
        { marketId: 'm0', conditionId: 'c0', clobTokenIds: ['t0y', 't0n'], threshold: 0, low: null, high: 45, label: '45°F or below', yesPrice: 0.05, noPrice: 0.95 },
        { marketId: 'm1', conditionId: 'c1', clobTokenIds: ['t1y', 't1n'], threshold: 1, low: 46, high: 47, label: '46-47°F', yesPrice: 0.10, noPrice: 0.90 },
        { marketId: 'm2', conditionId: 'c2', clobTokenIds: ['t2y', 't2n'], threshold: 2, low: 48, high: 49, label: '48-49°F', yesPrice: 0.25, noPrice: 0.75 },
        { marketId: 'm3', conditionId: 'c3', clobTokenIds: ['t3y', 't3n'], threshold: 3, low: 50, high: 51, label: '50-51°F', yesPrice: 0.30, noPrice: 0.70 },
        { marketId: 'm4', conditionId: 'c4', clobTokenIds: ['t4y', 't4n'], threshold: 4, low: 52, high: 53, label: '52-53°F', yesPrice: 0.15, noPrice: 0.85 },
        { marketId: 'm5', conditionId: 'c5', clobTokenIds: ['t5y', 't5n'], threshold: 5, low: 54, high: 55, label: '54-55°F', yesPrice: 0.05, noPrice: 0.95 },
        { marketId: 'm6', conditionId: 'c6', clobTokenIds: ['t6y', 't6n'], threshold: 6, low: 58, high: null, label: '58°F or higher', yesPrice: 0.15, noPrice: 0.85 },
      ],
      endDate: '2026-06-14T12:00:00Z',
    };
    const forecast = { forecastHigh: 50, metric: 'low' as const, stdDev: 3, source: 'combined' as const, ensembleMembers: 31 };
    const cityActuals = {
      highs: [70, 71, 72, 69, 73, 70, 71, 72], // all ≥ 58 → high-based fraction = 1.0 (would block)
      lows: [48, 50, 49, 51, 47, 50, 52, 49],  // all < 58 → low-based fraction = 0 (allows)
      unit: 'fahrenheit',
      sampleSize: 8,
      updatedAt: new Date().toISOString(),
    };

    const { opportunities } = findMispricedBrackets(lowEvent, forecast, 1, 0.08, {
      cityActuals: cityActuals as never,
      baseRateMinSamples: 5,
      baseRateNoBlockThreshold: 0.70,
      minModelCoverage: 0.5, // isolate the base-rate gate from the coverage guard
    });

    // The high-tail NO survived the gate (lows don't favour YES) → opportunity present.
    const tailNo = opportunities.find((o) => o.bracketLabel === '58°F or higher' && o.tradeSide === 'NO');
    expect(tailNo).toBeDefined();
    expect(tailNo!.metric).toBe('low');
  });

  it('lowest-temp tail-NO fails CLOSED when cityActuals.lows is absent (stale cache entry)', () => {
    // A cache entry written before lowest-temp support has highs but no lows. The
    // gate must NOT fall back to highs — it fails closed (blocks the tail NO) until
    // the actuals cache is refreshed with lows (≤36h TTL window after deploy).
    const lowEvent = {
      eventId: 'el2', slug: 'low-event-2', city: 'chicago', coords: lookupCity('chicago')!,
      targetDate: '2026-06-14', unit: 'fahrenheit' as const, metric: 'low' as const,
      brackets: [
        { marketId: 'm0', conditionId: 'c0', clobTokenIds: ['t0y', 't0n'], threshold: 0, low: null, high: 45, label: '45°F or below', yesPrice: 0.05, noPrice: 0.95 },
        { marketId: 'm3', conditionId: 'c3', clobTokenIds: ['t3y', 't3n'], threshold: 3, low: 50, high: 51, label: '50-51°F', yesPrice: 0.30, noPrice: 0.70 },
        { marketId: 'm6', conditionId: 'c6', clobTokenIds: ['t6y', 't6n'], threshold: 6, low: 58, high: null, label: '58°F or higher', yesPrice: 0.15, noPrice: 0.85 },
      ],
      endDate: '2026-06-14T12:00:00Z',
    };
    const forecast = { forecastHigh: 50, metric: 'low' as const, stdDev: 3, source: 'combined' as const, ensembleMembers: 31 };
    const staleActuals = {
      highs: [48, 50, 49, 51, 47, 50, 52, 49], // < 58 — would ALLOW the NO if wrongly used
      // no `lows` field (old cache entry)
      unit: 'fahrenheit', sampleSize: 8, updatedAt: new Date().toISOString(),
    };

    const { opportunities } = findMispricedBrackets(lowEvent, forecast, 1, 0.08, {
      cityActuals: staleActuals as never,
      baseRateMinSamples: 5,
      baseRateNoBlockThreshold: 0.70,
      minModelCoverage: 0.5,
    });

    // lows absent → actualsSeries undefined → fail closed → tail NO suppressed.
    const tailNo = opportunities.find((o) => o.bracketLabel === '58°F or higher' && o.tradeSide === 'NO');
    expect(tailNo).toBeUndefined();
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
    // cityActuals with 0% YES rate for ≥60°F so fail-closed gate doesn't block tail NO.
    const lowActuals = { highs: Array(14).fill(50) as number[], unit: 'fahrenheit' as const, sampleSize: 14, updatedAt: '2026-01-01T00:00:00Z' };
    const { opportunities: baselineOpps } = findMispricedBrackets(event, forecast, 1, 0, { stddevMultiplier: 1.0, minModelCoverage: 0, cityActuals: lowActuals });
    const { opportunities: widenedOpps }  = findMispricedBrackets(event, forecast, 1, 0, { stddevMultiplier: 1.5, minModelCoverage: 0, cityActuals: lowActuals });

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

    // cityActuals with 0% YES rate for ≤39°F so fail-closed gate doesn't block tail NO.
    const highActuals = { highs: Array(14).fill(52) as number[], unit: 'fahrenheit' as const, sampleSize: 14, updatedAt: '2026-01-01T00:00:00Z' };
    const { opportunities: opps } = findMispricedBrackets(event, forecast, 1, 0.0, { minModelCoverage: 0, maxTailNoBetModelProb: 0.5, cityActuals: highActuals });
    const noOpps = opps.filter((o) => o.tradeSide === 'NO');
    expect(noOpps.length).toBeGreaterThan(0);
  });

  it('does NOT block NO bet on an interior bracket even when modelProb > 0.5', () => {
    // Interior bracket (low=50, high=51): NOT a tail bracket.
    // Forecast 53°F → rounds to 53, NOT inside [50, 51] → rounding gate does not fire.
    // modelProb for [50-51] at forecast=53 is near 0; noPrice=0.05 → edgeNo≈0.95 → tradeSide=NO.
    // Tail NO gate must only fire for tail brackets, not interior ones.
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
    const forecast = { forecastHigh: 53, stdDev: 0.5, source: 'noaa' as const, ensembleMembers: 0 };

    const { opportunities: opps } = findMispricedBrackets(event, forecast, 1, 0.0, { minModelCoverage: 0, maxTailNoBetModelProb: 0.5 });
    const noOpps = opps.filter((o) => o.tradeSide === 'NO');
    expect(noOpps.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// findMispricedBrackets — interior NO rounding gate
// ---------------------------------------------------------------------------

describe('findMispricedBrackets - interior NO rounding gate', () => {
  it('blocks interior NO when Math.round(correctedForecastHigh) falls inside bracket', () => {
    // "32°C" bracket (low=32, high=32). Forecast 31.59°C → rounds to 32 → inside bracket → blocked.
    // This is the Hong Kong failure case: model says 31.59°C but WU rounds to 32 → YES.
    const event = {
      eventId: 'e-hk-32', slug: 'hk-32', city: 'hong kong',
      coords: lookupCity('hong kong') ?? { lat: 22.39, lon: 114.11 },
      targetDate: '2026-05-22', unit: 'celsius' as const,
      brackets: [
        { marketId: 'm0', conditionId: 'c0', clobTokenIds: ['t0y', 't0n'],
          threshold: 0, low: 32, high: 32, label: '32°C',
          yesPrice: 0.25, noPrice: 0.72 },
      ],
      endDate: '2026-05-22T12:00:00Z',
    };
    const forecast = { forecastHigh: 31.59, stdDev: 2, source: 'combined' as const, ensembleMembers: 31 };

    const { opportunities } = findMispricedBrackets(event, forecast, 1, 0.0, { minModelCoverage: 0 });
    // Now SHADOW-LOGGED (not silently dropped) but flagged blocked + excluded from execution,
    // so the calibrator keeps learning from this coin-flip cohort with resolved outcomes.
    const noOpps = opportunities.filter((o) => o.tradeSide === 'NO');
    expect(noOpps).toHaveLength(1);
    expect(noOpps[0]!.blockedByInteriorMargin).toBe(true);
  });

  it('allows interior NO when rounded forecast is clearly outside bracket', () => {
    // "32°C" bracket (low=32, high=32). Forecast 29°C → rounds to 29 → outside bracket.
    // yesPrice=0.90 (overpriced) → edgeYes < 0; noPrice=0.05 → edgeNo > 0 → tradeSide=NO.
    // Rounding gate must NOT fire: Math.round(29)=29 is not in [32, 32].
    const event = {
      eventId: 'e-hk-32-safe', slug: 'hk-32-safe', city: 'hong kong',
      coords: lookupCity('hong kong') ?? { lat: 22.39, lon: 114.11 },
      targetDate: '2026-05-22', unit: 'celsius' as const,
      brackets: [
        { marketId: 'm0', conditionId: 'c0', clobTokenIds: ['t0y', 't0n'],
          threshold: 0, low: 32, high: 32, label: '32°C',
          yesPrice: 0.90, noPrice: 0.05 },
      ],
      endDate: '2026-05-22T12:00:00Z',
    };
    const forecast = { forecastHigh: 29, stdDev: 2, source: 'combined' as const, ensembleMembers: 31 };

    const { opportunities } = findMispricedBrackets(event, forecast, 1, 0.0, { minModelCoverage: 0 });
    const noOpps = opportunities.filter((o) => o.tradeSide === 'NO');
    expect(noOpps.length).toBeGreaterThan(0);
    // Clearly outside the bracket → a genuine (tradable) NO, not interior-margin-blocked.
    expect(noOpps[0]!.blockedByInteriorMargin ?? false).toBe(false);
  });

  it('blocks interior NO with bias-corrected forecast that rounds into bracket', () => {
    // Raw forecast 34°C, bias +2°C → corrected = 32°C → rounds to 32 → inside bracket → blocked.
    const event = {
      eventId: 'e-bias-round', slug: 'bias-round', city: 'hong kong',
      coords: lookupCity('hong kong') ?? { lat: 22.39, lon: 114.11 },
      targetDate: '2026-05-22', unit: 'celsius' as const,
      brackets: [
        { marketId: 'm0', conditionId: 'c0', clobTokenIds: ['t0y', 't0n'],
          threshold: 0, low: 32, high: 32, label: '32°C',
          yesPrice: 0.20, noPrice: 0.77 },
      ],
      endDate: '2026-05-22T12:00:00Z',
    };
    const forecast = { forecastHigh: 34, stdDev: 2, source: 'combined' as const, ensembleMembers: 31 };
    const cityBias = { meanBias: 2.0, empiricalStddev: 2.0, meanShiftHelpful: true, sampleSize: 20, updatedAt: '' };

    const { opportunities } = findMispricedBrackets(
      event, forecast, 1, 0.0,
      { minModelCoverage: 0, cityBias, biasCorrectionEnabled: true },
    );
    const noOpps = opportunities.filter((o) => o.tradeSide === 'NO');
    expect(noOpps).toHaveLength(1);
    expect(noOpps[0]!.blockedByInteriorMargin).toBe(true);
  });

  it('does not block tail brackets via rounding gate', () => {
    // "32°C or higher" (low=32, high=null): tail bracket. Forecast 29°C rounds to 29.
    // Rounding gate is interior-only (requires both bounds non-null); high=null → gate must not fire.
    // yesPrice=0.90 → edgeYes<0; noPrice=0.05 → edgeNo>0. modelProb≈0.11<0.5 → tail gate passes.
    const event = {
      eventId: 'e-tail-round', slug: 'tail-round', city: 'hong kong',
      coords: lookupCity('hong kong') ?? { lat: 22.39, lon: 114.11 },
      targetDate: '2026-05-22', unit: 'celsius' as const,
      brackets: [
        { marketId: 'm0', conditionId: 'c0', clobTokenIds: ['t0y', 't0n'],
          threshold: 0, low: 32, high: null, label: '32°C or higher',
          yesPrice: 0.90, noPrice: 0.05 },
      ],
      endDate: '2026-05-22T12:00:00Z',
    };
    const forecast = { forecastHigh: 29, stdDev: 2, source: 'combined' as const, ensembleMembers: 31 };

    // cityActuals with 0% YES rate for ≥32°C so fail-closed gate doesn't block tail NO.
    const coolActuals = { highs: Array(14).fill(28) as number[], unit: 'celsius' as const, sampleSize: 14, updatedAt: '2026-01-01T00:00:00Z' };
    const { opportunities } = findMispricedBrackets(event, forecast, 1, 0.0, { minModelCoverage: 0, cityActuals: coolActuals });
    const noOpps = opportunities.filter((o) => o.tradeSide === 'NO');
    expect(noOpps.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// findMispricedBrackets — confluence gates (market-favorite veto, MAE margin, confluence YES)
// ---------------------------------------------------------------------------

describe('findMispricedBrackets - market-favorite NO veto', () => {
  // NO on a bracket the model dislikes (forecast 79, bracket 76-77) but the MARKET
  // prices as the heavy favorite (yesPrice 0.90). The Miami pattern.
  const event = {
    eventId: 'e-mfav', slug: 'miami-mfav', city: 'miami',
    coords: lookupCity('miami') ?? { lat: 25.79, lon: -80.29 },
    targetDate: '2026-06-25', unit: 'fahrenheit' as const,
    endDate: '2026-06-25T12:00:00Z',
    brackets: [
      { marketId: 'm0', conditionId: 'c0', clobTokenIds: ['t0y', 't0n'],
        threshold: 0, low: 76, high: 77, label: '76-77°F', yesPrice: 0.90, noPrice: 0.08 },
    ],
  };
  const forecast = { forecastHigh: 79, stdDev: 2, source: 'combined' as const, ensembleMembers: 31 };

  it('blocks a NO on a bracket priced ≥ threshold when enabled', () => {
    const { opportunities } = findMispricedBrackets(event, forecast, 1, 0.0, {
      minModelCoverage: 0, marketFavoriteNoVetoEnabled: true, marketFavoriteNoMaxYesPrice: 0.85,
    });
    const no = opportunities.find((o) => o.tradeSide === 'NO')!;
    expect(no).toBeDefined();
    expect(no.blockedByMarketFavorite).toBe(true);
  });

  it('does not block when disabled, or when yesPrice is below the threshold', () => {
    const disabled = findMispricedBrackets(event, forecast, 1, 0.0, {
      minModelCoverage: 0, marketFavoriteNoVetoEnabled: false, marketFavoriteNoMaxYesPrice: 0.85,
    }).opportunities.find((o) => o.tradeSide === 'NO')!;
    expect(disabled.blockedByMarketFavorite ?? false).toBe(false);

    const cheaper = { ...event, brackets: [{ ...event.brackets[0]!, yesPrice: 0.80, noPrice: 0.18 }] };
    const below = findMispricedBrackets(cheaper, forecast, 1, 0.0, {
      minModelCoverage: 0, marketFavoriteNoVetoEnabled: true, marketFavoriteNoMaxYesPrice: 0.85,
    }).opportunities.find((o) => o.tradeSide === 'NO')!;
    expect(below.blockedByMarketFavorite ?? false).toBe(false);
  });
});

describe('findMispricedBrackets - MAE-aware interior margin', () => {
  // Forecast 79.4 → rounds to 79. Bracket 76-77. Flat margin 1 → [75,78] excludes 79 (no block).
  // correctedMae 2.5 × mult 1.0 → margin 2.5 → [73.5,79.5] includes 79 → blocked.
  const event = {
    eventId: 'e-mae', slug: 'mae', city: 'miami',
    coords: lookupCity('miami') ?? { lat: 25.79, lon: -80.29 },
    targetDate: '2026-06-25', unit: 'fahrenheit' as const,
    endDate: '2026-06-25T12:00:00Z',
    brackets: [
      { marketId: 'm0', conditionId: 'c0', clobTokenIds: ['t0y', 't0n'],
        threshold: 0, low: 76, high: 77, label: '76-77°F', yesPrice: 0.15, noPrice: 0.70 },
    ],
  };
  const forecast = { forecastHigh: 79.4, stdDev: 2, source: 'combined' as const, ensembleMembers: 31 };
  const cityBias = { meanBias: 0, empiricalStddev: 2, correctedMae: 2.5, sampleSize: 20, updatedAt: '' };

  it('flat margin (mult=0) does NOT block a forecast just outside the bracket', () => {
    const no = findMispricedBrackets(event, forecast, 1, 0.0, {
      minModelCoverage: 0, interiorNoForecastMargin: 1, interiorNoMarginMaeMult: 0, cityBias,
    }).opportunities.find((o) => o.tradeSide === 'NO')!;
    expect(no.blockedByInteriorMargin ?? false).toBe(false);
    expect(no.interiorNoMarginEff).toBe(1);
  });

  it('MAE-widened margin (mult=1.0) blocks the same NO', () => {
    const no = findMispricedBrackets(event, forecast, 1, 0.0, {
      minModelCoverage: 0, interiorNoForecastMargin: 1, interiorNoMarginMaeMult: 1.0, cityBias,
    }).opportunities.find((o) => o.tradeSide === 'NO')!;
    expect(no.interiorNoMarginEff).toBeCloseTo(2.5, 6);
    expect(no.blockedByInteriorMargin).toBe(true);
  });
});

describe('findMispricedBrackets - confluence YES (shadow)', () => {
  // Forecast 78.5 → model-modal bracket is 78-79. Market favorite is also 78-79 (yes 0.55).
  const event = {
    eventId: 'e-conf', slug: 'conf', city: 'miami',
    coords: lookupCity('miami') ?? { lat: 25.79, lon: -80.29 },
    targetDate: '2026-06-25', unit: 'fahrenheit' as const,
    endDate: '2026-06-25T12:00:00Z',
    brackets: [
      { marketId: 'm0', conditionId: 'c0', clobTokenIds: ['ay','an'], threshold: 0, low: 76, high: 77, label: '76-77°F', yesPrice: 0.10, noPrice: 0.88 },
      { marketId: 'm1', conditionId: 'c1', clobTokenIds: ['by','bn'], threshold: 0, low: 78, high: 79, label: '78-79°F', yesPrice: 0.55, noPrice: 0.43 },
      { marketId: 'm2', conditionId: 'c2', clobTokenIds: ['cy','cn'], threshold: 0, low: 80, high: 81, label: '80-81°F', yesPrice: 0.05, noPrice: 0.93 },
    ],
  };
  const forecast = { forecastHigh: 78.5, stdDev: 1.5, source: 'combined' as const, ensembleMembers: 31 };

  it('flags the bracket that is BOTH model-modal and market-favorite', () => {
    const opps = findMispricedBrackets(event, forecast, 1, 0.0, {
      minModelCoverage: 0, confluenceYesShadowEnabled: true, marketFavoriteNoVetoEnabled: false,
    }).opportunities;
    const fav = opps.find((o) => o.bracketLabel === '78-79°F')!;
    expect(fav.confluenceYesAgree).toBe(true);
    expect(fav.marketFavoriteBracket).toBe('78-79°F');
    expect(fav.modelModalBracket).toBe('78-79°F');
    // A non-confluence bracket is not flagged.
    const other = opps.find((o) => o.bracketLabel === '76-77°F')!;
    expect(other.confluenceYesAgree ?? false).toBe(false);
  });

  it('does not flag confluence when the shadow switch is off', () => {
    const opps = findMispricedBrackets(event, forecast, 1, 0.0, {
      minModelCoverage: 0, confluenceYesShadowEnabled: false, marketFavoriteNoVetoEnabled: false,
    }).opportunities;
    expect(opps.every((o) => !(o.confluenceYesAgree ?? false))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Res-day lock-in (observed-max nowcast)
// ---------------------------------------------------------------------------

describe('isWeatherHighLockedIn', () => {
  it('locks when observed max ≥ bracketHigh + margin (high can only stay/rise)', () => {
    expect(isWeatherHighLockedIn(30, 28, 1.0)).toBe(true);   // 30 ≥ 29
    expect(isWeatherHighLockedIn(29, 28, 1.0)).toBe(true);   // 29 ≥ 29 (boundary)
    expect(isWeatherHighLockedIn(28.9, 28, 1.0)).toBe(false); // 28.9 < 29
    expect(isWeatherHighLockedIn(28, 28, 1.0)).toBe(false);
    expect(isWeatherHighLockedIn(null, 28, 1.0)).toBe(false);
    expect(isWeatherHighLockedIn(35, null, 1.0)).toBe(false);
  });
});

describe('isWeatherLowLockedIn', () => {
  it('locks low NO after the running minimum falls below the bracket floor', () => {
    expect(isWeatherLowLockedIn(28, 30, 31, 'NO', 1.0)).toBe(true);
    expect(isWeatherLowLockedIn(29.1, 30, 31, 'NO', 1.0)).toBe(false);
  });

  it('locks low-tail YES but not bounded low YES intraday', () => {
    expect(isWeatherLowLockedIn(28, null, 29, 'YES', 1.0)).toBe(true);
    expect(isWeatherLowLockedIn(30, 30, 31, 'YES', 1.0)).toBe(false);
  });
});

describe('executeWeatherLockIns', () => {
  const baseOpp = {
    marketId: 'm1', conditionId: 'c1', eventId: 'e1', eventSlug: 's1', clobTokenIds: ['ty', 'tn'],
    city: 'taipei', targetDate: '2026-06-26', metric: 'high' as const, bracketLabel: '28°C',
    question: 'Will the highest temperature in Taipei be 28°C on June 26?',
    yesPrice: 0.30, noPrice: 0.70, outcomePrice: 0.70, tradeSide: 'NO' as const,
    modelProbability: 0.06, edge: 0.23, forecastHigh: 31, daysOut: 0, isResolutionDay: true,
    allowedByConfig: true,
  } as never;
  const lockCfg = (over: Record<string, unknown> = {}) => ({
    ...baseConfig, WEATHER_SCANNER_ENABLED: true, WEATHER_EXECUTION_ENABLED: true,
    WEATHER_LOCKIN_ENABLED: true, WEATHER_TAKER_ENTRY_ENABLED: true,
    WEATHER_LOCKIN_MARGIN: 1.0, WEATHER_LOCKIN_STAKE_USD: 10, WEATHER_LOCKIN_MODEL_WIN: 0.97, ...over,
  });
  const obs = (observedMax: number, confidence = 'settlement_aligned', source = 'hko-live', monotonic = true) => (async () => ({
    city: 'taipei', targetDate: '2026-06-26', observedMax, metric: 'high', source,
    observedAt: '2026-06-26T07:00:00Z', confidence, monotonic,
  })) as never;

  it('takes NO when the observed max has already exceeded the bracket', async () => {
    mockLoadConfig.mockReturnValue(lockCfg());
    const execute = vi.fn().mockResolvedValue({ signal: {}, skipped: false });
    await executeWeatherLockIns({} as never, [baseOpp], undefined, { fetchObs: obs(30), execute: execute as never });
    expect(execute).toHaveBeenCalledTimes(1);
    const sig = execute.mock.calls[0]![0] as { direction: string; consensusProbability: number; stakeUsd: number; _isResolutionDay: boolean; _forceTakerEntry?: boolean };
    expect(sig.direction).toBe('NO');
    expect(sig.consensusProbability).toBeCloseTo(0.03, 6); // 1 − WEATHER_LOCKIN_MODEL_WIN → near-certain NO
    expect(sig.stakeUsd).toBe(10);
    expect(sig._isResolutionDay).toBe(true);
    expect(sig._forceTakerEntry).toBe(true);
  });

  it('still takes lock-in NO when calibration cohort gating blocked the scanner entry path', async () => {
    mockLoadConfig.mockReturnValue(lockCfg());
    const execute = vi.fn().mockResolvedValue({ signal: {}, skipped: false });
    await executeWeatherLockIns(
      {} as never,
      [{ ...baseOpp, allowedByConfig: false, blockedByCalibrationCohort: true }] as never,
      undefined,
      { fetchObs: obs(30), execute: execute as never },
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('still takes lock-in NO when the proven-loser cohort blocks flagged the scanner entry', async () => {
    // WEATHER_BLOCKED_STRATEGY_FAMILIES / WEATHER_NO_MAX_EDGE target MODEL overconfidence;
    // a physics-confirmed lock-in overrides the model edge and is intentionally exempt
    // (same exemption as the calibration-cohort case above). The control for lock-ins is
    // WEATHER_LOCKIN_ENABLED — not the family list.
    mockLoadConfig.mockReturnValue(lockCfg());
    const execute = vi.fn().mockResolvedValue({ signal: {}, skipped: false });
    await executeWeatherLockIns(
      {} as never,
      [{ ...baseOpp, blockedByFamilyBlock: true, blockedByHighNoEdge: true }] as never,
      undefined,
      { fetchObs: obs(30), execute: execute as never },
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does NOT take when the observed max is below bracketHigh + margin', async () => {
    mockLoadConfig.mockReturnValue(lockCfg());
    const execute = vi.fn();
    await executeWeatherLockIns({} as never, [baseOpp], undefined, { fetchObs: obs(28), execute: execute as never });
    expect(execute).not.toHaveBeenCalled();
  });

  it('is a no-op when disabled, even if the bracket is exceeded', async () => {
    mockLoadConfig.mockReturnValue(lockCfg({ WEATHER_LOCKIN_ENABLED: false }));
    const execute = vi.fn();
    await executeWeatherLockIns({} as never, [baseOpp], undefined, { fetchObs: obs(40), execute: execute as never });
    expect(execute).not.toHaveBeenCalled();
  });

  it('is a no-op when the res-day taker path is off (lock-in must not become a maker)', async () => {
    mockLoadConfig.mockReturnValue(lockCfg({ WEATHER_TAKER_ENTRY_ENABLED: false }));
    const execute = vi.fn();
    await executeWeatherLockIns({} as never, [baseOpp], undefined, { fetchObs: obs(40), execute: execute as never });
    expect(execute).not.toHaveBeenCalled();
  });

  it('is a no-op when WEATHER_SCANNER_ENABLED is off (master live-trade kill switch / shadow mode)', async () => {
    mockLoadConfig.mockReturnValue(lockCfg({ WEATHER_SCANNER_ENABLED: false }));
    const execute = vi.fn();
    await executeWeatherLockIns({} as never, [baseOpp], undefined, { fetchObs: obs(40), execute: execute as never });
    expect(execute).not.toHaveBeenCalled();
  });

  it('skips PROXY observations — only settlement-aligned obs can trigger an irreversible lock-in', async () => {
    mockLoadConfig.mockReturnValue(lockCfg());
    const execute = vi.fn();
    await executeWeatherLockIns({} as never, [baseOpp], undefined, { fetchObs: obs(40, 'proxy'), execute: execute as never });
    expect(execute).not.toHaveBeenCalled();
  });

  it('skips WU live observations because same-day WU historical highs can revise downward', async () => {
    mockLoadConfig.mockReturnValue(lockCfg());
    const execute = vi.fn();
    await executeWeatherLockIns(
      {} as never,
      [baseOpp],
      undefined,
      { fetchObs: obs(40, 'settlement_aligned', 'wu-live'), execute: execute as never },
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('skips a NON-MONOTONIC source even when settlement-aligned (revisable max unsafe for an irreversible bet)', async () => {
    mockLoadConfig.mockReturnValue(lockCfg());
    const execute = vi.fn();
    // settlement_aligned + not wu-live, but monotonic=false → blocked by the new gate.
    await executeWeatherLockIns(
      {} as never,
      [baseOpp],
      undefined,
      { fetchObs: obs(40, 'settlement_aligned', 'metar-live', false), execute: execute as never },
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('allows a non-monotonic source only when WEATHER_LOCKIN_MONOTONIC_SOURCES_ONLY is off (escape hatch)', async () => {
    mockLoadConfig.mockReturnValue(lockCfg({ WEATHER_LOCKIN_MONOTONIC_SOURCES_ONLY: false }));
    const execute = vi.fn().mockResolvedValue({ signal: {}, skipped: false });
    await executeWeatherLockIns(
      {} as never,
      [baseOpp],
      undefined,
      { fetchObs: obs(40, 'settlement_aligned', 'metar-live', false), execute: execute as never },
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('takes a monotonic METAR lock-in (settlement-aligned + monotonic)', async () => {
    mockLoadConfig.mockReturnValue(lockCfg());
    const execute = vi.fn().mockResolvedValue({ signal: {}, skipped: false });
    await executeWeatherLockIns(
      {} as never,
      [baseOpp],
      undefined,
      { fetchObs: obs(40, 'settlement_aligned', 'metar-live', true), execute: execute as never },
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('skips YES opps, low-metric, and tail brackets', async () => {
    mockLoadConfig.mockReturnValue(lockCfg());
    const execute = vi.fn();
    const opps = [
      { ...baseOpp, tradeSide: 'YES' },
      { ...baseOpp, metric: 'low' },
      { ...baseOpp, bracketLabel: '32°C or higher' }, // tail → bracket.high null
    ] as never;
    await executeWeatherLockIns({} as never, opps, undefined, { fetchObs: obs(40), execute: execute as never });
    expect(execute).not.toHaveBeenCalled();
  });

  it('skips when the live observation is stale / confidence none', async () => {
    mockLoadConfig.mockReturnValue(lockCfg());
    const execute = vi.fn();
    await executeWeatherLockIns({} as never, [baseOpp], undefined, { fetchObs: obs(40, 'none'), execute: execute as never });
    expect(execute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// findMispricedBrackets — YES-bet quality gates
// ---------------------------------------------------------------------------

describe('findMispricedBrackets - YES quality gates', () => {
  const baseEvent = {
    eventId: 'e1', slug: 's1', city: 'paris',
    coords: lookupCity('paris') ?? { lat: 48.85, lon: 2.35, unit: 'celsius' as const, tz: 'Europe/Paris', noaaCoverage: false },
    targetDate: '2026-05-31', unit: 'celsius' as const,
    endDate: '2026-05-31T12:00:00Z',
    allMarketIds: ['m1'],
  };
  // Explicit gate options: restrictive (production-like) vs permissive (gate disabled)
  const GATES_ON = { yesAllowInteriorBrackets: false, yesMinMarketPrice: 0.30, yesMinModelProb: 0.50 };
  const NO_GATES = { yesAllowInteriorBrackets: true, yesMinMarketPrice: 0, yesMinModelProb: 0 };

  // Interior bracket with forecast 24.1°C; modelProb ≈ 0.286.
  // yesPrice must be < modelProb for YES to have edge (e.g. 0.10).
  function makeInteriorBracket(yesPrice = 0.10) {
    return [{
      marketId: 'm1', conditionId: 'c1', clobTokenIds: ['ty', 'tn'],
      threshold: 0, low: 24, high: 24, label: '24°C',
      yesPrice, noPrice: 1 - yesPrice,
    }];
  }

  function makeHighTailBracket(yesPrice = 0.40) {
    return [{
      marketId: 'm1', conditionId: 'c1', clobTokenIds: ['ty', 'tn'],
      threshold: 0, low: 24, high: null, label: '24°C or higher',
      yesPrice, noPrice: 1 - yesPrice,
    }];
  }

  // Interior bracket far from forecast so interior-NO rounding gate doesn't fire;
  // yesPrice high so tradeSide=NO and YES gates don't interfere.
  function makeInteriorNoBracket() {
    return [{
      marketId: 'm2', conditionId: 'c2', clobTokenIds: ['ty2', 'tn2'],
      threshold: 0, low: 28, high: 28, label: '28°C',
      yesPrice: 0.90, noPrice: 0.08,
    }];
  }

  const forecast = { forecastHigh: 24.1, stdDev: 1.36, source: 'open-meteo' as const, ensembleMembers: 30 };

  it('blocks interior YES when gates are enabled (yesAllowInteriorBrackets=false)', () => {
    const event = { ...baseEvent, brackets: makeInteriorBracket(0.40) };
    const { opportunities } = findMispricedBrackets(event, forecast, 1, 0.0, {
      minModelCoverage: 0, ...GATES_ON,
    });
    expect(opportunities.filter((o) => o.tradeSide === 'YES')).toHaveLength(0);
  });

  it('allows interior YES when yesAllowInteriorBrackets=true and other gates disabled', () => {
    // yesPrice=0.10 < modelProb≈0.286 → edgeYes > 0 → tradeSide=YES
    const event = { ...baseEvent, brackets: makeInteriorBracket(0.10) };
    const { opportunities } = findMispricedBrackets(event, forecast, 1, 0.0, {
      minModelCoverage: 0, ...NO_GATES,
    });
    expect(opportunities.filter((o) => o.tradeSide === 'YES')).toHaveLength(1);
  });

  it('does not block NO bets on interior brackets via YES gate', () => {
    // Bracket "28°C" is far from forecast 24.1°C: rounds to 24 ≠ 28, so interior-NO
    // rounding gate doesn't fire. High yesPrice → edgeNo > 0 → tradeSide=NO.
    // YES gates must not affect NO-side bets.
    const event = { ...baseEvent, brackets: makeInteriorNoBracket() };
    const { opportunities } = findMispricedBrackets(event, forecast, 1, 0.0, {
      minModelCoverage: 0, ...GATES_ON,
    });
    expect(opportunities.filter((o) => o.tradeSide === 'NO')).toHaveLength(1);
  });

  it('blocks YES when market price is below yesMinMarketPrice', () => {
    // High-tail bracket passes interior gate, but yesPrice=0.10 < 0.30 threshold
    const event = { ...baseEvent, brackets: makeHighTailBracket(0.10) };
    const { opportunities } = findMispricedBrackets(event, forecast, 1, 0.0, {
      minModelCoverage: 0, ...GATES_ON,
    });
    expect(opportunities.filter((o) => o.tradeSide === 'YES')).toHaveLength(0);
  });

  it('allows YES when market price meets yesMinMarketPrice', () => {
    // High-tail "24°C or higher", forecastHigh=28°C → modelProb ~0.97 > 0.50; yesPrice=0.35 > 0.30
    const highForecast = { forecastHigh: 28, stdDev: 1.36, source: 'open-meteo' as const, ensembleMembers: 30 };
    const event = { ...baseEvent, brackets: makeHighTailBracket(0.35) };
    const { opportunities } = findMispricedBrackets(event, highForecast, 1, 0.0, {
      minModelCoverage: 0, ...GATES_ON,
    });
    expect(opportunities.filter((o) => o.tradeSide === 'YES')).toHaveLength(1);
  });

  it('blocks YES when model probability is below yesMinModelProb', () => {
    // Use threshold 0.99 to force block even on a high-tail bracket
    const event = { ...baseEvent, brackets: makeHighTailBracket(0.35) };
    const { opportunities } = findMispricedBrackets(event, forecast, 1, 0.0, {
      minModelCoverage: 0, yesAllowInteriorBrackets: false, yesMinMarketPrice: 0, yesMinModelProb: 0.99,
    });
    expect(opportunities.filter((o) => o.tradeSide === 'YES')).toHaveLength(0);
  });

  it('falls back to NO when YES is gated but NO has positive edge', () => {
    // Interior "25°C", forecast 24.4°C → modelProb ≈ 0.261.
    // yesPrice=0.10 → edgeYes=0.161 wins the raw comparison over edgeNo=0.089.
    // YES gate fires (interior, gates on) → must fall back to NO (edge 0.089), not drop.
    const brackets = [{
      marketId: 'm1', conditionId: 'c1', clobTokenIds: ['ty', 'tn'],
      threshold: 0, low: 25, high: 25, label: '25°C',
      yesPrice: 0.10, noPrice: 0.65,
    }];
    const forecast24 = { forecastHigh: 24.4, stdDev: 1.36, source: 'open-meteo' as const, ensembleMembers: 30 };
    const event = { ...baseEvent, brackets };
    const { opportunities } = findMispricedBrackets(event, forecast24, 1, 0.0, {
      minModelCoverage: 0, ...GATES_ON,
    });
    // YES is gated; NO survives (interior-NO rounding gate: Math.round(24.4)=24 ≠ 25)
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]!.tradeSide).toBe('NO');
  });

  it('skips the bracket entirely when YES is gated and NO has no positive edge', () => {
    // Interior "25°C", forecast 24.4°C → modelProb ≈ 0.261, edgeYes=0.161 (>edgeNo).
    // noPrice=0.95 → edgeNo = (1-0.261) - 0.95 = -0.211 < 0. YES gated (interior) and
    // NO has no edge → must skip entirely (the terminal else/continue branch).
    const brackets = [{
      marketId: 'm1', conditionId: 'c1', clobTokenIds: ['ty', 'tn'],
      threshold: 0, low: 25, high: 25, label: '25°C',
      yesPrice: 0.10, noPrice: 0.95,
    }];
    const forecast24 = { forecastHigh: 24.4, stdDev: 1.36, source: 'open-meteo' as const, ensembleMembers: 30 };
    const event = { ...baseEvent, brackets };
    const { opportunities } = findMispricedBrackets(event, forecast24, 1, 0.0, {
      minModelCoverage: 0, ...GATES_ON,
    });
    expect(opportunities).toHaveLength(0);
  });

  it('tags a YES-gate fallback NO with yesFellBackToNo + yesGateReason', () => {
    const brackets = [{
      marketId: 'm1', conditionId: 'c1', clobTokenIds: ['ty', 'tn'],
      threshold: 0, low: 25, high: 25, label: '25°C',
      yesPrice: 0.10, noPrice: 0.65,
    }];
    const forecast24 = { forecastHigh: 24.4, stdDev: 1.36, source: 'open-meteo' as const, ensembleMembers: 30 };
    const event = { ...baseEvent, brackets };
    const { opportunities } = findMispricedBrackets(event, forecast24, 1, 0.0, {
      minModelCoverage: 0, ...GATES_ON,
    });
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]!.tradeSide).toBe('NO');
    expect(opportunities[0]!.yesFellBackToNo).toBe(true);
    expect(opportunities[0]!.yesGateReason).toBe('interior_bracket');
  });

  it('does not tag a native NO (YES never had edge) as a fallback', () => {
    // Bracket "28°C" far from forecast 24.1°C: edgeYes negative → native NO, not a fallback.
    const event = { ...baseEvent, brackets: makeInteriorNoBracket() };
    const { opportunities } = findMispricedBrackets(event, forecast, 1, 0.0, {
      minModelCoverage: 0, ...GATES_ON,
    });
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]!.tradeSide).toBe('NO');
    expect(opportunities[0]!.yesFellBackToNo).toBe(false);
    // Native NO must stay untagged even though the interior gate would trip on a
    // YES candidate — keeps the native-NO cohort clean for shadow analysis.
    expect(opportunities[0]!.yesGateReason).toBeNull();
  });

  it('allows high-tail YES when all gates pass', () => {
    // forecastHigh=28°C, "24°C or higher" → modelProb ~0.97; yesPrice=0.50 > 0.30; model > 0.50
    const highForecast = { forecastHigh: 28, stdDev: 1.36, source: 'open-meteo' as const, ensembleMembers: 30 };
    const event = { ...baseEvent, brackets: makeHighTailBracket(0.50) };
    const { opportunities } = findMispricedBrackets(event, highForecast, 1, 0.0, {
      minModelCoverage: 0, ...GATES_ON,
    });
    expect(opportunities.filter((o) => o.tradeSide === 'YES')).toHaveLength(1);
  });
});

describe('findMispricedBrackets - far NO ladder', () => {
  const event = {
    eventId: 'e-far-no',
    slug: 'highest-temperature-in-paris-on-june-28-2026',
    city: 'paris',
    coords: lookupCity('paris')!,
    targetDate: '2026-06-28',
    unit: 'celsius' as const,
    metric: 'high' as const,
    endDate: '2026-06-28T22:00:00Z',
    brackets: [
      { marketId: 'm29', conditionId: 'c29', clobTokenIds: ['y29', 'n29'], threshold: 0, low: 29, high: 29, label: '29°C', yesPrice: 0.05, noPrice: 0.95 },
      { marketId: 'm30', conditionId: 'c30', clobTokenIds: ['y30', 'n30'], threshold: 1, low: 30, high: 30, label: '30°C', yesPrice: 0.25, noPrice: 0.75 },
      { marketId: 'm31', conditionId: 'c31', clobTokenIds: ['y31', 'n31'], threshold: 2, low: 31, high: 31, label: '31°C', yesPrice: 0.20, noPrice: 0.80 },
      { marketId: 'm34', conditionId: 'c34', clobTokenIds: ['y34', 'n34'], threshold: 3, low: 34, high: 34, label: '34°C', yesPrice: 0.01, noPrice: 0.99 },
      { marketId: 'm35', conditionId: 'c35', clobTokenIds: ['y35', 'n35'], threshold: 4, low: 35, high: 35, label: '35°C', yesPrice: 0.01, noPrice: 0.99 },
    ],
  };
  const forecast = {
    forecastHigh: 30,
    stdDev: 1,
    source: 'open-meteo' as const,
    ensembleMembers: 30,
  };

  it('emits far NO candidates at the configured maker bid instead of the expensive market quote', () => {
    const { opportunities } = findMispricedBrackets(event, forecast, 1, 0.08, {
      minModelCoverage: 0,
      farNoLadderEnabled: true,
      farNoMinWinProb: 0.975,
      farNoMinEdge: 0.03,
      farNoMaxBid: 0.94,
      farNoMinBid: 0.50,
      farNoMinDistanceDegrees: 2,
    });

    const far = opportunities.find((o) => o.bracketLabel === '34°C');
    expect(far).toBeDefined();
    expect(far!.tradeSide).toBe('NO');
    expect(far!.isFarNoLadder).toBe(true);
    expect(far!.farNoMarketPrice).toBe(0.99);
    expect(far!.outcomePrice).toBeCloseTo(0.94, 6);
    expect(far!.edge).toBeGreaterThanOrEqual(0.03);
  });

  it('does not turn nearby exact brackets into ladder NO candidates', () => {
    const { opportunities } = findMispricedBrackets(event, forecast, 1, 0.08, {
      minModelCoverage: 0,
      farNoLadderEnabled: true,
      farNoMinWinProb: 0.50,
      farNoMinEdge: 0.03,
      farNoMaxBid: 0.94,
      farNoMinBid: 0.50,
      farNoMinDistanceDegrees: 2,
    });

    const nearby = opportunities.find((o) => o.bracketLabel === '31°C');
    expect(nearby?.isFarNoLadder ?? false).toBe(false);
  });

  it('emits adjacent NO ladder candidates with a lower bid cap and separate tag', () => {
    const adjacentEvent = {
      ...event,
      brackets: [
        ...event.brackets,
        { marketId: 'm32', conditionId: 'c32', clobTokenIds: ['y32', 'n32'], threshold: 5, low: 32, high: 32, label: '32°C', yesPrice: 0.12, noPrice: 0.88 },
      ],
    };
    const { opportunities } = findMispricedBrackets(adjacentEvent, forecast, 1, 0.08, {
      minModelCoverage: 0,
      farNoLadderEnabled: false,
      adjacentNoLadderEnabled: true,
      adjacentNoMinWinProb: 0.88,
      adjacentNoMinEdge: 0.06,
      adjacentNoMaxBid: 0.80,
      adjacentNoMinBid: 0.50,
      adjacentNoMinDistanceDegrees: 0.5,
      adjacentNoMaxDistanceDegrees: 2,
    });

    const adjacent = opportunities.find((o) => o.bracketLabel === '32°C');
    expect(adjacent).toBeDefined();
    expect(adjacent!.tradeSide).toBe('NO');
    expect(adjacent!.isFarNoLadder).toBe(false);
    expect(adjacent!.isAdjacentNoLadder).toBe(true);
    expect(adjacent!.noLadderKind).toBe('adjacent');
    expect(adjacent!.farNoDistance).toBeCloseTo(1.5, 6);
    expect(adjacent!.farNoMarketPrice).toBe(0.88);
    expect(adjacent!.outcomePrice).toBeCloseTo(0.80, 6);
    expect(adjacent!.edge).toBeGreaterThanOrEqual(0.06);
  });

  it('does not turn the exact forecast bracket into an adjacent NO ladder candidate', () => {
    const { opportunities } = findMispricedBrackets(event, forecast, 1, 0.08, {
      minModelCoverage: 0,
      adjacentNoLadderEnabled: true,
      adjacentNoMinWinProb: 0.50,
      adjacentNoMinEdge: 0.03,
      adjacentNoMaxBid: 0.80,
      adjacentNoMinBid: 0.50,
      adjacentNoMinDistanceDegrees: 0.5,
      adjacentNoMaxDistanceDegrees: 2,
    });

    const exact = opportunities.find((o) => o.bracketLabel === '30°C');
    expect(exact?.isAdjacentNoLadder ?? false).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findMispricedBrackets — NO-bias model-safety guards (2026-06-19)
// ---------------------------------------------------------------------------

describe('findMispricedBrackets - NO-bias model-safety guards (2026-06-19)', () => {
  const baseEvent = {
    eventId: 'e1', slug: 's1', city: 'paris',
    coords: lookupCity('paris') ?? { lat: 48.85, lon: 2.35, unit: 'celsius' as const, tz: 'Europe/Paris', noaaCoverage: false },
    targetDate: '2026-06-30', unit: 'celsius' as const, metric: 'high' as const,
    endDate: '2026-06-30T12:00:00Z', allMarketIds: ['m1'],
  };
  const GATES_ON = { yesAllowInteriorBrackets: false, yesMinMarketPrice: 0.30, yesMinModelProb: 0.50 };

  // Interior "25°C", forecast 24.4°C → modelProb ≈ 0.261; edgeYes (0.161) ≥ edgeNo
  // (0.089). YES is gated (interior) → the model preferred YES but it was blocked.
  function fallbackBrackets() {
    return [{
      marketId: 'm1', conditionId: 'c1', clobTokenIds: ['ty', 'tn'],
      threshold: 0, low: 25, high: 25, label: '25°C', yesPrice: 0.10, noPrice: 0.65,
    }];
  }
  const fallbackForecast = { forecastHigh: 24.4, stdDev: 1.36, source: 'open-meteo' as const, ensembleMembers: 30 };

  it('shadow-logs (does not trade) a YES-gate fallback NO when the fallback is disabled', () => {
    const event = { ...baseEvent, brackets: fallbackBrackets() };
    const { opportunities } = findMispricedBrackets(event, fallbackForecast, 1, 0.0, {
      minModelCoverage: 0, ...GATES_ON, yesGateNoFallbackEnabled: false,
    });
    expect(opportunities).toHaveLength(1);
    const o = opportunities[0]!;
    expect(o.tradeSide).toBe('NO');
    expect(o.blockedByNoFallback).toBe(true);      // recorded for shadow…
    expect(o.wouldHaveFallenBackToNo).toBe(true);
    expect(o.yesFellBackToNo).toBe(false);         // …but did NOT trade as a fallback
    expect(o.yesGateReason).toBe('interior_bracket');
  });

  it('still trades the YES-gate fallback NO when the fallback is enabled', () => {
    const event = { ...baseEvent, brackets: fallbackBrackets() };
    const { opportunities } = findMispricedBrackets(event, fallbackForecast, 1, 0.0, {
      minModelCoverage: 0, ...GATES_ON, yesGateNoFallbackEnabled: true,
    });
    expect(opportunities).toHaveLength(1);
    const o = opportunities[0]!;
    expect(o.tradeSide).toBe('NO');
    expect(o.blockedByNoFallback).toBe(false);
    expect(o.yesFellBackToNo).toBe(true);
  });

  it('does not block a native NO when the fallback is disabled', () => {
    // "28°C" far from forecast 24.1°C → edgeYes < 0 → native NO, not a fallback.
    const event = { ...baseEvent, brackets: [{
      marketId: 'm2', conditionId: 'c2', clobTokenIds: ['ty2', 'tn2'],
      threshold: 0, low: 28, high: 28, label: '28°C', yesPrice: 0.90, noPrice: 0.08,
    }] };
    const forecast = { forecastHigh: 24.1, stdDev: 1.36, source: 'open-meteo' as const, ensembleMembers: 30 };
    const { opportunities } = findMispricedBrackets(event, forecast, 1, 0.0, {
      minModelCoverage: 0, ...GATES_ON, yesGateNoFallbackEnabled: false,
    });
    expect(opportunities).toHaveLength(1);
    const o = opportunities[0]!;
    expect(o.tradeSide).toBe('NO');
    expect(o.blockedByNoFallback).toBe(false);
    expect(o.wouldHaveFallenBackToNo).toBe(false);
  });

  it('inflates Open-Meteo σ only (source-aware multiplier)', () => {
    const event = { ...baseEvent, brackets: [{
      marketId: 'm1', conditionId: 'c1', clobTokenIds: ['ty', 'tn'],
      threshold: 0, low: 24, high: null, label: '24°C or higher', yesPrice: 0.40, noPrice: 0.60,
    }] };
    const om = { forecastHigh: 26, stdDev: 1.5, source: 'open-meteo' as const, ensembleMembers: 30 };
    const noaa = { forecastHigh: 26, stdDev: 1.5, source: 'noaa' as const, ensembleMembers: 0 };
    const rOm = findMispricedBrackets(event, om, 1, 0.0, { minModelCoverage: 0, openMeteoStddevMultiplier: 1.5 });
    const rNoaa = findMispricedBrackets(event, noaa, 1, 0.0, { minModelCoverage: 0, openMeteoStddevMultiplier: 1.5 });
    expect(rOm.effectiveStdDev).toBeCloseTo(1.5 * 1.5, 6);   // 1.5°C × 1.5 source mult
    expect(rNoaa.effectiveStdDev).toBeCloseTo(1.5, 6);       // NOAA untouched
    expect(rOm.opportunities[0]!.sourceStddevMultiplier).toBe(1.5);
    expect(rNoaa.opportunities[0]!.sourceStddevMultiplier).toBe(1.0);
  });

  it('shadow-logs (blocks) an interior NO when the forecast rounds adjacent to the bracket (margin 1)', () => {
    // "24°C" bracket, forecast 25.4°C → rounds to 25 → within [24-1, 24+1] = [23,25] at margin 1.
    const brackets = [{
      marketId: 'm1', conditionId: 'c1', clobTokenIds: ['ty', 'tn'],
      threshold: 0, low: 24, high: 24, label: '24°C', yesPrice: 0.90, noPrice: 0.05,
    }];
    const forecast = { forecastHigh: 25.4, stdDev: 1.36, source: 'open-meteo' as const, ensembleMembers: 30 };
    const event = { ...baseEvent, brackets };

    // margin 1: logged-as-blocked (shadow), excluded from execution.
    const blocked = findMispricedBrackets(event, forecast, 1, 0.0, {
      minModelCoverage: 0, interiorNoForecastMargin: 1,
    }).opportunities.filter((o) => o.tradeSide === 'NO');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.blockedByInteriorMargin).toBe(true);

    // Legacy margin 0: rounded 25 ∉ [24,24] → genuine (tradable) NO, not blocked.
    const allowed = findMispricedBrackets(event, forecast, 1, 0.0, {
      minModelCoverage: 0, interiorNoForecastMargin: 0,
    }).opportunities.filter((o) => o.tradeSide === 'NO');
    expect(allowed).toHaveLength(1);
    expect(allowed[0]!.blockedByInteriorMargin ?? false).toBe(false);
  });

  // June 2026 failure cohort: exact-degree NO bets whose actual high resolved AT
  // the degree. PR1 cannot fully fix the deep-confidence misses (that needs the
  // learned calibrator in PR2), but its Open-Meteo σ inflation must REDUCE the NO
  // edge on every one of these shapes — moving them toward un-tradable.
  const JUNE_NO_CASES = [
    { city: 'toronto',  label: '24°C', low: 24, high: 24, forecastHigh: 25.8 },
    { city: 'istanbul', label: '23°C', low: 23, high: 23, forecastHigh: 27.0 },
    { city: 'taipei',   label: '37°C', low: 37, high: 37, forecastHigh: 38.6 },
    { city: 'madrid',   label: '29°C', low: 29, high: 29, forecastHigh: 30.6 },
    { city: 'shenzhen', label: '27°C', low: 27, high: 27, forecastHigh: 29.4 },
  ];
  for (const c of JUNE_NO_CASES) {
    it(`reduces NO edge on the June ${c.city} ${c.label} exact-degree case`, () => {
      const event = {
        ...baseEvent, city: c.city, coords: lookupCity(c.city) ?? baseEvent.coords,
        brackets: [{
          marketId: 'm1', conditionId: 'c1', clobTokenIds: ['ty', 'tn'],
          threshold: 0, low: c.low, high: c.high, label: c.label, yesPrice: 0.10, noPrice: 0.49,
        }],
      };
      const forecast = { forecastHigh: c.forecastHigh, stdDev: 1.36, source: 'open-meteo' as const, ensembleMembers: 30 };
      // Legacy: no σ inflation, strict interior gate.
      const legacy = findMispricedBrackets(event, forecast, 1, 0.0, {
        minModelCoverage: 0, openMeteoStddevMultiplier: 1.0, interiorNoForecastMargin: 0,
      }).opportunities.find((o) => o.tradeSide === 'NO');
      // PR1: Open-Meteo σ × 1.25, adjacency margin 1.
      const pr1 = findMispricedBrackets(event, forecast, 1, 0.0, {
        minModelCoverage: 0, openMeteoStddevMultiplier: 1.25, interiorNoForecastMargin: 1,
      }).opportunities.find((o) => o.tradeSide === 'NO');
      expect(legacy).toBeDefined();
      // PR1 either blocks the NO entirely or strictly reduces its edge.
      if (pr1) expect(pr1.edge).toBeLessThan(legacy!.edge);
    });
  }

  // ── Calibration shadow pass (PR2a) ──────────────────────────────────────────
  it('attaches calibrated shadow fields when calibrationShadowEnabled, without changing the live decision', () => {
    const brackets = [{
      marketId: 'm1', conditionId: 'c1', clobTokenIds: ['ty', 'tn'],
      threshold: 0, low: 28, high: 28, label: '28°C', yesPrice: 0.90, noPrice: 0.08,
    }];
    const forecast = { forecastHigh: 24.1, stdDev: 1.36, source: 'open-meteo' as const, ensembleMembers: 30 };
    const event = { ...baseEvent, brackets };
    const opp = findMispricedBrackets(event, forecast, 1, 0.0, {
      minModelCoverage: 0, ...GATES_ON, calibrationShadowEnabled: true,
    }).opportunities[0]!;
    // Live decision is unchanged (still a native NO on the raw probability).
    expect(opp.tradeSide).toBe('NO');
    // Calibrated fields are populated and well-formed (uses the committed artifact).
    expect(opp.modelProbCalibrated).not.toBeNull();
    expect(opp.modelProbCalibrated!).toBeGreaterThanOrEqual(0);
    expect(opp.modelProbCalibrated!).toBeLessThanOrEqual(1);
    expect(opp.edgeCalibrated).not.toBeNull();
    expect(['YES', 'NO', null]).toContain(opp.tradeSideCalibrated);
    // A real high-metric/exact/open-meteo cell exists in the committed artifact,
    // so calibration must be a NON-identity transform that LIFTS this very low
    // input (28°C far from a 24.1° forecast → tiny raw YES) toward its realized
    // (higher) rate. This pins the metric routing + the calibrator actually firing.
    expect(opp.modelProbCalInput).not.toBeNull();
    expect(opp.modelProbCalibrated!).toBeGreaterThan(opp.modelProbCalInput!);
    // modelProbability (the live raw prob) is untouched by calibration.
    expect(opp.modelProbability).toBeCloseTo(opp.modelProbRaw!, 6);
  });

  it('calibrates the PRE-source-inflation Gaussian (modelProbCalInput) — distinct from the σ-inflated live prob', () => {
    const brackets = [{
      marketId: 'm1', conditionId: 'c1', clobTokenIds: ['ty', 'tn'],
      threshold: 0, low: 28, high: 28, label: '28°C', yesPrice: 0.90, noPrice: 0.08,
    }];
    const forecast = { forecastHigh: 24.1, stdDev: 1.36, source: 'open-meteo' as const, ensembleMembers: 30 };
    const event = { ...baseEvent, brackets };
    const opp = findMispricedBrackets(event, forecast, 1, 0.0, {
      minModelCoverage: 0, ...GATES_ON, calibrationShadowEnabled: true,
      openMeteoStddevMultiplier: 1.25,
    }).opportunities[0]!;
    // Live σ includes the 1.25× source inflation; the calibrator input does NOT.
    expect(opp.effectiveStdDev).toBeCloseTo(1.36 * 1.25, 4);
    // So the calibrator input (pre-inflation Gaussian) differs from the live prob.
    expect(opp.modelProbCalInput).not.toBeNull();
    expect(opp.modelProbCalInput!).not.toBeCloseTo(opp.modelProbability, 4);
    // And modelProbRaw (no bias, no inflation) here equals the calibrator input
    // (no bias correction in this test), confirming calInput is the un-inflated scale.
    expect(opp.modelProbCalInput!).toBeCloseTo(opp.modelProbRaw!, 6);
  });

  it('leaves calibrated shadow fields null when calibrationShadowEnabled is off (default)', () => {
    const brackets = [{
      marketId: 'm1', conditionId: 'c1', clobTokenIds: ['ty', 'tn'],
      threshold: 0, low: 28, high: 28, label: '28°C', yesPrice: 0.90, noPrice: 0.08,
    }];
    const forecast = { forecastHigh: 24.1, stdDev: 1.36, source: 'open-meteo' as const, ensembleMembers: 30 };
    const event = { ...baseEvent, brackets };
    const opp = findMispricedBrackets(event, forecast, 1, 0.0, {
      minModelCoverage: 0, ...GATES_ON,
    }).opportunities[0]!;
    expect(opp.modelProbCalibrated ?? null).toBeNull();
    expect(opp.edgeCalibrated ?? null).toBeNull();
    expect(opp.tradeSideCalibrated ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findMispricedBrackets — calibrated LIVE decisions, per-cohort (PR2b)
// ---------------------------------------------------------------------------

describe('findMispricedBrackets - calibrated live decisions (PR2b)', () => {
  // Synthetic table: range|hrrr-combined maps everything to 0.60 (so a cheap-YES
  // range bracket flips to a calibrated YES); a high|metric root for fallback.
  const rise60 = Array.from({ length: 10 }, () => 0.60);
  const synthTable = {
    _meta: { generatedAt: '', scoredPairs: 9000, binCount: 10, priorStrength: 20, minCellSamples: 80, version: 1 },
    byShapeSourceHorizon: {},
    byShapeSource: { 'high|range|hrrr-combined': { n: 500, bins: rise60 } },
    byShape: {},
    byMetric: { high: { n: 9000, bins: Array.from({ length: 10 }, (_, i) => (i + 0.5) / 10) } },
  };
  // A US Fahrenheit range bracket priced as a NO under the raw model (forecast far
  // below), so without calibration it's a NO; calibration (0.60) flips it to YES.
  const rangeEvent = {
    eventId: 'e1', slug: 's1', city: 'chicago', coords: lookupCity('chicago')!,
    targetDate: '2026-06-30', unit: 'fahrenheit' as const, metric: 'high' as const,
    endDate: '2026-06-30T12:00:00Z', allMarketIds: ['m1'],
    brackets: [{ marketId: 'm1', conditionId: 'c1', clobTokenIds: ['ty', 'tn'],
      threshold: 0, low: 70, high: 71, label: '70-71°F', yesPrice: 0.25, noPrice: 0.72 }],
  };
  const forecastHrrr = { forecastHigh: 64, stdDev: 4, source: 'hrrr-combined' as const, ensembleMembers: 31 };

  beforeEach(() => { _setCalibrationTableForTest(synthTable as never); });
  afterEach(() => { _setCalibrationTableForTest(undefined); });

  it('acts on calibration for an allow-listed cohort and surfaces interior YES', () => {
    const opp = findMispricedBrackets(rangeEvent, forecastHrrr, 1, 0.0, {
      minModelCoverage: 0, yesAllowInteriorBrackets: false, yesMinMarketPrice: 0.30, yesMinModelProb: 0.50,
      calibrationShadowEnabled: true, calibrationLiveEnabled: true,
      calibrationLiveCohorts: 'YES|high|range|hrrr-combined', calibrationYesMinPrice: 0.15,
    }).opportunities[0]!;
    expect(opp.tradeSide).toBe('YES');               // calibrated 0.60 > yesPrice 0.25 → YES
    expect(opp.calibrationLive).toBe(true);
    expect(opp.modelProbability).toBeCloseTo(0.60, 6); // decision prob = calibrated (drives Kelly)
    expect(opp.modelProbCalibrated).toBeCloseTo(0.60, 6);
  });

  it('uses calibrated probability for a non-admitted cohort but marks it shadow-only', () => {
    const opp = findMispricedBrackets(rangeEvent, { ...forecastHrrr, source: 'open-meteo' as const }, 1, 0.0, {
      minModelCoverage: 0, yesAllowInteriorBrackets: false, yesMinMarketPrice: 0.30, yesMinModelProb: 0.50,
      calibrationShadowEnabled: true, calibrationLiveEnabled: true,
      calibrationLiveCohorts: 'YES|high|range|hrrr-combined', calibrationYesMinPrice: 0.15,
    }).opportunities[0]!;
    // Calibration-live no longer falls back to raw for non-admitted cohorts; it
    // computes on calibrated probability but keeps the cohort shadow-only.
    expect(opp.calibrationLive).toBe(false);
    expect(opp.blockedByCalibrationCohort).toBe(true);
    expect(opp.allowedByConfig).toBe(false);
    expect(opp.modelProbability).toBe(opp.modelProbCalibrated);
  });

  it('does not act on calibration when calibrationLiveEnabled is off (default)', () => {
    const opp = findMispricedBrackets(rangeEvent, forecastHrrr, 1, 0.0, {
      minModelCoverage: 0, yesAllowInteriorBrackets: false, yesMinMarketPrice: 0.30, yesMinModelProb: 0.50,
      calibrationShadowEnabled: true, // shadow on, but live OFF
      calibrationLiveCohorts: 'YES|high|range|hrrr-combined',
    }).opportunities[0]!;
    expect(opp.calibrationLive).toBe(false);
    expect(opp.tradeSide).toBe('NO');                 // raw decision unchanged
    expect(opp.modelProbCalibrated).toBeCloseTo(0.60, 6); // still LOGGED in shadow
    expect(opp.modelProbability).toBeCloseTo(opp.modelProbRaw!, 6);
  });

  it('blocks a low-metric market sharing the same shape|source unless the metric-specific cohort is admitted', () => {
    // Regression guard (review finding): the live cohort key is metric-aware, so a
    // lowest-temperature range/HRRR market stays on the RAW model even with the
    // high-temp cohort allow-listed — the low cells are not OOS-validated.
    const lowEvent = { ...rangeEvent, metric: 'low' as const };
    const opp = findMispricedBrackets(lowEvent, forecastHrrr, 1, 0.0, {
      minModelCoverage: 0, yesAllowInteriorBrackets: false, yesMinMarketPrice: 0.30, yesMinModelProb: 0.50,
      calibrationShadowEnabled: true, calibrationLiveEnabled: true,
      calibrationLiveCohorts: 'YES|high|range|hrrr-combined', calibrationYesMinPrice: 0.15,
    }).opportunities[0]!;
    expect(opp.calibrationLive).toBe(false);          // low metric excluded from the high cohort
    expect(opp.blockedByCalibrationCohort).toBe(true);
    expect(opp.allowedByConfig).toBe(false);
    expect(opp.modelProbability).toBe(opp.modelProbCalibrated);
  });

  it('requires the selected calibrated side to be admitted', () => {
    _setCalibrationTableForTest({
      _meta: { generatedAt: '', scoredPairs: 9000, binCount: 10, priorStrength: 20, minCellSamples: 80, version: 1 },
      byShapeSourceHorizon: {},
      byShapeSource: { 'high|range|hrrr-combined': { n: 500, bins: Array(10).fill(0.20) } },
      byShape: {},
      byMetric: { high: { n: 9000, bins: Array.from({ length: 10 }, (_, i) => (i + 0.5) / 10) } },
    } as never);
    const noOpp = findMispricedBrackets(rangeEvent, forecastHrrr, 1, 0.0, {
      minModelCoverage: 0, yesAllowInteriorBrackets: false, yesMinMarketPrice: 0.30, yesMinModelProb: 0.50,
      calibrationShadowEnabled: true, calibrationLiveEnabled: true,
      calibrationLiveCohorts: 'NO|high|range|hrrr-combined', calibrationYesMinPrice: 0.15,
    }).opportunities[0]!;
    expect(noOpp.tradeSide).toBe('NO');
    expect(noOpp.calibrationLive).toBe(true);
    expect(noOpp.blockedByCalibrationCohort).toBe(false);
    expect(noOpp.allowedByConfig).toBe(true);
  });

  it('falls through to an admitted NO when an unadmitted tail YES has the larger edge', () => {
    _setCalibrationTableForTest({
      _meta: { generatedAt: '', scoredPairs: 9000, binCount: 10, priorStrength: 20, minCellSamples: 80, version: 1 },
      byShapeSourceHorizon: {},
      byShapeSource: { 'high|high_tail|hrrr-combined': { n: 500, bins: Array(10).fill(0.60) } },
      byShape: {},
      byMetric: { high: { n: 9000, bins: Array.from({ length: 10 }, (_, i) => (i + 0.5) / 10) } },
    } as never);
    const tailEvent = {
      ...rangeEvent,
      brackets: [{
        marketId: 'm-tail', conditionId: 'c-tail', clobTokenIds: ['ty-tail', 'tn-tail'],
        threshold: 0, low: 70, high: null, label: '70°F or higher',
        yesPrice: 0.20, noPrice: 0.15,
      }],
    };
    const opp = findMispricedBrackets(tailEvent, forecastHrrr, 1, 0.0, {
      minModelCoverage: 0,
      yesAllowInteriorBrackets: false,
      yesMinMarketPrice: 0.10,
      yesMinModelProb: 0.50,
      maxTailNoBetModelProb: 1,
      cityActuals: {
        highs: [60, 61, 62, 63, 64, 65, 66],
        unit: 'fahrenheit',
        sampleSize: 7,
        updatedAt: '2026-06-30T00:00:00Z',
      },
      calibrationShadowEnabled: true,
      calibrationLiveEnabled: true,
      calibrationLiveCohorts: 'NO|high|high_tail|hrrr-combined',
      calibrationYesMinPrice: 0.15,
    }).opportunities[0]!;

    expect(opp.tradeSide).toBe('NO');
    expect(opp.calibrationLive).toBe(true);
    expect(opp.blockedByCalibrationCohort).toBe(false);
    expect(opp.allowedByConfig).toBe(true);
  });

  it('falls through to an admitted YES when an unadmitted NO has the larger edge', () => {
    _setCalibrationTableForTest({
      _meta: { generatedAt: '', scoredPairs: 9000, binCount: 10, priorStrength: 20, minCellSamples: 80, version: 1 },
      byShapeSourceHorizon: {},
      byShapeSource: { 'high|range|hrrr-combined': { n: 500, bins: Array(10).fill(0.35) } },
      byShape: {},
      byMetric: { high: { n: 9000, bins: Array.from({ length: 10 }, (_, i) => (i + 0.5) / 10) } },
    } as never);
    const yesOnlyEvent = {
      ...rangeEvent,
      brackets: [{
        ...rangeEvent.brackets[0]!,
        yesPrice: 0.20,
        noPrice: 0.40,
      }],
    };
    const opp = findMispricedBrackets(yesOnlyEvent, forecastHrrr, 1, 0.0, {
      minModelCoverage: 0,
      yesAllowInteriorBrackets: false,
      yesMinMarketPrice: 0.30,
      yesMinModelProb: 0.50,
      calibrationShadowEnabled: true,
      calibrationLiveEnabled: true,
      calibrationLiveCohorts: 'YES|high|range|hrrr-combined',
      calibrationYesMinPrice: 0.15,
    }).opportunities[0]!;

    expect(opp.tradeSide).toBe('YES');
    expect(opp.edge).toBeCloseTo(0.15, 6);
    expect(opp.calibrationLive).toBe(true);
    expect(opp.blockedByCalibrationCohort).toBe(false);
    expect(opp.allowedByConfig).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findMispricedBrackets — tail NO base-rate gate
// ---------------------------------------------------------------------------

describe('findMispricedBrackets - tail NO base-rate gate', () => {
  // "25°C or higher" (low=25, high=null): high-tail bracket.
  // Forecast 22°C → modelProb ≈ 0.07 (model says NO). noPrice=0.10 gives strong
  // apparent edgeNo. But WU shows city hit ≥25°C 13/14 recent days (93%).
  const highTailEvent = {
    eventId: 'e-high-tail', slug: 'mexico-city', city: 'mexico city',
    coords: lookupCity('mexico city') ?? { lat: 19.43, lon: -99.13 },
    targetDate: '2026-05-20', unit: 'celsius' as const,
    brackets: [
      { marketId: 'm0', conditionId: 'c0', clobTokenIds: ['t0y', 't0n'],
        threshold: 0, low: 25, high: null, label: '25°C or higher',
        yesPrice: 0.88, noPrice: 0.10 },
    ],
    endDate: '2026-05-20T12:00:00Z',
  };
  const coldForecast = { forecastHigh: 22, stdDev: 3, source: 'combined' as const, ensembleMembers: 31 };

  const highYesActuals = {
    highs: [26, 25, 27, 25, 26, 25, 28, 25, 26, 27, 25, 26, 25, 22], // 13/14 ≥ 25
    unit: 'celsius',
    sampleSize: 14,
    updatedAt: '2026-05-20T00:00:00Z',
  };

  it('blocks high-tail NO when recent WU base rate ≥ threshold', () => {
    const { opportunities } = findMispricedBrackets(
      highTailEvent, coldForecast, 1, 0.0,
      { minModelCoverage: 0, cityActuals: highYesActuals, baseRateMinSamples: 7, baseRateNoBlockThreshold: 0.70 },
    );
    expect(opportunities.filter((o) => o.tradeSide === 'NO')).toHaveLength(0);
  });

  it('allows high-tail NO when base rate is below threshold', () => {
    const lowYesActuals = {
      highs: [22, 21, 20, 23, 22, 21, 20, 22, 21, 19, 22, 20, 21, 22], // 0/14 ≥ 25
      unit: 'celsius',
      sampleSize: 14,
      updatedAt: '2026-05-20T00:00:00Z',
    };
    const { opportunities } = findMispricedBrackets(
      highTailEvent, coldForecast, 1, 0.0,
      { minModelCoverage: 0, cityActuals: lowYesActuals, baseRateMinSamples: 7, baseRateNoBlockThreshold: 0.70 },
    );
    const noOpps = opportunities.filter((o) => o.tradeSide === 'NO');
    expect(noOpps.length).toBeGreaterThan(0);
  });

  it('fails CLOSED (blocks NO) when cityActuals is null (cache miss)', () => {
    const { opportunities } = findMispricedBrackets(
      highTailEvent, coldForecast, 1, 0.0,
      { minModelCoverage: 0, cityActuals: null, baseRateMinSamples: 7, baseRateNoBlockThreshold: 0.70 },
    );
    const noOpps = opportunities.filter((o) => o.tradeSide === 'NO');
    expect(noOpps.length).toBe(0);
  });

  it('fails open when sampleSize < baseRateMinSamples', () => {
    const thinActuals = {
      highs: [26, 25, 27], // 3/3 ≥ 25 but sample too thin
      unit: 'celsius',
      sampleSize: 3,
      updatedAt: '2026-05-20T00:00:00Z',
    };
    const { opportunities } = findMispricedBrackets(
      highTailEvent, coldForecast, 1, 0.0,
      { minModelCoverage: 0, cityActuals: thinActuals, baseRateMinSamples: 7, baseRateNoBlockThreshold: 0.70 },
    );
    const noOpps = opportunities.filter((o) => o.tradeSide === 'NO');
    expect(noOpps.length).toBeGreaterThan(0);
  });

  it('fails open when unit does not match event unit', () => {
    const wrongUnitActuals = {
      highs: [77, 79, 81, 77, 78, 79, 80, 77, 78, 79, 77, 79, 77, 80], // Fahrenheit values ≥ 25 trivially
      unit: 'fahrenheit', // event is celsius
      sampleSize: 14,
      updatedAt: '2026-05-20T00:00:00Z',
    };
    const { opportunities } = findMispricedBrackets(
      highTailEvent, coldForecast, 1, 0.0,
      { minModelCoverage: 0, cityActuals: wrongUnitActuals, baseRateMinSamples: 7, baseRateNoBlockThreshold: 0.70 },
    );
    const noOpps = opportunities.filter((o) => o.tradeSide === 'NO');
    expect(noOpps.length).toBeGreaterThan(0);
  });

  it('blocks low-tail NO when recent WU base rate of ≤ threshold is high', () => {
    // "39°F or below" (low=null, high=39). Forecast 52°F → modelProb near 0 → strong edgeNo.
    // But WU shows 13/14 days ≤ 39°F → gate blocks it.
    const lowTailEvent = {
      eventId: 'e-low-tail', slug: 'low-tail', city: 'chicago',
      coords: lookupCity('chicago')!,
      targetDate: '2026-04-14', unit: 'fahrenheit' as const,
      brackets: [
        { marketId: 'm0', conditionId: 'c0', clobTokenIds: ['t0y', 't0n'],
          threshold: 0, low: null, high: 39, label: '39°F or below',
          yesPrice: 0.88, noPrice: 0.10 },
      ],
      endDate: '2026-04-14T12:00:00Z',
    };
    const warmForecast = { forecastHigh: 52, stdDev: 3, source: 'noaa' as const, ensembleMembers: 0 };
    const coldActuals = {
      highs: [35, 37, 38, 36, 39, 35, 37, 38, 36, 35, 38, 37, 36, 52], // 13/14 ≤ 39
      unit: 'fahrenheit',
      sampleSize: 14,
      updatedAt: '2026-04-14T00:00:00Z',
    };
    const { opportunities } = findMispricedBrackets(
      lowTailEvent, warmForecast, 1, 0.0,
      { minModelCoverage: 0, cityActuals: coldActuals, baseRateMinSamples: 7, baseRateNoBlockThreshold: 0.70 },
    );
    expect(opportunities.filter((o) => o.tradeSide === 'NO')).toHaveLength(0);
  });

  it('does not block interior bracket NO bets via base-rate gate', () => {
    // Interior bracket (low=20, high=25). Base-rate gate is tail-only.
    // Forecast 28°C → rounds to 28, NOT inside [20, 25] → rounding gate does not fire.
    // modelProb for [20-25] at 28°C is near 0; noPrice=0.05 → edgeNo≈0.95 → tradeSide=NO.
    const interiorEvent = {
      eventId: 'e-interior', slug: 'interior', city: 'chicago',
      coords: lookupCity('chicago')!,
      targetDate: '2026-04-14', unit: 'celsius' as const,
      brackets: [
        { marketId: 'm0', conditionId: 'c0', clobTokenIds: ['t0y', 't0n'],
          threshold: 0, low: 20, high: 25, label: '20-25°C',
          yesPrice: 0.90, noPrice: 0.05 },
      ],
      endDate: '2026-04-14T12:00:00Z',
    };
    const forecast = { forecastHigh: 28, stdDev: 0.5, source: 'combined' as const, ensembleMembers: 31 };
    const { opportunities } = findMispricedBrackets(
      interiorEvent, forecast, 1, 0.0,
      { minModelCoverage: 0, cityActuals: highYesActuals, baseRateMinSamples: 7, baseRateNoBlockThreshold: 0.70 },
    );
    const noOpps = opportunities.filter((o) => o.tradeSide === 'NO');
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

  it('bias disabled → forecastHigh unchanged, meanShiftApplied=false on result and opps', () => {
    const cityBias = { meanBias: 2.0, empiricalStddev: 2.5, meanShiftHelpful: true, sampleSize: 20, updatedAt: '' };
    const result = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.01,
      { minModelCoverage: 0, cityBias, biasCorrectionEnabled: false },
    );
    expect(result.meanShiftApplied).toBe(false);
    for (const opp of result.opportunities) {
      expect(opp.meanShiftApplied).toBe(false);
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
    expect(result.meanShiftApplied).toBe(true);
    expect(result.opportunities.length).toBeGreaterThan(0);
    for (const opp of result.opportunities) {
      expect(opp.meanShiftApplied).toBe(true);
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
    expect(result.meanShiftApplied).toBe(true);
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
    expect(result.meanShiftApplied).toBe(false);
    for (const opp of result.opportunities) {
      expect(opp.correctedForecastHigh).toBeCloseTo(52, 4);
      expect(opp.effectiveStdDev).toBeCloseTo(5.0, 5);
    }
  });

  it('bias enabled + sampleSize < threshold → correction not applied, result.meanShiftApplied=false', () => {
    const cityBias = { meanBias: 2.0, empiricalStddev: 2.5, sampleSize: 10, updatedAt: '' };
    const result = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.01,
      { minModelCoverage: 0, cityBias, biasCorrectionEnabled: true, biasMinSamples: 14 }, // sampleSize=10 < 14 → no correction
    );
    expect(result.meanShiftApplied).toBe(false);
    for (const opp of result.opportunities) {
      expect(opp.meanShiftApplied).toBe(false);
      expect(opp.correctedForecastHigh).toBeCloseTo(opp.rawForecastHigh, 5);
    }
  });

  it('result.meanShiftApplied=true even when no brackets clear minEdge', () => {
    // High minEdge so no brackets pass, but bias was still applied internally
    const cityBias = { meanBias: 2.0, empiricalStddev: 2.5, meanShiftHelpful: true, sampleSize: 20, updatedAt: '' };
    const result = findMispricedBrackets(
      biasEvent, biasBaseForecast, 1, 0.99,
      { minModelCoverage: 0, cityBias, biasCorrectionEnabled: true },
    );
    expect(result.opportunities).toHaveLength(0);
    expect(result.meanShiftApplied).toBe(true); // was applied even though no opps returned
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
    expect(opp.meanShiftApplied).toBe(true);
    expect(opp.biasMode).toBe('full');
    expect(opp.effectiveStdDev).toBeCloseTo(3, 5); // max(3, 2.5) = 3
  });

  // ── Weak-band (min ≤ sampleSize < trusted): widen σ, no mean shift ────────
  it('weak-band → mean NOT shifted, meanShiftApplied=false, biasMode=weak', () => {
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
    expect(result.meanShiftApplied).toBe(false);
    expect(result.opportunities.length).toBeGreaterThan(0);
    for (const opp of result.opportunities) {
      expect(opp.meanShiftApplied).toBe(false);
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
    expect(result.meanShiftApplied).toBe(true);
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
    expect(result.meanShiftApplied).toBe(false);
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
    expect(opp.meanShiftApplied).toBe(false);
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
    expect(result.meanShiftApplied).toBe(false);
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
      0, // retryCount default when no opts passed
      'high', // metric — high-temperature event
    );
    expect(mockFetchEnsemble).toHaveBeenNthCalledWith(
      2,
      londonCoords!.lat,
      londonCoords!.lon,
      '2026-04-20',
      'celsius',
      undefined,
      true,
      0,
      'high', // metric — shadow ensemble keeps the same metric
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
      0, // retryCount default when no opts passed
      'high', // metric — high-temperature event
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
      0, // retryCount default when no opts passed
      'high', // metric — high-temperature event
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
// fetchForecast — cross-source spread gate
// ---------------------------------------------------------------------------

describe('fetchForecast - cross-source spread gate', () => {
  function makeUsEvent(city: string, targetDate: string) {
    const coords = lookupCity(city);
    expect(coords).not.toBeNull();
    return {
      eventId: `${city}-spread-test`,
      slug: `${city}-spread-test`,
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

  it('returns null when spread exceeds maxCrossSourceSpread (HRRR outlier)', async () => {
    // NOAA=70°F, OM=72°F, HRRR=10°F (garbage) → spread=62 > 15
    const mockEvent = makeUsEvent('chicago', '2026-04-20');
    mockFetchNwsForecast.mockResolvedValueOnce({ highF: 70, lowF: 55, forecastDate: '2026-04-20' });
    mockFetchOpenMeteo.mockResolvedValueOnce({ highTemp: 72, lowTemp: 57, precipProbability: 20, forecastDate: '2026-04-20' });
    mockFetchHrrr.mockResolvedValueOnce({ highTemp: 10, lowTemp: 5, precipProbability: 0, forecastDate: '2026-04-20' });

    const result = await fetchForecast(mockEvent, 1, undefined, 0.7, false, true, false, 15);
    expect(result).toBeNull();
  });

  it('returns forecast when spread is within maxCrossSourceSpread', async () => {
    // NOAA=70°F, OM=72°F, HRRR=74°F → spread=4 ≤ 15
    const mockEvent = makeUsEvent('chicago', '2026-04-20');
    mockFetchNwsForecast.mockResolvedValueOnce({ highF: 70, lowF: 55, forecastDate: '2026-04-20' });
    mockFetchOpenMeteo.mockResolvedValueOnce({ highTemp: 72, lowTemp: 57, precipProbability: 20, forecastDate: '2026-04-20' });
    mockFetchHrrr.mockResolvedValueOnce({ highTemp: 74, lowTemp: 58, precipProbability: 18, forecastDate: '2026-04-20' });

    const result = await fetchForecast(mockEvent, 1, undefined, 0.7, false, true, false, 15);
    expect(result).not.toBeNull();
    expect(result!.forecastHigh).toBeCloseTo(72, 1);
    expect(result!.source).toBe('hrrr-combined');
  });

  it('spread gate disabled when no maxCrossSourceSpread passed (Infinity default)', async () => {
    // Default maxCrossSourceSpread=Infinity: gate is inactive regardless of HRRR value
    const mockEvent = makeUsEvent('chicago', '2026-04-20');
    mockFetchNwsForecast.mockResolvedValueOnce({ highF: 70, lowF: 55, forecastDate: '2026-04-20' });
    mockFetchOpenMeteo.mockResolvedValueOnce({ highTemp: 72, lowTemp: 57, precipProbability: 20, forecastDate: '2026-04-20' });
    mockFetchHrrr.mockResolvedValueOnce({ highTemp: 74, lowTemp: 58, precipProbability: 18, forecastDate: '2026-04-20' });

    const result = await fetchForecast(mockEvent, 1, undefined, 0.7, false, true, false);
    expect(result).not.toBeNull();
    expect(result!.forecastHigh).toBeCloseTo(72, 1); // (70+72+74)/3
  });

  it('spread gate not applied when HRRR is null (NOAA+OM only path)', async () => {
    // Gate is HRRR-specific — skipped entirely when HRRR did not contribute
    const mockEvent = makeUsEvent('chicago', '2026-04-20');
    mockFetchNwsForecast.mockResolvedValueOnce({ highF: 70, lowF: 55, forecastDate: '2026-04-20' });
    mockFetchOpenMeteo.mockResolvedValueOnce({ highTemp: 72, lowTemp: 57, precipProbability: 20, forecastDate: '2026-04-20' });
    mockFetchHrrr.mockResolvedValueOnce(null);

    const result = await fetchForecast(mockEvent, 1, undefined, 0.7, false, true, false, 15);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('combined');
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

  it('stamps every weather_bracket shadow row with a side-consistent strategy family (PR1)', async () => {
    const gammaEvent = makeMockGammaEvent();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([gammaEvent]),
    }) as unknown as typeof fetch;
    mockFetchNwsForecast.mockResolvedValue({
      highF: 52, lowF: 38, precipProbability: 10, forecastDate: targetIso, shortForecast: 'Mostly Cloudy',
    });
    mockFetchOpenMeteo.mockResolvedValue({ highTemp: 52, lowTemp: 38, precipProbability: 10, forecastDate: targetIso });
    mockFetchEnsemble.mockResolvedValue({
      meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8, memberCount: 31, forecastDate: targetIso,
    });

    await scanWeatherMarkets(redisMock as never);

    const YES_FAMILIES = ['tail_yes', 'interior_yes'];
    const NO_FAMILIES = [
      'native_no', 'yes_gated_fallback_no', 'far_no_ladder',
      'adjacent_no_ladder', 'resday_lockin_no', 'market_favorite_fade',
    ];
    const bracketWrites = mockEnqueueWrite.mock.calls
      .filter((c) => c[0] === 'shadow_observations' && (c[1] as { kind?: string }).kind === 'weather_bracket')
      .map((c) => (c[1] as { payload: {
        tradeSide: 'YES' | 'NO'; strategyFamily: string | null; selectedBy: string | null; modalDisagreement: boolean;
      } }).payload);

    expect(bracketWrites.length).toBeGreaterThan(0);
    for (const p of bracketWrites) {
      // Exactly one family, consistent with the traded side.
      expect(p.strategyFamily).not.toBeNull();
      if (p.tradeSide === 'YES') {
        expect(YES_FAMILIES).toContain(p.strategyFamily);
      } else {
        expect(NO_FAMILIES).toContain(p.strategyFamily);
      }
      // selectedBy and the disagreement tag are always populated.
      expect(['raw_edge', 'calibrated_edge', 'ladder_bid', 'lockin']).toContain(p.selectedBy);
      expect(typeof p.modalDisagreement).toBe('boolean');
    }
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

    // Seed actuals with all highs well below the 58°F threshold (0% YES rate)
    // so the base-rate fail-closed gate passes, and the adverseMove gate can fire.
    redisMock._store.set(
      'weather:actuals:chicago',
      JSON.stringify({ highs: Array(14).fill(50), unit: 'fahrenheit', sampleSize: 14, updatedAt: new Date().toISOString() }),
    );

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

    // Adverse repricing: NO price moved UP from 0.40 → 0.55 (+0.15 ≥ MIN_ADVERSE_MOVE=0.10)
    // while model win-probability barely changed. Model computes P(NO for "≥58°F" | forecast=52°F,
    // σ=3.2) ≈ 0.957 via normalCdf((57.5-52)/3.2). Prior=0.95 → improvement≈0.007 ≤ 0.03.
    redisMock._store.set(
      'weather:market_state:m10:NO',
      JSON.stringify({
        tradeSide: 'NO',
        outcomePrice: 0.40,
        winProbability: 0.95,
        observedAt: new Date().toISOString(),
      }),
    );

    const results = await scanWeatherMarkets(redisMock as never);
    const blocked = results.find((o) => o.marketId === 'm10');
    expect(blocked).toBeDefined();
    expect(blocked!.blockedByMarketDisagreement).toBe(true);
    expect(blocked!.previousOutcomePrice).toBe(0.40);
    expect(blocked!.previousWinProbability).toBe(0.95);
  });

  it('sets blockedByEnsembleVeto when ECMWF shadow sees no edge and veto is enabled', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: true,
      WEATHER_DUAL_ENSEMBLE_VETO_ENABLED: true,
    });

    const gammaEvent = makeMockGammaEvent();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([gammaEvent]),
    }) as unknown as typeof fetch;

    // Forecast: 52°F — GFS sees a YES edge on the 52-53°F bracket (market=0.12, modelProb≈0.25).
    mockFetchNwsForecast.mockResolvedValue({ highF: 52, lowF: 38, precipProbability: 10, forecastDate: targetIso, shortForecast: 'Sunny' });
    mockFetchOpenMeteo.mockResolvedValue({ highTemp: 52, lowTemp: 38, precipProbability: 10, forecastDate: targetIso });

    // GFS: stddev 3.2 → P(52-53°F) ≈ 0.25 → edge on YES ≈ 0.13
    // ECMWF shadow: stddev 8.0 (very wide) → P(52-53°F) collapses, shadow edge goes negative
    mockFetchEnsemble
      .mockResolvedValueOnce({ meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8, memberCount: 31, forecastDate: targetIso, ensembleModel: 'gfs' })
      .mockResolvedValueOnce({ meanHigh: 52, stddevHigh: 8.0, meanLow: 38, stddevLow: 5.0, memberCount: 51, forecastDate: targetIso, ensembleModel: 'ecmwf' });

    const results = await scanWeatherMarkets(redisMock as never);
    // The 52-53°F bracket should have positive GFS edge but ECMWF vetoes it
    const vetoed = results.find((o) => o.bracketLabel === '52-53°F');
    expect(vetoed).toBeDefined();
    expect(vetoed!.shadowEdge).toBeDefined();
    expect(vetoed!.shadowEdge!).toBeLessThanOrEqual(0);
    expect(vetoed!.blockedByEnsembleVeto).toBe(true);
  });

  it('does not set blockedByEnsembleVeto when ECMWF also sees positive edge', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: true,
      WEATHER_DUAL_ENSEMBLE_VETO_ENABLED: true,
    });

    const gammaEvent = makeMockGammaEvent();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([gammaEvent]),
    }) as unknown as typeof fetch;

    mockFetchNwsForecast.mockResolvedValue({ highF: 52, lowF: 38, precipProbability: 10, forecastDate: targetIso, shortForecast: 'Sunny' });
    mockFetchOpenMeteo.mockResolvedValue({ highTemp: 52, lowTemp: 38, precipProbability: 10, forecastDate: targetIso });

    // Both GFS and ECMWF agree: stddev ≈ 3, forecast 52°F → P(52-53°F) ≈ 0.25 → positive edge
    mockFetchEnsemble
      .mockResolvedValueOnce({ meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8, memberCount: 31, forecastDate: targetIso, ensembleModel: 'gfs' })
      .mockResolvedValueOnce({ meanHigh: 52, stddevHigh: 3.0, meanLow: 38, stddevLow: 2.5, memberCount: 51, forecastDate: targetIso, ensembleModel: 'ecmwf' });

    const results = await scanWeatherMarkets(redisMock as never);
    const bracket = results.find((o) => o.bracketLabel === '52-53°F');
    expect(bracket).toBeDefined();
    expect(bracket!.shadowEdge!).toBeGreaterThan(0);
    expect(bracket!.blockedByEnsembleVeto).toBe(false);
  });

  it('does not veto when WEATHER_DUAL_ENSEMBLE_VETO_ENABLED is false even if ECMWF edge is negative', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: true,
      WEATHER_DUAL_ENSEMBLE_VETO_ENABLED: false,
    });

    const gammaEvent = makeMockGammaEvent();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([gammaEvent]),
    }) as unknown as typeof fetch;

    mockFetchNwsForecast.mockResolvedValue({ highF: 52, lowF: 38, precipProbability: 10, forecastDate: targetIso, shortForecast: 'Sunny' });
    mockFetchOpenMeteo.mockResolvedValue({ highTemp: 52, lowTemp: 38, precipProbability: 10, forecastDate: targetIso });

    // GFS sees edge; ECMWF wide stddev → negative shadow edge — but veto flag is off
    mockFetchEnsemble
      .mockResolvedValueOnce({ meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8, memberCount: 31, forecastDate: targetIso, ensembleModel: 'gfs' })
      .mockResolvedValueOnce({ meanHigh: 52, stddevHigh: 8.0, meanLow: 38, stddevLow: 5.0, memberCount: 51, forecastDate: targetIso, ensembleModel: 'ecmwf' });

    const results = await scanWeatherMarkets(redisMock as never);
    const bracket = results.find((o) => o.bracketLabel === '52-53°F');
    expect(bracket).toBeDefined();
    expect(bracket!.blockedByEnsembleVeto).toBe(false);
  });

  it('veto fires when ECMWF is primary and GFS shadow sees no edge (roles swapped)', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_MODEL_ECMWF_ENABLED: true,
      WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: true,
      WEATHER_DUAL_ENSEMBLE_VETO_ENABLED: true,
    });

    const gammaEvent = makeMockGammaEvent();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([gammaEvent]),
    }) as unknown as typeof fetch;

    mockFetchNwsForecast.mockResolvedValue({ highF: 52, lowF: 38, precipProbability: 10, forecastDate: targetIso, shortForecast: 'Sunny' });
    mockFetchOpenMeteo.mockResolvedValue({ highTemp: 52, lowTemp: 38, precipProbability: 10, forecastDate: targetIso });

    // ECMWF primary (tight stddev → positive edge); GFS shadow (wide stddev → edge collapses)
    mockFetchEnsemble
      .mockResolvedValueOnce({ meanHigh: 52, stddevHigh: 3.0, meanLow: 38, stddevLow: 2.5, memberCount: 51, forecastDate: targetIso, ensembleModel: 'ecmwf' })
      .mockResolvedValueOnce({ meanHigh: 52, stddevHigh: 8.0, meanLow: 38, stddevLow: 5.0, memberCount: 31, forecastDate: targetIso, ensembleModel: 'gfs' });

    const results = await scanWeatherMarkets(redisMock as never);
    const bracket = results.find((o) => o.bracketLabel === '52-53°F');
    expect(bracket).toBeDefined();
    // Shadow is GFS (roles swapped: ECMWF primary, GFS shadow)
    expect(bracket!.shadowEnsembleModel).toBe('gfs');
    expect(bracket!.shadowEdge!).toBeLessThanOrEqual(0);
    expect(bracket!.blockedByEnsembleVeto).toBe(true);
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
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob', governorStamped: true, entryPrice: 0.9, sharesFilled: 10,
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

    it('shadow-logs but does NOT execute an interior NO blocked by the coin-flip margin veto', async () => {
      // Same config as the passing "executes correctly" test — only the prices change.
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
      });
      // Forecast 52°F. Make "52-53°F" (idx 7) a NO bet (high yesPrice) — round(52)=52
      // ∈ [52,53] → interior-margin veto → biggest raw edge (~0.66) but shadow-only.
      // "54-55°F" (idx 8) stays a genuine YES. With WEATHER_MAX_PER_CITY=1, WITHOUT
      // the veto the 52-53 NO would be the #1 execution; the veto must drop it so the
      // single Chicago trade is 54-55 instead — proving the block excludes execution.
      const yesPrices = [0.01, 0.03, 0.05, 0.10, 0.15, 0.20, 0.18, 0.90, 0.08, 0.05, 0.03];
      wireMockGammaAndForecast(yesPrices);
      mockGetBankroll.mockResolvedValue(1000);
      mockExecuteAndRecordSignal.mockResolvedValue({
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob', governorStamped: true, entryPrice: 0.9, sharesFilled: 10,
      });

      await runWeatherScan(redisMock as never);

      const executedQuestions = mockExecuteAndRecordSignal.mock.calls.map(
        (c) => (c[0] as { question: string }).question,
      );
      expect(executedQuestions.length).toBeGreaterThan(0);                  // the scan does execute a trade…
      expect(executedQuestions.some((q) => /52-53°F/.test(q))).toBe(false); // …but never the vetoed coin-flip
      expect(executedQuestions.some((q) => /54-55°F/.test(q))).toBe(true);  // it's the next, un-vetoed bracket
    });

    it('does NOT execute a NO on a bracket the market prices as the favorite (market-favorite veto)', async () => {
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
        WEATHER_MARKET_FAVORITE_NO_VETO_ENABLED: true,
        WEATHER_MARKET_FAVORITE_NO_MAX_YESPRICE: 0.85,
      });
      // Forecast 52°F. "40-41°F" (idx 1) is far below → model ~0 → a NO with a huge raw
      // edge (~0.90) at yesPrice 0.90. With WEATHER_MAX_PER_CITY=1 that NO would be the
      // #1 execution — but the market prices the bracket at 0.90 (≥0.85), so the
      // market-favorite veto must drop it and a different bracket trades instead.
      const yesPrices = [0.05, 0.90, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05];
      wireMockGammaAndForecast(yesPrices);
      mockGetBankroll.mockResolvedValue(1000);
      mockExecuteAndRecordSignal.mockResolvedValue({
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob', governorStamped: true, entryPrice: 0.9, sharesFilled: 10,
      });

      await runWeatherScan(redisMock as never);

      const executedQuestions = mockExecuteAndRecordSignal.mock.calls.map(
        (c) => (c[0] as { question: string }).question,
      );
      expect(executedQuestions.length).toBeGreaterThan(0);                  // the scan still trades…
      expect(executedQuestions.some((q) => /40-41°F/.test(q))).toBe(false); // …but never the market-favorite NO
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
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob', governorStamped: true,
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
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob', governorStamped: true,
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
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob', governorStamped: true,
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

    it('does NOT set the active-event marker for a maker_pending placement (preserves cross-scan retry)', async () => {
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
      });
      wireMockGammaAndForecast();
      mockGetBankroll.mockResolvedValue(1000);
      // A fresh maker GTC: governor stamped on acceptance, but not yet a position.
      mockExecuteAndRecordSignal.mockResolvedValue({
        signal: { stakeUsd: 5 } as never,
        skipped: false,
        executionVenue: 'clob',
        entryExecutionPath: 'maker_pending',
        governorStamped: true,
      });

      await runWeatherScan(redisMock as never);

      expect(mockExecuteAndRecordSignal).toHaveBeenCalled();
      const activeEventSets = redisMock.set.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].startsWith('weather:active_event:'),
      );
      expect(activeEventSets).toHaveLength(0);
    });

    it('sets the active-event marker for a confirmed fill', async () => {
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
      });
      wireMockGammaAndForecast();
      mockGetBankroll.mockResolvedValue(1000);
      mockExecuteAndRecordSignal.mockResolvedValue({
        signal: { stakeUsd: 5 } as never,
        skipped: false,
        executionVenue: 'clob',
        entryExecutionPath: 'clob_direct',
        entryPrice: 0.9,
        sharesFilled: 10,
        governorStamped: true,
      });

      await runWeatherScan(redisMock as never);

      expect(mockExecuteAndRecordSignal).toHaveBeenCalled();
      const activeEventSets = redisMock.set.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].startsWith('weather:active_event:'),
      );
      expect(activeEventSets.length).toBeGreaterThanOrEqual(1);
    });

    it('sets the active-event marker for a fill that lands on a resume cycle (governorStamped=false)', async () => {
      // A maker GTC posted on an earlier scan that FILLS on this resume cycle:
      // the executor does not re-stamp the governor (governorStamped=false), but
      // it is a real position now, so the marker must still be set.
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
      });
      wireMockGammaAndForecast();
      mockGetBankroll.mockResolvedValue(1000);
      mockExecuteAndRecordSignal.mockResolvedValue({
        signal: { stakeUsd: 5 } as never,
        skipped: false,
        executionVenue: 'clob',
        entryExecutionPath: 'maker_fill',
        entryPrice: 0.9,
        sharesFilled: 10,
        governorStamped: false,
      });

      await runWeatherScan(redisMock as never);

      expect(mockExecuteAndRecordSignal).toHaveBeenCalled();
      const activeEventSets = redisMock.set.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].startsWith('weather:active_event:'),
      );
      expect(activeEventSets.length).toBeGreaterThanOrEqual(1);
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
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob', governorStamped: true, entryPrice: 0.9, sharesFilled: 10,
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
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob', governorStamped: true, entryPrice: 0.9, sharesFilled: 10,
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
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob', governorStamped: true, entryPrice: 0.9, sharesFilled: 10,
      });

      await runWeatherScan(redisMock as never);

      expect(mockExecuteAndRecordSignal).toHaveBeenCalled();
    });

    it('res-day-only gate blocks off-day (non-resolution-day) opportunities', async () => {
      // Default fixture targets ~2 days out → isResolutionDay=false. With the gate ON
      // and the lookahead gate wide open (72h), the ONLY thing that can suppress
      // execution is the res-day-only gate.
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
        WEATHER_MAX_LOOKAHEAD_HOURS: 72,
        WEATHER_RES_DAY_ENTRY_ONLY: true,
      });
      wireMockGammaAndForecast();
      mockGetBankroll.mockResolvedValue(1000);
      mockExecuteAndRecordSignal.mockResolvedValue({
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob', governorStamped: true, entryPrice: 0.9, sharesFilled: 10,
      });

      await runWeatherScan(redisMock as never);

      expect(mockExecuteAndRecordSignal).not.toHaveBeenCalled();
    });

    it('res-day-only gate marks off-day shadow rows blockedByResDayOnly + wouldTrade=false', async () => {
      // The shadow stream must reflect the active config: with the gate ON, an off-day
      // bracket that the model would otherwise trade must record wouldTrade=false,
      // wouldBlock=true and blockedByResDayOnly=true — not overstate tradability.
      // featureLive is true (scanner+execution enabled) so wouldTrade would be true here
      // if the gate did not flip it.
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
        WEATHER_MAX_LOOKAHEAD_HOURS: 72,
        WEATHER_RES_DAY_ENTRY_ONLY: true,
      });
      wireMockGammaAndForecast();
      mockGetBankroll.mockResolvedValue(1000);
      mockExecuteAndRecordSignal.mockResolvedValue({
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob', governorStamped: true, entryPrice: 0.9, sharesFilled: 10,
      });

      await runWeatherScan(redisMock as never);

      const bracketWrites = mockEnqueueWrite.mock.calls
        .filter((c) => c[0] === 'shadow_observations' && (c[1] as { kind?: string }).kind === 'weather_bracket')
        .map((c) => c[1] as { wouldBlock: boolean; payload: { wouldTrade: boolean; blockedByResDayOnly: boolean } });
      expect(bracketWrites.length).toBeGreaterThan(0);
      for (const w of bracketWrites) {
        expect(w.payload.blockedByResDayOnly).toBe(true);
        expect(w.payload.wouldTrade).toBe(false);
        expect(w.wouldBlock).toBe(true);
      }
    });

    it('res-day-only gate OFF leaves the same off-day opportunity tradable', async () => {
      // Identical ~2-day-out fixture with the gate explicitly OFF: the off-day opp still
      // executes, proving the block above is the gate itself, not the fixture.
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
        WEATHER_MAX_LOOKAHEAD_HOURS: 72,
        WEATHER_RES_DAY_ENTRY_ONLY: false,
      });
      wireMockGammaAndForecast();
      mockGetBankroll.mockResolvedValue(1000);
      mockExecuteAndRecordSignal.mockResolvedValue({
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob', governorStamped: true, entryPrice: 0.9, sharesFilled: 10,
      });

      await runWeatherScan(redisMock as never);

      expect(mockExecuteAndRecordSignal).toHaveBeenCalled();
    });
  });

  // ── full-bracket shadow census (PR2) ─────────────────────────────────────
  describe('full-bracket shadow snapshots (WEATHER_FULL_BRACKET_SHADOW_ENABLED)', () => {
    function wireFull(): void {
      const evt = makeMockGammaEvent();
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve([evt]),
      }) as unknown as typeof fetch;
      // Tight forecast around 52F: the modal bracket becomes an opportunity while
      // far tail brackets skip (cityActuals is null in tests → tail_no_actuals_absent),
      // so both wasSkipped populations are exercised.
      mockFetchNwsForecast.mockResolvedValue({ highF: 52, lowF: 38, precipProbability: 10, forecastDate: targetIso, shortForecast: 'Cloudy' });
      mockFetchOpenMeteo.mockResolvedValue({ highTemp: 52, lowTemp: 38, precipProbability: 10, forecastDate: targetIso });
      mockFetchEnsemble.mockResolvedValue({ meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8, memberCount: 31, forecastDate: targetIso });
    }
    function fullRows(): { payload: Record<string, unknown> }[] {
      return mockEnqueueWrite.mock.calls
        .filter((c) => c[0] === 'shadow_observations' && (c[1] as { kind?: string }).kind === 'weather_bracket_full')
        .map((c) => c[1] as { payload: Record<string, unknown> });
    }
    function bracketRowCount(): number {
      return mockEnqueueWrite.mock.calls
        .filter((c) => c[0] === 'shadow_observations' && (c[1] as { kind?: string }).kind === 'weather_bracket').length;
    }

    it('writes NO weather_bracket_full rows when the flag is off', async () => {
      mockLoadConfig.mockReturnValue({ ...baseConfig, WEATHER_SCANNER_ENABLED: true, WEATHER_FULL_BRACKET_SHADOW_ENABLED: false });
      wireFull();
      await scanWeatherMarkets(redisMock as never);
      expect(fullRows()).toHaveLength(0);
    });

    it('writes exactly one full row per bracket (opportunities + skipped) when on', async () => {
      mockLoadConfig.mockReturnValue({ ...baseConfig, WEATHER_SCANNER_ENABLED: true, WEATHER_FULL_BRACKET_SHADOW_ENABLED: true });
      wireFull();
      await scanWeatherMarkets(redisMock as never);
      const rows = fullRows();
      // fixture has 11 brackets; every bracket is either an opportunity or skipped.
      expect(rows).toHaveLength(11);
      const opps = rows.filter((r) => r.payload.wasSkipped === false);
      const skipped = rows.filter((r) => r.payload.wasSkipped === true);
      expect(opps.length).toBeGreaterThan(0);
      expect(skipped.length).toBeGreaterThan(0);
      expect(opps.length + skipped.length).toBe(11);
    });

    it('carries numeric both-side edges on every full row', async () => {
      mockLoadConfig.mockReturnValue({ ...baseConfig, WEATHER_SCANNER_ENABLED: true, WEATHER_FULL_BRACKET_SHADOW_ENABLED: true });
      wireFull();
      await scanWeatherMarkets(redisMock as never);
      const rows = fullRows();
      expect(rows.length).toBeGreaterThan(0);
      for (const { payload: p } of rows) {
        expect(Number.isFinite(p.edgeYes as number)).toBe(true);
        expect(Number.isFinite(p.edgeNo as number)).toBe(true);
      }
    });

    it('carries a numeric forecastDistance on every full row, including non-ladder opportunities', async () => {
      mockLoadConfig.mockReturnValue({ ...baseConfig, WEATHER_SCANNER_ENABLED: true, WEATHER_FULL_BRACKET_SHADOW_ENABLED: true });
      wireFull();
      await scanWeatherMarkets(redisMock as never);
      const rows = fullRows();
      expect(rows.length).toBeGreaterThan(0);
      for (const { payload: p } of rows) {
        expect(Number.isFinite(p.forecastDistance as number)).toBe(true);
      }
      // The regressed case: non-ladder opportunity rows (farNoLadderQualifies=false,
      // wasSkipped=false) previously read opp.farNoDistance (ladder-only) → null.
      const nonLadderOpps = rows.filter((r) => r.payload.wasSkipped === false && r.payload.farNoLadderQualifies === false);
      expect(nonLadderOpps.length).toBeGreaterThan(0);
      for (const { payload: p } of nonLadderOpps) {
        expect(typeof p.forecastDistance).toBe('number');
      }
    });

    it('skipped rows set wasSkipped=true + a terminalSkipReason; opportunity rows set neither', async () => {
      mockLoadConfig.mockReturnValue({ ...baseConfig, WEATHER_SCANNER_ENABLED: true, WEATHER_FULL_BRACKET_SHADOW_ENABLED: true });
      wireFull();
      await scanWeatherMarkets(redisMock as never);
      const rows = fullRows();
      for (const { payload: p } of rows) {
        if (p.wasSkipped === true) {
          expect(typeof p.terminalSkipReason).toBe('string');
          expect(p.terminalSkipReason).toBeTruthy();
        } else {
          expect(p.terminalSkipReason).toBeNull();
          expect(typeof p.wouldTrade).toBe('boolean');
          expect(typeof p.proposedEntryPrice).toBe('number');
        }
      }
    });

    it('leaves the legacy weather_bracket population unchanged whether the flag is on or off', async () => {
      mockLoadConfig.mockReturnValue({ ...baseConfig, WEATHER_SCANNER_ENABLED: true, WEATHER_FULL_BRACKET_SHADOW_ENABLED: false });
      wireFull();
      await scanWeatherMarkets(redisMock as never);
      const countOff = bracketRowCount();

      vi.clearAllMocks();
      redisMock = createRedisMock();
      mockLoadConfig.mockReturnValue({ ...baseConfig, WEATHER_SCANNER_ENABLED: true, WEATHER_FULL_BRACKET_SHADOW_ENABLED: true });
      wireFull();
      await scanWeatherMarkets(redisMock as never);
      const countOn = bracketRowCount();

      expect(countOn).toBe(countOff);
      expect(countOff).toBeGreaterThan(0);
    });
  });

  // ── proven-loser cohort blocks (entry-backtest driven) ───────────────────
  describe('proven-loser cohort blocks (WEATHER_BLOCKED_STRATEGY_FAMILIES / WEATHER_NO_MAX_EDGE)', () => {
    function wire(): void {
      const evt = makeMockGammaEvent();
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([evt]) }) as unknown as typeof fetch;
      mockFetchNwsForecast.mockResolvedValue({ highF: 52, lowF: 38, precipProbability: 10, forecastDate: targetIso, shortForecast: 'Cloudy' });
      mockFetchOpenMeteo.mockResolvedValue({ highTemp: 52, lowTemp: 38, precipProbability: 10, forecastDate: targetIso });
      mockFetchEnsemble.mockResolvedValue({ meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8, memberCount: 31, forecastDate: targetIso });
    }
    function bracketRows(): { direction: string; wouldBlock: boolean; metricValue: number; payload: Record<string, unknown> }[] {
      return mockEnqueueWrite.mock.calls
        .filter((c) => c[0] === 'shadow_observations' && (c[1] as { kind?: string }).kind === 'weather_bracket')
        .map((c) => c[1] as { direction: string; wouldBlock: boolean; metricValue: number; payload: Record<string, unknown> });
    }

    it('default config blocks nothing (regression: flags false on every row)', async () => {
      mockLoadConfig.mockReturnValue({ ...baseConfig, WEATHER_SCANNER_ENABLED: true });
      wire();
      await scanWeatherMarkets(redisMock as never);
      const rows = bracketRows();
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.payload.blockedByFamilyBlock).toBe(false);
        expect(r.payload.blockedByHighNoEdge).toBe(false);
      }
    });

    it('a listed family is shadow-flagged + not traded; blocking every family stops execution', async () => {
      // native_no listed → those rows are flagged blocked and would not trade.
      mockLoadConfig.mockReturnValue({ ...baseConfig, WEATHER_SCANNER_ENABLED: true, WEATHER_BLOCKED_STRATEGY_FAMILIES: 'native_no' });
      wire();
      await scanWeatherMarkets(redisMock as never);
      const nativeNo = bracketRows().filter((r) => r.payload.strategyFamily === 'native_no');
      expect(nativeNo.length).toBeGreaterThan(0);
      for (const r of nativeNo) {
        expect(r.payload.blockedByFamilyBlock).toBe(true);
        expect(r.payload.wouldTrade).toBe(false);
        expect(r.wouldBlock).toBe(true);
      }

      // Block every family → no opportunity survives the tradable filter → no execution.
      vi.clearAllMocks();
      redisMock = createRedisMock();
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_EXECUTION_ENABLED: true,
        WEATHER_BLOCKED_STRATEGY_FAMILIES:
          'native_no,interior_yes,tail_yes,market_favorite_fade,far_no_ladder,adjacent_no_ladder,yes_gated_fallback_no,resday_lockin_no',
      });
      wire();
      mockGetBankroll.mockResolvedValue(1000);
      mockExecuteAndRecordSignal.mockResolvedValue({
        signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob', governorStamped: true, entryPrice: 0.9, sharesFilled: 10,
      });
      await runWeatherScan(redisMock as never);
      expect(mockExecuteAndRecordSignal).not.toHaveBeenCalled();
    });

    it('does NOT block an unlisted family (only the listed one is paused)', async () => {
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_BLOCKED_STRATEGY_FAMILIES: 'tail_yes',  // not native_no
      });
      wire();
      await scanWeatherMarkets(redisMock as never);
      const nativeNo = bracketRows().filter((r) => r.payload.strategyFamily === 'native_no');
      expect(nativeNo.length).toBeGreaterThan(0);
      for (const r of nativeNo) expect(r.payload.blockedByFamilyBlock).toBe(false);
    });

    it('blocks NO entries whose edge exceeds WEATHER_NO_MAX_EDGE', async () => {
      mockLoadConfig.mockReturnValue({ ...baseConfig, WEATHER_SCANNER_ENABLED: true, WEATHER_NO_MAX_EDGE: 0.05 });
      wire();
      await scanWeatherMarkets(redisMock as never);
      const rows = bracketRows();
      const highEdgeNo = rows.filter((r) => r.direction === 'NO' && r.metricValue > 0.05);
      expect(highEdgeNo.length).toBeGreaterThan(0);
      for (const r of highEdgeNo) expect(r.payload.blockedByHighNoEdge).toBe(true);
      // NO entries at/below the ceiling are untouched by this gate.
      for (const r of rows.filter((r) => r.direction === 'NO' && r.metricValue <= 0.05)) {
        expect(r.payload.blockedByHighNoEdge).toBe(false);
      }
    });
  });

  // ── lowest-temperature discovery + shadow/live gating ────────────────────
  describe('lowest-temperature events', () => {
    function makeMockLowGammaEvent() {
      const ev = makeMockGammaEvent();
      ev.id = 'event-low-1';
      ev.title = `Lowest temperature in Chicago on ${titleDate}?`;
      ev.slug = `lowest-temperature-in-chicago-on-${slugDate}`;
      ev.markets = ev.markets.map((m) => ({
        ...m,
        question: m.question.replace('highest temperature', 'lowest temperature'),
      }));
      return ev;
    }

    // Gamma fetch returns the low event for the lowest-temperature tag and nothing
    // for the highest-temperature tag, isolating low-event behaviour. Forecast low
    // is wired to 52 so the same bracket structure produces opportunities.
    function wireLowOnlyGammaAndForecast() {
      globalThis.fetch = vi.fn((url: string) => Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(String(url).includes('lowest-temperature') ? [makeMockLowGammaEvent()] : []),
      })) as unknown as typeof fetch;
      mockFetchNwsForecast.mockResolvedValue({
        highF: 70, lowF: 52, precipProbability: 10, forecastDate: targetIso, shortForecast: 'Clear',
      });
      mockFetchOpenMeteo.mockResolvedValue({
        highTemp: 70, lowTemp: 52, precipProbability: 10, forecastDate: targetIso,
      });
      mockFetchEnsemble.mockResolvedValue({
        meanHigh: 70, stddevHigh: 3.2, meanLow: 52, stddevLow: 3.2, memberCount: 31, forecastDate: targetIso,
      });
    }

    it('shadow mode: evaluates a low event but suppresses it from the returned (tradable) set', async () => {
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_LOWEST_TEMP_ENABLED: false,   // not live
        WEATHER_LOWEST_TEMP_SHADOW_ENABLED: true,
      });
      wireLowOnlyGammaAndForecast();

      const results = await scanWeatherMarkets(redisMock as never);

      // The low event is evaluated (logged with metric='low') ...
      expect(logger.info).toHaveBeenCalledWith(
        '[weather] event evaluated',
        expect.objectContaining({ city: 'chicago', metric: 'low' }),
      );
      // ... but produces NO tradable opportunities (shadow-suppressed).
      expect(results.filter((o) => o.metric === 'low')).toHaveLength(0);
      // The scan summary records the suppression so it is provably evaluated-then-held.
      const summaryCall = (logger.info as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .find((c) => c[0] === '[weather] scan summary');
      expect(summaryCall).toBeDefined();
      expect((summaryCall![1] as { lowShadowSuppressed: number }).lowShadowSuppressed).toBeGreaterThan(0);
    });

    it('live mode: low opportunities ARE returned for execution when WEATHER_LOWEST_TEMP_ENABLED=true', async () => {
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_SCANNER_ENABLED: true,
        WEATHER_LOWEST_TEMP_ENABLED: true,    // live
        WEATHER_LOWEST_TEMP_SHADOW_ENABLED: true,
      });
      wireLowOnlyGammaAndForecast();

      const results = await scanWeatherMarkets(redisMock as never);

      const lowOpps = results.filter((o) => o.metric === 'low');
      expect(lowOpps.length).toBeGreaterThan(0);
      // sourcedFrom carries the low namespace so it never collides with a high market.
      expect(lowOpps[0]!.city).toBe('chicago');
    });
  });
});

// ---------------------------------------------------------------------------
// Resolution-day size-up + near-res gate bypass
// ---------------------------------------------------------------------------

describe('resolution-day size-up and near-res gate bypass', () => {
  let redisMock: ReturnType<typeof createRedisMock>;
  let originalFetch: typeof globalThis.fetch;

  // Use Chicago's local date. The scanner compares event.targetDate against
  // cityLocalDate(event.coords.tz), so the event slug must match the city's
  // local calendar date — not UTC — for the resolution-day branch to fire.
  const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  const [yyyy, mm, dd] = todayIso.split('-') as [string, string, string];
  const MONTH_NAMES2 = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const monthName2 = MONTH_NAMES2[parseInt(mm, 10) - 1] ?? 'May';
  const titleDate2 = `${monthName2} ${parseInt(dd, 10).toString()}`;
  const slugDate2 = `${monthName2.toLowerCase()}-${parseInt(dd, 10).toString()}-${yyyy}`;
  const endDateIso2 = `${todayIso}T12:00:00Z`;
  const activeEventKey = `weather:active_event:highest-temperature-in-chicago-on-${slugDate2}`;

  function makeTodayGammaEvent() {
    return {
      id: 'event-today',
      title: `Highest temperature in Chicago on ${titleDate2}?`,
      slug: `highest-temperature-in-chicago-on-${slugDate2}`,
      active: true,
      closed: false,
      negRisk: true,
      endDate: endDateIso2,
      markets: Array.from({ length: 11 }, (_, i) => {
        const labels = [
          '39°F or below', '40-41°F', '42-43°F', '44-45°F', '46-47°F',
          '48-49°F', '50-51°F', '52-53°F', '54-55°F', '56-57°F', '58°F or higher',
        ];
        const yesPrices = [0.01, 0.03, 0.05, 0.10, 0.15, 0.20, 0.18, 0.12, 0.08, 0.05, 0.03];
        return {
          id: `mt${i}`,
          question: `Will the highest temperature in Chicago be ${labels[i]} on ${titleDate2}?`,
          conditionId: `cond-t${i}`,
          clobTokenIds: `["tt${i}y","tt${i}n"]`,
          outcomePrices: `["${(yesPrices[i] ?? 0).toFixed(2)}","${(1 - (yesPrices[i] ?? 0)).toFixed(2)}"]`,
          outcomes: '["Yes","No"]',
          active: true,
          closed: false,
          volume: '10000',
          liquidity: '5000',
          endDate: endDateIso2,
          description: null,
          groupItemTitle: labels[i],
          groupItemThreshold: i.toString(),
        };
      }),
    };
  }

  function makeTodayLowGammaEvent() {
    const highEvent = makeTodayGammaEvent();
    return {
      ...highEvent,
      id: 'event-low-today',
      title: `Lowest temperature in Chicago on ${titleDate2}?`,
      slug: `lowest-temperature-in-chicago-on-${slugDate2}`,
      markets: highEvent.markets.map((m, i) => {
        const labels = [
          '29°F or below', '30-31°F', '32-33°F', '34-35°F', '36-37°F',
          '38-39°F', '40-41°F', '42-43°F', '44-45°F', '46-47°F', '48°F or higher',
        ];
        return {
          ...m,
          id: `mlt${i}`,
          question: `Will the lowest temperature in Chicago be ${labels[i]} on ${titleDate2}?`,
          conditionId: `cond-lt${i}`,
          clobTokenIds: `["tlt${i}y","tlt${i}n"]`,
          groupItemTitle: labels[i],
        };
      }),
    };
  }

  function wireTodayMocks() {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve([makeTodayGammaEvent()]),
    }) as unknown as typeof fetch;
    mockFetchEnsemble.mockResolvedValue({
      meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8, memberCount: 31, forecastDate: todayIso,
    });
    mockFetchOpenMeteo.mockResolvedValue({
      highTemp: 52, lowTemp: 38, precipProbability: 10, forecastDate: todayIso,
    });
    mockFetchNwsForecast.mockResolvedValue({
      highF: 52, lowF: 38, precipProbability: 10, forecastDate: todayIso, shortForecast: 'Cloudy',
    });
  }

  function wireTodayHighAndLowMocks() {
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(url.includes('tag_slug=lowest-temperature')
          ? [makeTodayLowGammaEvent()]
          : [makeTodayGammaEvent()]),
      });
    }) as unknown as typeof fetch;
    mockFetchEnsemble.mockResolvedValue({
      meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8, memberCount: 31, forecastDate: todayIso,
    });
    mockFetchOpenMeteo.mockResolvedValue({
      highTemp: 52, lowTemp: 38, precipProbability: 10, forecastDate: todayIso,
    });
    mockFetchNwsForecast.mockResolvedValue({
      highF: 52, lowF: 38, precipProbability: 10, forecastDate: todayIso, shortForecast: 'Cloudy',
    });
  }

  function liveObs(overrides: Record<string, unknown> = {}) {
    return {
      city: 'chicago',
      targetDate: todayIso,
      observedMax: 52,
      metric: 'high',
      source: 'wu-live',
      observedAt: `${todayIso}T16:00:00Z`,
      confidence: 'settlement_aligned',
      ...overrides,
    };
  }

  function signalDecisionWrites() {
    return mockEnqueueWrite.mock.calls
      .filter((c) => c[0] === 'signal_decisions')
      .map((c) => c[1] as Record<string, any>);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    redisMock = createRedisMock();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fires size-up on resolution day when active event key is present', async () => {
    redisMock._store.set(activeEventKey, '1');
    // Satisfy hasOpenPosition check for whichever bracket(s) the scanner evaluates
    for (let i = 0; i < 11; i++) {
      redisMock._store.set(`position:mt${i}:NO`, '1');
      redisMock._store.set(`position:mt${i}:YES`, '1');
    }
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      SIZE_UP_ENABLED: true,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0, // disable far-out gate
      WEATHER_NEAR_RES_ENTRY_ENABLED: false,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    wireTodayMocks();
    mockGetBankroll.mockResolvedValue(1000);
    mockExecuteAndRecordSignal.mockResolvedValue({
      signal: { stakeUsd: 5 } as never, skipped: false, isSizeUp: true,
      executionVenue: 'clob', entryPrice: 0.9, sharesFilled: 10, governorStamped: true,
    });

    await runWeatherScan(redisMock as never);

    expect(mockExecuteAndRecordSignal).toHaveBeenCalled();
  });

  // ── Fix D: size-ups face the same quality gates as a fresh entry ────────────
  // Helper: held position on ONLY the model-favoured 52-53°F YES bracket (mt7),
  // so there is exactly one size-up candidate to gate. Forecast 52°F gives GFS a
  // positive YES edge there; ECMWF stddev decides the ensemble veto.
  function wireSingleBracketSizeUp(ecmwfStddev: number) {
    redisMock._store.set(activeEventKey, '1');
    redisMock._store.set('position:mt7:YES', '1');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve([makeTodayGammaEvent()]),
    }) as unknown as typeof fetch;
    mockFetchNwsForecast.mockResolvedValue({ highF: 52, lowF: 38, precipProbability: 10, forecastDate: todayIso, shortForecast: 'Sunny' });
    mockFetchOpenMeteo.mockResolvedValue({ highTemp: 52, lowTemp: 38, precipProbability: 10, forecastDate: todayIso });
    mockFetchEnsemble
      .mockResolvedValueOnce({ meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8, memberCount: 31, forecastDate: todayIso, ensembleModel: 'gfs' })
      .mockResolvedValueOnce({ meanHigh: 52, stddevHigh: ecmwfStddev, meanLow: 38, stddevLow: 2.8, memberCount: 51, forecastDate: todayIso, ensembleModel: 'ecmwf' });
    mockGetBankroll.mockResolvedValue(1000);
    mockExecuteAndRecordSignal.mockResolvedValue({
      signal: { stakeUsd: 5 } as never, skipped: false, isSizeUp: true,
      executionVenue: 'clob', entryPrice: 0.9, sharesFilled: 10, governorStamped: true,
    });
  }

  it('does NOT bypass the ensemble veto for size-ups (Fix D) — vetoed top-up is filtered', async () => {
    // Previously size-ups short-circuited the veto/disagreement gates, so a top-up
    // cleared fewer gates than the entry. ECMWF stddev 8.0 collapses the 52-53°F
    // probability → shadowEdge ≤ 0 → blockedByEnsembleVeto. The size-up must now be
    // dropped before the executor, exactly as a fresh entry would be.
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      WEATHER_TRADE_SIDES: 'BOTH',
      SIZE_UP_ENABLED: true,
      WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: true,
      WEATHER_DUAL_ENSEMBLE_VETO_ENABLED: true,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      WEATHER_NEAR_RES_ENTRY_ENABLED: false,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    wireSingleBracketSizeUp(8.0);

    await runWeatherScan(redisMock as never);

    expect(mockExecuteAndRecordSignal).not.toHaveBeenCalled();
  });

  it('control: the same size-up DOES fire when the ensemble veto is disabled', async () => {
    // Identical setup, veto off → blockedByEnsembleVeto=false → the top-up reaches
    // the executor. Proves the previous test is the veto filtering it (Fix D), not
    // some unrelated gate.
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      WEATHER_TRADE_SIDES: 'BOTH',
      SIZE_UP_ENABLED: true,
      WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: true,
      WEATHER_DUAL_ENSEMBLE_VETO_ENABLED: false,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      WEATHER_NEAR_RES_ENTRY_ENABLED: false,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    wireSingleBracketSizeUp(8.0);

    await runWeatherScan(redisMock as never);

    expect(mockExecuteAndRecordSignal).toHaveBeenCalled();
  });

  // ── Shadow mode: emit the evaluation, let the executor decline + shadow-log ──
  it('shadow mode (SIZE_UP_ENABLED=false + SIZE_UP_SHADOW_ENABLED=true) still emits a sanctioned size-up eval', async () => {
    // The scanner must reach the executor with a sanctioned size-up signal even when
    // the feature is off, so evaluateSizeUp can write `would_size_up` shadow rows
    // (it returns feature_disabled → no execution). Without this the held event is
    // skipped and no shadow data is produced.
    redisMock._store.set(activeEventKey, '1');
    for (let i = 0; i < 11; i++) {
      redisMock._store.set(`position:mt${i}:NO`, '1');
      redisMock._store.set(`position:mt${i}:YES`, '1');
    }
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      WEATHER_TRADE_SIDES: 'BOTH',
      SIZE_UP_ENABLED: false,
      SIZE_UP_SHADOW_ENABLED: true,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      WEATHER_NEAR_RES_ENTRY_ENABLED: false,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    wireTodayMocks();
    mockGetBankroll.mockResolvedValue(1000);
    mockExecuteAndRecordSignal.mockResolvedValue({
      signal: { stakeUsd: 0 } as never, skipped: true, skipReason: 'size_up_ineligible',
    });

    await runWeatherScan(redisMock as never);

    expect(mockExecuteAndRecordSignal).toHaveBeenCalled();
    const sig = mockExecuteAndRecordSignal.mock.calls[0]![0] as { sizeUpSanctioned?: boolean };
    expect(sig.sizeUpSanctioned).toBe(true);
  });

  it('fully off (SIZE_UP_ENABLED=false + SIZE_UP_SHADOW_ENABLED=false) skips the held event — no executor call', async () => {
    redisMock._store.set(activeEventKey, '1');
    for (let i = 0; i < 11; i++) {
      redisMock._store.set(`position:mt${i}:NO`, '1');
      redisMock._store.set(`position:mt${i}:YES`, '1');
    }
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      WEATHER_TRADE_SIDES: 'BOTH',
      SIZE_UP_ENABLED: false,
      SIZE_UP_SHADOW_ENABLED: false,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      WEATHER_NEAR_RES_ENTRY_ENABLED: false,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    wireTodayMocks();
    mockGetBankroll.mockResolvedValue(1000);

    await runWeatherScan(redisMock as never);

    expect(mockExecuteAndRecordSignal).not.toHaveBeenCalled();
  });

  it('re-evaluates size-up on EVERY resolution-day scan (no once-per-day dedup)', async () => {
    // The old `weather:event_resday:` key let only the FIRST res-day scan evaluate
    // a size-up; if a gate transiently failed at that moment, the opportunity was
    // lost for the whole day. Now every scan re-evaluates: two consecutive scans
    // must BOTH reach the executor for the held event.
    redisMock._store.set(activeEventKey, '1');
    for (let i = 0; i < 11; i++) {
      redisMock._store.set(`position:mt${i}:NO`, '1');
      redisMock._store.set(`position:mt${i}:YES`, '1');
    }
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      SIZE_UP_ENABLED: true,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      WEATHER_NEAR_RES_ENTRY_ENABLED: false,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    wireTodayMocks();
    mockGetBankroll.mockResolvedValue(1000);
    mockExecuteAndRecordSignal.mockResolvedValue({
      signal: { stakeUsd: 5 } as never, skipped: false, isSizeUp: true,
      executionVenue: 'clob', entryPrice: 0.9, sharesFilled: 10, governorStamped: true,
    });

    await runWeatherScan(redisMock as never);
    expect(mockExecuteAndRecordSignal).toHaveBeenCalled();
    const firstScanCalls = mockExecuteAndRecordSignal.mock.calls.length;

    // Second scan in the same day, same Redis state (the first scan's keys remain).
    // Pre-change this dedup-skipped the event; now it must re-evaluate.
    await runWeatherScan(redisMock as never);
    expect(mockExecuteAndRecordSignal.mock.calls.length).toBeGreaterThan(firstScanCalls);
    // Every emitted size-up signal must still be resolution-day sanctioned.
    for (const call of mockExecuteAndRecordSignal.mock.calls) {
      expect((call[0] as { sizeUpSanctioned?: boolean }).sizeUpSanctioned).toBe(true);
    }
  });

  it('claims the res-day early-entry dedup key with the per-scan TTL, not an all-day TTL', async () => {
    // Regression guard: the early-entry claim used to hold an all-day TTL
    // (max(DEDUP_TTL, until-end-of-day)), which dropped the event out of the
    // revalidation pass's universe for the rest of the day — its resting order
    // could no longer be FV-checked, and after an FV-cancel or transient gate
    // failure it never got a fresh post. The claim now uses the per-scan
    // WEATHER_DEDUP_TTL_S window so the event is re-emitted (and re-postable)
    // every scan. No active position + SIZE_UP disabled → early-entry path.
    (redisMock as any).del = vi.fn().mockResolvedValue(1);
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      SIZE_UP_ENABLED: false,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      WEATHER_NEAR_RES_ENTRY_ENABLED: false,
      WEATHER_RES_DAY_EARLY_ENTRY_ENABLED: true,
      WEATHER_RES_DAY_MIN_HOURS_REMAINING: -100, // always pass regardless of clock
      // Small sentinel so the assertion is deterministic: old code would pass
      // max(7, until-end-of-day) ≫ 7; new code passes exactly 7.
      WEATHER_DEDUP_TTL_S: 7,
      WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: true,
      WEATHER_DUAL_ENSEMBLE_VETO_ENABLED: false,
      WEATHER_MARKET_DISAGREEMENT_ENABLED: false,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    wireTodayMocks();
    mockFetchEnsemble.mockResolvedValue({
      meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8,
      memberCount: 31, forecastDate: todayIso, ensembleModel: 'gfs',
    });
    mockGetBankroll.mockResolvedValue(1000);
    mockExecuteAndRecordSignal.mockResolvedValue({
      signal: { stakeUsd: 5 } as never, skipped: false,
      executionVenue: 'clob', entryPrice: 0.43, sharesFilled: null,
      governorStamped: true, wasEmptyBook: true,
    });

    await runWeatherScan(redisMock as never);

    // The early-entry dedup claim: set(key, '1', 'EX', ttlSeconds, 'NX').
    const earlyClaim = redisMock.set.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].startsWith('weather:event_resday_early:'),
    );
    expect(earlyClaim).toBeDefined();
    expect(earlyClaim?.[3]).toBe(7);      // WEATHER_DEDUP_TTL_S — not until-end-of-day
    expect(earlyClaim?.[4]).toBe('NX');
  });

  it('skips resolution-day event when no active position exists', async () => {
    // No activeEventKey set in Redis, no position keys — both fallback paths return false.
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      SIZE_UP_ENABLED: true,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    wireTodayMocks();
    mockGetBankroll.mockResolvedValue(1000);

    await runWeatherScan(redisMock as never);

    expect(mockExecuteAndRecordSignal).not.toHaveBeenCalled();
  });

  it('fires size-up on resolution day via position fallback when active event marker is absent', async () => {
    // No activeEventKey — marker may have expired or was never set. Positions exist
    // in the ledger. The hasAnyOpenWeatherPosition fallback should still allow size-up.
    for (let i = 0; i < 11; i++) {
      redisMock._store.set(`position:mt${i}:NO`, '1');
    }
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      SIZE_UP_ENABLED: true,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      WEATHER_NEAR_RES_ENTRY_ENABLED: false,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    wireTodayMocks();
    mockGetBankroll.mockResolvedValue(1000);
    mockExecuteAndRecordSignal.mockResolvedValue({
      signal: { stakeUsd: 5 } as never, skipped: false, isSizeUp: true,
      executionVenue: 'clob', entryPrice: 0.9, sharesFilled: 10, governorStamped: true,
    });

    await runWeatherScan(redisMock as never);

    expect(mockExecuteAndRecordSignal).toHaveBeenCalled();
  });

  it('does NOT size up on a non-resolution day (off-day top-ups gated out)', async () => {
    // Tomorrow's event (daysOut=1) with the normal dedup key already claimed and a
    // position present. Before resolution-day gating this triggered an off-day
    // size-up; size-ups are now restricted to the target/resolution day, so the
    // dedup-claimed off-day scan must skip rather than re-evaluate for a top-up.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const tomorrowIso = tomorrow.toISOString().slice(0, 10);
    const [ty, tm, tdStr] = tomorrowIso.split('-') as [string, string, string];
    const tMonthName = MONTH_NAMES2[parseInt(tm, 10) - 1] ?? 'May';
    const tSlugDate = `${tMonthName.toLowerCase()}-${parseInt(tdStr, 10).toString()}-${ty}`;
    const tEndDate = `${tomorrowIso}T12:00:00Z`; // noon tomorrow → genuine off-day
    const tSlug = `highest-temperature-in-chicago-on-${tSlugDate}`;
    const tActiveKey = `weather:active_event:${tSlug}`;
    const tDedupKey = `weather:event:${tSlug}`;

    redisMock._store.set(tActiveKey, '1');
    redisMock._store.set(tDedupKey, '1'); // dedup already claimed
    for (let i = 0; i < 11; i++) {
      redisMock._store.set(`position:mnr${i}:NO`, '1');
      redisMock._store.set(`position:mnr${i}:YES`, '1');
    }

    const tTitleDate = `${tMonthName} ${parseInt(tdStr, 10).toString()}`;
    const tMarkets = Array.from({ length: 11 }, (_, i) => {
      const labels = [
        '39°F or below', '40-41°F', '42-43°F', '44-45°F', '46-47°F',
        '48-49°F', '50-51°F', '52-53°F', '54-55°F', '56-57°F', '58°F or higher',
      ];
      const yesPrices = [0.01, 0.03, 0.05, 0.10, 0.15, 0.20, 0.18, 0.12, 0.08, 0.05, 0.03];
      return {
        id: `mnr${i}`, question: `Will the highest temperature in Chicago be ${labels[i]} on ${tTitleDate}?`,
        conditionId: `cond-nr${i}`, clobTokenIds: `["tnr${i}y","tnr${i}n"]`,
        outcomePrices: `["${(yesPrices[i] ?? 0).toFixed(2)}","${(1 - (yesPrices[i] ?? 0)).toFixed(2)}"]`,
        outcomes: '["Yes","No"]', active: true, closed: false, volume: '10000', liquidity: '5000',
        endDate: tEndDate, description: null,
        groupItemTitle: labels[i], groupItemThreshold: i.toString(),
      };
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve([{
        id: 'event-nr', title: `Highest temperature in Chicago on ${tTitleDate}?`,
        slug: tSlug, active: true, closed: false, negRisk: true, endDate: tEndDate, markets: tMarkets,
      }]),
    }) as unknown as typeof fetch;
    mockFetchEnsemble.mockResolvedValue({
      meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8, memberCount: 31, forecastDate: tomorrowIso,
    });
    mockFetchOpenMeteo.mockResolvedValue({ highTemp: 52, lowTemp: 38, precipProbability: 10, forecastDate: tomorrowIso });
    mockFetchNwsForecast.mockResolvedValue({ highF: 52, lowF: 38, precipProbability: 10, forecastDate: tomorrowIso, shortForecast: 'Cloudy' });

    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      SIZE_UP_ENABLED: true,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    mockGetBankroll.mockResolvedValue(1000);
    mockExecuteAndRecordSignal.mockResolvedValue({
      signal: { stakeUsd: 5 } as never, skipped: false, isSizeUp: true,
      executionVenue: 'clob', entryPrice: 0.9, sharesFilled: 10, governorStamped: true,
    });

    await runWeatherScan(redisMock as never);

    expect(mockExecuteAndRecordSignal).not.toHaveBeenCalled();
  });

  it('near-res gate does not block resolution-day size-up opportunities', async () => {
    // Resolution day (today) with endDate only 5h away so the near-res entry gate
    // (threshold=10h) would block a FRESH entry. A position is present, so the scan
    // enters the resolution-day size-up path, which must bypass the near-res gate
    // (sizeUpScanOnly) and still fire — this is where same-day top-ups land.
    const nearEndDate = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
    const baseEvent = makeTodayGammaEvent();

    redisMock._store.set(activeEventKey, '1');
    for (let i = 0; i < 11; i++) {
      redisMock._store.set(`position:mt${i}:NO`, '1');
      redisMock._store.set(`position:mt${i}:YES`, '1');
    }

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve([{
        ...baseEvent,
        endDate: nearEndDate,
        markets: baseEvent.markets.map((m) => ({ ...m, endDate: nearEndDate })),
      }]),
    }) as unknown as typeof fetch;
    mockFetchEnsemble.mockResolvedValue({
      meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8, memberCount: 31, forecastDate: todayIso,
    });
    mockFetchOpenMeteo.mockResolvedValue({ highTemp: 52, lowTemp: 38, precipProbability: 10, forecastDate: todayIso });
    mockFetchNwsForecast.mockResolvedValue({ highF: 52, lowF: 38, precipProbability: 10, forecastDate: todayIso, shortForecast: 'Cloudy' });

    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      SIZE_UP_ENABLED: true,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      WEATHER_NEAR_RES_ENTRY_ENABLED: true,
      WEATHER_NEAR_RES_ENTRY_HOURS: 10,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    mockGetBankroll.mockResolvedValue(1000);
    mockExecuteAndRecordSignal.mockResolvedValue({
      signal: { stakeUsd: 5 } as never, skipped: false, isSizeUp: true,
      executionVenue: 'clob', entryPrice: 0.9, sharesFilled: 10, governorStamped: true,
    });

    await runWeatherScan(redisMock as never);

    expect(mockExecuteAndRecordSignal).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Bracket-maker strategy gate tests
  // ---------------------------------------------------------------------------

  // Helper: build a proper non-resolution-day event (tomorrow slug) for bracket tests.
  function makeTomorrowEventFixture() {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const tomorrowIso = tomorrow.toISOString().slice(0, 10);
    const [ty, tm, tdStr] = tomorrowIso.split('-') as [string, string, string];
    const tMonthName = MONTH_NAMES2[parseInt(tm, 10) - 1] ?? 'May';
    const tSlugDate = `${tMonthName.toLowerCase()}-${parseInt(tdStr, 10).toString()}-${ty}`;
    const tTitleDate = `${tMonthName} ${parseInt(tdStr, 10).toString()}`;
    const tEndDate = `${tomorrowIso}T12:00:00Z`;
    const tSlug = `highest-temperature-in-chicago-on-${tSlugDate}`;
    const labels = [
      '39°F or below', '40-41°F', '42-43°F', '44-45°F', '46-47°F',
      '48-49°F', '50-51°F', '52-53°F', '54-55°F', '56-57°F', '58°F or higher',
    ];
    const yesPrices = [0.01, 0.03, 0.05, 0.10, 0.15, 0.20, 0.18, 0.12, 0.08, 0.05, 0.03];
    const tMarkets = Array.from({ length: 11 }, (_, i) => ({
      id: `mbkt${i}`, question: `Will the highest temperature in Chicago be ${labels[i]} on ${tTitleDate}?`,
      conditionId: `cond-bkt${i}`, clobTokenIds: `["tbkt${i}y","tbkt${i}n"]`,
      outcomePrices: `["${(yesPrices[i] ?? 0).toFixed(2)}","${(1 - (yesPrices[i] ?? 0)).toFixed(2)}"]`,
      outcomes: '["Yes","No"]', active: true, closed: false, volume: '10000', liquidity: '5000',
      endDate: tEndDate, description: null, groupItemTitle: labels[i], groupItemThreshold: i.toString(),
    }));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve([{ id: 'event-bkt', title: `Highest temperature in Chicago on ${tTitleDate}?`, slug: tSlug, active: true, closed: false, negRisk: true, endDate: tEndDate, markets: tMarkets }]),
    }) as unknown as typeof fetch;
    mockFetchEnsemble.mockResolvedValue({ meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8, memberCount: 31, forecastDate: tomorrowIso });
    mockFetchOpenMeteo.mockResolvedValue({ highTemp: 52, lowTemp: 38, precipProbability: 10, forecastDate: tomorrowIso });
    mockFetchNwsForecast.mockResolvedValue({ highF: 52, lowF: 38, precipProbability: 10, forecastDate: tomorrowIso, shortForecast: 'Cloudy' });
  }

  it('bracket fires on empty-book pre-resolution-day primary (positive path)', async () => {
    makeTomorrowEventFixture();
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      WEATHER_BRACKET_ENABLED: true,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    mockGetBankroll.mockResolvedValue(1000);
    // Primary result: empty-book commit
    mockExecuteAndRecordSignal.mockResolvedValueOnce({
      signal: { stakeUsd: 5 } as never,
      skipped: false,
      executionVenue: 'clob',
      entryPrice: 0.43,
      sharesFilled: null,
      governorStamped: true,
      wasEmptyBook: true,
    });
    // Bracket result (second call)
    mockExecuteAndRecordSignal.mockResolvedValueOnce({
      signal: { stakeUsd: 3 } as never,
      skipped: false,
      executionVenue: 'clob',
      entryPrice: 0.12,
      sharesFilled: null,
      governorStamped: true,
      wasEmptyBook: true,
    });

    await runWeatherScan(redisMock as never);

    // executeAndRecordSignal called at least twice: primary + bracket opposite
    expect(mockExecuteAndRecordSignal.mock.calls.length).toBeGreaterThanOrEqual(2);
    const bracketCall = mockExecuteAndRecordSignal.mock.calls.find(
      (c) => (c[0] as { _isBracketOpposite?: boolean })._isBracketOpposite === true,
    );
    expect(bracketCall).toBeDefined();
    const primaryCall = mockExecuteAndRecordSignal.mock.calls.find(
      (c) => !(c[0] as { _isBracketOpposite?: boolean })._isBracketOpposite,
    );
    expect(primaryCall).toBeDefined();
    expect((bracketCall![0] as { decisionId?: string }).decisionId).toBe(
      (primaryCall![0] as { decisionId?: string }).decisionId,
    );
  });

  it('bracket leg carries _bracketTargetShares equal to the primary filled share count', async () => {
    // Regression for the bracket oversizing bug: the leg must target the primary's
    // SHARE count (1:1 pairing) rather than a dollar stake the executor would re-divide
    // by the discounted post price. With an explicit primary fill of 12 shares, the
    // bracket signal must carry _bracketTargetShares === 12.
    makeTomorrowEventFixture();
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      WEATHER_BRACKET_ENABLED: true,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    mockGetBankroll.mockResolvedValue(1000);
    // Primary result: empty-book commit with an explicit filled share count.
    mockExecuteAndRecordSignal.mockResolvedValueOnce({
      signal: { stakeUsd: 5 } as never,
      skipped: false,
      executionVenue: 'clob',
      entryPrice: 0.43,
      sharesFilled: 12,
      governorStamped: true,
      wasEmptyBook: true,
    });
    // Bracket result (second call)
    mockExecuteAndRecordSignal.mockResolvedValueOnce({
      signal: { stakeUsd: 3 } as never,
      skipped: false,
      executionVenue: 'clob',
      entryPrice: 0.12,
      sharesFilled: null,
      governorStamped: true,
      wasEmptyBook: true,
    });

    await runWeatherScan(redisMock as never);

    const bracketCall = mockExecuteAndRecordSignal.mock.calls.find(
      (c) => (c[0] as { _isBracketOpposite?: boolean })._isBracketOpposite === true,
    );
    expect(bracketCall).toBeDefined();
    expect((bracketCall![0] as { _bracketTargetShares?: number })._bracketTargetShares).toBe(12);
  });

  it('bracket does NOT fire when primary was a real-book entry (wasEmptyBook=false)', async () => {
    makeTomorrowEventFixture();
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      WEATHER_BRACKET_ENABLED: true,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    mockGetBankroll.mockResolvedValue(1000);
    // Primary result: real-book commit (wasEmptyBook=false/absent)
    mockExecuteAndRecordSignal.mockResolvedValue({
      signal: { stakeUsd: 5 } as never,
      skipped: false,
      executionVenue: 'clob',
      entryPrice: 0.43,
      sharesFilled: null,
      governorStamped: true,
      wasEmptyBook: false,
    });

    await runWeatherScan(redisMock as never);

    const bracketCall = mockExecuteAndRecordSignal.mock.calls.find(
      (c) => (c[0] as { _isBracketOpposite?: boolean })._isBracketOpposite === true,
    );
    expect(bracketCall).toBeUndefined();
  });

  it('res-day-only gate ALLOWS resolution-day entries (isResolutionDay=true)', async () => {
    // Same res-day fresh-entry path as the test below, but with WEATHER_RES_DAY_ENTRY_ONLY
    // ON. The gate must NOT block res-day opportunities — it only suppresses off-day ones.
    // The executed signal must carry _isResolutionDay=true (the flag the gate keys off).
    (redisMock as any).del = vi.fn().mockResolvedValue(1);
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      WEATHER_RES_DAY_ENTRY_ONLY: true,
      SIZE_UP_ENABLED: true,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      WEATHER_NEAR_RES_ENTRY_ENABLED: false,
      WEATHER_RES_DAY_EARLY_ENTRY_ENABLED: true,
      WEATHER_RES_DAY_MIN_HOURS_REMAINING: -100, // always pass regardless of clock
      WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: true,
      WEATHER_DUAL_ENSEMBLE_VETO_ENABLED: false,
      WEATHER_MARKET_DISAGREEMENT_ENABLED: false,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    wireTodayMocks();
    mockFetchEnsemble.mockResolvedValue({
      meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8,
      memberCount: 31, forecastDate: todayIso, ensembleModel: 'gfs',
    });
    mockGetBankroll.mockResolvedValue(1000);
    mockExecuteAndRecordSignal.mockResolvedValue({
      signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob',
      entryPrice: 0.43, sharesFilled: null, governorStamped: true, wasEmptyBook: true,
    });

    await runWeatherScan(redisMock as never);

    expect(mockGetBankroll).toHaveBeenCalled();
    const primaryCall = mockExecuteAndRecordSignal.mock.calls.find(
      (c) => !(c[0] as { _isBracketOpposite?: boolean })._isBracketOpposite,
    );
    expect(primaryCall).toBeDefined();
    expect((primaryCall![0] as { _isResolutionDay?: boolean })._isResolutionDay).toBe(true);
  });

  it('res-day live-confirmation gate blocks unconfirmed fresh entries and records decision context', async () => {
    (redisMock as any).del = vi.fn().mockResolvedValue(1);
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      WEATHER_RES_DAY_ENTRY_ONLY: true,
      WEATHER_RES_DAY_LIVE_CONFIRMATION_REQUIRED: true,
      SIZE_UP_ENABLED: true,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      WEATHER_NEAR_RES_ENTRY_ENABLED: false,
      WEATHER_RES_DAY_EARLY_ENTRY_ENABLED: true,
      WEATHER_RES_DAY_MIN_HOURS_REMAINING: -100,
      WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: true,
      WEATHER_DUAL_ENSEMBLE_VETO_ENABLED: false,
      WEATHER_MARKET_DISAGREEMENT_ENABLED: false,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    wireTodayMocks();
    mockFetchLiveObservation.mockResolvedValue(liveObs({ observedMax: 52 }));
    mockGetBankroll.mockResolvedValue(1000);

    await runWeatherScan(redisMock as never);

    expect(mockExecuteAndRecordSignal).not.toHaveBeenCalled();
    const blocked = signalDecisionWrites().find((w) =>
      String(w.skipDetail ?? '').includes('live_confirmation_missing'));
    expect(blocked).toBeDefined();
    expect(blocked!.hasTrade).toBe(false);
    expect(blocked!.decisionId).toMatch(/[0-9a-f-]{36}/);
    expect((blocked!.raw as Record<string, unknown>).isResolutionDay).toBe(true);
    expect((blocked!.raw as Record<string, unknown>).sizeUpScanOnly).toBe(false);
    expect((blocked!.raw as Record<string, unknown>).blockedByLiveConfirmation).toBe(true);
  });

  it('res-day live-confirmation gate allows a settlement-aligned lock-confirmed entry and links decisionId', async () => {
    (redisMock as any).del = vi.fn().mockResolvedValue(1);
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      WEATHER_RES_DAY_ENTRY_ONLY: true,
      WEATHER_RES_DAY_LIVE_CONFIRMATION_REQUIRED: true,
      SIZE_UP_ENABLED: true,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      WEATHER_NEAR_RES_ENTRY_ENABLED: false,
      WEATHER_RES_DAY_EARLY_ENTRY_ENABLED: true,
      WEATHER_RES_DAY_MIN_HOURS_REMAINING: -100,
      WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: true,
      WEATHER_DUAL_ENSEMBLE_VETO_ENABLED: false,
      WEATHER_MARKET_DISAGREEMENT_ENABLED: false,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    wireTodayMocks();
    mockFetchEnsemble
      .mockResolvedValueOnce({
        meanHigh: 65, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8,
        memberCount: 31, forecastDate: todayIso, ensembleModel: 'gfs',
      })
      .mockResolvedValueOnce({
        meanHigh: 65, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8,
        memberCount: 51, forecastDate: todayIso, ensembleModel: 'ecmwf',
      });
    mockFetchOpenMeteo.mockResolvedValue({
      highTemp: 65, lowTemp: 38, precipProbability: 10, forecastDate: todayIso,
    });
    mockFetchNwsForecast.mockResolvedValue({
      highF: 65, lowF: 38, precipProbability: 10, forecastDate: todayIso, shortForecast: 'Cloudy',
    });
    mockFetchLiveObservation.mockResolvedValue(liveObs({ observedMax: 70 }));
    mockGetBankroll.mockResolvedValue(1000);
    mockExecuteAndRecordSignal.mockResolvedValue({
      signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob',
      entryPrice: 0.43, sharesFilled: null, governorStamped: true, wasEmptyBook: true,
    });

    await runWeatherScan(redisMock as never);

    const primaryCall = mockExecuteAndRecordSignal.mock.calls.find(
      (c) => !(c[0] as { _isBracketOpposite?: boolean })._isBracketOpposite,
    );
    expect(primaryCall).toBeDefined();
    const signal = primaryCall![0] as { decisionId?: string };
    expect(signal.decisionId).toMatch(/[0-9a-f-]{36}/);
    const traded = signalDecisionWrites().find((w) => w.decisionId === signal.decisionId);
    expect(traded).toBeDefined();
    expect(traded!.hasTrade).toBe(true);
    expect((traded!.raw as Record<string, unknown>).isResolutionDay).toBe(true);
    expect((traded!.raw as Record<string, unknown>).liveObservationConfirmed).toBe(true);
  });

  it('res-day live-confirmation gate blocks unconfirmed low-metric bounded entries', async () => {
    (redisMock as any).del = vi.fn().mockResolvedValue(1);
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      WEATHER_LOWEST_TEMP_ENABLED: true,
      WEATHER_RES_DAY_ENTRY_ONLY: true,
      WEATHER_RES_DAY_LIVE_CONFIRMATION_REQUIRED: true,
      SIZE_UP_ENABLED: true,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      WEATHER_NEAR_RES_ENTRY_ENABLED: false,
      WEATHER_RES_DAY_EARLY_ENTRY_ENABLED: true,
      WEATHER_RES_DAY_MIN_HOURS_REMAINING: -100,
      WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: true,
      WEATHER_DUAL_ENSEMBLE_VETO_ENABLED: false,
      WEATHER_MARKET_DISAGREEMENT_ENABLED: false,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    wireTodayHighAndLowMocks();
    mockFetchLiveObservation.mockResolvedValue(liveObs({ metric: 'low', observedMax: 38 }));
    mockGetBankroll.mockResolvedValue(1000);

    await runWeatherScan(redisMock as never);

    const lowBlocked = signalDecisionWrites().find((w) =>
      String((w.raw as Record<string, unknown>).metric) === 'low' &&
      String(w.skipDetail ?? '').includes('live_confirmation_missing'));
    expect(lowBlocked).toBeDefined();
    expect(lowBlocked!.hasTrade).toBe(false);
    expect((lowBlocked!.raw as Record<string, unknown>).blockedByLiveConfirmation).toBe(true);
    expect((lowBlocked!.raw as Record<string, unknown>).liveObservationConfirmed).toBe(false);
  });

  it('res-day live-confirmation gate allows low NO when the running minimum locks it in', async () => {
    (redisMock as any).del = vi.fn().mockResolvedValue(1);
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      WEATHER_LOWEST_TEMP_ENABLED: true,
      WEATHER_RES_DAY_ENTRY_ONLY: true,
      WEATHER_RES_DAY_LIVE_CONFIRMATION_REQUIRED: true,
      SIZE_UP_ENABLED: true,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      WEATHER_NEAR_RES_ENTRY_ENABLED: false,
      WEATHER_RES_DAY_EARLY_ENTRY_ENABLED: true,
      WEATHER_RES_DAY_MIN_HOURS_REMAINING: -100,
      WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: true,
      WEATHER_DUAL_ENSEMBLE_VETO_ENABLED: false,
      WEATHER_MARKET_DISAGREEMENT_ENABLED: false,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const lowEvent = makeTodayLowGammaEvent();
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(url.includes('tag_slug=lowest-temperature')
          ? [{
              ...lowEvent,
              markets: lowEvent.markets.map((m) => ({ ...m, outcomePrices: '["0.85","0.15"]' })),
            }]
          : [makeTodayGammaEvent()]),
      });
    }) as unknown as typeof fetch;
    mockFetchEnsemble.mockResolvedValue({
      meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8,
      memberCount: 31, forecastDate: todayIso, ensembleModel: 'gfs',
    });
    mockFetchOpenMeteo.mockResolvedValue({
      highTemp: 52, lowTemp: 38, precipProbability: 10, forecastDate: todayIso,
    });
    mockFetchNwsForecast.mockResolvedValue({
      highF: 52, lowF: 38, precipProbability: 10, forecastDate: todayIso, shortForecast: 'Cloudy',
    });
    mockFetchLiveObservation.mockResolvedValue(liveObs({ metric: 'low', observedMax: 28 }));
    mockGetBankroll.mockResolvedValue(1000);
    mockExecuteAndRecordSignal.mockResolvedValue({
      signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob',
      entryPrice: 0.43, sharesFilled: null, governorStamped: true, wasEmptyBook: true,
    });

    await runWeatherScan(redisMock as never);

    const lowTraded = signalDecisionWrites().find((w) =>
      w.hasTrade === true &&
      String((w.raw as Record<string, unknown>).metric) === 'low' &&
      (w.raw as Record<string, unknown>).liveObservationConfirmed === true);
    expect(lowTraded).toBeDefined();
    expect((lowTraded!.raw as Record<string, unknown>).blockedByLiveConfirmation).toBe(false);
    const lowCall = mockExecuteAndRecordSignal.mock.calls.find((c) =>
      String((c[0] as { sourcedFrom?: string }).sourcedFrom ?? '').startsWith('weather:low:'));
    expect(lowCall).toBeDefined();
  });

  it('exact Open-Meteo NO gate blocks unconfirmed exact high brackets and records decision context', async () => {
    const target = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const targetIso = target.toISOString().slice(0, 10);
    const [py, pm, pd] = targetIso.split('-') as [string, string, string];
    const parisMonth = MONTH_NAMES2[parseInt(pm, 10) - 1] ?? 'May';
    const parisDay = parseInt(pd, 10).toString();
    const parisSlugDate = `${parisMonth.toLowerCase()}-${parisDay}-${py}`;
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const events = url.includes('tag_slug=lowest-temperature')
        ? []
        : [{
            id: 'event-paris-exact',
            title: `Highest temperature in Paris on ${parisMonth} ${parisDay}?`,
            slug: `highest-temperature-in-paris-on-${parisSlugDate}`,
            active: true,
            closed: false,
            negRisk: true,
            endDate: `${targetIso}T12:00:00Z`,
            markets: [
              {
                id: 'm-paris-low-tail',
                question: `Will the highest temperature in Paris be 19°C or below on ${parisMonth} ${parisDay}?`,
                conditionId: 'cond-paris-low-tail',
                clobTokenIds: '["tply","tpln"]',
                outcomePrices: '["0.36","0.63"]',
                outcomes: '["Yes","No"]',
                active: true,
                closed: false,
                volume: '10000',
                liquidity: '5000',
                endDate: `${targetIso}T12:00:00Z`,
                description: null,
                groupItemTitle: '19°C or below',
                groupItemThreshold: '0',
              },
              {
                id: 'm-paris-exact',
                question: `Will the highest temperature in Paris be 24°C on ${parisMonth} ${parisDay}?`,
                conditionId: 'cond-paris-exact',
                clobTokenIds: '["tpey","tpen"]',
                outcomePrices: '["0.90","0.10"]',
                outcomes: '["Yes","No"]',
                active: true,
                closed: false,
                volume: '10000',
                liquidity: '5000',
                endDate: `${targetIso}T12:00:00Z`,
                description: null,
                groupItemTitle: '24°C',
                groupItemThreshold: '1',
              },
              {
                id: 'm-paris-high-tail',
                question: `Will the highest temperature in Paris be 25°C or higher on ${parisMonth} ${parisDay}?`,
                conditionId: 'cond-paris-high-tail',
                clobTokenIds: '["tphy","tphn"]',
                outcomePrices: '["0.01","0.99"]',
                outcomes: '["Yes","No"]',
                active: true,
                closed: false,
                volume: '10000',
                liquidity: '5000',
                endDate: `${targetIso}T12:00:00Z`,
                description: null,
                groupItemTitle: '25°C or higher',
                groupItemThreshold: '2',
              },
            ],
          }];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(events) });
    }) as unknown as typeof fetch;
    mockFetchEnsemble.mockResolvedValue({
      meanHigh: 20, stddevHigh: 1, meanLow: 12, stddevLow: 1, memberCount: 31, forecastDate: targetIso,
    });
    mockFetchOpenMeteo.mockResolvedValue({
      highTemp: 20, lowTemp: 12, precipProbability: 10, forecastDate: targetIso,
    });
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      WEATHER_BLOCK_EXACT_OPEN_METEO_NO_WITHOUT_LIVE_CONFIRMATION: true,
      WEATHER_MIN_MODEL_COVERAGE: 0,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: false,
      WEATHER_MARKET_DISAGREEMENT_ENABLED: false,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    mockGetBankroll.mockResolvedValue(1000);

    await runWeatherScan(redisMock as never);

    expect(mockExecuteAndRecordSignal).not.toHaveBeenCalled();
    const exactBlocked = signalDecisionWrites().find((w) =>
      String(w.skipDetail ?? '').includes('exact_open_meteo_no_unconfirmed'));
    expect(exactBlocked).toBeDefined();
    expect(exactBlocked!.hasTrade).toBe(false);
    expect((exactBlocked!.raw as Record<string, unknown>).blockedByExactOpenMeteoNo).toBe(true);
    expect((exactBlocked!.raw as Record<string, unknown>).forecastSource).toBe('open-meteo');
  });

  // Shadow-ensemble last-good cache: a res-day fresh entry fail-closes when the
  // shadow (ECMWF) fetch returns null (429), UNLESS a last-good shadow is cached.
  const shadowEntryConfig = {
    WEATHER_SCANNER_ENABLED: true,
    WEATHER_EXECUTION_ENABLED: true,
    SIZE_UP_ENABLED: true,
    WEATHER_MAX_LOOKAHEAD_HOURS: 0,
    WEATHER_NEAR_RES_ENTRY_ENABLED: false,
    WEATHER_RES_DAY_EARLY_ENTRY_ENABLED: true,
    WEATHER_RES_DAY_MIN_HOURS_REMAINING: -100,
    WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: true,
    WEATHER_DUAL_ENSEMBLE_VETO_ENABLED: false,
    WEATHER_MARKET_DISAGREEMENT_ENABLED: false,
    ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
  };
  // Primary (GFS, useEcmwf=false) succeeds; shadow (ECMWF, useEcmwf=true) 429s → null.
  function wirePrimaryOkShadowNull() {
    wireTodayMocks();
    mockFetchEnsemble.mockImplementation((..._args: unknown[]) =>
      Promise.resolve(_args[5] // useEcmwf
        ? null
        : { meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8, memberCount: 31, forecastDate: todayIso, ensembleModel: 'gfs' }));
    mockGetBankroll.mockResolvedValue(1000);
    mockExecuteAndRecordSignal.mockResolvedValue({
      signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob',
      entryPrice: 0.43, sharesFilled: null, governorStamped: true, wasEmptyBook: true,
    });
  }

  it('res-day entry fail-closes when the fresh shadow ensemble is null and no cache exists', async () => {
    (redisMock as any).del = vi.fn().mockResolvedValue(1);
    mockLoadConfig.mockReturnValue({ ...baseConfig, ...shadowEntryConfig });
    wirePrimaryOkShadowNull(); // no shadow cache seeded

    await runWeatherScan(redisMock as never);

    // Null shadowEdge → early-entry veto fails closed → nothing executes.
    expect(mockExecuteAndRecordSignal).not.toHaveBeenCalled();
  });

  it('res-day entry recovers via the last-good shadow cache when the fresh shadow fetch is null', async () => {
    (redisMock as any).del = vi.fn().mockResolvedValue(1);
    // Seed what a prior successful scan would have cached for this city/date/metric.
    // Key format mirrors forecastCache.shadowEnsembleCacheKey (kept in sync by the
    // dedicated forecastCache unit tests; a format drift fails this test loudly).
    redisMock._store.set(
      `weather:shadow_ensemble_cache:high:chicago:${todayIso}`,
      JSON.stringify({ stdDev: 3.2, ensembleMembers: 51, ensembleModel: 'ecmwf', fetchedAt: '2026-06-27T10:00:00.000Z' }),
    );
    mockLoadConfig.mockReturnValue({ ...baseConfig, ...shadowEntryConfig });
    wirePrimaryOkShadowNull(); // identical to the test above, except the cache is seeded

    await runWeatherScan(redisMock as never);

    // The cached shadow restores shadowEdge → the entry is no longer fail-closed.
    expect(mockExecuteAndRecordSignal).toHaveBeenCalled();
    const primaryCall = mockExecuteAndRecordSignal.mock.calls.find(
      (c) => !(c[0] as { _isBracketOpposite?: boolean })._isBracketOpposite,
    );
    expect(primaryCall).toBeDefined();
  });

  it('res-day entry FAILS OPEN when shadow null + no cache + WEATHER_RES_DAY_ENTRY_FAIL_OPEN_ON_NULL_SHADOW', async () => {
    // Same as the "fail-closes" test (null fresh shadow, no cache seeded) but with the
    // fail-open flag on: the residual-null case must ALLOW the entry on the primary alone
    // (sustained ensemble-endpoint outage no longer blocks every res-day entry).
    (redisMock as any).del = vi.fn().mockResolvedValue(1);
    mockLoadConfig.mockReturnValue({
      ...baseConfig, ...shadowEntryConfig,
      WEATHER_RES_DAY_ENTRY_FAIL_OPEN_ON_NULL_SHADOW: true,
    });
    wirePrimaryOkShadowNull(); // shadow fetch null, no cache seeded

    await runWeatherScan(redisMock as never);

    expect(mockExecuteAndRecordSignal).toHaveBeenCalled();
    const primaryCall = mockExecuteAndRecordSignal.mock.calls.find(
      (c) => !(c[0] as { _isBracketOpposite?: boolean })._isBracketOpposite,
    );
    expect(primaryCall).toBeDefined();
  });

  it('res-day entry is STILL vetoed with fail-open ON when the shadow genuinely disagrees (shadowEdge ≤ 0)', async () => {
    // Safety invariant: fail-open must rescue ONLY the null case, never a real disagreement.
    // YES-only so the single tradable opp is YES 52-53°F. Primary (GFS, σ=3.2) gives it
    // positive edge (model ~0.24 vs price 0.12); the shadow (ECMWF, σ=8) collapses the
    // center-bracket prob to ~0.10 < 0.12 → shadowEdge ≤ 0. With fail-open ON it must
    // still veto (shadowEdge is a real value, not null) → nothing executes.
    (redisMock as any).del = vi.fn().mockResolvedValue(1);
    mockLoadConfig.mockReturnValue({
      ...baseConfig, ...shadowEntryConfig,
      WEATHER_TRADE_SIDES: 'YES',
      WEATHER_RES_DAY_ENTRY_FAIL_OPEN_ON_NULL_SHADOW: true,
    });
    wireTodayMocks();
    mockFetchEnsemble.mockImplementation((..._args: unknown[]) =>
      Promise.resolve(_args[5] // useEcmwf → shadow: very wide σ → collapses every tradable YES bracket below its price → shadowEdge ≤ 0
        ? { meanHigh: 52, stddevHigh: 20.0, meanLow: 38, stddevLow: 12.0, memberCount: 51, forecastDate: todayIso, ensembleModel: 'ecmwf' }
        : { meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8, memberCount: 31, forecastDate: todayIso, ensembleModel: 'gfs' }));
    mockGetBankroll.mockResolvedValue(1000);
    mockExecuteAndRecordSignal.mockResolvedValue({
      signal: { stakeUsd: 5 } as never, skipped: false, executionVenue: 'clob',
      entryPrice: 0.12, sharesFilled: null, governorStamped: true, wasEmptyBook: true,
    });

    await runWeatherScan(redisMock as never);

    expect(mockExecuteAndRecordSignal).not.toHaveBeenCalled();
  });

  it('bracket does NOT fire on resolution-day entries (isResolutionDay=true)', async () => {
    // No existing positions — with SIZE_UP_ENABLED=true but hasPosition=false, the scanner
    // falls through to the early fresh-entry path (WEATHER_RES_DAY_EARLY_ENTRY_ENABLED=true),
    // producing sizeUpScanOnly=false opportunities with isResolutionDay=true.
    // The bracket gate !opp.isResolutionDay must suppress the bracket here;
    // removing it while wasEmptyBook=true would cause the bracket to fire.
    (redisMock as any).del = vi.fn().mockResolvedValue(1); // scanner calls del on forecast fail
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_SCANNER_ENABLED: true,
      WEATHER_EXECUTION_ENABLED: true,
      WEATHER_BRACKET_ENABLED: true,
      SIZE_UP_ENABLED: true,
      WEATHER_MAX_LOOKAHEAD_HOURS: 0,
      WEATHER_NEAR_RES_ENTRY_ENABLED: false,
      WEATHER_RES_DAY_EARLY_ENTRY_ENABLED: true,
      WEATHER_RES_DAY_MIN_HOURS_REMAINING: -100, // always pass regardless of clock
      // Shadow MUST be enabled: early-entry uses fail-closed shadowEdge check
      // (shadowEdge==null also blocks). Both mocks return meanHigh=52 so
      // shadow and primary agree → shadowEdge>0 → blockedByEnsembleVeto=false.
      WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: true,
      WEATHER_DUAL_ENSEMBLE_VETO_ENABLED: false,
      WEATHER_MARKET_DISAGREEMENT_ENABLED: false,
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 60,
    });
    wireTodayMocks();
    // Override ensemble mock to include ensembleModel so the shadow ensemble is
    // populated (forecast.shadowEnsemble requires shadowEnsembleModel). Without a
    // shadow ensemble, shadowEdge=null and the early-entry fail-closed veto blocks
    // every opportunity before execution.
    mockFetchEnsemble.mockResolvedValue({
      meanHigh: 52, stddevHigh: 3.2, meanLow: 38, stddevLow: 2.8,
      memberCount: 31, forecastDate: todayIso, ensembleModel: 'gfs',
    });
    mockGetBankroll.mockResolvedValue(1000);
    mockExecuteAndRecordSignal.mockResolvedValue({
      signal: { stakeUsd: 5 } as never,
      skipped: false,
      executionVenue: 'clob',
      entryPrice: 0.43,
      sharesFilled: null,
      governorStamped: true,
      wasEmptyBook: true,
    });

    await runWeatherScan(redisMock as never);

    // getBankroll is called only after opportunities are found — if this fails,
    // the scanner found no tradable opportunities through the early-entry path.
    expect(mockGetBankroll).toHaveBeenCalled();
    // Primary must have executed (sizeUpScanOnly=false, isResolutionDay=true)
    expect(mockExecuteAndRecordSignal).toHaveBeenCalled();
    const primaryCall = mockExecuteAndRecordSignal.mock.calls.find(
      (c) => !(c[0] as { _isBracketOpposite?: boolean })._isBracketOpposite,
    );
    expect(primaryCall).toBeDefined();
    // Bracket must NOT fire — blocked by !opp.isResolutionDay (wasEmptyBook=true passes,
    // sizeUpScanOnly=false passes, orderCommitted=true passes)
    const bracketCall = mockExecuteAndRecordSignal.mock.calls.find(
      (c) => (c[0] as { _isBracketOpposite?: boolean })._isBracketOpposite === true,
    );
    expect(bracketCall).toBeUndefined();
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

// ---------------------------------------------------------------------------
// buildWeatherFillShadow — posted-price-vs-side-market shadow payload
// ---------------------------------------------------------------------------

describe('buildWeatherFillShadow', () => {
  const baseOpp = {
    marketId: '2406929',
    city: 'paris',
    bracketLabel: '20°C',
    daysOut: 1,
    isResolutionDay: false,
  };

  it('sources postedPrice from the benchmark makerPostedPrice on fills, not the VWAP entryPrice', () => {
    // On maker FILLS, result.entryPrice is the actual fill VWAP (can sit below
    // the posted limit when the GTC crossed at post time). The shadow compares
    // the POSTED price against the side market, so it must read the benchmark's
    // makerPostedPrice — logging the VWAP here would corrupt the fill-priority
    // analytics this shadow exists for.
    const shadow = buildWeatherFillShadow({
      leg: 'primary',
      side: 'NO',
      gammaSideMid: 0.65,
      edge: 0.2,
      opp: baseOpp,
      result: {
        entryPrice: 0.55, // actual fill VWAP
        skipped: false,
        entryExecutionPath: 'maker_fill',
        sharesFilled: 7.94,
        wasEmptyBook: true,
        decisionBenchmark: { decisionMidPrice: 0.5, makerPostedPrice: 0.63 },
      },
    });
    expect(shadow.postedPrice).toBe(0.63);
    // gap computed off the posted price: (0.63-0.65)/0.65 ≈ -308 bps
    expect(shadow.gapVsGammaBps).toBe(-308);
  });

  it('falls back to entryPrice for postedPrice when no maker benchmark exists', () => {
    const shadow = buildWeatherFillShadow({
      leg: 'primary',
      side: 'NO',
      gammaSideMid: 0.65,
      edge: 0.2,
      opp: baseOpp,
      result: {
        entryPrice: 0.52,
        skipped: false,
        entryExecutionPath: 'clob_direct',
        sharesFilled: 10,
        wasEmptyBook: false,
        decisionBenchmark: undefined,
      },
    });
    expect(shadow.postedPrice).toBe(0.52);
  });

  it('reports negative gap-vs-gamma when the leg rests below the scan-time Gamma price', () => {
    const shadow = buildWeatherFillShadow({
      leg: 'primary',
      side: 'NO',
      gammaSideMid: 0.65,
      edge: 0.2071,
      opp: baseOpp,
      result: {
        entryPrice: 0.52,
        skipped: false,
        skipReason: undefined,
        entryExecutionPath: 'maker_pending',
        sharesFilled: null,
        wasEmptyBook: true,
        // empty-book ⇒ decisionMidPrice is the YES-book mid (≈0.5 on a ghost book)
        decisionBenchmark: { decisionMidPrice: 0.5 },
      },
    });
    expect(shadow.leg).toBe('primary');
    expect(shadow.side).toBe('NO');
    expect(shadow.postedPrice).toBe(0.52);
    expect(shadow.gammaSideMid).toBe(0.65);
    // posted 0.52 vs Gamma 0.65 ⇒ (0.52-0.65)/0.65 = -2000 bps
    expect(shadow.gapVsGammaBps).toBe(-2000);
    expect(shadow.edge).toBe(0.207);
    expect(shadow.wasEmptyBook).toBe(true);
    expect(shadow.entryExecutionPath).toBe('maker_pending');
  });

  it('flips the empty-book YES-book mid to a side-relative clobSideMid for a NO leg', () => {
    // Empty-book NO leg: executor reports the YES-book mid (0.30). The NO side mid
    // is 1 - 0.30 = 0.70, and posted 0.52 sits (0.52-0.70)/0.70 = -2571 bps below it.
    const shadow = buildWeatherFillShadow({
      leg: 'primary',
      side: 'NO',
      gammaSideMid: 0.65,
      edge: 0.2,
      opp: baseOpp,
      result: {
        entryPrice: 0.52,
        skipped: false,
        sharesFilled: null,
        wasEmptyBook: true,
        decisionBenchmark: { decisionMidPrice: 0.3 },
      },
    });
    expect(shadow.clobSideMid).toBeCloseTo(0.7, 5);
    expect(shadow.gapVsClobBps).toBe(-2571);
  });

  it('does NOT flip the mid on a YES leg or on a real-book (non-empty) NO leg', () => {
    const yesEmpty = buildWeatherFillShadow({
      leg: 'bracket',
      side: 'YES',
      gammaSideMid: 0.2,
      edge: 0,
      opp: baseOpp,
      result: {
        entryPrice: 0.2,
        skipped: false,
        wasEmptyBook: true,
        decisionBenchmark: { decisionMidPrice: 0.2 },
      },
    });
    expect(yesEmpty.clobSideMid).toBe(0.2); // YES leg uses the YES-book mid directly

    const noRealBook = buildWeatherFillShadow({
      leg: 'primary',
      side: 'NO',
      gammaSideMid: 0.55,
      edge: 0.1,
      opp: baseOpp,
      // real book ⇒ executor read the NO-side token, so the mid is already side-relative
      result: {
        entryPrice: 0.55,
        skipped: false,
        wasEmptyBook: false,
        decisionBenchmark: { decisionMidPrice: 0.55 },
      },
    });
    expect(noRealBook.clobSideMid).toBe(0.55); // no flip
    expect(noRealBook.gapVsClobBps).toBe(0);
  });

  it('labels the bracket leg, carries zero edge, and is crash-safe with a null posted price', () => {
    const shadow = buildWeatherFillShadow({
      leg: 'bracket',
      side: 'YES',
      gammaSideMid: 0.2,
      edge: 0,
      opp: { ...baseOpp, isResolutionDay: true, daysOut: 0 },
      result: {
        entryPrice: null,
        skipped: true,
        skipReason: 'entry_price_above_cap',
        entryExecutionPath: undefined,
        sharesFilled: undefined,
        wasEmptyBook: undefined,
        decisionBenchmark: undefined,
      },
    });
    expect(shadow.leg).toBe('bracket');
    expect(shadow.edge).toBe(0);
    expect(shadow.isResolutionDay).toBe(true);
    // null posted price / missing benchmark must not produce gaps or throw
    expect(shadow.postedPrice).toBeNull();
    expect(shadow.clobSideMid).toBeNull();
    expect(shadow.gapVsClobBps).toBeNull();
    expect(shadow.gapVsGammaBps).toBeNull();
    // missing path/shares normalise to null, not undefined
    expect(shadow.entryExecutionPath).toBeNull();
    expect(shadow.sharesFilled).toBeNull();
    expect(shadow.skipReason).toBe('entry_price_above_cap');
    expect(shadow.skipped).toBe(true);
  });

  it('emits a positive gap when the leg posts above the reference (likely immediate fill)', () => {
    const shadow = buildWeatherFillShadow({
      leg: 'primary',
      side: 'NO',
      gammaSideMid: 0.5,
      edge: 0.3,
      opp: baseOpp,
      result: {
        entryPrice: 0.55,
        skipped: false,
        sharesFilled: 20,
        wasEmptyBook: false,
        decisionBenchmark: { decisionMidPrice: 0.5 },
      },
    });
    expect(shadow.gapVsGammaBps).toBe(1000);
    expect(shadow.gapVsClobBps).toBe(1000);
    expect(shadow.sharesFilled).toBe(20);
  });
});

describe('shrinkTowardMarket', () => {
  it('w=1 is the identity (no shrink — legacy behavior)', () => {
    expect(shrinkTowardMarket(0.65, 0.43, 1)).toBeCloseTo(0.65, 10);
  });

  it('w=0 returns the market price (fully market)', () => {
    expect(shrinkTowardMarket(0.65, 0.43, 0)).toBeCloseTo(0.43, 10);
  });

  it('w=0.5 is the midpoint (the configured default)', () => {
    expect(shrinkTowardMarket(0.65, 0.43, 0.5)).toBeCloseTo(0.54, 10);
  });

  it('clamps the weight to [0,1]', () => {
    expect(shrinkTowardMarket(0.65, 0.43, 2)).toBeCloseTo(0.65, 10); // >1 → 1 (identity)
    expect(shrinkTowardMarket(0.65, 0.43, -1)).toBeCloseTo(0.43, 10); // <0 → 0 (market)
  });

  it('clamps the output to [0,1]', () => {
    expect(shrinkTowardMarket(1.2, 0.9, 1)).toBe(1);
    expect(shrinkTowardMarket(-0.2, 0.1, 1)).toBe(0);
  });

  it('is sign-invariant about the price: shrunk vs price matches model vs price', () => {
    // model > price → shrunk still > price (positive edge preserved)
    expect(shrinkTowardMarket(0.65, 0.43, 0.5)).toBeGreaterThan(0.43);
    // model < price → shrunk still < price (negative edge preserved)
    expect(shrinkTowardMarket(0.30, 0.43, 0.5)).toBeLessThan(0.43);
    // model == price → shrunk == price
    expect(shrinkTowardMarket(0.43, 0.43, 0.5)).toBeCloseTo(0.43, 10);
  });

  it('reduces the Kelly stake but never flips a positive-edge entry to a skip', () => {
    // Overconfident model 0.65, market price 0.43 — the calibration case.
    const winProb = 0.65;
    const price = 0.43;
    const rawKelly = computeHalfKelly(winProb, price, 0.25);
    const shrunkKelly = computeHalfKelly(shrinkTowardMarket(winProb, price, 0.5), price, 0.25);
    expect(rawKelly).toBeGreaterThan(0);
    expect(shrunkKelly).toBeGreaterThan(0); // still a trade, not skipped
    expect(shrunkKelly).toBeLessThan(rawKelly); // but a smaller stake
  });

  it('a model prob at/below the price still yields a zero Kelly under the shrink (no synthetic edge)', () => {
    expect(computeHalfKelly(shrinkTowardMarket(0.43, 0.43, 0.5), 0.43, 0.25)).toBe(0);
    expect(computeHalfKelly(shrinkTowardMarket(0.40, 0.43, 0.5), 0.43, 0.25)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fetchForecast — ensemble-only fallback (forecast resilience)
// ---------------------------------------------------------------------------

describe('fetchForecast - ensemble-only fallback', () => {
  const amsCoords = lookupCity('amsterdam');

  function mockEvent() {
    return {
      eventId: 'ams-test',
      slug: 'amsterdam-test',
      city: 'amsterdam',
      coords: amsCoords!,
      targetDate: '2026-06-04',
      unit: 'celsius' as const,
      brackets: [],
      endDate: '2026-06-04T12:00:00Z',
    };
  }

  function goodEnsemble() {
    return {
      meanHigh: 17.8,
      stddevHigh: 1.4,
      meanLow: 11,
      stddevLow: 0.9,
      memberCount: 31,
      forecastDate: '2026-06-04',
      ensembleModel: 'gfs',
    };
  }

  beforeEach(() => {
    mockFetchEnsemble.mockReset();
    mockFetchOpenMeteo.mockReset();
    mockFetchNwsForecast.mockReset();
    mockFetchHrrr.mockReset();
  });

  it('returns null when deterministic fails and the caller did NOT opt in (entry path)', async () => {
    // The 2026-06-04 outage shape: deterministic 502s, ensemble healthy.
    mockFetchEnsemble.mockResolvedValue(goodEnsemble());
    mockFetchOpenMeteo.mockResolvedValue(null);

    const result = await fetchForecast(mockEvent(), 1, undefined, 0.7);
    expect(result).toBeNull();
  });

  it('returns an ensemble-only forecast when deterministic fails and the caller opted in (monitoring)', async () => {
    mockFetchEnsemble.mockResolvedValue(goodEnsemble());
    mockFetchOpenMeteo.mockResolvedValue(null);

    const result = await fetchForecast(
      mockEvent(), 1, undefined, 0.7, false, false, false, Infinity,
      { allowEnsembleOnly: true },
    );
    expect(result).not.toBeNull();
    expect(result!.source).toBe('ensemble-only');
    expect(result!.forecastHigh).toBeCloseTo(17.8, 6);
    expect(result!.ensembleMembers).toBe(31);
    // stdDev floored at floorStd * stddevMinFraction even on the fallback path
    const floorCelsius = getDefaultStdDev(1, 6) * (5 / 9) * 0.7;
    expect(result!.stdDev).toBeGreaterThanOrEqual(Math.min(1.4, floorCelsius) - 1e-9);
  });

  it('US city: falls back to ensemble-only when NWS, Open-Meteo, and HRRR all fail (opted in)', async () => {
    const chiCoords = lookupCity('chicago');
    const event = {
      eventId: 'chi-test', slug: 'chicago-test', city: 'chicago',
      coords: chiCoords!, targetDate: '2026-06-05', unit: 'fahrenheit' as const,
      brackets: [], endDate: '2026-06-05T12:00:00Z',
    };
    mockFetchEnsemble.mockResolvedValue({ ...goodEnsemble(), meanHigh: 78.4, stddevHigh: 3.1 });
    mockFetchNwsForecast.mockResolvedValue(null);
    mockFetchOpenMeteo.mockResolvedValue(null);

    const result = await fetchForecast(
      event, 1, undefined, 0.7, false, false, false, Infinity,
      { allowEnsembleOnly: true },
    );
    expect(result).not.toBeNull();
    expect(result!.source).toBe('ensemble-only');
    expect(result!.forecastHigh).toBeCloseTo(78.4, 6);
  });

  it('still returns null when BOTH deterministic and ensemble fail, even when opted in', async () => {
    mockFetchEnsemble.mockResolvedValue(null);
    mockFetchOpenMeteo.mockResolvedValue(null);

    const result = await fetchForecast(
      mockEvent(), 1, undefined, 0.7, false, false, false, Infinity,
      { allowEnsembleOnly: true },
    );
    expect(result).toBeNull();
  });

  it('threads opts.retryCount through to the underlying fetchers', async () => {
    mockFetchEnsemble.mockResolvedValue(goodEnsemble());
    mockFetchOpenMeteo.mockResolvedValue({
      highTemp: 18, lowTemp: 11, precipProbability: 10, forecastDate: '2026-06-04',
    });

    await fetchForecast(
      mockEvent(), 1, undefined, 0.7, false, false, false, Infinity,
      { retryCount: 2 },
    );
    // fetchOpenMeteoForecast(lat, lon, date, unit, fetchFn, retryCount)
    expect(mockFetchOpenMeteo).toHaveBeenCalledWith(
      expect.any(Number), expect.any(Number), '2026-06-04', 'celsius', undefined, 2,
    );
    // fetchEnsembleForecast(lat, lon, date, unit, fetchFn, useEcmwf, retryCount, metric)
    expect(mockFetchEnsemble).toHaveBeenCalledWith(
      expect.any(Number), expect.any(Number), '2026-06-04', 'celsius', undefined, false, 2, 'high',
    );
  });
});

// ---------------------------------------------------------------------------
// scanWeatherMarkets — outage alert + forecast cache write
// ---------------------------------------------------------------------------

describe('scanWeatherMarkets - outage alert and forecast cache', () => {
  // +72h, not +24h: with a "tomorrow" (UTC) target date the CEST cities cross
  // local midnight at 22:00 UTC, the synthetic event silently becomes
  // resolution-day for them, and the scan takes the early-res-day path —
  // these tests then fail in the 22:00–00:00 UTC wall-clock window (observed
  // 2026-06-05 22:04 UTC; pre-existing flake, unrelated to any code change).
  // Three days out is res-day for no city at any wall-clock time.
  const tomorrow = new Date(Date.now() + 72 * 60 * 60 * 1000);
  const tomorrowIso = tomorrow.toISOString().slice(0, 10);
  const [oy, om, od] = tomorrowIso.split('-') as [string, string, string];
  const O_MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const oMonthName = O_MONTHS[parseInt(om, 10) - 1] ?? 'June';
  const oTitleDate = `${oMonthName} ${parseInt(od, 10).toString()}`;
  const oSlugDate = `${oMonthName.toLowerCase()}-${parseInt(od, 10).toString()}-${oy}`;
  const oEndDate = `${tomorrowIso}T12:00:00Z`;

  function makeIntlEvent(city: string, cityTitle: string) {
    return {
      id: `event-${city}`,
      title: `Highest temperature in ${cityTitle} on ${oTitleDate}?`,
      slug: `highest-temperature-in-${city.replace(/ /g, '-')}-on-${oSlugDate}`,
      active: true,
      closed: false,
      negRisk: true,
      endDate: oEndDate,
      markets: Array.from({ length: 3 }, (_, i) => {
        const labels = ['16°C or below', '17°C', '18°C or higher'];
        const yesPrices = [0.2, 0.5, 0.3];
        return {
          id: `m-${city}-${i}`,
          question: `Will the highest temperature in ${cityTitle} be ${labels[i]} on ${oTitleDate}?`,
          conditionId: `cond-${city}-${i}`,
          clobTokenIds: `["t${city}${i}y","t${city}${i}n"]`,
          outcomePrices: `["${(yesPrices[i] ?? 0).toFixed(2)}","${(1 - (yesPrices[i] ?? 0)).toFixed(2)}"]`,
          outcomes: '["Yes","No"]',
          active: true,
          closed: false,
          volume: '10000',
          liquidity: '5000',
          endDate: oEndDate,
          description: null,
          groupItemTitle: labels[i],
          groupItemThreshold: i.toString(),
        };
      }),
    };
  }

  const SIX_CITIES: Array<[string, string]> = [
    ['amsterdam', 'Amsterdam'], ['london', 'London'], ['paris', 'Paris'],
    ['madrid', 'Madrid'], ['milan', 'Milan'], ['istanbul', 'Istanbul'],
  ];

  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    savedFetch = globalThis.fetch;
    mockGetBankroll.mockResolvedValue(1000);
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  function wireEvents(cities: Array<[string, string]>) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve(cities.map(([c, t]) => makeIntlEvent(c, t))),
    }) as unknown as typeof fetch;
  }

  function allForecastsFail() {
    mockFetchEnsemble.mockResolvedValue(null);
    mockFetchOpenMeteo.mockResolvedValue(null);
    mockFetchNwsForecast.mockResolvedValue(null);
  }

  it('sends ONE deduped Telegram alert when the forecast failure rate exceeds the threshold', async () => {
    const redisMock = createRedisMock();
    mockLoadConfig.mockReturnValue({ ...baseConfig, WEATHER_OUTAGE_ALERT_ENABLED: true });
    wireEvents(SIX_CITIES);
    allForecastsFail();

    await scanWeatherMarkets(redisMock as never);

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(String(mockNotify.mock.calls[0]![0])).toContain('forecast provider degraded');
    expect(redisMock.set).toHaveBeenCalledWith(
      'weather:outage_alert', '1', 'EX', 14_400, 'NX',
    );
  });

  it('suppresses the alert while the dedup key is live', async () => {
    const redisMock = createRedisMock();
    redisMock._store.set('weather:outage_alert', '1'); // prior alert within the window
    mockLoadConfig.mockReturnValue({ ...baseConfig, WEATHER_OUTAGE_ALERT_ENABLED: true });
    wireEvents(SIX_CITIES);
    allForecastsFail();

    await scanWeatherMarkets(redisMock as never);

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('does not alert below the minimum attempted-fetch sample size', async () => {
    const redisMock = createRedisMock();
    mockLoadConfig.mockReturnValue({ ...baseConfig, WEATHER_OUTAGE_ALERT_ENABLED: true });
    wireEvents(SIX_CITIES.slice(0, 3)); // 3 attempted < 5 — even at 100% failure
    allForecastsFail();

    await scanWeatherMarkets(redisMock as never);

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('does not alert when WEATHER_OUTAGE_ALERT_ENABLED=false', async () => {
    const redisMock = createRedisMock();
    mockLoadConfig.mockReturnValue({ ...baseConfig }); // base: disabled
    wireEvents(SIX_CITIES);
    allForecastsFail();

    await scanWeatherMarkets(redisMock as never);

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('writes the successful forecast to the cache keyed by city and target date', async () => {
    const redisMock = createRedisMock();
    mockLoadConfig.mockReturnValue({ ...baseConfig });
    wireEvents([['amsterdam', 'Amsterdam']]);
    mockFetchEnsemble.mockResolvedValue({
      meanHigh: 17.8, stddevHigh: 1.4, meanLow: 11, stddevLow: 0.9,
      memberCount: 31, forecastDate: tomorrowIso, ensembleModel: 'gfs',
    });
    mockFetchOpenMeteo.mockResolvedValue({
      highTemp: 18, lowTemp: 11, precipProbability: 10, forecastDate: tomorrowIso,
    });

    await scanWeatherMarkets(redisMock as never);
    // cacheForecast is fire-and-forget — let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 0));

    const cacheKey = `weather:forecast_cache:high:amsterdam:${tomorrowIso}`;
    expect(redisMock._store.has(cacheKey)).toBe(true);
    const payload = JSON.parse(redisMock._store.get(cacheKey)!) as { forecastHigh: number };
    expect(payload.forecastHigh).toBe(18);
  });

  it('does not write a cache entry when the forecast fetch fails', async () => {
    const redisMock = createRedisMock();
    mockLoadConfig.mockReturnValue({ ...baseConfig });
    wireEvents([['amsterdam', 'Amsterdam']]);
    allForecastsFail();

    await scanWeatherMarkets(redisMock as never);
    await new Promise((r) => setTimeout(r, 0));

    const cacheKey = `weather:forecast_cache:high:amsterdam:${tomorrowIso}`;
    expect(redisMock._store.has(cacheKey)).toBe(false);
  });
});

describe('partitionTradableByEntryCap', () => {
  const cfg = { WEATHER_MAX_ENTRY_PRICE: 0.75, WEATHER_EARLY_ENTRY_MAX_PRICE: 0.55 };

  it('moves out-of-range opportunities behind in-range ones, preserving order within groups', () => {
    const tradable = [
      { marketId: 'a', outcomePrice: 0.80, isResolutionDay: false },  // out (pre-res cap 0.55)
      { marketId: 'b', outcomePrice: 0.50, isResolutionDay: false },  // in
      { marketId: 'c', outcomePrice: 0.60, isResolutionDay: false },  // out
      { marketId: 'd', outcomePrice: 0.30, isResolutionDay: true },   // in
    ];
    const result = partitionTradableByEntryCap(tradable as never, cfg);
    expect(result.map((o: { marketId: string }) => o.marketId)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('uses WEATHER_MAX_ENTRY_PRICE (not the early cap) on resolution day', () => {
    const tradable = [
      { marketId: 'a', outcomePrice: 0.70, isResolutionDay: true },   // in: 0.70 ≤ 0.75
      { marketId: 'b', outcomePrice: 0.70, isResolutionDay: false },  // out: 0.70 > 0.55
      { marketId: 'c', outcomePrice: 0.80, isResolutionDay: true },   // out: 0.80 > 0.75
    ];
    const result = partitionTradableByEntryCap(tradable as never, cfg);
    expect(result.map((o: { marketId: string }) => o.marketId)).toEqual(['a', 'b', 'c']);
  });

  it('treats size-up rows as in-range regardless of price', () => {
    const tradable = [
      { marketId: 'a', outcomePrice: 0.90, isResolutionDay: false, sizeUpScanOnly: true },
      { marketId: 'b', outcomePrice: 0.50, isResolutionDay: false },
    ];
    const result = partitionTradableByEntryCap(tradable as never, cfg);
    expect(result.map((o: { marketId: string }) => o.marketId)).toEqual(['a', 'b']);
  });

  it('is a no-op when the caps are disabled (0)', () => {
    const tradable = [
      { marketId: 'a', outcomePrice: 0.99, isResolutionDay: false },
      { marketId: 'b', outcomePrice: 0.10, isResolutionDay: false },
    ];
    const result = partitionTradableByEntryCap(tradable as never, {
      WEATHER_MAX_ENTRY_PRICE: 0,
      WEATHER_EARLY_ENTRY_MAX_PRICE: 0,
    });
    expect(result.map((o: { marketId: string }) => o.marketId)).toEqual(['a', 'b']);
  });
});

describe('revalidateRestingWeatherOrders', () => {
  const revalidationConfig = () => ({
    ...baseConfig,
    WEATHER_RESTING_REVALIDATION_ENABLED: true,
  });

  function pendingEntry(overrides: {
    marketId?: string;
    direction?: 'YES' | 'NO';
    order?: Record<string, unknown>;
  } = {}) {
    return {
      marketId: overrides.marketId ?? 'mkt-1',
      direction: overrides.direction ?? 'NO',
      order: {
        orderId: 'order-1',
        tokenId: 'tok',
        price: 0.55,
        size: 10,
        postedAt: 1,
        expiresAt: Date.now() + 3_600_000,
        consensusP: 0.30,
        direction: overrides.direction ?? 'NO',
        source: 'weather',
        edgeMagnitude: 0.20,
        ...overrides.order,
      },
    };
  }

  function liveOrder(matched: string, original = '10') {
    return {
      id: 'order-1',
      status: 'LIVE',
      size_matched: matched,
      original_size: original,
    };
  }

  // Minimal opportunity shape: the primary rule reads marketId + modelProbability;
  // the bracket rule additionally reads isResolutionDay + yesPrice/noPrice.
  function opp(marketId: string, modelProbability: number, extra: Record<string, unknown> = {}) {
    return { marketId, modelProbability, ...extra } as never;
  }

  beforeEach(() => {
    mockListPendingOrders.mockReset();
    mockDeletePendingOrder.mockReset();
    mockGetClobOrder.mockReset();
    mockCancelClobOrder.mockReset();
    mockDeletePendingOrder.mockResolvedValue(undefined);
    mockLoadConfig.mockReturnValue(revalidationConfig() as never);
  });

  it('cancels a primary whose side-FV dropped below the posted price and deletes the key', async () => {
    // NO posted at 0.55; fresh model P(YES)=0.80 → NO side FV = 0.20 < 0.55 → cancel.
    mockListPendingOrders.mockResolvedValue([pendingEntry()]);
    mockGetClobOrder
      .mockResolvedValueOnce(liveOrder('0'))   // pre-cancel read: nothing filled
      .mockResolvedValueOnce(null);            // post-cancel read: order gone
    mockCancelClobOrder.mockResolvedValue(true);

    await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.80)]);

    expect(mockCancelClobOrder).toHaveBeenCalledWith('order-1');
    expect(mockDeletePendingOrder).toHaveBeenCalledWith(expect.anything(), 'mkt-1', 'NO');
  });

  it('keeps a primary whose side-FV still supports the posted price', async () => {
    // NO posted at 0.55; fresh P(YES)=0.20 → NO side FV = 0.80 > 0.55 → keep resting.
    mockListPendingOrders.mockResolvedValue([pendingEntry()]);

    await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.20)]);

    expect(mockCancelClobOrder).not.toHaveBeenCalled();
    expect(mockDeletePendingOrder).not.toHaveBeenCalled();
  });

  it('keeps far-NO ladder bids through primary FV revalidation for queue priority', async () => {
    // A ladder NO can intentionally rest at 0.94 below a 0.99 ask even when the
    // current fresh FV no longer supports that price. The ladder marker gives it
    // a dedicated lifecycle: hold until fill, explicit external cancel, or the
    // post-resolution sweep.
    mockListPendingOrders.mockResolvedValue([
      pendingEntry({
        order: {
          isWeatherFarNoLadder: true,
          price: 0.94,
          edgeMagnitude: 0.04,
        },
      }),
    ]);

    await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.20)]);

    expect(mockGetClobOrder).not.toHaveBeenCalled();
    expect(mockCancelClobOrder).not.toHaveBeenCalled();
    expect(mockDeletePendingOrder).not.toHaveBeenCalled();
  });

  it('never cancels bracket-opposite legs, flagged or legacy (edge=0)', async () => {
    mockListPendingOrders.mockResolvedValue([
      pendingEntry({ marketId: 'mkt-1', order: { isBracketOpposite: true } }),
      pendingEntry({ marketId: 'mkt-2', order: { edgeMagnitude: 0 } }), // legacy blob heuristic
    ]);

    await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.80), opp('mkt-2', 0.80)]);

    expect(mockCancelClobOrder).not.toHaveBeenCalled();
    expect(mockDeletePendingOrder).not.toHaveBeenCalled();
  });

  it('never cancels legacy blobs missing edgeMagnitude entirely (when in doubt, do not cancel)', async () => {
    // A real pre-flag legacy blob in Redis has neither isBracketOpposite nor
    // edgeMagnitude — it could be a bracket leg, so it must be left alone.
    mockListPendingOrders.mockResolvedValue([
      pendingEntry({ order: { edgeMagnitude: undefined } }),
    ]);

    await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.80)]);

    expect(mockCancelClobOrder).not.toHaveBeenCalled();
    expect(mockDeletePendingOrder).not.toHaveBeenCalled();
  });

  it('leaves orders for markets outside the current scan universe untouched', async () => {
    mockListPendingOrders.mockResolvedValue([pendingEntry({ marketId: 'mkt-gone' })]);

    await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.80)]);

    expect(mockGetClobOrder).not.toHaveBeenCalled();
    expect(mockCancelClobOrder).not.toHaveBeenCalled();
  });

  it('zero opportunities (Gamma outage): FV rule inert, pre-resolution orders untouched', async () => {
    // The post-resolution sweep proceeds on an outage (resolution-based, not
    // FV-based), so listPendingOrders IS consulted — but a pre-resolution order
    // (default pendingEntry has no sourcedFrom → not past resolution) has no
    // rule left to fire: the FV rule needs an opportunity row it doesn't have.
    mockListPendingOrders.mockResolvedValue([pendingEntry()]);

    await revalidateRestingWeatherOrders({} as never, []);

    expect(mockListPendingOrders).toHaveBeenCalled();
    expect(mockCancelClobOrder).not.toHaveBeenCalled();
    expect(mockDeletePendingOrder).not.toHaveBeenCalled();
  });

  it('zero opportunities with only the bracket knob on: fully inert (no Redis scan)', async () => {
    // Without the primary (revalidation) knob there is no resolution-based
    // rule, so the original outage fail-safe applies in full.
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_BRACKET_CANCEL_ENABLED: true,
      WEATHER_RESTING_REVALIDATION_ENABLED: false,
    } as never);
    mockListPendingOrders.mockResolvedValue([pendingEntry()]);

    await revalidateRestingWeatherOrders({} as never, []);

    expect(mockListPendingOrders).not.toHaveBeenCalled();
  });

  it('is inert when BOTH the revalidation and bracket-cancel knobs are off', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig } as never); // both default false
    mockListPendingOrders.mockResolvedValue([pendingEntry()]);

    await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.80)]);

    expect(mockListPendingOrders).not.toHaveBeenCalled();
  });

  it('cancels the residual but KEEPS the pending key when the order partially filled', async () => {
    mockListPendingOrders.mockResolvedValue([pendingEntry()]);
    mockGetClobOrder
      .mockResolvedValueOnce(liveOrder('4'))  // pre-cancel: 4/10 filled
      .mockResolvedValueOnce(liveOrder('4')); // post-cancel: still 4 matched
    mockCancelClobOrder.mockResolvedValue(true);

    await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.80)]);

    expect(mockCancelClobOrder).toHaveBeenCalledWith('order-1');
    // Key kept → reconciler links the on-chain fill to its metadata.
    expect(mockDeletePendingOrder).not.toHaveBeenCalled();
  });

  it('skips fully-filled orders entirely (resume/reconciler will record the position)', async () => {
    mockListPendingOrders.mockResolvedValue([pendingEntry()]);
    mockGetClobOrder.mockResolvedValueOnce(liveOrder('10', '10'));

    await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.80)]);

    expect(mockCancelClobOrder).not.toHaveBeenCalled();
    expect(mockDeletePendingOrder).not.toHaveBeenCalled();
  });

  it('keeps the key and retries next scan when the cancel cannot be confirmed', async () => {
    mockListPendingOrders.mockResolvedValue([pendingEntry()]);
    mockGetClobOrder
      .mockResolvedValueOnce(liveOrder('0'))   // pre-cancel read
      .mockResolvedValueOnce(liveOrder('0'));  // confirm read: still LIVE
    mockCancelClobOrder.mockResolvedValue(false);

    await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.80)]);

    expect(mockDeletePendingOrder).not.toHaveBeenCalled();
  });

  describe('post-resolution sweep (market past city-local resolution)', () => {
    // isWeatherOrderPastResolution parses sourcedFrom
    // (weather:<city>:<YYYY-MM-DD>:<bracket>) and compares now to the
    // city-local end-of-day. A past date is resolved; a far-future date is
    // not. 'chicago' is a lookupCity-known city; expiresAt is irrelevant now.
    const resolved = () => ({ sourcedFrom: 'weather:chicago:2020-01-01:40-41°F' });
    const unresolved = () => ({ sourcedFrom: 'weather:chicago:2999-12-31:40-41°F' });

    it('cancels a post-resolution primary even when its market is outside the scan universe', async () => {
      mockListPendingOrders.mockResolvedValue([
        pendingEntry({ marketId: 'mkt-gone', order: resolved() }),
      ]);
      mockGetClobOrder
        .mockResolvedValueOnce(liveOrder('0'))   // pre-cancel read: nothing filled
        .mockResolvedValueOnce(null);            // post-cancel read: order gone
      mockCancelClobOrder.mockResolvedValue(true);

      await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.80)]);

      expect(mockCancelClobOrder).toHaveBeenCalledWith('order-1');
      expect(mockDeletePendingOrder).toHaveBeenCalledWith(expect.anything(), 'mkt-gone', 'NO');
    });

    it('sweeps post-resolution primaries even on a Gamma outage (zero opportunities)', async () => {
      mockListPendingOrders.mockResolvedValue([pendingEntry({ order: resolved() })]);
      mockGetClobOrder
        .mockResolvedValueOnce(liveOrder('0'))
        .mockResolvedValueOnce(null);
      mockCancelClobOrder.mockResolvedValue(true);

      await revalidateRestingWeatherOrders({} as never, []);

      expect(mockCancelClobOrder).toHaveBeenCalledWith('order-1');
      expect(mockDeletePendingOrder).toHaveBeenCalledWith(expect.anything(), 'mkt-1', 'NO');
    });

    it('does NOT sweep a pre-resolution primary — held for queue priority — even out of universe and long past expiresAt', async () => {
      // The core of the fix: an unfilled weather maker on a still-live market is
      // kept resting (CLOB queue/time priority preserved) regardless of
      // expiresAt, even when the scanner has stopped emitting it. The executor
      // holds it; the sweep only clears it after actual resolution.
      mockListPendingOrders.mockResolvedValue([
        pendingEntry({
          marketId: 'mkt-gone',
          order: { ...unresolved(), expiresAt: Date.now() - 86_400_000 },
        }),
      ]);

      await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.80)]);

      expect(mockGetClobOrder).not.toHaveBeenCalled();
      expect(mockCancelClobOrder).not.toHaveBeenCalled();
      expect(mockDeletePendingOrder).not.toHaveBeenCalled();
    });

    it('never sweeps bracket legs, however old — their lifecycle is the bracket rule', async () => {
      mockLoadConfig.mockReturnValue({
        ...revalidationConfig(),
        WEATHER_BRACKET_CANCEL_ENABLED: true,
      } as never);
      mockListPendingOrders.mockResolvedValue([
        pendingEntry({
          marketId: 'mkt-gone', // out of universe → bracket rule can't fire either
          order: { isBracketOpposite: true, edgeMagnitude: 0, ...resolved() },
        }),
      ]);

      await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.80)]);

      expect(mockCancelClobOrder).not.toHaveBeenCalled();
      expect(mockDeletePendingOrder).not.toHaveBeenCalled();
    });

    it('never sweeps ambiguous legacy blobs (no bracket flag, edge ≤ 0)', async () => {
      mockListPendingOrders.mockResolvedValue([
        pendingEntry({ order: { edgeMagnitude: 0, ...resolved() } }),
      ]);

      await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.20)]);

      expect(mockGetClobOrder).not.toHaveBeenCalled();
      expect(mockCancelClobOrder).not.toHaveBeenCalled();
    });

    it('is inert (no sweep) when the revalidation knob is off, even with the bracket knob on', async () => {
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_BRACKET_CANCEL_ENABLED: true,
        WEATHER_RESTING_REVALIDATION_ENABLED: false,
      } as never);
      mockListPendingOrders.mockResolvedValue([
        pendingEntry({ marketId: 'mkt-1', order: resolved() }),
      ]);

      await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.80)]);

      expect(mockCancelClobOrder).not.toHaveBeenCalled();
      expect(mockDeletePendingOrder).not.toHaveBeenCalled();
    });

    it('keeps the key on a partial fill (residual cancelled, reconciler attribution preserved)', async () => {
      mockListPendingOrders.mockResolvedValue([
        pendingEntry({ marketId: 'mkt-gone', order: resolved() }),
      ]);
      mockGetClobOrder
        .mockResolvedValueOnce(liveOrder('4'))  // pre-cancel: 4/10 filled
        .mockResolvedValueOnce(liveOrder('4')); // post-cancel: still 4 matched
      mockCancelClobOrder.mockResolvedValue(true);

      await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.80)]);

      expect(mockCancelClobOrder).toHaveBeenCalledWith('order-1');
      expect(mockDeletePendingOrder).not.toHaveBeenCalled();
    });

    it('keeps the key when the order is gone from the CLOB (possible unattributed fill)', async () => {
      mockListPendingOrders.mockResolvedValue([
        pendingEntry({ marketId: 'mkt-gone', order: resolved() }),
      ]);
      mockGetClobOrder.mockResolvedValueOnce(null); // vanished — fill or external cancel

      await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.80)]);

      expect(mockCancelClobOrder).not.toHaveBeenCalled();
      expect(mockDeletePendingOrder).not.toHaveBeenCalled();
    });

    it('does not sweep when sourcedFrom is unparseable / city unknown (fail-safe)', async () => {
      // Unknown city → lookupCity returns undefined → cannot compute resolution
      // → not swept (the Redis key TTL is the backstop). A date well in the past
      // confirms it is the city lookup, not the date, that fails safe.
      mockListPendingOrders.mockResolvedValue([
        pendingEntry({ marketId: 'mkt-gone', order: { sourcedFrom: 'weather:atlantis:2020-01-01:40°F' } }),
      ]);

      await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.80)]);

      expect(mockGetClobOrder).not.toHaveBeenCalled();
      expect(mockCancelClobOrder).not.toHaveBeenCalled();
      expect(mockDeletePendingOrder).not.toHaveBeenCalled();
    });

    it('post-resolution + in-universe + value-negative is handled once (sweep, not FV)', async () => {
      // Both the post-res sweep and the FV rule would match; the sweep runs
      // first and `continue`s, so the FV rule must not re-process it.
      mockListPendingOrders.mockResolvedValue([pendingEntry({ order: resolved() })]);
      mockGetClobOrder
        .mockResolvedValueOnce(liveOrder('0'))
        .mockResolvedValueOnce(null);
      mockCancelClobOrder.mockResolvedValue(true);

      await revalidateRestingWeatherOrders({} as never, [opp('mkt-1', 0.80)]);

      expect(mockCancelClobOrder).toHaveBeenCalledTimes(1);
      expect(mockDeletePendingOrder).toHaveBeenCalledTimes(1);
    });
  });

  describe('bracket-leg cancel (late res-day + early certainty)', () => {
    const bracketCancelConfig = () => ({
      ...baseConfig,
      WEATHER_BRACKET_CANCEL_ENABLED: true,
      WEATHER_BRACKET_CANCEL_LOCAL_HOUR: 18,
      WEATHER_BRACKET_CANCEL_PRIMARY_PRICE: 0.95,
      // Bracket rule must work independently of the primary FV rule.
      WEATHER_RESTING_REVALIDATION_ENABLED: false,
    });

    function bracketEntry(overrides: Record<string, unknown> = {}) {
      // Leg direction NO → primary side is YES (primarySidePrice = opp.yesPrice).
      return pendingEntry({ order: { isBracketOpposite: true, edgeMagnitude: 0, ...overrides } });
    }

    // 'london' resolves via the real lookupCity (the late-hour arm needs a tz).
    const resDayOpp = (extra: Record<string, unknown> = {}) =>
      opp('mkt-1', 0.80, { city: 'london', isResolutionDay: true, yesPrice: 0.60, noPrice: 0.40, ...extra });

    beforeEach(() => {
      mockCityLocalHour.mockReset();
      mockLoadConfig.mockReturnValue(bracketCancelConfig() as never);
    });

    it('cancels an unfilled bracket leg LATE on resolution day (local hour ≥ threshold)', async () => {
      mockCityLocalHour.mockReturnValue(19); // past 18:00 local — high realized
      mockListPendingOrders.mockResolvedValue([bracketEntry()]);
      mockGetClobOrder
        .mockResolvedValueOnce(liveOrder('0'))  // pre-cancel: nothing filled
        .mockResolvedValueOnce(null);           // post-cancel: order gone
      mockCancelClobOrder.mockResolvedValue(true);

      await revalidateRestingWeatherOrders({} as never, [resDayOpp()]);

      expect(mockCancelClobOrder).toHaveBeenCalledWith('order-1');
      expect(mockDeletePendingOrder).toHaveBeenCalledWith(expect.anything(), 'mkt-1', 'NO');
    });

    it('keeps the leg EARLY on resolution day — whipsaw dips through the bid stay capturable', async () => {
      mockCityLocalHour.mockReturnValue(10); // mid-morning: high not realized yet
      mockListPendingOrders.mockResolvedValue([bracketEntry()]);

      // Even with the primary side near-certain (0.97): the certainty arm is
      // pre-res-day only — on res-day, time governs, not price.
      await revalidateRestingWeatherOrders({} as never, [
        resDayOpp({ yesPrice: 0.97, noPrice: 0.03 }),
      ]);

      expect(mockCancelClobOrder).not.toHaveBeenCalled();
      expect(mockDeletePendingOrder).not.toHaveBeenCalled();
    });

    it('late-hour arm fails safe when the city timezone is unknown', async () => {
      mockCityLocalHour.mockReturnValue(23);
      mockListPendingOrders.mockResolvedValue([bracketEntry()]);

      await revalidateRestingWeatherOrders({} as never, [
        resDayOpp({ city: 'atlantis-unknown-city' }),
      ]);

      expect(mockCancelClobOrder).not.toHaveBeenCalled();
    });

    it('late-hour arm disabled (24) → res-day legs are never time-cancelled', async () => {
      mockCityLocalHour.mockReturnValue(23);
      mockLoadConfig.mockReturnValue({
        ...bracketCancelConfig(),
        WEATHER_BRACKET_CANCEL_LOCAL_HOUR: 24,
      } as never);
      mockListPendingOrders.mockResolvedValue([bracketEntry()]);

      await revalidateRestingWeatherOrders({} as never, [resDayOpp()]);

      expect(mockCancelClobOrder).not.toHaveBeenCalled();
    });

    it('keeps a pre-res-day bracket leg while the primary side is below the certainty threshold', async () => {
      mockListPendingOrders.mockResolvedValue([bracketEntry()]);

      await revalidateRestingWeatherOrders({} as never, [
        opp('mkt-1', 0.80, { isResolutionDay: false, yesPrice: 0.92, noPrice: 0.08 }),
      ]);

      expect(mockCancelClobOrder).not.toHaveBeenCalled();
      expect(mockDeletePendingOrder).not.toHaveBeenCalled();
    });

    it('cancels a pre-res-day bracket leg when the primary side reaches the certainty threshold', async () => {
      // Leg is NO → primary side is YES at 0.96 ≥ 0.95 → settled a day early.
      mockListPendingOrders.mockResolvedValue([bracketEntry()]);
      mockGetClobOrder
        .mockResolvedValueOnce(liveOrder('0'))
        .mockResolvedValueOnce(null);
      mockCancelClobOrder.mockResolvedValue(true);

      await revalidateRestingWeatherOrders({} as never, [
        opp('mkt-1', 0.80, { isResolutionDay: false, yesPrice: 0.96, noPrice: 0.04 }),
      ]);

      expect(mockCancelClobOrder).toHaveBeenCalledWith('order-1');
      expect(mockDeletePendingOrder).toHaveBeenCalledWith(expect.anything(), 'mkt-1', 'NO');
    });

    it('uses the leg direction to pick the primary side (YES leg → noPrice)', async () => {
      // YES leg → primary side is NO; noPrice 0.96 ≥ 0.95 → cancel.
      mockListPendingOrders.mockResolvedValue([
        pendingEntry({ direction: 'YES', order: { isBracketOpposite: true, direction: 'YES' } }),
      ]);
      mockGetClobOrder
        .mockResolvedValueOnce(liveOrder('0'))
        .mockResolvedValueOnce(null);
      mockCancelClobOrder.mockResolvedValue(true);

      await revalidateRestingWeatherOrders({} as never, [
        opp('mkt-1', 0.04, { isResolutionDay: false, yesPrice: 0.04, noPrice: 0.96 }),
      ]);

      expect(mockCancelClobOrder).toHaveBeenCalledWith('order-1');
      expect(mockDeletePendingOrder).toHaveBeenCalledWith(expect.anything(), 'mkt-1', 'YES');
    });

    it('certainty arm disabled (0) → pre-res-day legs are kept regardless of primary price', async () => {
      mockLoadConfig.mockReturnValue({
        ...bracketCancelConfig(),
        WEATHER_BRACKET_CANCEL_PRIMARY_PRICE: 0,
      } as never);
      mockListPendingOrders.mockResolvedValue([bracketEntry()]);

      await revalidateRestingWeatherOrders({} as never, [
        opp('mkt-1', 0.80, { isResolutionDay: false, yesPrice: 0.97, noPrice: 0.03 }),
      ]);

      expect(mockCancelClobOrder).not.toHaveBeenCalled();
    });

    it('never cancels legacy ambiguous blobs even late on resolution day', async () => {
      // Pre-flag blob: no isBracketOpposite, edge 0 — could be either kind.
      mockCityLocalHour.mockReturnValue(20);
      mockListPendingOrders.mockResolvedValue([
        pendingEntry({ order: { edgeMagnitude: 0 } }),
      ]);

      await revalidateRestingWeatherOrders({} as never, [
        resDayOpp({ yesPrice: 0.95, noPrice: 0.05 }),
      ]);

      expect(mockCancelClobOrder).not.toHaveBeenCalled();
      expect(mockDeletePendingOrder).not.toHaveBeenCalled();
    });

    it('partial-filled bracket leg late on res-day: residual cancelled, key kept for reconciler', async () => {
      mockCityLocalHour.mockReturnValue(20);
      mockListPendingOrders.mockResolvedValue([bracketEntry()]);
      mockGetClobOrder
        .mockResolvedValueOnce(liveOrder('3'))   // 3/10 filled pre-cancel
        .mockResolvedValueOnce(liveOrder('3'));  // still 3 after cancel
      mockCancelClobOrder.mockResolvedValue(true);

      await revalidateRestingWeatherOrders({} as never, [resDayOpp()]);

      expect(mockCancelClobOrder).toHaveBeenCalledWith('order-1');
      expect(mockDeletePendingOrder).not.toHaveBeenCalled();
    });

    it('bracket knob off → res-day legs are left alone (legacy behaviour)', async () => {
      mockCityLocalHour.mockReturnValue(20);
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_RESTING_REVALIDATION_ENABLED: true,
        WEATHER_BRACKET_CANCEL_ENABLED: false,
      } as never);
      mockListPendingOrders.mockResolvedValue([bracketEntry()]);

      await revalidateRestingWeatherOrders({} as never, [resDayOpp()]);

      expect(mockCancelClobOrder).not.toHaveBeenCalled();
    });

    it('primary FV rule stays gated on its own knob while the bracket rule runs', async () => {
      // REVALIDATION off + BRACKET_CANCEL on: a value-negative PRIMARY must be
      // kept while a late-res-day bracket leg in the same pass is cancelled.
      mockCityLocalHour.mockReturnValue(20);
      mockListPendingOrders.mockResolvedValue([
        pendingEntry({ marketId: 'mkt-primary' }), // primary, sideFV 0.20 < 0.55
        { ...bracketEntry(), marketId: 'mkt-bracket' },
      ]);
      mockGetClobOrder
        .mockResolvedValueOnce(liveOrder('0'))
        .mockResolvedValueOnce(null);
      mockCancelClobOrder.mockResolvedValue(true);

      await revalidateRestingWeatherOrders({} as never, [
        opp('mkt-primary', 0.80, { isResolutionDay: false }),
        opp('mkt-bracket', 0.80, { city: 'london', isResolutionDay: true, yesPrice: 0.60, noPrice: 0.40 }),
      ]);

      expect(mockCancelClobOrder).toHaveBeenCalledTimes(1);
      expect(mockDeletePendingOrder).toHaveBeenCalledWith(expect.anything(), 'mkt-bracket', 'NO');
      expect(mockDeletePendingOrder).not.toHaveBeenCalledWith(expect.anything(), 'mkt-primary', 'NO');
    });
  });

  describe('conditional oracle cancel rule (fourth rule)', () => {
    // Shared helpers for this block.
    const condOracleConfig = () => ({
      ...baseConfig,
      WEATHER_COND_ORACLE_RESTING_CANCEL_ENABLED: true,
      WEATHER_COND_ORACLE_EXIT_COST_BUFFER: 0.05,
      // Primary FV rule off so it can't interfere.
      WEATHER_RESTING_REVALIDATION_ENABLED: false,
    });

    // Resolution-day opportunity with a parseable sourcedFrom
    const resDayOpp = (extra: Record<string, unknown> = {}) =>
      opp('mkt-1', 0.60, {
        city: 'chicago',
        targetDate: '2026-06-10',
        isResolutionDay: true,
        ...extra,
      });

    // Pending entry whose order is resting at price 0.55 (NO direction)
    const condEntry = (overrides: Record<string, unknown> = {}) =>
      pendingEntry({ order: { price: 0.55, edgeMagnitude: 0.20, source: 'weather', ...overrides } });

    // Build a minimal Redis mock whose .get returns a pre-set value.
    function makeRedisMock(getReturnValue: string | null) {
      return { get: vi.fn().mockResolvedValue(getReturnValue) } as unknown as import('ioredis').Redis;
    }

    // Valid cached oracle result: heldProb 0.40 → order.price 0.55 > 0.40 + 0.05 → picked off.
    // computedAt must be present and fresh for the blob-age check to pass (≤35 min).
    const hitPayload = () => JSON.stringify({
      heldProb: 0.40,
      isStale: false,
      estimator: 'ensemble',
      confidence: 'settlement_aligned',
      computedAt: Date.now(),
    });

    beforeEach(() => {
      mockLoadConfig.mockReturnValue(condOracleConfig() as never);
    });

    it('cancels a resting primary when price > conditionalHeldProb + buffer on res-day', async () => {
      mockListPendingOrders.mockResolvedValue([condEntry()]);
      mockGetClobOrder
        .mockResolvedValueOnce(liveOrder('0'))  // pre-cancel: nothing filled
        .mockResolvedValueOnce(null);           // post-cancel: order gone
      mockCancelClobOrder.mockResolvedValue(true);

      await revalidateRestingWeatherOrders(makeRedisMock(hitPayload()), [resDayOpp()]);

      expect(mockCancelClobOrder).toHaveBeenCalledWith('order-1');
      expect(mockDeletePendingOrder).toHaveBeenCalledWith(expect.anything(), 'mkt-1', 'NO');
    });

    it('does NOT cancel when the order price is within the buffer (0.55 ≤ 0.52 + 0.05)', async () => {
      // heldProb=0.52 → threshold=0.57 → order.price=0.55 ≤ 0.57 → keep.
      const payload = JSON.stringify({
        heldProb: 0.52,
        isStale: false,
        estimator: 'ensemble',
        confidence: 'settlement_aligned',
        computedAt: Date.now(),
      });
      mockListPendingOrders.mockResolvedValue([condEntry()]);

      await revalidateRestingWeatherOrders(makeRedisMock(payload), [resDayOpp()]);

      expect(mockCancelClobOrder).not.toHaveBeenCalled();
      expect(mockDeletePendingOrder).not.toHaveBeenCalled();
    });

    it('does NOT cancel when the blob computedAt is older than 35 minutes', async () => {
      const oldPayload = JSON.stringify({
        heldProb: 0.40,
        isStale: false,
        estimator: 'ensemble',
        confidence: 'settlement_aligned',
        computedAt: Date.now() - 36 * 60 * 1000,
      });
      mockListPendingOrders.mockResolvedValue([condEntry()]);

      await revalidateRestingWeatherOrders(makeRedisMock(oldPayload), [resDayOpp()]);

      expect(mockCancelClobOrder).not.toHaveBeenCalled();
    });

    it('does NOT cancel on a non-resolution-day opportunity', async () => {
      mockListPendingOrders.mockResolvedValue([condEntry()]);

      await revalidateRestingWeatherOrders(
        makeRedisMock(hitPayload()),
        [opp('mkt-1', 0.60, { city: 'chicago', targetDate: '2026-06-10', isResolutionDay: false })],
      );

      expect(mockCancelClobOrder).not.toHaveBeenCalled();
    });

    it('does NOT cancel when there is no cache entry (fail-safe)', async () => {
      mockListPendingOrders.mockResolvedValue([condEntry()]);

      await revalidateRestingWeatherOrders(makeRedisMock(null), [resDayOpp()]);

      expect(mockCancelClobOrder).not.toHaveBeenCalled();
    });

    it('does NOT cancel when the cached result is stale', async () => {
      const stalePayload = JSON.stringify({
        heldProb: 0.30,
        isStale: true,
        estimator: 'climo',
        confidence: 'settlement_aligned',
      });
      mockListPendingOrders.mockResolvedValue([condEntry()]);

      await revalidateRestingWeatherOrders(makeRedisMock(stalePayload), [resDayOpp()]);

      expect(mockCancelClobOrder).not.toHaveBeenCalled();
    });

    it('does NOT cancel when confidence is not settlement_aligned', async () => {
      const heuristicPayload = JSON.stringify({
        heldProb: 0.30,
        isStale: false,
        estimator: 'climo',
        confidence: 'heuristic',
      });
      mockListPendingOrders.mockResolvedValue([condEntry()]);

      await revalidateRestingWeatherOrders(makeRedisMock(heuristicPayload), [resDayOpp()]);

      expect(mockCancelClobOrder).not.toHaveBeenCalled();
    });

    it('skips gracefully when the cache value is malformed JSON', async () => {
      mockListPendingOrders.mockResolvedValue([condEntry()]);

      await revalidateRestingWeatherOrders(makeRedisMock('not-json{bad}'), [resDayOpp()]);

      expect(mockCancelClobOrder).not.toHaveBeenCalled();
    });

    it('does NOT fire when the knob is off — all three knobs off is inert', async () => {
      mockLoadConfig.mockReturnValue({
        ...baseConfig,
        WEATHER_RESTING_REVALIDATION_ENABLED: false,
        WEATHER_BRACKET_CANCEL_ENABLED: false,
        WEATHER_COND_ORACLE_RESTING_CANCEL_ENABLED: false,
      } as never);
      mockListPendingOrders.mockResolvedValue([condEntry()]);

      await revalidateRestingWeatherOrders(makeRedisMock(hitPayload()), [resDayOpp()]);

      // listPendingOrders is not called when all three rules are off.
      expect(mockListPendingOrders).not.toHaveBeenCalled();
    });

    it('skips bracket legs (isBracketOpposite=true) even with a picked-off cache hit', async () => {
      mockListPendingOrders.mockResolvedValue([
        condEntry({ isBracketOpposite: true }),
      ]);

      await revalidateRestingWeatherOrders(makeRedisMock(hitPayload()), [resDayOpp()]);

      expect(mockCancelClobOrder).not.toHaveBeenCalled();
    });

    it('falls through to FV rule when fourth rule conditions are not met (cache miss)', async () => {
      // Cache miss → fourth rule skipped → FV rule fires (primary revalidation on, sideFV 0.40 < 0.55).
      mockLoadConfig.mockReturnValue({
        ...condOracleConfig(),
        WEATHER_RESTING_REVALIDATION_ENABLED: true,
      } as never);
      mockListPendingOrders.mockResolvedValue([condEntry()]);
      mockGetClobOrder
        .mockResolvedValueOnce(liveOrder('0'))
        .mockResolvedValueOnce(null);
      mockCancelClobOrder.mockResolvedValue(true);

      // modelProbability=0.60 → NO side FV = 0.40 < posted 0.55 → FV fires.
      await revalidateRestingWeatherOrders(makeRedisMock(null), [resDayOpp()]);

      expect(mockCancelClobOrder).toHaveBeenCalledWith('order-1');
      expect(mockDeletePendingOrder).toHaveBeenCalledWith(expect.anything(), 'mkt-1', 'NO');
    });
  });
});

// ---------------------------------------------------------------------------
// scanWeatherMarkets — modal-mass NO veto (2026-06-19)
// ---------------------------------------------------------------------------

describe('scanWeatherMarkets - modal-mass NO veto (2026-06-19)', () => {
  let redisMock: ReturnType<typeof createRedisMock>;
  let originalFetch: typeof globalThis.fetch;

  const td = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const iso = `${td.getUTCFullYear().toString()}-${(td.getUTCMonth() + 1).toString().padStart(2, '0')}-${td.getUTCDate().toString().padStart(2, '0')}`;
  const MN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const titleDate = `${MN[td.getUTCMonth()] ?? 'June'} ${td.getUTCDate().toString()}`;
  const slugDate = `${(MN[td.getUTCMonth()] ?? 'June').toLowerCase()}-${td.getUTCDate().toString()}-${td.getUTCFullYear().toString()}`;
  const endIso = `${iso}T12:00:00Z`;

  // One interior bracket ("50-51°F") priced as a NO bet far below the point
  // forecast (56°F) — the Gaussian gives it low YES so NO has edge, and the
  // forecast does not round near it (round(56)=56 ∉ [49,52]). Only the ensemble
  // modal-mass veto can block it.
  function makeEvent() {
    const mk = (id: string, label: string, yes: string, no: string, thr: string) => ({
      id,
      question: `Will the highest temperature in Chicago be ${label} on ${titleDate}?`,
      conditionId: `cond-${id}`,
      clobTokenIds: `["${id}y","${id}n"]`,
      outcomePrices: `["${yes}","${no}"]`,
      outcomes: '["Yes","No"]',
      active: true,
      closed: false,
      volume: '10000',
      liquidity: '5000',
      endDate: endIso,
      description: null,
      groupItemTitle: label,
      groupItemThreshold: thr,
    });
    return {
      id: 'event-mm',
      title: `Highest temperature in Chicago on ${titleDate}?`,
      slug: `highest-temperature-in-chicago-on-${slugDate}`,
      active: true,
      closed: false,
      negRisk: true,
      endDate: endIso,
      markets: [
        mk('m0', '49°F or below', '0.02', '0.99', '0'),
        mk('m1', '50-51°F', '0.05', '0.60', '1'), // bounded NO target
        mk('m2', '52°F or higher', '0.10', '0.85', '2'),
      ],
    };
  }

  function hourlyWithModalMass(mass: number) {
    // 20 members, each a flat 24-hour trajectory. `mass` controls the share
    // inside 50-51°F widened by margin=1, i.e. [49,52].
    const members = 20;
    const inside = Math.round(members * mass);
    return {
      hours: Array.from({ length: 24 }, (_, h) => h * 3600),
      memberTemps: Array.from({ length: members }, (_, i) => {
        const tempF = i < inside ? 50.5 : 60;
        return Array.from({ length: 24 }, () => tempF);
      }),
      memberCount: members,
      forecastDate: iso,
      ensembleModel: 'gfs' as const,
    };
  }

  function hourlyClusteredAt(tempF: number) {
    // 20 members, each a flat 24-hour trajectory at tempF -> daily max = tempF.
    return {
      hours: Array.from({ length: 24 }, (_, h) => h * 3600),
      memberTemps: Array.from({ length: 20 }, () => Array.from({ length: 24 }, () => tempF)),
      memberCount: 20,
      forecastDate: iso,
      ensembleModel: 'gfs' as const,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    redisMock = createRedisMock();
    originalFetch = globalThis.fetch;
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_MIN_MODEL_COVERAGE: 0,
      WEATHER_MIN_EDGE: 0.02,
      WEATHER_MODAL_MASS_VETO_ENABLED: true,
      WEATHER_INTERIOR_NO_MODAL_MASS_VETO: 0.65,
      WEATHER_INTERIOR_NO_FORECAST_MARGIN: 1,
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: () => Promise.resolve([makeEvent()]),
    }) as unknown as typeof fetch;
    mockFetchNwsForecast.mockResolvedValue({ highF: 56, lowF: 40, precipProbability: 0, forecastDate: iso, shortForecast: 'Clear' });
    mockFetchOpenMeteo.mockResolvedValue({ highTemp: 56, lowTemp: 40, precipProbability: 0, forecastDate: iso });
    mockFetchEnsemble.mockResolvedValue({ meanHigh: 56, stddevHigh: 3.2, meanLow: 40, stddevLow: 2.8, memberCount: 31, forecastDate: iso });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    // Restore the default fresh-spread implementation so later files/tests are unaffected.
    mockLoadConfig.mockImplementation(() => ({ ...baseConfig }));
  });

  it('blocks the interior NO when ensemble YES mass reaches the higher threshold', async () => {
    mockFetchEnsembleHourly.mockResolvedValue(hourlyWithModalMass(0.65));
    const results = await scanWeatherMarkets(redisMock as never);
    const no = results.find((o) => o.bracketLabel === '50-51°F' && o.tradeSide === 'NO');
    expect(no).toBeDefined();
    expect(no!.blockedByModalMass).toBe(true);
    expect(no!.ensembleYesMass ?? 0).toBeGreaterThanOrEqual(0.65);
    expect(mockFetchEnsembleHourly).toHaveBeenCalled();
  });

  it('does not block the interior NO at 50% ensemble YES mass', async () => {
    mockFetchEnsembleHourly.mockResolvedValue(hourlyWithModalMass(0.50));
    const results = await scanWeatherMarkets(redisMock as never);
    const no = results.find((o) => o.bracketLabel === '50-51°F' && o.tradeSide === 'NO');
    expect(no).toBeDefined();
    expect(no!.blockedByModalMass).toBe(false);
    expect(no!.ensembleYesMass).toBeCloseTo(0.50, 6);
  });

  it('does not block the interior NO when ensemble members are far from the bracket', async () => {
    mockFetchEnsembleHourly.mockResolvedValue(hourlyClusteredAt(60));
    const results = await scanWeatherMarkets(redisMock as never);
    const no = results.find((o) => o.bracketLabel === '50-51°F' && o.tradeSide === 'NO');
    expect(no).toBeDefined();
    expect(no!.blockedByModalMass).toBe(false);
    expect(no!.ensembleYesMass ?? 1).toBeLessThan(0.65);
  });

  it('skips the ensemble-hourly fetch when the veto is disabled', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig, WEATHER_MIN_MODEL_COVERAGE: 0, WEATHER_MIN_EDGE: 0.02, WEATHER_MODAL_MASS_VETO_ENABLED: false,
    });
    const results = await scanWeatherMarkets(redisMock as never);
    const no = results.find((o) => o.bracketLabel === '50-51°F' && o.tradeSide === 'NO');
    expect(no).toBeDefined();
    expect(no!.blockedByModalMass).toBe(false);
    expect(mockFetchEnsembleHourly).not.toHaveBeenCalled();
  });

  it('skips the modal-mass veto on a non-resolution-day event when RES_DAY_ONLY=true', async () => {
    // The event targets ~2 days out (not res-day), so res-day-only gating must
    // skip the veto entirely: no ensemble-hourly fetch, NO not blocked by modal mass.
    mockFetchEnsembleHourly.mockResolvedValue(hourlyClusteredAt(50.5));
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      WEATHER_MIN_MODEL_COVERAGE: 0,
      WEATHER_MIN_EDGE: 0.02,
      WEATHER_MODAL_MASS_VETO_ENABLED: true,
      WEATHER_INTERIOR_NO_MODAL_MASS_VETO: 0.65,
      WEATHER_INTERIOR_NO_FORECAST_MARGIN: 1,
      WEATHER_MODAL_MASS_VETO_RES_DAY_ONLY: true,
    });
    const results = await scanWeatherMarkets(redisMock as never);
    const no = results.find((o) => o.bracketLabel === '50-51°F' && o.tradeSide === 'NO');
    expect(no).toBeDefined();
    expect(no!.blockedByModalMass).toBe(false);
    expect(no!.ensembleYesMass ?? null).toBeNull();
    expect(mockFetchEnsembleHourly).not.toHaveBeenCalled();
  });
});
