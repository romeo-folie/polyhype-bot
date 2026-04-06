import { vi, describe, it, expect, beforeEach } from 'vitest';
import type * as GammaModule from '../../mapping/gamma.js';

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

let configOverride = {
  COPYTRADE_ENABLED: true,
  COPYTRADE_WALLETS: '0xabc',
  COPYTRADE_MARKET_SCOPE: ['weather', 'geopolitical'],
  COPYTRADE_SIZE_SCALE: 0.1,
  COPYTRADE_MAX_STAKE_USD: 25,
  COPYTRADE_MAX_SLIPPAGE_BPS: 200,
  COPYTRADE_MIN_TIME_TO_RESOLVE_HOURS: 6,
  COPYTRADE_MIN_LIQUIDITY: 1000,
  COPYTRADE_EXIT_MODE: 'rules',
  MAX_BET_FRACTION: 0.1,
  TAKER_MIN_EDGE_CATEGORIES: {} as Record<string, number>,
  COPYTRADE_MAX_SLIPPAGE_BPS_CATEGORIES: {} as Record<string, number>,
};

vi.mock('../../shared/logger.js', () => ({ logger: mockLogger }));

const mockDedup = vi.fn();
vi.mock('../../shared/redis.js', () => ({ dedup: mockDedup }));

const mockFetchWithTimeout = vi.fn();
const mockGetMarketBySlug = vi.fn();
vi.mock('../../mapping/gamma.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GammaModule>();
  return {
    ...actual,
    fetchWithTimeout: mockFetchWithTimeout,
    getMarketBySlug: mockGetMarketBySlug,
  };
});

const mockGetOpenPositions = vi.fn();
vi.mock('../../execution/positionLedger.js', () => ({
  getOpenPositions: mockGetOpenPositions,
}));

const mockFetchCurrentPrice = vi.fn();
vi.mock('../../monitor/priceFetcher.js', () => ({
  fetchCurrentPrice: mockFetchCurrentPrice,
}));

const mockExecuteTakeProfit = vi.fn();
vi.mock('../../monitor/takeProfitExecutor.js', () => ({
  executeTakeProfit: mockExecuteTakeProfit,
}));

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => configOverride),
}));

const makeTrade = (overrides?: Partial<Record<string, unknown>>) => ({
  proxyWallet: '0xabc',
  timestamp: 1700000000,
  conditionId: '0xcond',
  type: 'TRADE',
  size: 1000,
  usdcSize: 1000,
  transactionHash: '0xtxhash',
  price: 0.6,
  asset: 'asset-1',
  side: 'BUY',
  outcomeIndex: 0,
  title: 'Will the highest temperature in Shenzhen be 28°C on March 25?',
  slug: 'highest-temperature-in-shenzhen-on-march-25-2026-28c',
  eventSlug: 'event-slug',
  outcome: 'Yes',
  ...overrides,
});

const makeMarket = (overrides?: Partial<Record<string, unknown>>) => ({
  id: 'market-1',
  question: 'Will the highest temperature in Shenzhen be 28°C on March 25?',
  conditionId: '0xcond',
  clobTokenIds: '["yes-token","no-token"]',
  outcomePrices: '["0.9","0.1"]',
  outcomes: ['Yes', 'No'],
  active: true,
  closed: false,
  volume: '10000',
  liquidity: '5000',
  endDate: new Date(Date.now() + 12 * 3600_000).toISOString(),
  description: 'Expect cold rain and wind.',
  ...overrides,
});

beforeEach(() => {
  mockDedup.mockResolvedValue(true);
  mockFetchWithTimeout.mockReset();
  mockGetMarketBySlug.mockReset();
  mockGetOpenPositions.mockReset().mockResolvedValue([]);
  mockFetchCurrentPrice.mockReset();
  mockExecuteTakeProfit.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  configOverride = {
    COPYTRADE_ENABLED: true,
    COPYTRADE_WALLETS: '0xabc',
    COPYTRADE_MARKET_SCOPE: ['weather', 'geopolitical'],
    COPYTRADE_SIZE_SCALE: 0.1,
    COPYTRADE_MAX_STAKE_USD: 25,
    COPYTRADE_MAX_SLIPPAGE_BPS: 200,
    COPYTRADE_MIN_TIME_TO_RESOLVE_HOURS: 6,
    COPYTRADE_MIN_LIQUIDITY: 1000,
    COPYTRADE_EXIT_MODE: 'rules',
    MAX_BET_FRACTION: 0.1,
    TAKER_MIN_EDGE_CATEGORIES: {},
    COPYTRADE_MAX_SLIPPAGE_BPS_CATEGORIES: {},
  };
});

