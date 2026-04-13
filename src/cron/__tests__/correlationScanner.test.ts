import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type * as GammaModule from '../../mapping/gamma.js';
import type { ConstraintEdge } from '../../correlation/types.js';

// ---------------------------------------------------------------------------
// Mocks — must come before dynamic import
// ---------------------------------------------------------------------------

const mockGetBankroll = vi.fn<() => Promise<number>>();
vi.mock('../../shared/bankroll.js', () => ({
  getBankroll: mockGetBankroll,
}));

const mockGetCachedMarkets = vi.fn<() => Promise<unknown[]>>();
vi.mock('../../shared/watchlist.js', () => ({
  getCachedMarkets: mockGetCachedMarkets,
}));

const mockExecuteSignal = vi.fn();
vi.mock('../../execution/executor.js', () => ({
  executeSignal: mockExecuteSignal,
}));

const mockLoadAllConstraints = vi.fn<() => Promise<ConstraintEdge[]>>();
vi.mock('../../correlation/constraintGraph.js', () => ({
  loadAllConstraints: mockLoadAllConstraints,
}));

vi.mock('../../shared/zones.js', () => ({
  priceZoneOf: vi.fn(() => 3 as const),
}));

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const DEFAULT_CONFIG = {
  CORRELATION_SCANNER_ENABLED: false,
  CORRELATION_MIN_EDGE: 0.05,
  CORRELATION_MIN_LIQUIDITY: 1000,
  CORRELATION_DEDUP_TTL_S: 3600,
  CORRELATION_MAX_TRADES_PER_RUN: 3,
  CORRELATION_MAX_STAKE_USD: 10,
  CORRELATION_MAX_STAKE_FRACTION: 0.02,
};

const mockLoadConfig = vi.fn(() => ({ ...DEFAULT_CONFIG }));
vi.mock('../../shared/config.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock('../../mapping/gamma.js', async () => {
  const actual = await vi.importActual<typeof GammaModule>('../../mapping/gamma.js');
  return {
    parseOutcomePrices: actual.parseOutcomePrices,
    parseClobTokenIds: actual.parseClobTokenIds,
  };
});

// ---------------------------------------------------------------------------
// Dynamic import
// ---------------------------------------------------------------------------

const { runCorrelationScan } = await import('../correlationScanner.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEdge(overrides: Partial<ConstraintEdge> = {}): ConstraintEdge {
  return {
    id: 'edge-1',
    type: 'implication',
    marketIdA: 'mkt-a',
    marketIdB: 'mkt-b',
    questionA: 'Market A question',
    questionB: 'Market B question',
    reasoning: 'A implies B',
    discoveredAt: Math.floor(Date.now() / 1000),
    endDateA: null,
    endDateB: null,
    ...overrides,
  };
}

function makeMarket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mkt-a',
    question: 'Market A question',
    conditionId: 'cond-a',
    clobTokenIds: JSON.stringify(['yes-token-a', 'no-token-a']),
    outcomePrices: JSON.stringify(['0.60', '0.40']),
    outcomes: JSON.stringify(['Yes', 'No']),
    active: true,
    closed: false,
    volume: '50000',
    liquidity: '5000',
    endDate: '2026-12-31T00:00:00Z',
    description: null,
    ...overrides,
  };
}

function makeRedis(overrides: Partial<Redis> = {}): Redis {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    smembers: vi.fn().mockResolvedValue([]),
    mget: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as Redis;
}

