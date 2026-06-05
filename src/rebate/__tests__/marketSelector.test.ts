import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetCachedMarkets = vi.fn();
vi.mock('../../shared/watchlist.js', () => ({
  getCachedMarkets: (...args: unknown[]) => mockGetCachedMarkets(...args),
}));

const mockGetClobOrderBook = vi.fn();
vi.mock('../../shared/clob.js', () => ({
  getClobOrderBook: (...args: unknown[]) => mockGetClobOrderBook(...args),
}));

const mockFetchRecentMarketFlow = vi.fn();
vi.mock('../flowAnalyzer.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchRecentMarketFlow: (...args: unknown[]) => mockFetchRecentMarketFlow(...args),
  };
});

const baseRebateConfig = {
  REBATE_REQUIRE_FEE_MARKETS: true,
  REBATE_MIN_VOLUME: 50_000,
  REBATE_MIN_LIQUIDITY: 10_000,
  REBATE_MIN_SPREAD_BPS: 50,
  REBATE_MAX_SPREAD_ABS: 0.10,
  REBATE_MAX_MID_VWAP_DIVERGENCE: 0.10,
  REBATE_FLOW_LOOKBACK_HOURS: 6,
  REBATE_MIN_FLOW_USD_PER_HOUR: 50,
  REBATE_FEE_RATE_BPS: 1000,
  REBATE_QUOTE_EDGE: 0.01,
  REBATE_TWO_SIDED: true,
  REBATE_MIN_COMBINED_EDGE: 0.02,
};
const mockLoadConfig = vi.fn(() => ({ ...baseRebateConfig }));
vi.mock('../../shared/config.js', () => ({
  loadConfig: () => mockLoadConfig(),
}));

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { selectRebateMarkets } from '../marketSelector.js';
import { logger } from '../../shared/logger.js';
import type { MarketFlowStats } from '../flowAnalyzer.js';

const redis = {} as never;

function makeMarket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mkt-1',
    conditionId: '0xcond1',
    question: 'Will it rain tomorrow?',
    outcomes: '["Yes","No"]',
    outcomePrices: '["0.40","0.60"]',
    clobTokenIds: '["tok-yes","tok-no"]',
    volume: '100000',
    liquidity: '20000',
    endDate: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    feesEnabled: true,
    feeType: 'weather_fees',
    ...overrides,
  };
}

function makeBook(bid: number, ask: number): Record<string, unknown> {
  return {
    bids: bid > 0 ? [{ price: String(bid), size: '100' }] : [],
    asks: ask > 0 ? [{ price: String(ask), size: '100' }] : [],
    tick_size: '0.01',
    neg_risk: false,
  };
}

function makeFlow(overrides: Partial<MarketFlowStats> = {}): MarketFlowStats {
  return {
    tradeCount: 40,
    takerNotionalUsd: 1200,
    takerNotionalUsdPerHour: 200,
    feeEquivalentUsd: 30,
    feeEquivalentUsdPerHour: 5,
    vwapYes: 0.40,
    effectiveWindowHours: 6,
    ...overrides,
  };
}

