import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// --- Mocks ---

const mockSubmitClobBuy = jest.fn<() => Promise<{ success: boolean; error?: string }>>();
jest.unstable_mockModule('../../shared/clob.js', () => ({
  submitClobBuy: mockSubmitClobBuy,
}));

const mockGetBankroll = jest.fn<() => Promise<number>>();
const mockDeductStake = jest.fn<() => Promise<number>>();
jest.unstable_mockModule('../../shared/bankroll.js', () => ({
  getBankroll: mockGetBankroll,
  deductStake: mockDeductStake,
}));

jest.unstable_mockModule('../../shared/config.js', () => ({
  loadConfig: jest.fn(() => ({
    CLOB_FALLBACK_ENABLED: true,
    ARB_ENABLED: true,
    ARB_MIN_EDGE: 0.04,
    ARB_MAX_STAKE_FRACTION: 0.05,
  })),
}));

jest.unstable_mockModule('../../shared/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockGetActiveMarkets = jest.fn<() => Promise<unknown[]>>();

// Import real parse helpers before mocking the module
const { parseOutcomePrices: realParseOutcomePrices, parseClobTokenIds: realParseClobTokenIds } =
  await import('../../mapping/gamma.js');

jest.unstable_mockModule('../../mapping/gamma.js', () => ({
  getActiveMarkets: mockGetActiveMarkets,
  parseOutcomePrices: realParseOutcomePrices,
  parseClobTokenIds: realParseClobTokenIds,
}));

const { scanForArb, executeArb } = await import('../scanner.js');

// --- Redis mock ---

function makeRedis() {
  const store = new Map<string, string>();
  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    setex: jest.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    _store: store,
  };
}

// --- Helpers ---

function makeMarket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'market-1',
    question: 'Will X happen?',
    conditionId: 'cond-1',
    clobTokenIds: '["yes-token","no-token"]',
    outcomePrices: '["0.40","0.50"]', // edge = 0.10
    outcomes: ['Yes', 'No'],
    active: true,
    closed: false,
    volume: '1000',
    liquidity: '500',
    endDate: null,
    description: null,
    ...overrides,
  };
}

// --- Tests ---

describe('scanForArb', () => {
  let redis: ReturnType<typeof makeRedis>;

  beforeEach(() => {
    redis = makeRedis();
    jest.clearAllMocks();
  });

  it('returns market with edge > 0.04', async () => {
    mockGetActiveMarkets.mockResolvedValue([makeMarket()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opps = await scanForArb(redis as any);
    expect(opps).toHaveLength(1);
    expect(opps[0]!.edge).toBeCloseTo(0.10);
    expect(opps[0]!.marketId).toBe('market-1');
  });

  it('excludes market with edge <= 0.04', async () => {
    mockGetActiveMarkets.mockResolvedValue([
      makeMarket({ outcomePrices: '["0.48","0.49"]' }), // edge = 0.03
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opps = await scanForArb(redis as any);
    expect(opps).toHaveLength(0);
  });

  it('skips already-deduped market', async () => {
    redis._store.set('arb:attempted:market-1', '1');
    mockGetActiveMarkets.mockResolvedValue([makeMarket()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opps = await scanForArb(redis as any);
    expect(opps).toHaveLength(0);
  });
});

describe('executeArb', () => {
  let redis: ReturnType<typeof makeRedis>;

  const opp = {
    marketId: 'market-1',
    question: 'Will X happen?',
    yesTokenId: 'yes-token',
    noTokenId: 'no-token',
    yesAsk: 0.40,
    noAsk: 0.50,
    edge: 0.10,
  };

  beforeEach(() => {
    redis = makeRedis();
    jest.clearAllMocks();
    mockGetBankroll.mockResolvedValue(100);
    mockDeductStake.mockResolvedValue(90);
  });

  it('returns yes_leg_failed when YES leg fails — NO not submitted', async () => {
    mockSubmitClobBuy.mockResolvedValue({ success: false, error: 'no_fill' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeArb(opp, redis as any);
    expect(result.success).toBe(false);
    expect(result.error).toBe('yes_leg_failed');
    // submitClobBuy called only once (YES leg)
    expect(mockSubmitClobBuy).toHaveBeenCalledTimes(1);
    expect(mockDeductStake).not.toHaveBeenCalled();
  });

  it('returns no_leg_failed_unhedged when YES fills but NO fails', async () => {
    mockSubmitClobBuy
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'no_fill' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeArb(opp, redis as any);
    expect(result.success).toBe(false);
    expect(result.error).toBe('no_leg_failed_unhedged');
    expect(result.yesResult?.success).toBe(true);
    expect(result.noResult?.success).toBe(false);
    // YES leg filled = real USDC spent — bankroll must be decremented by 1 leg
    expect(mockDeductStake).toHaveBeenCalledWith(expect.anything(), 5);
  });

  it('deducts stakePerLeg * 2 when both legs fill', async () => {
    mockSubmitClobBuy.mockResolvedValue({ success: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeArb(opp, redis as any);
    expect(result.success).toBe(true);
    expect(mockSubmitClobBuy).toHaveBeenCalledTimes(2);
    // stakePerLeg = 100 * 0.05 = 5, so deduct 10
    expect(mockDeductStake).toHaveBeenCalledWith(expect.anything(), 10);
  });

  it('returns stake_too_small when bankroll too low', async () => {
    mockGetBankroll.mockResolvedValue(10); // 10 * 0.05 = 0.50 < 1.0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeArb(opp, redis as any);
    expect(result.success).toBe(false);
    expect(result.error).toBe('stake_too_small');
    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
  });

  it('sets dedup key on execution', async () => {
    mockSubmitClobBuy.mockResolvedValue({ success: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeArb(opp, redis as any);
    expect(redis.setex).toHaveBeenCalledWith('arb:attempted:market-1', 1800, '1');
  });

  it('passes FOK order type to both legs', async () => {
    mockSubmitClobBuy.mockResolvedValue({ success: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeArb(opp, redis as any);
    expect(mockSubmitClobBuy).toHaveBeenCalledWith(
      expect.objectContaining({ orderType: 'FOK', tokenId: 'yes-token' }),
    );
    expect(mockSubmitClobBuy).toHaveBeenCalledWith(
      expect.objectContaining({ orderType: 'FOK', tokenId: 'no-token' }),
    );
  });
});
