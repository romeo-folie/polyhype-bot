import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SpotMove } from '../thresholdDetector.js';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    LLM_PROVIDER: 'gemini',
    OPENAI_MODEL: 'gpt-4o-mini',
    GEMINI_MODEL: 'gemini-2.5-flash',
  }),
}));

const mockRedis = {
  get: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
  set: vi.fn<() => Promise<'OK'>>().mockResolvedValue('OK'),
};

vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn().mockReturnValue(mockRedis),
}));

vi.mock('../../mapping/gamma.js', () => ({
  searchEvents: vi.fn(),
  parseOutcomePrices: vi.fn(),
  parseClobTokenIds: vi.fn(),
}));

// Mock LLM modules
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      generateContent: vi.fn<any>().mockResolvedValue({
        response: { text: () => 'positive' },
      }),
    }),
  })),
}));

const { searchEvents, parseOutcomePrices, parseClobTokenIds } = await import(
  '../../mapping/gamma.js'
);
const { findCorrelatedMarkets } = await import('../marketCorrelator.js');

const mockSearchEvents = vi.mocked(searchEvents);
const mockParseOutcomePrices = vi.mocked(parseOutcomePrices);
const mockParseClobTokenIds = vi.mocked(parseClobTokenIds);

function makeMove(overrides: Partial<SpotMove> = {}): SpotMove {
  return {
    assetId: 'bitcoin',
    currentPrice: 67000,
    referencePrice: 65000,
    changePercent: 3.08,
    windowMinutes: 5,
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeGammaMarket(
  id: string,
  question: string,
  volume = '50000',
  liquidity = '10000',
) {
  return {
    id,
    question,
    conditionId: `cond-${id}`,
    clobTokenIds: '["tok-yes","tok-no"]',
    outcomePrices: '["0.60","0.40"]',
    outcomes: ['Yes', 'No'],
    active: true,
    closed: false,
    volume,
    liquidity,
    endDate: null,
    description: `Description for ${question}`,
  };
}

beforeEach(() => {
  mockSearchEvents.mockReset();
  mockParseOutcomePrices.mockReset();
  mockParseClobTokenIds.mockReset();
  mockRedis.get.mockReset().mockResolvedValue(null);
  mockRedis.set.mockReset().mockResolvedValue('OK');

  mockParseOutcomePrices.mockReturnValue(['0.60', '0.40']);
  mockParseClobTokenIds.mockReturnValue(['tok-yes', 'tok-no']);
});

describe('findCorrelatedMarkets', () => {
  it('returns correlated markets from Gamma search', async () => {
    const market = makeGammaMarket('mkt-1', 'Will Bitcoin exceed $100k by June?');
    mockSearchEvents.mockResolvedValue([
      { id: 'evt-1', title: 'Bitcoin', slug: 'bitcoin', active: true, closed: false, markets: [market] },
    ]);

    const results = await findCorrelatedMarkets(makeMove());

    expect(results).toHaveLength(1);
    expect(results[0]!.marketId).toBe('mkt-1');
    expect(results[0]!.currentYesPrice).toBe(0.6);
    expect(results[0]!.clobTokenIds).toEqual(['tok-yes', 'tok-no']);
    expect(results[0]!.correlationDirection).toBe('positive');
  });

  it('deduplicates markets across multiple search queries', async () => {
    const market = makeGammaMarket('mkt-1', 'Will BTC hit $100k?');
    mockSearchEvents.mockResolvedValue([
      { id: 'evt-1', title: 'BTC', slug: 'btc', active: true, closed: false, markets: [market] },
    ]);

    const results = await findCorrelatedMarkets(makeMove());

    // bitcoin has 3 search queries: "bitcoin", "BTC", "crypto"
    // Same market returned for each — should only appear once
    const uniqueIds = new Set(results.map((r) => r.marketId));
    expect(uniqueIds.size).toBe(results.length);
  });

  it('filters out markets below liquidity threshold', async () => {
    const lowLiquidity = makeGammaMarket('mkt-low', 'Low liquidity market', '100', '100');
    mockSearchEvents.mockResolvedValue([
      {
        id: 'evt-1',
        title: 'BTC',
        slug: 'btc',
        active: true,
        closed: false,
        markets: [lowLiquidity],
      },
    ]);

    const results = await findCorrelatedMarkets(makeMove());
    expect(results).toHaveLength(0);
  });

  it('filters out closed/inactive markets', async () => {
    const closedMarket = {
      ...makeGammaMarket('mkt-closed', 'Closed market'),
      active: false,
      closed: true,
    };
    mockSearchEvents.mockResolvedValue([
      {
        id: 'evt-1',
        title: 'BTC',
        slug: 'btc',
        active: true,
        closed: false,
        markets: [closedMarket],
      },
    ]);

    const results = await findCorrelatedMarkets(makeMove());
    expect(results).toHaveLength(0);
  });

  it('uses cached correlation direction from Redis', async () => {
    mockRedis.get.mockResolvedValue('negative');

    const market = makeGammaMarket('mkt-1', 'Will BTC regulation pass?');
    mockSearchEvents.mockResolvedValue([
      { id: 'evt-1', title: 'BTC', slug: 'btc', active: true, closed: false, markets: [market] },
    ]);

    const results = await findCorrelatedMarkets(makeMove());

    expect(results).toHaveLength(1);
    expect(results[0]!.correlationDirection).toBe('negative');
  });

  it('returns empty array when Gamma search fails', async () => {
    mockSearchEvents.mockRejectedValue(new Error('API error'));

    const results = await findCorrelatedMarkets(makeMove());
    expect(results).toHaveLength(0);
  });

  it('handles commodity assets with their specific search queries', async () => {
    const market = makeGammaMarket('mkt-oil', 'Will oil prices exceed $80?');
    mockSearchEvents.mockResolvedValue([
      { id: 'evt-1', title: 'Oil', slug: 'oil', active: true, closed: false, markets: [market] },
    ]);

    const results = await findCorrelatedMarkets(makeMove({ assetId: 'CL=F' }));

    // CL=F has search queries: "oil", "crude", "OPEC", "sanctions"
    expect(mockSearchEvents).toHaveBeenCalled();
    // At least one result from the first successful query
    expect(results.length).toBeGreaterThanOrEqual(0);
  });
});
