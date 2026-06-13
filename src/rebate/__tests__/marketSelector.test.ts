import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { z } from 'zod';

const mockGetCachedMarkets = vi.fn();
vi.mock('../../shared/watchlist.js', () => ({
  getCachedMarkets: (...args: unknown[]) => mockGetCachedMarkets(...args),
}));

const mockGetClobOrderBook = vi.fn();
vi.mock('../../shared/clob.js', () => ({
  getClobOrderBook: (...args: unknown[]) => mockGetClobOrderBook(...args),
}));
// NOTE: shared/bookTouch.js is intentionally NOT mocked — it's pure, and the
// raw-REST-ordering regression test below depends on its real scanning.

// Primary candidate universe: Gamma ordered by trailing-24h volume. The parse
// helpers stay real (pure functions) — only the fetch is mocked.
const mockGetActiveMarkets = vi.fn();
vi.mock('../../mapping/gamma.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getActiveMarkets: (...args: unknown[]) => mockGetActiveMarkets(...args),
  };
});

const mockFetchRecentMarketFlow = vi.fn();
vi.mock('../flowAnalyzer.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchRecentMarketFlow: (...args: unknown[]) => mockFetchRecentMarketFlow(...args),
  };
});

const mockGetOpenPositions = vi.fn();
const mockGetPosition = vi.fn();
vi.mock('../../execution/positionLedger.js', () => ({
  getOpenPositions: (...args: unknown[]) => mockGetOpenPositions(...args),
  getPosition: (...args: unknown[]) => mockGetPosition(...args),
}));

// Foundation from the REAL Zod schema defaults so the mock can't drift from
// config.ts (see feedback: hand-written literals crash on new cfg.X reads).
const { envSchema } = await vi.importActual<{ envSchema: z.AnyZodObject }>(
  '../../shared/config.js',
);
function schemaDefaults(schema: z.AnyZodObject): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const parsed = field.safeParse(undefined);
    if (parsed.success && parsed.data !== undefined) defaults[key] = parsed.data;
  }
  return defaults;
}

