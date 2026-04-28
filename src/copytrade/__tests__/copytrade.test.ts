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
  COPYTRADE_MAX_TRADE_AGE_MIN: 30,
  COPYTRADE_EXIT_MODE: 'rules',
  MAX_BET_FRACTION: 0.1,
  COPYTRADE_MAX_BET_FRACTION: 0.1,
  TAKER_MIN_EDGE_CATEGORIES: {} as Record<string, number>,
  COPYTRADE_MAX_SLIPPAGE_BPS_CATEGORIES: {} as Record<string, number>,
};

vi.mock('../../shared/logger.js', () => ({ logger: mockLogger }));

const mockDedup = vi.fn();
vi.mock('../../shared/redis.js', () => ({ dedup: mockDedup }));

const mockFetchWithTimeout = vi.fn();
const mockGetMarketBySlug = vi.fn();
const mockGetEventTagSlugs = vi.fn();
vi.mock('../../mapping/gamma.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GammaModule>();
  return {
    ...actual,
    fetchWithTimeout: mockFetchWithTimeout,
    getMarketBySlug: mockGetMarketBySlug,
    getEventTagSlugs: mockGetEventTagSlugs,
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

const mockNotify = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
vi.mock('../../execution/telegram.js', () => ({
  notify: mockNotify,
  escapeHtml: (s: string) => s,
}));

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => configOverride),
}));

const makeTrade = (overrides?: Partial<Record<string, unknown>>) => ({
  proxyWallet: '0xabc',
  timestamp: Math.floor(Date.now() / 1000),
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
  mockGetEventTagSlugs.mockReset().mockResolvedValue([]);
  mockGetOpenPositions.mockReset().mockResolvedValue([]);
  mockFetchCurrentPrice.mockReset();
  mockExecuteTakeProfit.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockNotify.mockReset().mockResolvedValue(undefined);
  configOverride = {
    COPYTRADE_ENABLED: true,
    COPYTRADE_WALLETS: '0xabc',
    COPYTRADE_MARKET_SCOPE: ['weather', 'geopolitical'],
    COPYTRADE_SIZE_SCALE: 0.1,
    COPYTRADE_MAX_STAKE_USD: 25,
    COPYTRADE_MAX_SLIPPAGE_BPS: 200,
    COPYTRADE_MIN_TIME_TO_RESOLVE_HOURS: 6,
    COPYTRADE_MIN_LIQUIDITY: 1000,
    COPYTRADE_MAX_TRADE_AGE_MIN: 30,
    COPYTRADE_EXIT_MODE: 'rules',
    MAX_BET_FRACTION: 0.1,
    COPYTRADE_MAX_BET_FRACTION: 0.1,
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
    // Soccer: match-day "win on" pattern
    expect(matchesCategory('Will 1. FC Köln win on 2026-04-17?', null, ['sports-soccer'])).toBe(true);
    // Soccer: club-name tokens (no "win on" — exercises the added club keywords directly)
    expect(matchesCategory('Will Dortmund qualify for the Champions League?', null, ['sports-soccer'])).toBe(true);
    expect(matchesCategory('Will Arsenal finish top-4?', null, ['sports-soccer'])).toBe(true);
    expect(matchesCategory('Will Köln be relegated this season?', null, ['sports-soccer'])).toBe(true);
  });

  it('matches new sport keyword buckets', async () => {
    const { matchesCategory } = await import('../index.js');
    // NHL
    expect(matchesCategory('Stars vs. Wild', null, ['sports-nhl'])).toBe(true);
    expect(matchesCategory('Penguins vs. Flyers', null, ['sports-nhl'])).toBe(true);
    expect(matchesCategory('Who wins the Stanley Cup?', null, ['sports-nhl'])).toBe(true);
    // F1
    expect(matchesCategory('Will Valtteri Bottas be the 2026 F1 Drivers Champion?', null, ['sports-f1'])).toBe(true);
    expect(matchesCategory('Will Cadillac be the 2026 F1 Constructors Champion?', null, ['sports-f1'])).toBe(true);
    expect(matchesCategory('Monaco Grand Prix winner?', null, ['sports-f1'])).toBe(true);
    // MMA
    expect(matchesCategory('O/U 1.5 Rounds', null, ['sports-mma'])).toBe(true);
    expect(matchesCategory('Will fighter A win by TKO?', null, ['sports-mma'])).toBe(true);
    // broader soccer clubs
    expect(matchesCategory('Vejle BK vs. Silkeborg IF: O/U 2.5', null, ['sports-soccer'])).toBe(true);
    expect(matchesCategory('Club Necaxa vs. CD Guadalajara: O/U 4.5', null, ['sports-soccer'])).toBe(true);
  });

  it('matches via Gamma event tags when keyword fails', async () => {
    const { matchesCategory } = await import('../index.js');
    // "Avalanche vs. Kings" — team names are in keyword bucket so this is keyword match
    // Use a title with no keyword overlap to exercise the tag path
    const title = 'Mystery Market Title';
    expect(matchesCategory(title, null, ['sports-nhl'])).toBe(false);
    expect(matchesCategory(title, null, ['sports-nhl'], ['nhl', 'hockey', 'sports'])).toBe(true);
    expect(matchesCategory(title, null, ['sports-f1'], ['f1', 'formula-1'])).toBe(true);
    expect(matchesCategory(title, null, ['sports-mma'], ['ufc', 'sports'])).toBe(true);
    // Wrong scope — tags don't match
    expect(matchesCategory(title, null, ['weather'], ['nhl', 'hockey'])).toBe(false);
  });
});

