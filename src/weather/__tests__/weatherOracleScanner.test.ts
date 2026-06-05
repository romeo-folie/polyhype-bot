/**
 * Tests for the Weather Oracle Scanner.
 * Covers:
 *  1. winningDirection — oracle winner selection logic for all bracket types.
 *  2. runWeatherOracleScan — shadow-logging, gate evaluation, execution routing.
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

const mockGetClobOrderBook = vi.fn();
vi.mock('../../shared/clob.js', () => ({
  getClobOrderBook: mockGetClobOrderBook,
}));

const mockFetchWeatherEvents = vi.fn();
const mockParseWeatherEvent = vi.fn();
vi.mock('../weatherScanner.js', () => ({
  fetchWeatherEvents: mockFetchWeatherEvents,
  parseWeatherEvent: mockParseWeatherEvent,
}));

vi.mock('../noaaClient.js', async () => {
  const actual = await vi.importActual<typeof import('../noaaClient.js')>('../noaaClient.js');
  return { ...actual };
});

const mockExecuteAndRecordSignal = vi.fn();
vi.mock('../../execution/executor.js', () => ({
  executeAndRecordSignal: mockExecuteAndRecordSignal,
}));

const mockGetBankroll = vi.fn();
vi.mock('../../shared/bankroll.js', () => ({
  getBankroll: mockGetBankroll,
}));

// ── Dynamic import ────────────────────────────────────────────────────────────

const { winningDirection, runWeatherOracleScan } = await import('../weatherOracleScanner.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides = {}) {
  return {
    WEATHER_ORACLE_ENABLED: false,
    WEATHER_ORACLE_MAX_BUY_PRICE: 0.15,
    WEATHER_ORACLE_MIN_DISCOUNT: 0.80,
    WEATHER_ORACLE_MAX_STAKE_USD: 10,
    ...overrides,
  };
}

function makeBracket(overrides = {}) {
  return {
    marketId: 'mkt1',
    conditionId: 'cond1',
    clobTokenIds: ['tok-yes', 'tok-no'],
    label: '75-80°F',
    question: 'Will NYC high be 75-80°F?',
    low: 75,
    high: 80,
    ...overrides,
  };
}

function makeEvent(bracketOverrides = {}) {
  return {
    city: 'new york',
    targetDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), // yesterday
    unit: 'fahrenheit',
    brackets: [makeBracket(bracketOverrides)],
  };
}

function makeRedis() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  };
}

// ── winningDirection tests ────────────────────────────────────────────────────

describe('winningDirection', () => {
  describe('interior bracket (low + high set)', () => {
    it('returns YES when actual is within range', () => {
      expect(winningDirection(77, 75, 80)).toBe('YES');
    });
    it('returns YES at lower boundary (inclusive)', () => {
      expect(winningDirection(75, 75, 80)).toBe('YES');
    });
    it('returns YES at upper boundary (inclusive)', () => {
      expect(winningDirection(80, 75, 80)).toBe('YES');
    });
    it('returns NO when actual is below range', () => {
      expect(winningDirection(74, 75, 80)).toBe('NO');
    });
    it('returns NO when actual is above range', () => {
      expect(winningDirection(81, 75, 80)).toBe('NO');
    });
  });

  describe('high-tail bracket (high is null)', () => {
    it('returns YES when actual >= low threshold', () => {
      expect(winningDirection(90, 85, null)).toBe('YES');
    });
    it('returns YES at the boundary', () => {
      expect(winningDirection(85, 85, null)).toBe('YES');
    });
    it('returns NO when actual < low threshold', () => {
      expect(winningDirection(84, 85, null)).toBe('NO');
    });
  });

  describe('low-tail bracket (low is null)', () => {
    it('returns YES when actual <= high threshold', () => {
      expect(winningDirection(60, null, 65)).toBe('YES');
    });
    it('returns YES at the boundary', () => {
      expect(winningDirection(65, null, 65)).toBe('YES');
    });
    it('returns NO when actual > high threshold', () => {
      expect(winningDirection(66, null, 65)).toBe('NO');
    });
  });
});

// ── runWeatherOracleScan tests ────────────────────────────────────────────────

describe('runWeatherOracleScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(makeConfig());
    mockGetBankroll.mockResolvedValue(100);
    mockExecuteAndRecordSignal.mockResolvedValue({
      skipped: false,
      signal: { stakeUsd: 5 },
      executionVenue: 'clob',
    });
  });

  it('returns early when DB query returns no ground-truth rows', async () => {
    mockSql.mockResolvedValue([]);
    await runWeatherOracleScan(makeRedis() as any);
    expect(mockFetchWeatherEvents).not.toHaveBeenCalled();
  });

  it('returns early when no active weather events', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    mockSql.mockResolvedValue([
      { city: 'new york', targetDate: yesterday, actualHigh: 77, unit: 'fahrenheit' },
    ]);
    mockFetchWeatherEvents.mockResolvedValue([]);
    await runWeatherOracleScan(makeRedis() as any);
    expect(mockGetClobOrderBook).not.toHaveBeenCalled();
  });

  it('shadow-logs opportunity and does not execute when WEATHER_ORACLE_ENABLED=false', async () => {
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    mockSql.mockResolvedValue([
      { city: 'new york', targetDate: yesterday, actualHigh: 77, unit: 'fahrenheit' },
    ]);
    mockFetchWeatherEvents.mockResolvedValue([{}]);
    mockParseWeatherEvent.mockReturnValue(makeEvent());
    // YES wins (77 in 75-80); ask is low enough to trade
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.08' }] });
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_ORACLE_ENABLED: false }));

    await runWeatherOracleScan(makeRedis() as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ kind: 'weather_oracle', wouldBlock: true }),
    );
    expect(mockExecuteAndRecordSignal).not.toHaveBeenCalled();
  });

  it('routes to YES when actualHigh is within bracket', async () => {
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    mockSql.mockResolvedValue([
      { city: 'new york', targetDate: yesterday, actualHigh: 77, unit: 'fahrenheit' },
    ]);
    mockFetchWeatherEvents.mockResolvedValue([{}]);
    mockParseWeatherEvent.mockReturnValue(makeEvent());
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.08' }] });
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_ORACLE_ENABLED: false }));

    await runWeatherOracleScan(makeRedis() as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ direction: 'YES' }),
    );
  });

  it('routes to NO when actualHigh is outside bracket', async () => {
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    mockSql.mockResolvedValue([
      { city: 'new york', targetDate: yesterday, actualHigh: 90, unit: 'fahrenheit' },
    ]);
    mockFetchWeatherEvents.mockResolvedValue([{}]);
    // Bracket 75-80°F; actual 90 → NO wins
    mockParseWeatherEvent.mockReturnValue(makeEvent());
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.08' }] });
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_ORACLE_ENABLED: false }));

    await runWeatherOracleScan(makeRedis() as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ direction: 'NO' }),
    );
  });

  it('skips bracket when winning ask exceeds WEATHER_ORACLE_MAX_BUY_PRICE', async () => {
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    mockSql.mockResolvedValue([
      { city: 'new york', targetDate: yesterday, actualHigh: 77, unit: 'fahrenheit' },
    ]);
    mockFetchWeatherEvents.mockResolvedValue([{}]);
    mockParseWeatherEvent.mockReturnValue(makeEvent());
    // Ask of 0.30 > WEATHER_ORACLE_MAX_BUY_PRICE 0.15 → wouldTrade=false
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.30' }] });
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_ORACLE_ENABLED: true }));

    await runWeatherOracleScan(makeRedis() as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ wouldBlock: true }),
    );
    expect(mockExecuteAndRecordSignal).not.toHaveBeenCalled();
  });

  it('calls executeAndRecordSignal when enabled and opportunity qualifies', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    mockSql.mockResolvedValue([
      { city: 'new york', targetDate: yesterday, actualHigh: 77, unit: 'fahrenheit' },
    ]);
    mockFetchWeatherEvents.mockResolvedValue([{}]);
    mockParseWeatherEvent.mockReturnValue(makeEvent());
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.08' }] });
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_ORACLE_ENABLED: true }));

    await runWeatherOracleScan(makeRedis() as any);

    expect(mockExecuteAndRecordSignal).toHaveBeenCalledOnce();
    const signal = mockExecuteAndRecordSignal.mock.calls[0]![0];
    expect(signal.direction).toBe('YES');
    expect(signal.source).toBe('weather');
  });

  it('reads the winning ask from a multi-level raw-REST-order book (asks[0] = WORST ask)', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    mockSql.mockResolvedValue([
      { city: 'new york', targetDate: yesterday, actualHigh: 77, unit: 'fahrenheit' },
    ]);
    mockFetchWeatherEvents.mockResolvedValue([{}]);
    mockParseWeatherEvent.mockReturnValue(makeEvent());
    // REST books are best-at-the-END: asks descending, real best ask 0.08 is
    // LAST. Pre-fix the scanner read asks[0]=0.99 → discount looked like 0.01
    // → every oracle opportunity on a populated book was suppressed.
    mockGetClobOrderBook.mockResolvedValue({
      asks: [
        { price: '0.99', size: '5' },
        { price: '0.40', size: '10' },
        { price: '0.08', size: '60' }, // real best ask — LAST
      ],
    });
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_ORACLE_ENABLED: true }));

    await runWeatherOracleScan(makeRedis() as any);

    expect(mockExecuteAndRecordSignal).toHaveBeenCalledOnce();
  });
});