// Schema defaults as the foundation; the explicit values below pin the knobs
// these tests' price/flow expectations are computed from.
const baseRebateConfig = {
  ...schemaDefaults(envSchema),
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

import { selectRebateMarkets, classifySportsEligibility, buildCompletionCandidates } from '../marketSelector.js';
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
    mockGetActiveMarkets.mockResolvedValue([makeMarket()]);

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
    mockGetActiveMarkets.mockResolvedValue([
      makeMarket({ id: 'no-fees', feesEnabled: false }),
      makeMarket({ id: 'fees', conditionId: '0xcond2' }),
    ]);

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected.map((c) => c.marketId)).toEqual(['fees']);
  });

  it('includes fee-free markets when the gate is explicitly disabled', async () => {
    mockLoadConfig.mockReturnValue({ ...baseRebateConfig, REBATE_REQUIRE_FEE_MARKETS: false });
    mockGetActiveMarkets.mockResolvedValue([makeMarket({ feesEnabled: false })]);

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected).toHaveLength(1);
  });

  it('rejects ghost books: wide absolute spread (the NO-at-0.02 case)', async () => {
    mockGetActiveMarkets.mockResolvedValue([makeMarket()]);
    // YES book bid 0.01 / ask 0.86 — spreadAbs 0.85 ≫ 0.10 cap.
    mockGetClobOrderBook.mockResolvedValue(makeBook(0.01, 0.86));

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected).toHaveLength(0);
    // Flow fetch never happens — gated out before spending the API call.
    expect(mockFetchRecentMarketFlow).not.toHaveBeenCalled();
  });

  it('rejects books whose mid detached from the printed trade VWAP', async () => {
    mockGetActiveMarkets.mockResolvedValue([makeMarket()]);
    // Book mid 0.40 but trades print at 0.85 in YES frame.
    mockFetchRecentMarketFlow.mockResolvedValue(makeFlow({ vwapYes: 0.85 }));

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected).toHaveLength(0);
  });

  it('fails closed with a per-market warn when the tape has flow but no usable outcomeIndex', async () => {
    mockGetActiveMarkets.mockResolvedValue([makeMarket()]);
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
    mockGetActiveMarkets.mockResolvedValue([makeMarket()]);
    mockFetchRecentMarketFlow.mockResolvedValue(
      makeFlow({ takerNotionalUsdPerHour: 10, feeEquivalentUsdPerHour: 0.2 }),
    );

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected).toHaveLength(0);
  });

  it('treats a failed flow fetch as do-not-quote, not as flow-exists', async () => {
    mockGetActiveMarkets.mockResolvedValue([makeMarket()]);
    mockFetchRecentMarketFlow.mockResolvedValue(null);

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected).toHaveLength(0);
  });

  it('ranks by recent fee-equivalent flow, not lifetime volume (audit finding 4)', async () => {
    mockGetActiveMarkets.mockResolvedValue([
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
    mockGetActiveMarkets.mockResolvedValue([makeMarket()]);
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
    mockGetActiveMarkets.mockResolvedValue([makeMarket()]);

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected[0]!.quotes).toHaveLength(1);
    // yesMid 0.40 < 0.5 → majority side is NO.
    expect(selected[0]!.quotes[0]!.direction).toBe('NO');
  });

  it('skips the WHOLE market when the combined price breaches the riskless-pair guard (P1-5 fail closed)', async () => {
    // Behavioral inversion from the original audit fix: the old code spliced
    // one quote off and quoted the survivor — exactly a naked fresh leg. In
    // strict-pair mode a market that cannot host both legs is not selected.
    mockLoadConfig.mockReturnValue({
      ...baseRebateConfig,
      // Edge so small both quotes land at mid: 0.40 + 0.60 = 1.00 > 1 − 0.02.
      REBATE_QUOTE_EDGE: 0,
      REBATE_MIN_COMBINED_EDGE: 0.02,
    });
    mockGetActiveMarkets.mockResolvedValue([makeMarket()]);

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected).toHaveLength(0);
  });

  it('one-sided mode (REBATE_TWO_SIDED=false) still quotes a single majority side', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseRebateConfig,
      REBATE_TWO_SIDED: false,
      REBATE_QUOTE_EDGE: 0, // would breach the combined guard in two-sided mode
      REBATE_MIN_COMBINED_EDGE: 0.02,
    });
    mockGetActiveMarkets.mockResolvedValue([makeMarket()]);

    const selected = await selectRebateMarkets(redis, 10);

    // Documented-intentional one-sided mode: the combined ceiling does not apply.
    expect(selected).toHaveLength(1);
    expect(selected[0]!.quotes).toHaveLength(1);
  });

  it('applies the 20% crypto rebate share from feeType', async () => {
    mockGetActiveMarkets.mockResolvedValue([makeMarket({ feeType: 'crypto_fees' })]);

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected[0]!.rebateShare).toBe(0.20);
  });

  it('reads the touch from multi-level books in raw REST order (bids[0] = WORST bid)', async () => {
    // Regression for the live failure where every market skipped
    // spread_too_wide: the REST book has best-at-the-END ordering, so naive
    // bids[0]/asks[0] reads saw 0.01/0.99 on a 0.21/0.22 book.
    mockGetActiveMarkets.mockResolvedValue([makeMarket({ outcomePrices: '["0.21","0.79"]' })]);
    mockGetClobOrderBook.mockImplementation((tokenId: string) =>
      Promise.resolve(
        tokenId === 'tok-yes'
          ? {
              bids: [
                { price: '0.01', size: '26941' },
                { price: '0.19', size: '66185' },
                { price: '0.21', size: '234414' },
              ],
              asks: [
                { price: '0.99', size: '359445' },
                { price: '0.24', size: '35383' },
                { price: '0.22', size: '48152' },
              ],
              tick_size: '0.01',
              neg_risk: false,
            }
          : makeBook(0.77, 0.79),
      ),
    );
    mockFetchRecentMarketFlow.mockResolvedValue(makeFlow({ vwapYes: 0.215 }));

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected).toHaveLength(1);
    // Touch = 0.21/0.22 → mid 0.215, spreadAbs 0.01 (NOT 0.98).
    expect(selected[0]!.yesMid).toBeCloseTo(0.215);
    expect(selected[0]!.spreadAbs).toBeCloseTo(0.01);
    const yes = selected[0]!.quotes.find((q) => q.direction === 'YES')!;
    // mid 0.215 − edge 0.01 = 0.205, clamped below ask (0.22 − tick) → 0.205 → tick-rounded 0.20
    expect(yes.price).toBeCloseTo(0.20);
  });

  describe('candidate universe sourcing', () => {
    it('sources the universe from Gamma ordered by trailing-24h volume, not the watchlist cache', async () => {
      mockGetActiveMarkets.mockResolvedValue([makeMarket()]);

      const selected = await selectRebateMarkets(redis, 10);

      expect(selected).toHaveLength(1);
      // Paginated below Gamma's silent 100-row page cap, recency-ordered.
      expect(mockGetActiveMarkets).toHaveBeenCalledWith(200, 100, { order: 'volume24hr' });
      expect(mockGetCachedMarkets).not.toHaveBeenCalled();
    });

    it('falls back to the watchlist cache when the Gamma fetch throws', async () => {
      mockGetActiveMarkets.mockRejectedValue(new Error('Gamma API rate-limited (429)'));
      mockGetCachedMarkets.mockResolvedValue([makeMarket()]);

      const selected = await selectRebateMarkets(redis, 10);

      expect(selected).toHaveLength(1);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        '[rebate] gamma universe fetch failed — falling back to watchlist cache',
        expect.objectContaining({ error: expect.stringContaining('429') }),
      );
    });

    it('falls back to the watchlist cache when the Gamma fetch returns empty', async () => {
      mockGetActiveMarkets.mockResolvedValue([]);
      mockGetCachedMarkets.mockResolvedValue([makeMarket()]);

      const selected = await selectRebateMarkets(redis, 10);

      expect(selected).toHaveLength(1);
      expect(mockGetCachedMarkets).toHaveBeenCalled();
    });

    it('applies the volume floor to 24h volume when present (lifetime volume otherwise)', async () => {
      mockGetActiveMarkets.mockResolvedValue([
        // Huge lifetime volume but dead today — must be filtered (the
        // lifetime-volume failure mode that starved selection pre-fix).
        makeMarket({ id: 'dead-today', conditionId: '0xdead', volume: '9000000', volume24hr: 1000 }),
        // Modest lifetime volume but active today — must survive.
        makeMarket({ id: 'live-today', conditionId: '0xlive', volume: '100', volume24hr: 60000 }),
      ]);

      const selected = await selectRebateMarkets(redis, 10);

      expect(selected.map((c) => c.marketId)).toEqual(['live-today']);
    });

    it('skips in-play sports markets (gameStartTime in the past) when REBATE_EXCLUDE_LIVE_GAMES=true', async () => {
      mockGetActiveMarkets.mockResolvedValue([
        // Game started an hour ago — informed in-play flow, must be skipped.
        makeMarket({
          id: 'live-game',
          feeType: 'sports_fees_v2',
          gameStartTime: new Date(Date.now() - 3600_000).toISOString(),
        }),
        // Game starts in 3h — pre-game book, allowed.
        makeMarket({
          id: 'pre-game',
          conditionId: '0xcond2',
          feeType: 'sports_fees_v2',
          gameStartTime: new Date(Date.now() + 3 * 3600_000).toISOString(),
        }),
        // No gameStartTime and non-sports feeType — gate doesn't apply.
        makeMarket({ id: 'no-game-time', conditionId: '0xcond3' }),
      ]);

      const selected = await selectRebateMarkets(redis, 10);

      expect(selected.map((c) => c.marketId).sort()).toEqual(['no-game-time', 'pre-game']);
    });

    it('fails closed on sports markets with NO usable gameStartTime resolving near-term (P1-6)', async () => {
      mockGetActiveMarkets.mockResolvedValue([
        // sports-typed, missing game metadata, resolves tomorrow → reads as
        // in-play risk: ineligible.
        makeMarket({
          id: 'sports-no-meta',
          feeType: 'sports_fees_v2',
          endDate: new Date(Date.now() + 1 * 86_400_000).toISOString(),
        }),
        // sports-typed, missing game metadata, resolves in 10 days → a
        // long-dated outright (World Cup winner shape): eligible.
        makeMarket({
          id: 'sports-outright',
          conditionId: '0xcond2',
          feeType: 'sports_fees_v2',
          endDate: new Date(Date.now() + 10 * 86_400_000).toISOString(),
        }),
      ]);

      const selected = await selectRebateMarkets(redis, 10);

      expect(selected.map((c) => c.marketId)).toEqual(['sports-outright']);
    });

    it('also applies the sports gate on the cache-fallback path', async () => {
      // CachedMarket carries gameStartTime since the strict-pairs change —
      // the gate must keep working when Gamma is down. (Entries cached before
      // the field rolled out lack it and now FAIL CLOSED for near-term sports.)
      mockGetActiveMarkets.mockRejectedValue(new Error('gamma down'));
      mockGetCachedMarkets.mockResolvedValue([
        makeMarket({
          id: 'cached-live-game',
          feeType: 'sports_fees_v2',
          gameStartTime: new Date(Date.now() - 3600_000).toISOString(),
        }),
        makeMarket({ id: 'cached-non-sports', conditionId: '0xcond2' }),
      ]);

      const selected = await selectRebateMarkets(redis, 10);

      expect(selected.map((c) => c.marketId)).toEqual(['cached-non-sports']);
    });

    it('keeps in-play sports markets when REBATE_EXCLUDE_LIVE_GAMES=false', async () => {
      mockLoadConfig.mockReturnValue({ ...baseRebateConfig, REBATE_EXCLUDE_LIVE_GAMES: false });
      mockGetActiveMarkets.mockResolvedValue([
        makeMarket({
          id: 'live-game',
          feeType: 'sports_fees_v2',
          gameStartTime: new Date(Date.now() - 3600_000).toISOString(),
        }),
      ]);

      const selected = await selectRebateMarkets(redis, 10);

      expect(selected.map((c) => c.marketId)).toEqual(['live-game']);
    });

    it('applies the volume floor to lifetime volume on the cache fallback (no volume24hr field)', async () => {
      // CachedMarket rows lack volume24hr entirely — the ?? must fall through
      // to lifetime volume, not treat every cached market as zero-volume.
      mockGetActiveMarkets.mockRejectedValue(new Error('gamma down'));
      mockGetCachedMarkets.mockResolvedValue([
        makeMarket({ id: 'below-floor', volume: '1000' }), // < 50k floor
        makeMarket({ id: 'above-floor', conditionId: '0xcond2', volume: '100000' }),
      ]);

      const selected = await selectRebateMarkets(redis, 10);

      expect(selected.map((c) => c.marketId)).toEqual(['above-floor']);
    });
  });
});