describe('copytrade helpers', () => {
  it('parses wallet list', async () => {
    const { parseWalletList } = await import('../index.js');
    expect(parseWalletList(undefined)).toEqual([]);
    expect(parseWalletList('')).toEqual([]);
    expect(parseWalletList(' 0xabc , 0xdef ')).toEqual(['0xabc', '0xdef']);
  });

  it('detects markets by category keywords in title or description', async () => {
    const { matchesCategory } = await import('../index.js');
    expect(matchesCategory('Will it rain in NYC?', null, ['weather'])).toBe(true);
    expect(matchesCategory('Market Title', 'Military action in Middle East', ['geopolitical'])).toBe(
      true,
    );
    expect(matchesCategory('Bitcoin price above $100k?', null, ['crypto-regulatory'])).toBe(true);
    expect(matchesCategory('Anything here', null, ['all'])).toBe(true);
    expect(matchesCategory('Bitcoin price above $100k?', null, ['weather'])).toBe(false);
  });
});

describe('runCopytrade', () => {
  it('skips when slippage exceeds threshold', async () => {
    const trade = makeTrade({ price: 0.5 });
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [trade] } as Response);
    mockGetMarketBySlug.mockResolvedValue(makeMarket({ outcomePrices: '["0.9","0.1"]' }));

    const { runCopytrade } = await import('../index.js');
    const redis = { get: vi.fn(), set: vi.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis, 1000);

    expect(result.signals).toHaveLength(0);
  });

  it('respects category-specific slippage overrides', async () => {
    // Global max is 200, but mentions is 50
    configOverride = {
      ...configOverride,
      COPYTRADE_MAX_SLIPPAGE_BPS: 200,
      COPYTRADE_MAX_SLIPPAGE_BPS_CATEGORIES: { mentions: 50 },
      COPYTRADE_MARKET_SCOPE: ['all'],
    };

    // 100 BPS slippage (0.5 to 0.505)
    // (0.505 - 0.5) / 0.5 * 10000 = 100 BPS
    const trade = makeTrade({ price: 0.5, title: 'Will Elon Musk say "X"?' });
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [trade] } as Response);
    mockGetMarketBySlug.mockResolvedValue(
      makeMarket({
        question: 'Will Elon Musk say "X"?',
        outcomePrices: '["0.505","0.495"]',
      }),
    );

    const { runCopytrade } = await import('../index.js');
    const redis = { get: vi.fn(), set: vi.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis, 1000);

    // Should be skipped because 100 BPS > 50 BPS (mentions limit)
    expect(result.signals).toHaveLength(0);
  });

  it('skips near-resolution and low-liquidity markets', async () => {
    const trade = makeTrade();
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [trade] } as Response);
    mockGetMarketBySlug.mockResolvedValue(
      makeMarket({
        endDate: new Date(Date.now() + 1 * 3600_000).toISOString(),
        liquidity: '50',
      }),
    );

    const { runCopytrade } = await import('../index.js');
    const redis = { get: vi.fn(), set: vi.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis, 1000);

    expect(result.signals).toHaveLength(0);
  });

  it('scales and caps stake size', async () => {
    const trade = makeTrade({ usdcSize: 1000, price: 0.6 });
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [trade] } as Response);
    mockGetMarketBySlug.mockResolvedValue(makeMarket({ outcomePrices: '["0.6","0.4"]' }));

    const { runCopytrade } = await import('../index.js');
    const redis = { get: vi.fn(), set: vi.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis, 1000);

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.stakeUsd).toBe(25);
  });

  it('exits copytrade position when whale sells in rules mode', async () => {
    configOverride = { ...configOverride, COPYTRADE_EXIT_MODE: 'rules' };

    const trade = makeTrade({ side: 'SELL', outcomeIndex: 0, price: 0.6 });
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [trade] } as Response);
    mockGetMarketBySlug.mockResolvedValue(makeMarket({ outcomePrices: '["0.6","0.4"]' }));
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'market-1',
        conditionId: '0xcond',
        clobTokenIds: ['yes-token', 'no-token'],
        question: 'Q',
        direction: 'YES',
        entryPrice: 0.4,
        stakeUsd: 10,
        consensusProbability: 0.5,
        edgeMagnitude: 0.1,
        sourcedFrom: 'copytrade:0xabc',
        openedAt: new Date().toISOString(),
        executionVenue: 'simmer',
      },
    ]);
    mockFetchCurrentPrice.mockResolvedValue({
      marketId: 'market-1',
      direction: 'YES',
      currentOutcomePrice: 0.6,
      currentYesPrice: 0.6,
    });
    mockExecuteTakeProfit.mockResolvedValue({ success: true });

    const { runCopytrade } = await import('../index.js');
    const redis = { get: vi.fn(), set: vi.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis, 1000);

    expect(result.exits).toBe(1);
    expect(mockExecuteTakeProfit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'copytrade_mirror' }),
    );
  });

  it('exits copytrade position when whale sells in mirror mode', async () => {
    configOverride = { ...configOverride, COPYTRADE_EXIT_MODE: 'mirror' };

    const trade = makeTrade({ side: 'SELL', outcomeIndex: 0, price: 0.6 });
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [trade] } as Response);
    mockGetMarketBySlug.mockResolvedValue(makeMarket({ outcomePrices: '["0.6","0.4"]' }));
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'market-1',
        conditionId: '0xcond',
        clobTokenIds: ['yes-token', 'no-token'],
        question: 'Q',
        direction: 'YES',
        entryPrice: 0.4,
        stakeUsd: 10,
        consensusProbability: 0.5,
        edgeMagnitude: 0.1,
        sourcedFrom: 'copytrade:0xabc',
        openedAt: new Date().toISOString(),
        executionVenue: 'simmer',
      },
    ]);
    mockFetchCurrentPrice.mockResolvedValue({
      marketId: 'market-1',
      direction: 'YES',
      currentOutcomePrice: 0.6,
      currentYesPrice: 0.6,
    });
    mockExecuteTakeProfit.mockResolvedValue({ success: true });

    const { runCopytrade } = await import('../index.js');
    const redis = { get: vi.fn(), set: vi.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis, 1000);

    expect(result.exits).toBe(1);
    expect(mockExecuteTakeProfit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'copytrade_mirror' }),
    );
  });

  it('dedups by tx hash + asset + outcome', async () => {
    const trade = makeTrade({ transactionHash: '0xabc', asset: 'asset-9', outcomeIndex: 1 });
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [trade] } as Response);
    mockGetMarketBySlug.mockResolvedValue(makeMarket({ outcomePrices: '["0.6","0.4"]' }));

    const { runCopytrade } = await import('../index.js');
    const redis = { get: vi.fn(), set: vi.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    await runCopytrade(redis, 1000);

    expect(mockDedup).toHaveBeenCalledWith('copytrade:tx:0xabc:asset-9:1', expect.any(Number));
  });

  it('continues after a trade-level failure', async () => {
    const tradeA = makeTrade({ transactionHash: '0xaaa', slug: 'bad-market' });
    const tradeB = makeTrade({ transactionHash: '0xbbb', slug: 'good-market' });
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: async () => [tradeA, tradeB],
    } as Response);
    mockGetMarketBySlug
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(makeMarket({ outcomePrices: '["0.6","0.4"]' }));

    const { runCopytrade } = await import('../index.js');
    const redis = { get: vi.fn(), set: vi.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis, 1000);

    expect(result.signals).toHaveLength(1);
  });

  it('polls multiple wallets in parallel', async () => {
    configOverride = { ...configOverride, COPYTRADE_WALLETS: '0x1,0x2,0x3' };
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [] } as Response);

    const { runCopytrade } = await import('../index.js');
    const redis = { get: vi.fn(), set: vi.fn() } as any;
    await runCopytrade(redis, 1000);

    // Should call fetchWithTimeout for each wallet
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(3);
    const urls = mockFetchWithTimeout.mock.calls.map((c: any) => c[0] as string);
    expect(urls.some((u: any) => u.includes('user=0x1'))).toBe(true);
    expect(urls.some((u: any) => u.includes('user=0x2'))).toBe(true);
    expect(urls.some((u: any) => u.includes('user=0x3'))).toBe(true);
  });
});