describe('selectRebateMarkets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ ...baseRebateConfig });
    // YES book: 0.39/0.41 (mid 0.40), NO book: 0.58/0.62.
    mockGetClobOrderBook.mockImplementation((tokenId: string) =>
      Promise.resolve(tokenId === 'tok-yes' ? makeBook(0.39, 0.41) : makeBook(0.58, 0.62)),
    );
    mockFetchRecentMarketFlow.mockResolvedValue(makeFlow());
  });

  it('selects a fee-enabled market with real flow and quotes both sides at mid − edge', async () => {
    mockGetCachedMarkets.mockResolvedValue([makeMarket()]);

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected).toHaveLength(1);
    const c = selected[0]!;
    expect(c.feesEnabled).toBe(true);
    expect(c.yesMid).toBeCloseTo(0.40);
    expect(c.rebateShare).toBe(0.25);
    expect(c.score).toBeCloseTo(5); // feeEquivalentUsdPerHour
    expect(c.quotes).toHaveLength(2);
    const yes = c.quotes.find((q) => q.direction === 'YES')!;
    const no = c.quotes.find((q) => q.direction === 'NO')!;
    // YES: mid 0.40 − edge 0.01 = 0.39 (below ask 0.41 — no clamp needed)
    expect(yes.price).toBeCloseTo(0.39);
    expect(yes.tokenId).toBe('tok-yes');
    // NO: effective mid 0.60 − 0.01 = 0.59, clamped to physical NO ask − tick = 0.61 → stays 0.59
    expect(no.price).toBeCloseTo(0.59);
    expect(no.tokenId).toBe('tok-no');
    // Combined guard: 0.39 + 0.59 = 0.98 ≤ 1 − 0.02 ✓
    expect(yes.price + no.price).toBeLessThanOrEqual(1 - 0.02 + 1e-9);
  });

  it('excludes feesEnabled=false markets when REBATE_REQUIRE_FEE_MARKETS=true (audit finding 2)', async () => {
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({ id: 'no-fees', feesEnabled: false }),
      makeMarket({ id: 'fees', conditionId: '0xcond2' }),
    ]);

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected.map((c) => c.marketId)).toEqual(['fees']);
  });

  it('includes fee-free markets when the gate is explicitly disabled', async () => {
    mockLoadConfig.mockReturnValue({ ...baseRebateConfig, REBATE_REQUIRE_FEE_MARKETS: false });
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ feesEnabled: false })]);

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected).toHaveLength(1);
  });

  it('rejects ghost books: wide absolute spread (the NO-at-0.02 case)', async () => {
    mockGetCachedMarkets.mockResolvedValue([makeMarket()]);
    // YES book bid 0.01 / ask 0.86 — spreadAbs 0.85 ≫ 0.10 cap.
    mockGetClobOrderBook.mockResolvedValue(makeBook(0.01, 0.86));

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected).toHaveLength(0);
    // Flow fetch never happens — gated out before spending the API call.
    expect(mockFetchRecentMarketFlow).not.toHaveBeenCalled();
  });

  it('rejects books whose mid detached from the printed trade VWAP', async () => {
    mockGetCachedMarkets.mockResolvedValue([makeMarket()]);
    // Book mid 0.40 but trades print at 0.85 in YES frame.
    mockFetchRecentMarketFlow.mockResolvedValue(makeFlow({ vwapYes: 0.85 }));

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected).toHaveLength(0);
  });

  it('fails closed with a per-market warn when the tape has flow but no usable outcomeIndex', async () => {
    mockGetCachedMarkets.mockResolvedValue([makeMarket()]);
    // Flow passes the notional gate but no trade carried an outcomeIndex →
    // vwapYes null → cannot verify the book isn't detached from prints.
    mockFetchRecentMarketFlow.mockResolvedValue(makeFlow({ vwapYes: null }));

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected).toHaveLength(0);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      '[rebate] tape has flow but no usable outcomeIndex — failing closed',
      expect.objectContaining({ marketId: 'mkt-1', tradeCount: 40 }),
    );
  });

  it('rejects markets without enough recent taker flow', async () => {
    mockGetCachedMarkets.mockResolvedValue([makeMarket()]);
    mockFetchRecentMarketFlow.mockResolvedValue(
      makeFlow({ takerNotionalUsdPerHour: 10, feeEquivalentUsdPerHour: 0.2 }),
    );

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected).toHaveLength(0);
  });

  it('treats a failed flow fetch as do-not-quote, not as flow-exists', async () => {
    mockGetCachedMarkets.mockResolvedValue([makeMarket()]);
    mockFetchRecentMarketFlow.mockResolvedValue(null);

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected).toHaveLength(0);
  });

  it('ranks by recent fee-equivalent flow, not lifetime volume (audit finding 4)', async () => {
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({ id: 'big-volume-dead', conditionId: '0xdead', volume: '9000000' }),
      makeMarket({ id: 'small-volume-active', conditionId: '0xactive', volume: '60000' }),
    ]);
    mockFetchRecentMarketFlow.mockImplementation((conditionId: string) =>
      Promise.resolve(
        conditionId === '0xdead'
          ? makeFlow({ feeEquivalentUsdPerHour: 0.9, takerNotionalUsdPerHour: 60 })
          : makeFlow({ feeEquivalentUsdPerHour: 12, takerNotionalUsdPerHour: 800 }),
      ),
    );

    const selected = await selectRebateMarkets(redis, 1);

    expect(selected).toHaveLength(1);
    expect(selected[0]!.marketId).toBe('small-volume-active');
  });

  it('clamps a quote below a physical ask so post-only cannot cross', async () => {
    mockGetCachedMarkets.mockResolvedValue([makeMarket()]);
    // NO physical book has a low ask at 0.55 (< target 0.59).
    mockGetClobOrderBook.mockImplementation((tokenId: string) =>
      Promise.resolve(tokenId === 'tok-yes' ? makeBook(0.39, 0.41) : makeBook(0.30, 0.55)),
    );

    const selected = await selectRebateMarkets(redis, 10);

    const no = selected[0]!.quotes.find((q) => q.direction === 'NO')!;
    expect(no.price).toBeCloseTo(0.54); // 0.55 − tick
  });

  it('quotes only the majority side when two-sided mode is off', async () => {
    mockLoadConfig.mockReturnValue({ ...baseRebateConfig, REBATE_TWO_SIDED: false });
    mockGetCachedMarkets.mockResolvedValue([makeMarket()]);

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected[0]!.quotes).toHaveLength(1);
    // yesMid 0.40 < 0.5 → majority side is NO.
    expect(selected[0]!.quotes[0]!.direction).toBe('NO');
  });

  it('drops one side when the combined price would breach the riskless-pair guard', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseRebateConfig,
      // Edge so small both quotes land at mid: 0.40 + 0.60 = 1.00 > 1 − 0.02.
      REBATE_QUOTE_EDGE: 0,
      REBATE_MIN_COMBINED_EDGE: 0.02,
    });
    mockGetCachedMarkets.mockResolvedValue([makeMarket()]);

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected[0]!.quotes.length).toBeLessThanOrEqual(1);
  });

  it('applies the 20% crypto rebate share from feeType', async () => {
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ feeType: 'crypto_fees' })]);

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected[0]!.rebateShare).toBe(0.20);
  });
});