// ── Sports eligibility classifier (pure) ─────────────────────────────────────

describe('classifySportsEligibility', () => {
  const inHours = (h: number): string => new Date(Date.now() + h * 3600_000).toISOString();

  it('classifies the six states', () => {
    expect(classifySportsEligibility({ feeType: 'weather_fees', gameStartTime: null, endDate: inHours(24) }, 2, 1)).toBe('non_sports');
    expect(classifySportsEligibility({ feeType: null, gameStartTime: null, endDate: null }, 2, 1)).toBe('non_sports');
    expect(classifySportsEligibility({ feeType: 'sports_fees_v2', gameStartTime: inHours(3), endDate: inHours(24) }, 2, 1)).toBe('pre_game');
    expect(classifySportsEligibility({ feeType: 'sports_fees_v2', gameStartTime: inHours(-1), endDate: inHours(24) }, 2, 1)).toBe('live');
    expect(classifySportsEligibility({ feeType: 'sports_fees_v2', gameStartTime: inHours(0.5), endDate: inHours(24) }, 2, 1)).toBe('starting_soon');
    expect(classifySportsEligibility({ feeType: 'sports_fees_v2', gameStartTime: null, endDate: inHours(24) }, 2, 1)).toBe('no_game_time_excluded');
    expect(classifySportsEligibility({ feeType: 'sports_fees_v2', gameStartTime: null, endDate: inHours(10 * 24) }, 2, 1)).toBe('outright_exempt');
  });

  it('treats unparseable gameStartTime as missing (fail closed for near-term)', () => {
    expect(
      classifySportsEligibility(
        { feeType: 'sports_fees_v2', gameStartTime: 'not-a-date', endDate: inHours(24) },
        2,
        1,
      ),
    ).toBe('no_game_time_excluded');
  });

  it('treats a sports market with no endDate as near-term (fail closed)', () => {
    expect(
      classifySportsEligibility({ feeType: 'sports_fees_v2', gameStartTime: null, endDate: null }, 2, 1),
    ).toBe('no_game_time_excluded');
  });
});

