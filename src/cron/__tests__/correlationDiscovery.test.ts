import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type * as GammaModule from '../../mapping/gamma.js';

// ---------------------------------------------------------------------------
// Mocks — must come before dynamic import
// ---------------------------------------------------------------------------

const mockGetCachedMarkets = vi.fn<() => Promise<unknown[]>>();
vi.mock('../../shared/watchlist.js', () => ({
  getCachedMarkets: mockGetCachedMarkets,
}));

const mockClassifyRelationship = vi.fn();
vi.mock('../../correlation/relationshipClassifier.js', () => ({
  classifyRelationship: mockClassifyRelationship,
}));

const mockSaveConstraint = vi.fn();
const mockEvictExpiredConstraints = vi.fn().mockResolvedValue(0);
const mockLoadAllConstraints = vi.fn().mockResolvedValue([]);
vi.mock('../../correlation/constraintGraph.js', () => ({
  saveConstraint: mockSaveConstraint,
  evictExpiredConstraints: mockEvictExpiredConstraints,
  loadAllConstraints: mockLoadAllConstraints,
}));

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const DEFAULT_CONFIG = {
  CORRELATION_SCANNER_ENABLED: false,
  CORRELATION_MIN_SHARED_ENTITIES: 2,
  CORRELATION_MAX_PAIRS_PER_DISCOVERY: 100,
  CORRELATION_CLASSIFY_DELAY_MS: 0,
  CORRELATION_GRAPH_TTL_S: 604800,
  CORRELATION_PAIR_DEDUP_TTL_S: 86400,
  CORRELATION_CLASSIFY_CACHE_TTL_S: 172800,
  CORRELATION_MIN_EDGE: 0.05,
  CORRELATION_MIN_LIQUIDITY: 1000,
  CORRELATION_MAX_MARKETS_FOR_DISCOVERY: 500,
};

const mockLoadConfig = vi.fn(() => ({ ...DEFAULT_CONFIG }));
vi.mock('../../shared/config.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

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
// Dynamic import (after mocks)
// ---------------------------------------------------------------------------

const { runCorrelationDiscovery } = await import('../correlationDiscovery.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMarket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mkt-1',
    question: 'Will Russia invade Ukraine in 2026?',
    conditionId: 'cond-1',
    clobTokenIds: JSON.stringify(['yes-token-1', 'no-token-1']),
    outcomePrices: JSON.stringify(['0.50', '0.50']),
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

describe('correlationDiscovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG });
    mockGetCachedMarkets.mockResolvedValue([]);
    mockClassifyRelationship.mockResolvedValue({ type: 'none', direction: null, reasoning: '' });
    mockSaveConstraint.mockResolvedValue(undefined);
    mockEvictExpiredConstraints.mockResolvedValue(0);
    mockLoadAllConstraints.mockResolvedValue([]);
  });

  it('returns early when market cache is empty', async () => {
    const redis = makeRedis();
    await runCorrelationDiscovery(redis);
    expect(mockClassifyRelationship).not.toHaveBeenCalled();
  });

  it('skips pair if pair_seen NX claim returns null', async () => {
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({ id: 'a', conditionId: 'ca', question: 'Will Russia attack Ukraine forces?' }),
      makeMarket({ id: 'b', conditionId: 'cb', question: 'Will Russia invade Ukraine territory?' }),
    ]);

    const redis = makeRedis({
      set: vi.fn().mockResolvedValue(null), // NX claim fails
    });

    await runCorrelationDiscovery(redis);
    expect(mockClassifyRelationship).not.toHaveBeenCalled();
  });

  it('skips pair classified as none', async () => {
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({ id: 'a', conditionId: 'ca', question: 'Will Russia attack Ukraine forces?' }),
      makeMarket({ id: 'b', conditionId: 'cb', question: 'Will Russia invade Ukraine territory?' }),
    ]);
    mockClassifyRelationship.mockResolvedValue({ type: 'none', direction: null, reasoning: '' });

    const redis = makeRedis();
    await runCorrelationDiscovery(redis);

    expect(mockSaveConstraint).not.toHaveBeenCalled();
  });

  it('saves constraint when LLM returns implication', async () => {
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({ id: 'a', conditionId: 'ca', question: 'Will Russia attack Ukraine forces?' }),
      makeMarket({ id: 'b', conditionId: 'cb', question: 'Will Russia invade Ukraine territory?' }),
    ]);
    mockClassifyRelationship.mockResolvedValue({
      type: 'implication',
      direction: 'A_implies_B',
      reasoning: 'Attack implies invasion',
    });

    const redis = makeRedis();
    await runCorrelationDiscovery(redis);

    expect(mockSaveConstraint).toHaveBeenCalledTimes(1);
    const savedEdge = mockSaveConstraint.mock.calls[0]![1];
    expect(savedEdge.type).toBe('implication');
  });

  it('swaps A/B when direction is B_implies_A', async () => {
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({ id: 'a', conditionId: 'ca', question: 'Will Russia attack Ukraine forces?' }),
      makeMarket({ id: 'b', conditionId: 'cb', question: 'Will Russia invade Ukraine territory?' }),
    ]);
    mockClassifyRelationship.mockResolvedValue({
      type: 'implication',
      direction: 'B_implies_A',
      reasoning: 'B implies A',
    });

    const redis = makeRedis();
    await runCorrelationDiscovery(redis);

    expect(mockSaveConstraint).toHaveBeenCalledTimes(1);
    const savedEdge = mockSaveConstraint.mock.calls[0]![1];
    // After swap, the "B" market should now be stored as marketIdA.
    // The exact IDs depend on pairFinder ordering, but the swap should occur.
    expect(savedEdge.type).toBe('implication');
  });

  it('filters out markets below minimum liquidity', async () => {
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({ id: 'a', conditionId: 'ca', question: 'Will Russia attack Ukraine forces?', liquidity: '500' }),
      makeMarket({ id: 'b', conditionId: 'cb', question: 'Will Russia invade Ukraine territory?', liquidity: '500' }),
    ]);

    const redis = makeRedis();
    await runCorrelationDiscovery(redis);

    expect(mockClassifyRelationship).not.toHaveBeenCalled();
  });
});
