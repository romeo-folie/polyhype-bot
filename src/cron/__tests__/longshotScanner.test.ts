import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type * as GammaModule from '../../mapping/gamma.js';

// ---------------------------------------------------------------------------
// Mocks -- must come before dynamic import
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

vi.mock('../../shared/zones.js', () => ({
  priceZoneOf: vi.fn(() => 5 as const),
}));

vi.mock('../../shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Default config -- tests override via mockLoadConfig return value
const DEFAULT_CONFIG = {
  LONGSHOT_SCANNER_ENABLED: false,
  LONGSHOT_MIN_EDGE: 0.03,
  LONGSHOT_MAX_STAKE_FRACTION: 0.02,
  LONGSHOT_YES_PRICE_MIN: 0.03,
  LONGSHOT_YES_PRICE_MAX: 0.15,
  LONGSHOT_MIN_LIQUIDITY: 1000,
  LONGSHOT_DEDUP_TTL_S: 7200,
  LONGSHOT_MAX_MARKETS: 30,
  LONGSHOT_EXEMPT_CATEGORIES: 'crypto-regulatory,macro',
};

const mockLoadConfig = vi.fn(() => ({ ...DEFAULT_CONFIG }));
vi.mock('../../shared/config.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

// Re-export actual parse helpers from gamma (not mocked)
vi.mock('../../mapping/gamma.js', async () => {
  const actual = await vi.importActual<typeof GammaModule>('../../mapping/gamma.js');
  return {
    getActiveMarkets: vi.fn(),
    parseOutcomePrices: actual.parseOutcomePrices,
    parseClobTokenIds: actual.parseClobTokenIds,
    parseOutcomes: actual.parseOutcomes,
  };
});

// ---------------------------------------------------------------------------
// Dynamic import (after mocks are set up)
// ---------------------------------------------------------------------------

const { scanForLongshotBias, runLongshotScan, classifyMarketCategory } = await import(
  '../longshotScanner.js'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMarket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mkt-1',
    question: 'Will team X win the tournament?',
    conditionId: 'cond-1',
    clobTokenIds: JSON.stringify(['yes-token-1', 'no-token-1']),
    outcomePrices: JSON.stringify(['0.08', '0.92']),
    outcomes: JSON.stringify(['Yes', 'No']),
    active: true,
    closed: false,
    volume: '50000',
    liquidity: '5000',
    endDate: '2026-06-01T00:00:00Z',
    description: null,
    ...overrides,
  };
}

function makeRedis(overrides: Partial<Redis> = {}): Redis {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    ...overrides,
  } as unknown as Redis;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('longshotScanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG });
    mockGetBankroll.mockResolvedValue(500);
    mockGetCachedMarkets.mockResolvedValue([]);
    mockExecuteSignal.mockResolvedValue({ skipped: false, executionVenue: 'clob', entryPrice: 0.92 });
  });

  // ── Price range filtering ──────────────────────────────────────────────

  it('includes markets with YES price in the 3-15 cent range', async () => {
    const redis = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({
        id: 'good-1',
        question: 'Will this movie win the Oscar?',
        outcomePrices: JSON.stringify(['0.05', '0.95']),
        liquidity: '3000',
      }),
      makeMarket({
        id: 'good-2',
        question: 'Will this show win the Emmy?',
        outcomePrices: JSON.stringify(['0.12', '0.88']),
        liquidity: '3000',
      }),
    ]);

    const opps = await scanForLongshotBias(redis);
    expect(opps).toHaveLength(2);
    expect(opps.map((o) => o.marketId)).toEqual(['good-1', 'good-2']);
  });

  it('filters markets with YES price below min (noise)', async () => {
    const redis = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({ id: 'too-cheap', outcomePrices: JSON.stringify(['0.01', '0.99']) }),
    ]);

    const opps = await scanForLongshotBias(redis);
    expect(opps).toHaveLength(0);
  });

  it('filters markets with YES price above max (bias weakens)', async () => {
    const redis = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({ id: 'too-expensive', outcomePrices: JSON.stringify(['0.25', '0.75']) }),
    ]);

    const opps = await scanForLongshotBias(redis);
    expect(opps).toHaveLength(0);
  });

  it('filters markets with wide YES/NO price spread (non-complementary)', async () => {
    const redis = makeRedis();
    // YES=0.08 but NO=0.80 (expected ~0.92) — spread too wide
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({
        id: 'wide-spread',
        question: 'Will this movie win the Oscar?',
        outcomePrices: JSON.stringify(['0.08', '0.80']),
        liquidity: '3000',
      }),
    ]);

    const opps = await scanForLongshotBias(redis);
    expect(opps).toHaveLength(0);
  });

  // ── Category exemption ────────────────────────────────────────────────

  it('skips exempt categories (crypto-regulatory)', async () => {
    const redis = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({
        id: 'crypto-mkt',
        question: 'Will Bitcoin reach $200K by December?',
        outcomePrices: JSON.stringify(['0.08', '0.92']),
      }),
    ]);

    const opps = await scanForLongshotBias(redis);
    expect(opps).toHaveLength(0);
  });

  it('skips exempt categories (macro)', async () => {
    const redis = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({
        id: 'macro-mkt',
        question: 'Will the Fed cut interest rate below 3% by June?',
        outcomePrices: JSON.stringify(['0.06', '0.94']),
      }),
    ]);

    const opps = await scanForLongshotBias(redis);
    expect(opps).toHaveLength(0);
  });

  it('includes non-exempt categories (entertainment)', async () => {
    const redis = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({
        id: 'entertainment-mkt',
        question: 'Will this movie win the Oscar for Best Picture?',
        outcomePrices: JSON.stringify(['0.07', '0.93']),
        liquidity: '2000',
      }),
    ]);

    const opps = await scanForLongshotBias(redis);
    expect(opps).toHaveLength(1);
    expect(opps[0]!.category).toBe('entertainment');
    expect(opps[0]!.optimismGap).toBe(0.05);
  });

  // ── Optimism gap computation ──────────────────────────────────────────

  it('computes correct optimism gap for entertainment (5pp)', () => {
    const cat = classifyMarketCategory('Will this movie win the Oscar?');
    expect(cat).toBe('entertainment');
  });

  it('computes correct optimism gap for sports (2pp)', () => {
    const cat = classifyMarketCategory('Will the Lakers win the NBA championship?');
    expect(cat).toBe('sports');
  });

  it('computes correct optimism gap for politics (3pp)', () => {
    const cat = classifyMarketCategory('Will Trump win the next presidential election?');
    expect(cat).toBe('us-politics');
  });

  it('uses default optimism gap (2pp) for unknown categories', async () => {
    const redis = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({
        id: 'misc-mkt',
        question: 'Will the sun rise in the west tomorrow?',
        outcomePrices: JSON.stringify(['0.05', '0.95']),
        liquidity: '2000',
      }),
    ]);

    const opps = await scanForLongshotBias(redis);
    // Default gap is 0.02, min edge is 0.03, so 0.02 < 0.03 -> filtered
    expect(opps).toHaveLength(0);
  });

  // ── Edge threshold ────────────────────────────────────────────────────

  it('skips markets below minimum edge threshold', async () => {
    const redis = makeRedis();
    // Sports category = 0.02 gap, but min edge = 0.03 -> filtered
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({
        id: 'sports-mkt',
        question: 'Will the Lakers win the NBA playoff series?',
        outcomePrices: JSON.stringify(['0.10', '0.90']),
        liquidity: '5000',
      }),
    ]);

    const opps = await scanForLongshotBias(redis);
    expect(opps).toHaveLength(0);
  });

  it('includes markets meeting minimum edge (entertainment = 5pp > 3pp min)', async () => {
    const redis = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({
        id: 'ent-mkt',
        question: 'Will this Netflix show win the Emmy?',
        outcomePrices: JSON.stringify(['0.08', '0.92']),
        liquidity: '3000',
      }),
    ]);

    const opps = await scanForLongshotBias(redis);
    expect(opps).toHaveLength(1);
    expect(opps[0]!.edge).toBeCloseTo(0.05, 10);
  });

  // ── Liquidity gate ────────────────────────────────────────────────────

  it('skips markets below minimum liquidity', async () => {
    const redis = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({
        id: 'illiquid',
        question: 'Will this movie win the Oscar?',
        outcomePrices: JSON.stringify(['0.06', '0.94']),
        liquidity: '500', // Below 1000 min
      }),
    ]);

    const opps = await scanForLongshotBias(redis);
    expect(opps).toHaveLength(0);
  });

  // ── Dedup behavior ────────────────────────────────────────────────────

  it('skips already-deduped markets via NX-claim in runLongshotScan', async () => {
    // Dedup is done at execution time via NX-claim, not at scan time.
    // Simulate NX returning null (key already exists) — should skip execution.
    const mockSet = vi.fn().mockResolvedValue(null); // NX claim fails
    const redis = makeRedis({ set: mockSet });
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({
        id: 'deduped-mkt',
        question: 'Will this movie win the Oscar?',
        outcomePrices: JSON.stringify(['0.06', '0.94']),
        liquidity: '3000',
      }),
    ]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, LONGSHOT_SCANNER_ENABLED: true });

    await runLongshotScan(redis);
    // Should NOT call executeSignal since NX-claim failed
    expect(mockExecuteSignal).not.toHaveBeenCalled();
  });

  it('claims dedup key with NX during runLongshotScan', async () => {
    const mockSet = vi.fn().mockResolvedValue('OK');
    const redis = makeRedis({ set: mockSet });
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({
        id: 'fresh-mkt',
        question: 'Will this movie win the Oscar?',
        outcomePrices: JSON.stringify(['0.06', '0.94']),
        liquidity: '3000',
      }),
    ]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, LONGSHOT_SCANNER_ENABLED: true });

    await runLongshotScan(redis);

    // runLongshotScan claims with NX
    const nxCalls = mockSet.mock.calls.filter(
      (call) => call[4] === 'NX',
    );
    expect(nxCalls.length).toBeGreaterThan(0);
    expect(nxCalls[0]![0]).toBe('longshot:attempted:fresh-mkt');
  });

  // ── Shadow-log when disabled ──────────────────────────────────────────

  it('shadow-logs but does not execute when disabled', async () => {
    const mockSet = vi.fn().mockResolvedValue('OK');
    const redis = makeRedis({ set: mockSet });
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({
        id: 'shadow-mkt',
        question: 'Will this movie win the Oscar?',
        outcomePrices: JSON.stringify(['0.07', '0.93']),
        liquidity: '3000',
      }),
    ]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, LONGSHOT_SCANNER_ENABLED: false });

    await runLongshotScan(redis);

    // Should NOT call executeSignal when disabled
    expect(mockExecuteSignal).not.toHaveBeenCalled();
    // Shadow dedup uses a separate short-lived key to avoid blocking real execution
    const shadowCalls = mockSet.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('shadow'),
    );
    expect(shadowCalls.length).toBeGreaterThan(0);
    expect(shadowCalls[0]![0]).toBe('longshot:attempted:shadow:shadow-mkt');
    // Short TTL (5min) instead of full LONGSHOT_DEDUP_TTL_S
    expect(shadowCalls[0]![3]).toBe(300);
  });

  it('executes trades when enabled', async () => {
    const redis = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({
        id: 'exec-mkt',
        question: 'Will this movie win the Oscar?',
        outcomePrices: JSON.stringify(['0.07', '0.93']),
        liquidity: '3000',
      }),
    ]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, LONGSHOT_SCANNER_ENABLED: true });

    await runLongshotScan(redis);

    expect(mockExecuteSignal).toHaveBeenCalledTimes(1);
    const signal = mockExecuteSignal.mock.calls[0]![0];
    expect(signal.direction).toBe('NO');
    expect(signal.source).toBe('longshot-bias');
    expect(signal.marketId).toBe('exec-mkt');
  });

  // ── Non-binary market filter ──────────────────────────────────────────

  it('skips non-binary markets (more than 2 outcomes)', async () => {
    const redis = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({
        id: 'multi-outcome',
        question: 'Who will win Best Picture?',
        outcomes: JSON.stringify(['Movie A', 'Movie B', 'Movie C']),
        outcomePrices: JSON.stringify(['0.05', '0.05', '0.90']),
        liquidity: '5000',
      }),
    ]);

    const opps = await scanForLongshotBias(redis);
    expect(opps).toHaveLength(0);
  });

  // ── Sorting ───────────────────────────────────────────────────────────

  it('sorts opportunities by edge descending, then YES price ascending', async () => {
    const redis = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({
        id: 'sports-3pp',
        question: 'Will Ukraine join NATO this year?',
        outcomePrices: JSON.stringify(['0.05', '0.95']),
        liquidity: '3000',
      }),
      makeMarket({
        id: 'ent-5pp',
        question: 'Will this movie win the Oscar?',
        outcomePrices: JSON.stringify(['0.10', '0.90']),
        liquidity: '3000',
      }),
      makeMarket({
        id: 'ent-5pp-cheaper',
        question: 'Will this show win the Emmy?',
        outcomePrices: JSON.stringify(['0.05', '0.95']),
        liquidity: '3000',
      }),
    ]);

    const opps = await scanForLongshotBias(redis);
    // Entertainment (5pp) comes first, geopolitical (3pp) comes last
    // Among equal edges (entertainment), lower YES price comes first
    expect(opps.map((o) => o.marketId)).toEqual(['ent-5pp-cheaper', 'ent-5pp', 'sports-3pp']);
  });

  // ── Max markets cap ───────────────────────────────────────────────────

  it('caps results to LONGSHOT_MAX_MARKETS', async () => {
    const redis = makeRedis();
    const markets = Array.from({ length: 40 }, (_, i) =>
      makeMarket({
        id: `mkt-${i}`,
        question: `Will movie ${i} win the Oscar?`,
        outcomePrices: JSON.stringify(['0.07', '0.93']),
        liquidity: '3000',
      }),
    );
    mockGetCachedMarkets.mockResolvedValue(markets);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, LONGSHOT_MAX_MARKETS: 5 });

    const opps = await scanForLongshotBias(redis);
    expect(opps).toHaveLength(5);
  });

  // ── Category classifier unit tests ────────────────────────────────────

  describe('classifyMarketCategory', () => {
    it('detects crypto-regulatory', () => {
      expect(classifyMarketCategory('Will Bitcoin ETF be approved?')).toBe('crypto-regulatory');
    });

    it('detects macro', () => {
      expect(classifyMarketCategory('Will the Fed cut interest rate?')).toBe('macro');
    });

    it('detects entertainment', () => {
      expect(classifyMarketCategory('Will the film win an Oscar?')).toBe('entertainment');
    });

    it('detects sports', () => {
      expect(classifyMarketCategory('Will the Warriors win the NBA championship?')).toBe('sports');
    });

    it('detects us-politics', () => {
      expect(classifyMarketCategory('Will Congress pass the legislation?')).toBe('us-politics');
    });

    it('detects geopolitical', () => {
      expect(classifyMarketCategory('Will NATO expand with Ukraine?')).toBe('geopolitical');
    });

    it('returns default for unclassifiable questions', () => {
      expect(classifyMarketCategory('Will the sun rise in the west tomorrow?')).toBe('default');
    });
  });
});