// ── Pre-game buffer (REBATE_MIN_HOURS_TO_GAME_START) ────────────────────────

describe('classifySportsEligibility — pre-game buffer', () => {
  const inHours = (h: number): string => new Date(Date.now() + h * 3600_000).toISOString();
  const sports = (startInH: number) => ({
    feeType: 'sports_fees_v2',
    gameStartTime: inHours(startInH),
    endDate: inHours(48),
  });

  it('classifies a game starting WITHIN the buffer as starting_soon (ineligible)', () => {
    expect(classifySportsEligibility(sports(0.5), 2, 1)).toBe('starting_soon');
    // Boundary: exactly at the buffer edge is still starting_soon (<=).
    expect(classifySportsEligibility(sports(1), 2, 1)).toBe('starting_soon');
  });

  it('classifies a game starting beyond the buffer as pre_game', () => {
    expect(classifySportsEligibility(sports(1.1), 2, 1)).toBe('pre_game');
    expect(classifySportsEligibility(sports(8), 2, 1)).toBe('pre_game');
  });

  it('buffer=0 disables the gate (any future start is pre_game)', () => {
    expect(classifySportsEligibility(sports(0.02), 2, 0)).toBe('pre_game');
  });

  it('a started game is live, not starting_soon', () => {
    expect(classifySportsEligibility(sports(-0.1), 2, 1)).toBe('live');
  });
});

