import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn(),
  closeRedis: vi.fn(),
}));

const mockGetCachedMarkets = vi.fn();
vi.mock('../../shared/watchlist.js', () => ({
  getCachedMarkets: (...args: unknown[]) => mockGetCachedMarkets(...args),
}));

const mockGetRecentOsintItems = vi.fn();
vi.mock('../../ingestion/osintStore.js', () => ({
  getRecentOsintItems: (...args: unknown[]) => mockGetRecentOsintItems(...args),
}));

import type * as GammaModule from '../../mapping/gamma.js';
vi.mock('../../mapping/gamma.js', async () => {
  const actual = await vi.importActual<typeof GammaModule>('../../mapping/gamma.js');
  return { parseOutcomePrices: actual.parseOutcomePrices };
});

// Mini OpenAI mock — returns a structured JSON completion.
const mockCreate = vi.fn();
vi.mock('openai', () => ({
  OpenAI: vi.fn(() => ({
    chat: { completions: { create: (...args: unknown[]) => mockCreate(...args) } },
  })),
}));

const DEFAULT_CONFIG = {
  NEAR_ZERO_INJECTOR_ENABLED: true,
  NEAR_ZERO_INJECTOR_MIN_NO_SCORE: 6,
  NEAR_ZERO_INJECTOR_MAX_LLM_PER_RUN: 10,
  NEAR_ZERO_INJECTOR_MIN_ENTITY_OVERLAP: 2,
  NEAR_ZERO_MIN_PRICE: 0.03,
  NEAR_ZERO_MAX_PRICE: 0.10,
  NEAR_ZERO_OSINT_SIGNAL_TTL_S: 172_800,
  OPENAI_API_KEY: 'test-key',
  OPENAI_MODEL: 'gpt-4.1-mini',
};

const mockLoadConfig = vi.fn(() => ({ ...DEFAULT_CONFIG }));
vi.mock('../../shared/config.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

const { runNearZeroOsintInjector } = await import('../nearZeroOsintInjector.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMarket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mkt-1',
    question: 'Will Iran and Israel sign a peace deal by July 2026?',
    active: true,
    closed: false,
    outcomePrices: JSON.stringify(['0.95', '0.05']), // YES=95¢, NO=5¢
    endDate: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

function makeOsintItem(overrides: Partial<{
  title: string;
  keywords: string[];
  urgencyScore: number;
  categoryId: string;
}> = {}) {
  return {
    title: 'Iran and Israel agree to indirect talks, ceasefire discussions ongoing',
    keywords: ['iran', 'israel', 'ceasefire', 'talks'],
    urgencyScore: 8,
    categoryId: 'geopolitical',
    ...overrides,
  };
}

function makeRedis() {
  const zadd = vi.fn().mockResolvedValue(1);
  const zremrangebyscore = vi.fn().mockResolvedValue(0);
  const redis = { zadd, zremrangebyscore } as unknown as Redis;
  return { redis, zadd, zremrangebyscore };
}

function mockLLMScore(score: number, reasoning = 'relevant') {
  mockCreate.mockResolvedValue({
    choices: [
      {
        message: {
          content: JSON.stringify({ score, reasoning }),
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runNearZeroOsintInjector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG });
    mockGetRecentOsintItems.mockResolvedValue([]);
    mockGetCachedMarkets.mockResolvedValue([]);
  });

  it('skips when NEAR_ZERO_INJECTOR_ENABLED=false', async () => {
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, NEAR_ZERO_INJECTOR_ENABLED: false });
    const { redis } = makeRedis();
    await runNearZeroOsintInjector(redis);
    expect(mockGetRecentOsintItems).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('skips when no recent OSINT items', async () => {
    mockGetRecentOsintItems.mockResolvedValue([]);
    mockGetCachedMarkets.mockResolvedValue([makeMarket()]);
    const { redis } = makeRedis();
    await runNearZeroOsintInjector(redis);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('skips when no NO-side near-zero markets', async () => {
    mockGetRecentOsintItems.mockResolvedValue([makeOsintItem()]);
    // YES is 5¢, NO is 95¢ — NO is not near-zero
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({ outcomePrices: JSON.stringify(['0.05', '0.95']) }),
    ]);
    const { redis } = makeRedis();
    await runNearZeroOsintInjector(redis);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('writes NO signal when LLM score meets threshold', async () => {
    mockGetRecentOsintItems.mockResolvedValue([makeOsintItem()]);
    mockGetCachedMarkets.mockResolvedValue([makeMarket()]);
    mockLLMScore(8);
    const { redis, zadd } = makeRedis();

    await runNearZeroOsintInjector(redis);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(zadd).toHaveBeenCalledTimes(1);
    const [key, , member] = zadd.mock.calls[0]!;
    expect(key).toBe('near_zero:osint_signals');
    const parsed = JSON.parse(member as string) as Record<string, unknown>;
    expect(parsed.marketId).toBe('mkt-1');
    expect(parsed.direction).toBe('NO');
    expect(parsed.urgencyScore).toBe(8);
  });

  it('does NOT write when LLM score is below threshold', async () => {
    mockGetRecentOsintItems.mockResolvedValue([makeOsintItem()]);
    mockGetCachedMarkets.mockResolvedValue([makeMarket()]);
    mockLLMScore(4); // below min 6
    const { redis, zadd } = makeRedis();

    await runNearZeroOsintInjector(redis);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(zadd).not.toHaveBeenCalled();
  });

  it('skips pair when keyword overlap is below minimum', async () => {
    mockGetRecentOsintItems.mockResolvedValue([
      makeOsintItem({ keywords: ['soccer', 'premier-league'] }), // unrelated keywords
    ]);
    mockGetCachedMarkets.mockResolvedValue([makeMarket()]); // iran/israel question
    const { redis } = makeRedis();

    await runNearZeroOsintInjector(redis);

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('respects NEAR_ZERO_INJECTOR_MAX_LLM_PER_RUN cap', async () => {
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, NEAR_ZERO_INJECTOR_MAX_LLM_PER_RUN: 2 });
    // 3 markets, 1 OSINT item → 3 valid pairs; only 2 LLM calls allowed
    const markets = [
      makeMarket({ id: 'mkt-a', question: 'Will Iran attack Israel by June?' }),
      makeMarket({ id: 'mkt-b', question: 'Will Israel retaliate against Iran?' }),
      makeMarket({ id: 'mkt-c', question: 'Will Iran cease hostilities with Israel?' }),
    ];
    mockGetCachedMarkets.mockResolvedValue(markets);
    mockGetRecentOsintItems.mockResolvedValue([
      makeOsintItem({ keywords: ['iran', 'israel', 'attack', 'retaliate'] }),
    ]);
    mockLLMScore(3); // below threshold — no writes expected
    const { redis, zadd } = makeRedis();

    await runNearZeroOsintInjector(redis);

    expect(mockCreate.mock.calls.length).toBeLessThanOrEqual(2);
    expect(zadd).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scanner: NEAR_ZERO_REQUIRE_OSINT gate
// ---------------------------------------------------------------------------

// These tests are in nearZeroScanner.test.ts (see 'OSINT gate' describe block).