describe('correlationScanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG });
    mockGetBankroll.mockResolvedValue(500);
    mockGetCachedMarkets.mockResolvedValue([]);
    mockLoadAllConstraints.mockResolvedValue([]);
    mockExecuteSignal.mockResolvedValue({ skipped: false, executionVenue: 'clob', entryPrice: 0.50 });
  });

  it('returns early when no constraints in graph', async () => {
    const redis = makeRedis();
    await runCorrelationScan(redis);
    expect(mockGetCachedMarkets).not.toHaveBeenCalled();
  });

  it('returns early when market cache is empty', async () => {
    mockLoadAllConstraints.mockResolvedValue([makeEdge()]);
    const redis = makeRedis();
    await runCorrelationScan(redis);
    expect(mockExecuteSignal).not.toHaveBeenCalled();
  });

  it('shadow-logs and does NOT execute when ENABLED=false', async () => {
    mockLoadAllConstraints.mockResolvedValue([
      makeEdge({ marketIdA: 'mkt-a', marketIdB: 'mkt-b' }),
    ]);
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({ id: 'mkt-a', outcomePrices: JSON.stringify(['0.70', '0.30']) }),
      makeMarket({ id: 'mkt-b', conditionId: 'cond-b', outcomePrices: JSON.stringify(['0.40', '0.60']) }),
    ]);

    const redis = makeRedis();
    await runCorrelationScan(redis);

    expect(mockExecuteSignal).not.toHaveBeenCalled();
    // Shadow dedup key should have been claimed.
    expect(redis.set).toHaveBeenCalled();
    const setCall = (redis.set as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('shadow'),
    );
    expect(setCall).toBeDefined();
  });

  it('executes when ENABLED=true and violation found', async () => {
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, CORRELATION_SCANNER_ENABLED: true });
    mockLoadAllConstraints.mockResolvedValue([
      makeEdge({ marketIdA: 'mkt-a', marketIdB: 'mkt-b' }),
    ]);
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({ id: 'mkt-a', outcomePrices: JSON.stringify(['0.70', '0.30']) }),
      makeMarket({ id: 'mkt-b', conditionId: 'cond-b', outcomePrices: JSON.stringify(['0.40', '0.60']) }),
    ]);

    const redis = makeRedis();
    await runCorrelationScan(redis);

    expect(mockExecuteSignal).toHaveBeenCalledTimes(1);
    const signal = mockExecuteSignal.mock.calls[0]![0];
    expect(signal.source).toBe('correlation-arb');
    expect(signal.direction).toBe('YES');
    expect(signal.marketId).toBe('mkt-b'); // B is tradeTarget in implication
  });

  it('skips when dedup NX claim returns null', async () => {
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, CORRELATION_SCANNER_ENABLED: true });
    mockLoadAllConstraints.mockResolvedValue([
      makeEdge({ marketIdA: 'mkt-a', marketIdB: 'mkt-b' }),
    ]);
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({ id: 'mkt-a', outcomePrices: JSON.stringify(['0.70', '0.30']) }),
      makeMarket({ id: 'mkt-b', conditionId: 'cond-b', outcomePrices: JSON.stringify(['0.40', '0.60']) }),
    ]);

    const redis = makeRedis({
      set: vi.fn().mockResolvedValue(null), // NX claim fails
    });
    await runCorrelationScan(redis);

    expect(mockExecuteSignal).not.toHaveBeenCalled();
  });

  it('caps to CORRELATION_MAX_TRADES_PER_RUN', async () => {
    mockLoadConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      CORRELATION_SCANNER_ENABLED: true,
      CORRELATION_MAX_TRADES_PER_RUN: 1,
    });
    mockLoadAllConstraints.mockResolvedValue([
      makeEdge({ id: 'e1', marketIdA: 'a1', marketIdB: 'b1' }),
      makeEdge({ id: 'e2', marketIdA: 'a2', marketIdB: 'b2' }),
    ]);
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({ id: 'a1', conditionId: 'ca1', outcomePrices: JSON.stringify(['0.80', '0.20']) }),
      makeMarket({ id: 'b1', conditionId: 'cb1', outcomePrices: JSON.stringify(['0.30', '0.70']) }),
      makeMarket({ id: 'a2', conditionId: 'ca2', outcomePrices: JSON.stringify(['0.75', '0.25']) }),
      makeMarket({ id: 'b2', conditionId: 'cb2', outcomePrices: JSON.stringify(['0.25', '0.75']) }),
    ]);

    const redis = makeRedis();
    await runCorrelationScan(redis);

    expect(mockExecuteSignal).toHaveBeenCalledTimes(1);
  });

  it('does not execute when violation is below min edge', async () => {
    mockLoadConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      CORRELATION_SCANNER_ENABLED: true,
      CORRELATION_MIN_EDGE: 0.50, // Very high threshold
    });
    mockLoadAllConstraints.mockResolvedValue([
      makeEdge({ marketIdA: 'mkt-a', marketIdB: 'mkt-b' }),
    ]);
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({ id: 'mkt-a', outcomePrices: JSON.stringify(['0.55', '0.45']) }),
      makeMarket({ id: 'mkt-b', conditionId: 'cond-b', outcomePrices: JSON.stringify(['0.50', '0.50']) }),
    ]);

    const redis = makeRedis();
    await runCorrelationScan(redis);

    expect(mockExecuteSignal).not.toHaveBeenCalled();
  });

  it('filters violations by minimum liquidity', async () => {
    mockLoadConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      CORRELATION_SCANNER_ENABLED: true,
      CORRELATION_MIN_LIQUIDITY: 10000,
    });
    mockLoadAllConstraints.mockResolvedValue([
      makeEdge({ marketIdA: 'mkt-a', marketIdB: 'mkt-b' }),
    ]);
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({ id: 'mkt-a', liquidity: '500', outcomePrices: JSON.stringify(['0.80', '0.20']) }),
      makeMarket({ id: 'mkt-b', conditionId: 'cond-b', liquidity: '500', outcomePrices: JSON.stringify(['0.30', '0.70']) }),
    ]);

    const redis = makeRedis();
    await runCorrelationScan(redis);

    expect(mockExecuteSignal).not.toHaveBeenCalled();
  });
});