describe('selectRebateMarkets — pre-game buffer exclusion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ ...baseRebateConfig });
    mockGetClobOrderBook.mockImplementation((tokenId: string) =>
      Promise.resolve(tokenId === 'tok-yes' ? makeBook(0.39, 0.41) : makeBook(0.58, 0.62)),
    );
    mockFetchRecentMarketFlow.mockResolvedValue(makeFlow());
  });

  it('excludes a sports market starting within the default 1h buffer (the NHL 5-min case)', async () => {
    mockGetActiveMarkets.mockResolvedValue([
      // Puck drop in 5 minutes — shadow caught this exact shape resting into
      // the live game. Must be starting_soon → excluded.
      makeMarket({
        id: 'puck-drop-soon',
        feeType: 'sports_fees_v2',
        gameStartTime: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
      // Same sport, 3h out — eligible.
      makeMarket({
        id: 'plenty-of-time',
        conditionId: '0xcond2',
        feeType: 'sports_fees_v2',
        gameStartTime: new Date(Date.now() + 3 * 3600_000).toISOString(),
      }),
    ]);

    const selected = await selectRebateMarkets(redis, 10);

    expect(selected.map((c) => c.marketId)).toEqual(['plenty-of-time']);
  });
});

describe('selectRebateMarkets — REBATE_EXCLUDE_LIVE_GAMES master switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClobOrderBook.mockImplementation((tokenId: string) =>
      Promise.resolve(tokenId === 'tok-yes' ? makeBook(0.39, 0.41) : makeBook(0.58, 0.62)),
    );
    mockFetchRecentMarketFlow.mockResolvedValue(makeFlow());
  });

  it('=false also disables the pre-game buffer (documented master-switch coupling)', async () => {
    mockLoadConfig.mockReturnValue({ ...baseRebateConfig, REBATE_EXCLUDE_LIVE_GAMES: false });
    mockGetActiveMarkets.mockResolvedValue([
      makeMarket({
        id: 'starting-in-5min',
        feeType: 'sports_fees_v2',
        gameStartTime: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
    ]);

    const selected = await selectRebateMarkets(redis, 10);

    // The whole sports-timing gate is off — starting_soon passes too.
    expect(selected.map((c) => c.marketId)).toEqual(['starting-in-5min']);
  });
});