describe('runCopytrade', () => {
  it('drops trades older than COPYTRADE_MAX_TRADE_AGE_MIN before pipeline', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const staleTrade = makeTrade({ timestamp: nowSec - 45 * 60 }); // 45 min old, floor is 30
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [staleTrade] } as Response);
    // If recency guard fails to drop, next gate is getMarketBySlug — force it to
    // throw so a leaked-through trade surfaces as a test failure.
    mockGetMarketBySlug.mockRejectedValue(new Error('recency guard leak'));

    const { runCopytrade } = await import('../index.js');
    const redis = { get: vi.fn(), set: vi.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis, 1000);

    expect(result.signals).toHaveLength(0);
    expect(mockGetMarketBySlug).not.toHaveBeenCalled();
  });

  it('advances last_ts cursor even when every trade is filtered by recency guard', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const staleTs = nowSec - 45 * 60;
    const staleTrade = makeTrade({ timestamp: staleTs });
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [staleTrade] } as Response);

    const { runCopytrade } = await import('../index.js');
    const redis = { get: vi.fn(), set: vi.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    await runCopytrade(redis, 1000);

    const cursorSet = redis.set.mock.calls.find(
      ([k]: [string]) => typeof k === 'string' && k.startsWith('copytrade:last_ts:'),
    );
    expect(cursorSet).toBeDefined();
    expect(cursorSet?.[1]).toBe(staleTs.toString());
  });

  it('uses cached slug-404 to skip getMarketBySlug HTTP call', async () => {
    const trade = makeTrade();
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [trade] } as Response);

    const { runCopytrade } = await import('../index.js');
    const redis = { get: vi.fn(), set: vi.fn() } as any;
    // Call order in runCopytrade:
    //   1) last_ts lookup → null (fresh wallet)
    //   2) persistent dedup check → null (tx not previously seen)
    //   3) slug-404 cache lookup → '1' (cached miss, short-circuit)
    redis.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('1');
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis, 1000);

    expect(result.signals).toHaveLength(0);
    expect(mockGetMarketBySlug).not.toHaveBeenCalled();
    expect(redis.get).toHaveBeenCalledWith(expect.stringMatching(/^copytrade:slug-404:/));
  });

  it('writes slug-404 cache entry when getMarketBySlug returns null', async () => {
    const trade = makeTrade();
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [trade] } as Response);
    mockGetMarketBySlug.mockResolvedValue(null);

    const { runCopytrade } = await import('../index.js');
    const redis = { get: vi.fn(), set: vi.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    await runCopytrade(redis, 1000);

    const setexCall = redis.set.mock.calls.find(
      ([k]: [string]) => typeof k === 'string' && k.startsWith('copytrade:slug-404:'),
    );
    expect(setexCall).toBeDefined();
    expect(setexCall?.[1]).toBe('1');
    expect(setexCall?.[2]).toBe('EX');
    expect(setexCall?.[3]).toBe(3600);
  });

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

  it('suppresses sports signals and sends Telegram notification when COPYTRADE_SPORTS_NOTIFY_ONLY=true', async () => {
    configOverride = {
      ...configOverride,
      COPYTRADE_SPORTS_NOTIFY_ONLY: true,
      COPYTRADE_MARKET_SCOPE: ['all'],
    };

    // Lakers/NBA title → inferCategory returns 'sports-nba' → starts with 'sports'
    const trade = makeTrade({
      title: 'Will the Lakers win the NBA Finals?',
      price: 0.4,
      side: 'BUY',
      outcomeIndex: 0,
    });
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [trade] } as Response);
    mockGetMarketBySlug.mockResolvedValue(
      makeMarket({
        question: 'Will the Lakers win the NBA Finals?',
        outcomePrices: '["0.4","0.6"]',
      }),
    );

    const { runCopytrade } = await import('../index.js');
    const redis = { get: vi.fn(), set: vi.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis, 1000);

    expect(result.signals).toHaveLength(0);
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining('suppressed'));
  });

  it('suppresses sports signals that pass scope via tag rescue (no keyword match)', async () => {
    // ATP match "Ostrava: Zdenek Kolar vs Filip Jianu" — no sports keywords in question,
    // passes scope via tag fallback but was bypassing notify-only gate (bug 2026-04-28).
    configOverride = {
      ...configOverride,
      COPYTRADE_SPORTS_NOTIFY_ONLY: true,
      COPYTRADE_MARKET_SCOPE: ['sports-tennis'],
      COPYTRADE_SCOPE_TAG_FALLBACK: true,
    };

    const trade = makeTrade({
      title: 'Ostrava: Zdenek Kolar vs Filip Jianu',
      price: 0.5,
      side: 'BUY',
      outcomeIndex: 0,
    });
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [trade] } as Response);
    mockGetMarketBySlug.mockResolvedValue(
      makeMarket({
        question: 'Ostrava: Zdenek Kolar vs Filip Jianu',
        outcomePrices: '["0.5","0.5"]',
        events: [{ id: 'evt-atp', slug: 'ostrava-atp' }],
      }),
    );
    mockGetEventTagSlugs.mockResolvedValue(['sports', 'tennis', 'atp']);

    const { runCopytrade } = await import('../index.js');
    const redis = { get: vi.fn(), set: vi.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis, 1000);

    expect(result.signals).toHaveLength(0);
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining('suppressed'));
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

  it('does not reject a 3h-TTR market when PM_MIN_HOURS_TO_RESOLUTION is 6', async () => {
    configOverride = {
      ...configOverride,
      COPYTRADE_MIN_TIME_TO_RESOLVE_HOURS: 0.25,
      PM_MIN_HOURS_TO_RESOLUTION: 6,
      PM_MAX_HOURS_TO_RESOLUTION_COPYTRADE: 2160,
    } as any;

    const trade = makeTrade({ price: 0.6 });
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [trade] } as Response);
    mockGetMarketBySlug.mockResolvedValue(
      makeMarket({
        outcomePrices: '["0.6","0.4"]',
        endDate: new Date(Date.now() + 3 * 3600_000).toISOString(),
      }),
    );

    const { runCopytrade } = await import('../index.js');
    const redis = { get: vi.fn(), set: vi.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis, 1000);

    const ttrSkip = mockLogger.info.mock.calls.some(
      (c: any[]) =>
        c[0] === '[copytrade] skipped by time-to-resolution gate' &&
        String(c[1]?.skipReason).includes('too_soon_expiring'),
    );
    expect(ttrSkip).toBe(false);
    expect(result.signals).toHaveLength(1);
  });

  it('rescues out-of-scope market via Gamma event tags', async () => {
    // Title has no keyword match for sports-nhl (no team names, no "nhl"/"hockey" etc.)
    // but the parent event carries the 'nhl' tag — exercises the tag fallback path.
    const trade = makeTrade({ title: 'Eastern Conference Playoff Series', slug: 'ec-playoff' });
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [trade] } as Response);
    mockGetMarketBySlug.mockResolvedValue(
      makeMarket({
        question: 'Eastern Conference Playoff Series',
        outcomePrices: '["0.6","0.4"]',
        events: [{ id: 'evt-999', slug: 'ec-playoff-event' }],
      }),
    );
    mockGetEventTagSlugs.mockResolvedValue(['nhl', 'hockey', 'sports']);

    configOverride = {
      ...configOverride,
      COPYTRADE_MARKET_SCOPE: ['sports-nhl'],
      COPYTRADE_SCOPE_TAG_FALLBACK: true,
    } as any;

    const { runCopytrade } = await import('../index.js');
    const redis = { get: vi.fn(), set: vi.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis, 1000);

    expect(mockGetEventTagSlugs).toHaveBeenCalledWith('evt-999');
    expect(result.signals).toHaveLength(1);
  });

  it('does not fetch event tags when keyword already matches', async () => {
    // "rain" triggers the weather keyword — tag fetch must be skipped
    const trade = makeTrade({ title: 'Will it rain in NYC?' });
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [trade] } as Response);
    mockGetMarketBySlug.mockResolvedValue(
      makeMarket({ question: 'Will it rain in NYC?', outcomePrices: '["0.6","0.4"]' }),
    );

    configOverride = {
      ...configOverride,
      COPYTRADE_MARKET_SCOPE: ['weather'],
      COPYTRADE_SCOPE_TAG_FALLBACK: true,
    } as any;

    const { runCopytrade } = await import('../index.js');
    const redis = { get: vi.fn(), set: vi.fn() } as any;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const result = await runCopytrade(redis, 1000);

    expect(mockGetEventTagSlugs).not.toHaveBeenCalled();
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
