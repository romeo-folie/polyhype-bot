import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

let configOverride = {
  COPYTRADE_ENABLED: true,
  COPYTRADE_WALLETS: '0xabc',
  COPYTRADE_MARKET_SCOPE: ['weather', 'geopolitics'],
  COPYTRADE_SIZE_SCALE: 0.1,
  COPYTRADE_MAX_STAKE_USD: 25,
  COPYTRADE_MAX_SLIPPAGE_BPS: 200,
  COPYTRADE_MIN_TIME_TO_RESOLVE_HOURS: 6,
  COPYTRADE_MIN_LIQUIDITY: 1000,
  COPYTRADE_EXIT_MODE: 'rules',
  MAX_BET_FRACTION: 0.1,
};

jest.unstable_mockModule('../../shared/logger.js', () => ({ logger: mockLogger }));

const mockDedup = jest.fn() as any;
jest.unstable_mockModule('../../shared/redis.js', () => ({ dedup: mockDedup }));

const mockFetchWithTimeout = jest.fn() as any;
const mockGetMarketBySlug = jest.fn() as any;
jest.unstable_mockModule('../../mapping/gamma.js', async () => {
  const actual = await import('../../mapping/gamma.js');
  return {
    ...actual,
    fetchWithTimeout: mockFetchWithTimeout,
    getMarketBySlug: mockGetMarketBySlug,
  };
});

const mockGetOpenPositions = jest.fn() as any;
jest.unstable_mockModule('../../execution/positionLedger.js', () => ({
  getOpenPositions: mockGetOpenPositions,
}));

const mockFetchCurrentPrice = jest.fn() as any;
jest.unstable_mockModule('../../monitor/priceFetcher.js', () => ({
  fetchCurrentPrice: mockFetchCurrentPrice,
}));

const mockExecuteTakeProfit = jest.fn() as any;
jest.unstable_mockModule('../../monitor/takeProfitExecutor.js', () => ({
  executeTakeProfit: mockExecuteTakeProfit,
}));

jest.unstable_mockModule('../../shared/config.js', () => ({
  loadConfig: jest.fn(() => configOverride),
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
  mockGetOpenPositions.mockReset();
  mockFetchCurrentPrice.mockReset();
  mockExecuteTakeProfit.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  configOverride = {
    COPYTRADE_ENABLED: true,
    COPYTRADE_WALLETS: '0xabc',
    COPYTRADE_MARKET_SCOPE: ['weather', 'geopolitics'],
    COPYTRADE_SIZE_SCALE: 0.1,
    COPYTRADE_MAX_STAKE_USD: 25,
    COPYTRADE_MAX_SLIPPAGE_BPS: 200,
    COPYTRADE_MIN_TIME_TO_RESOLVE_HOURS: 6,
    COPYTRADE_MIN_LIQUIDITY: 1000,
    COPYTRADE_EXIT_MODE: 'rules',
    MAX_BET_FRACTION: 0.1,
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
    expect(matchesCategory('Market Title', 'Military action in Middle East', ['geopolitics'])).toBe(true);
    expect(matchesCategory('Bitcoin price above $100k?', null, ['crypto'])).toBe(true);
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
    const redis = { get: jest.fn(), set: jest.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis as any, 1000);

    expect(result.signals).toHaveLength(0);
  });

  it('skips near-resolution and low-liquidity markets', async () => {
    const trade = makeTrade();
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [trade] } as Response);
    mockGetMarketBySlug.mockResolvedValue(makeMarket({
      endDate: new Date(Date.now() + 1 * 3600_000).toISOString(),
      liquidity: '50',
    }));

    const { runCopytrade } = await import('../index.js');
    const redis = { get: jest.fn(), set: jest.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis as any, 1000);

    expect(result.signals).toHaveLength(0);
  });

  it('scales and caps stake size', async () => {
    const trade = makeTrade({ usdcSize: 1000, price: 0.6 });
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [trade] } as Response);
    mockGetMarketBySlug.mockResolvedValue(makeMarket({ outcomePrices: '["0.6","0.4"]' }));

    const { runCopytrade } = await import('../index.js');
    const redis = { get: jest.fn(), set: jest.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis as any, 1000);

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.stakeUsd).toBe(25);
  });

  it('executes mirror exits only when configured', async () => {
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
    const redis = { get: jest.fn(), set: jest.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis as any, 1000);

    expect(result.exits).toBe(1);
    expect(mockExecuteTakeProfit).toHaveBeenCalled();
  });

  it('dedups by tx hash + asset + outcome', async () => {
    const trade = makeTrade({ transactionHash: '0xabc', asset: 'asset-9', outcomeIndex: 1 });
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [trade] } as Response);
    mockGetMarketBySlug.mockResolvedValue(makeMarket({ outcomePrices: '["0.6","0.4"]' }));

    const { runCopytrade } = await import('../index.js');
    const redis = { get: jest.fn(), set: jest.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    await runCopytrade(redis as any, 1000);

    expect(mockDedup).toHaveBeenCalledWith('copytrade:tx:0xabc:asset-9:1', expect.any(Number));
  });

  it('continues after a trade-level failure', async () => {
    const tradeA = makeTrade({ transactionHash: '0xaaa', slug: 'bad-market' });
    const tradeB = makeTrade({ transactionHash: '0xbbb', slug: 'good-market' });
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [tradeA, tradeB] } as Response);
    mockGetMarketBySlug
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(makeMarket({ outcomePrices: '["0.6","0.4"]' }));

    const { runCopytrade } = await import('../index.js');
    const redis = { get: jest.fn(), set: jest.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis as any, 1000);

    expect(result.signals).toHaveLength(1);
  });

  it('polls multiple wallets in parallel', async () => {
    configOverride = { ...configOverride, COPYTRADE_WALLETS: '0x1,0x2,0x3' };
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [] } as Response);

    const { runCopytrade } = await import('../index.js');
    const redis = { get: jest.fn(), set: jest.fn() } as any;
    await runCopytrade(redis as any, 1000);

    // Should call fetchWithTimeout for each wallet
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(3);
    const urls = mockFetchWithTimeout.mock.calls.map((c: any) => c[0] as string);
    expect(urls.some((u: any) => u.includes('user=0x1'))).toBe(true);
    expect(urls.some((u: any) => u.includes('user=0x2'))).toBe(true);
    expect(urls.some((u: any) => u.includes('user=0x3'))).toBe(true);
  });
});