describe('buildCompletionCandidates', () => {
  function nakedNoPosition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sourcedFrom: 'rebate-farming',
      direction: 'NO',
      marketId: 'mkt-nl',
      conditionId: '0xnl',
      clobTokenIds: ['tok-yes', 'tok-no'],
      question: 'Will Netherlands win?',
      entryPrice: 0.51,
      sharesHeld: 6,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ ...baseRebateConfig });
    // YES book 0.46/0.48 → mid 0.47 → YES completion quote = 0.47 − edge(0.01) = 0.46.
    mockGetClobOrderBook.mockImplementation((tokenId: string) =>
      Promise.resolve(tokenId === 'tok-yes' ? makeBook(0.46, 0.48) : makeBook(0.50, 0.54)),
    );
    mockGetPosition.mockResolvedValue(null); // no held opposite by default
    mockGetOpenPositions.mockResolvedValue([]);
  });

  it('builds a YES completion candidate for a naked NO leg on a de-selected market', async () => {
    mockGetOpenPositions.mockResolvedValue([nakedNoPosition()]);

    const out = await buildCompletionCandidates(redis, new Set<string>(), new Map());

    expect(out).toHaveLength(1);
    const c = out[0]!;
    expect(c.marketId).toBe('mkt-nl');
    expect(c.quotes).toHaveLength(1);
    expect(c.quotes[0]!.direction).toBe('YES');
    expect(c.quotes[0]!.price).toBeCloseTo(0.46, 5);
    // combined held NO 0.51 + completion YES 0.46 = 0.97 < ceiling 0.98.
  });

  it('builds a NO completion candidate for a naked YES leg (NO-book clamp path)', async () => {
    // Held YES @ 0.46 → completion is NO. effectiveMid = 1 − yesMid(0.47) = 0.53;
    // NO quote = 0.53 − edge(0.01) = 0.52, clamped by the NO book ask(0.54) − tick.
    mockGetOpenPositions.mockResolvedValue([nakedNoPosition({ direction: 'YES', entryPrice: 0.46 })]);

    const out = await buildCompletionCandidates(redis, new Set<string>(), new Map());

    expect(out).toHaveLength(1);
    const c = out[0]!;
    expect(c.quotes[0]!.direction).toBe('NO');
    expect(c.quotes[0]!.tokenId).toBe('tok-no');
    expect(c.quotes[0]!.price).toBeCloseTo(0.52, 5);
    // combined held YES 0.46 + NO 0.52 = 0.98 ≤ ceiling 0.98 (1e-9 tolerance) → built.
  });

  it('skips a market already selected this cycle (the Phase-4 loop owns it)', async () => {
    mockGetOpenPositions.mockResolvedValue([nakedNoPosition()]);

    const out = await buildCompletionCandidates(redis, new Set(['mkt-nl']), new Map());

    expect(out).toHaveLength(0);
  });

  it('skips when the opposite side is already held (pair already complete)', async () => {
    mockGetOpenPositions.mockResolvedValue([nakedNoPosition()]);
    mockGetPosition.mockResolvedValue({ direction: 'YES', sharesHeld: 6, entryPrice: 0.46 });

    const out = await buildCompletionCandidates(redis, new Set<string>(), new Map());

    expect(out).toHaveLength(0);
  });

  it('skips when the completion leg is already resting', async () => {
    mockGetOpenPositions.mockResolvedValue([nakedNoPosition()]);
    const resting = new Map<string, never>([
      ['oid-1', { marketId: 'mkt-nl', direction: 'YES' } as never],
    ]);

    const out = await buildCompletionCandidates(redis, new Set<string>(), resting);

    expect(out).toHaveLength(0);
  });

  it('skips when the completion would breach the pair-cost ceiling', async () => {
    // Held NO @ 0.55 + YES completion 0.46 = 1.01 > ceiling 0.98 → would lock a loss.
    mockGetOpenPositions.mockResolvedValue([nakedNoPosition({ entryPrice: 0.55 })]);

    const out = await buildCompletionCandidates(redis, new Set<string>(), new Map());

    expect(out).toHaveLength(0);
  });

  it('ignores non-rebate positions', async () => {
    mockGetOpenPositions.mockResolvedValue([
      nakedNoPosition({ sourcedFrom: 'weather:amsterdam' }),
    ]);

    const out = await buildCompletionCandidates(redis, new Set<string>(), new Map());

    expect(out).toHaveLength(0);
  });
});
