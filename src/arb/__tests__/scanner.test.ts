import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks ---

const mockSubmitClobBuy = vi.fn<() => Promise<{ success: boolean; error?: string }>>();
vi.mock('../../shared/clob.js', () => ({
  submitClobBuy: mockSubmitClobBuy,
}));

const mockGetBankroll = vi.fn<() => Promise<number>>();
const mockDeductStake = vi.fn<() => Promise<number>>();
vi.mock('../../shared/bankroll.js', () => ({
  getBankroll: mockGetBankroll,
  deductStake: mockDeductStake,
}));

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    CLOB_FALLBACK_ENABLED: true,
    ARB_ENABLED: true,
    ARB_MIN_EDGE: 0.05,
    ARB_MAX_STAKE_FRACTION: 0.05,
    ARB_FEE_RATE: 0.02,        // env-configurable fee rate
  })),
}));

vi.mock('../../shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock Telegram so unhedged alert doesn't make real HTTP calls
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock('../../execution/telegram.js', () => ({
  notifyUnhedgedArbPosition: vi.fn<() => Promise<void>>().mockResolvedValue(),
}));

const mockGetActiveMarkets = vi.fn<() => Promise<unknown[]>>();
vi.mock('../../mapping/gamma.js', async () => {
  const actual = await vi.importActual<typeof import('../../mapping/gamma.js')>('../../mapping/gamma.js');
  return {
    getActiveMarkets: mockGetActiveMarkets,
    parseOutcomePrices: actual.parseOutcomePrices,
    parseClobTokenIds: actual.parseClobTokenIds,
  };
});

const { scanForArb, executeArb } = await import('../scanner.js');

// Polymarket fee rate (matches POLYMARKET_FEE_RATE in scanner.ts)
const FEE_RATE = 0.02;

// --- Redis mock ---

function makeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      const had = store.has(key) ? 1 : 0;
      store.delete(key);
      return had;
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
    outcomePrices: '["0.40","0.50"]', // gross edge = 0.10; net = 0.10 - 0.90*0.02 = 0.082
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
    vi.clearAllMocks();
  });

  it('returns market with net edge > ARB_MIN_EDGE (0.05)', async () => {
    // gross=0.10, net = 0.10 - 0.90*0.02 = 0.082 > 0.05 ✅
    mockGetActiveMarkets.mockResolvedValue([makeMarket()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opps = await scanForArb(redis as any);
    expect(opps).toHaveLength(1);
    // edge reported is net edge
    const expectedNet = 0.10 - (0.40 + 0.50) * FEE_RATE;
    expect(opps[0]!.edge).toBeCloseTo(expectedNet, 4);
    expect(opps[0]!.grossEdge).toBeCloseTo(0.10, 4);
    expect(opps[0]!.marketId).toBe('market-1');
  });

  it('excludes market with net edge <= ARB_MIN_EDGE (0.05)', async () => {
    // yesAsk=0.48, noAsk=0.49 → gross=0.03, net=0.03-0.97*0.02=0.0106 < 0.05 ✗
    mockGetActiveMarkets.mockResolvedValue([
      makeMarket({ outcomePrices: '["0.48","0.49"]' }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opps = await scanForArb(redis as any);
    expect(opps).toHaveLength(0);
  });

  it('skips market with degenerate zero prices (combined < 0.02)', async () => {
    mockGetActiveMarkets.mockResolvedValue([
      makeMarket({ outcomePrices: '["0.00","0.00"]' }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opps = await scanForArb(redis as any);
    expect(opps).toHaveLength(0);
  });

  it('skips market with near-zero combined price', async () => {
    mockGetActiveMarkets.mockResolvedValue([
      makeMarket({ outcomePrices: '["0.005","0.005"]' }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opps = await scanForArb(redis as any);
    expect(opps).toHaveLength(0);
  });

  it('skips non-binary market with 3 outcomes', async () => {
    mockGetActiveMarkets.mockResolvedValue([
      makeMarket({
        outcomePrices: '["0.30","0.30","0.30"]',
        clobTokenIds: '["t1","t2","t3"]',
      }),
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

  // yesAsk=0.40, noAsk=0.50, combined=0.90
  // gross edge = 0.10; net edge after fees = 0.10 - 0.90*0.02 = 0.082
  const yesAsk = 0.40;
  const noAsk = 0.50;
  const combined = yesAsk + noAsk;
  const grossEdge = 1 - combined;
  const netEdge = grossEdge - combined * FEE_RATE;

  const opp = {
    marketId: 'market-1',
    question: 'Will X happen?',
    yesTokenId: 'yes-token',
    noTokenId: 'no-token',
    yesAsk,
    noAsk,
    grossEdge,
    edge: netEdge,
  };

  // bankroll=100, ARB_MAX_STAKE_FRACTION=0.05 → totalBudget=5
  // shares = 5 / 0.90 ≈ 5.556; yesUsd = 5.556 * 0.40 ≈ 2.222; noUsd = 5.556 * 0.50 ≈ 2.778
  const totalBudget = 100 * 0.05;
  const shares = totalBudget / combined;
  const yesUsd = shares * yesAsk;
  const noUsd = shares * noAsk;

  beforeEach(() => {
    redis = makeRedis();
    vi.clearAllMocks();
    mockGetBankroll.mockResolvedValue(100);
    mockDeductStake.mockResolvedValue(90);
  });

  it('returns yes_leg_failed when first leg (YES) fails — NO leg is aborted', async () => {
    mockSubmitClobBuy.mockResolvedValue({ success: false, error: 'no_fill' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeArb(opp, redis as any);
    expect(result.success).toBe(false);
    expect(result.error).toBe('yes_leg_failed');
    // NO leg should NOT be called if YES fails
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
    // YES leg cost + Polymarket taker fees should be deducted from bankroll
    expect(mockDeductStake).toHaveBeenCalledWith(expect.anything(), expect.closeTo(yesUsd * (1 + FEE_RATE), 4));
  });

  it('guards against unhedged risk when YES fills but NO fails', async () => {
    mockSubmitClobBuy
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'no_fill' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeArb(opp, redis as any);
    expect(result.success).toBe(false);
    expect(result.error).toBe('no_leg_failed_unhedged');
    expect(result.yesResult?.success).toBe(true);
    expect(result.noResult?.success).toBe(false);
    // YES leg cost + Polymarket taker fees should be deducted from bankroll
    expect(mockDeductStake).toHaveBeenCalledWith(expect.anything(), expect.closeTo(yesUsd * (1 + FEE_RATE), 4));
  });

  it('deducts yesUsd + noUsd (equal-share total cost) when both legs fill', async () => {
    mockSubmitClobBuy.mockResolvedValue({ success: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeArb(opp, redis as any);
    expect(result.success).toBe(true);
    expect(mockSubmitClobBuy).toHaveBeenCalledTimes(2);
    // Total cost = (yesUsd + noUsd) * (1 + FEE_RATE), includes Polymarket taker fees
    expect(mockDeductStake).toHaveBeenCalledWith(
      expect.anything(),
      expect.closeTo((yesUsd + noUsd) * (1 + FEE_RATE), 4),
    );
  });

  it('submits equal-share USD amounts — not equal dollar', async () => {
    mockSubmitClobBuy.mockResolvedValue({ success: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeArb(opp, redis as any);
    // YES leg gets yesUsd (< noUsd because yesAsk < noAsk)
    expect(mockSubmitClobBuy).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'yes-token', amountUsd: expect.closeTo(yesUsd, 4) }),
    );
    expect(mockSubmitClobBuy).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'no-token', amountUsd: expect.closeTo(noUsd, 4) }),
    );
    // The two amounts must differ (equal-share, not equal-dollar)
    expect(yesUsd).not.toBeCloseTo(noUsd, 2);
  });

  it('returns stake_too_small when bankroll too low', async () => {
    mockGetBankroll.mockResolvedValue(10); // 10 * 0.05 = 0.50 < 2.0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeArb(opp, redis as any);
    expect(result.success).toBe(false);
    expect(result.error).toBe('stake_too_small');
    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
  });

  it('uses SET NX for atomic dedup (not setex)', async () => {
    mockSubmitClobBuy.mockResolvedValue({ success: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeArb(opp, redis as any);
    // redis.set called with NX flag for atomic claim
    expect(redis.set).toHaveBeenCalledWith(
      'arb:attempted:market-1', '1', 'EX', 1800, 'NX',
    );
    // setex should NOT be used for the dedup key
    expect(redis.setex).not.toHaveBeenCalledWith('arb:attempted:market-1', expect.anything(), expect.anything());
  });

  it('returns dedup_concurrent when NX claim fails (concurrent run)', async () => {
    // Pre-populate the key so NX returns null
    redis._store.set('arb:attempted:market-1', '1');
    mockSubmitClobBuy.mockResolvedValue({ success: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeArb(opp, redis as any);
    expect(result.success).toBe(false);
    expect(result.error).toBe('dedup_concurrent');
    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
  });

  it('returns degenerate_price error when combined is near-zero', async () => {
    const degenerateOpp = {
      ...opp,
      yesAsk: 0.005,
      noAsk: 0.005,
      edge: 0.98,
      grossEdge: 0.99,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeArb(degenerateOpp, redis as any);
    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid_combined_price');
    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
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
