import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type * as GammaModule from '../../mapping/gamma.js';

// ---------------------------------------------------------------------------
// Mocks -- must come before dynamic import
// ---------------------------------------------------------------------------

const mockGetBankroll = vi.fn<() => Promise<number>>();
vi.mock('../../shared/bankroll.js', () => ({
  getBankroll: mockGetBankroll,
}));

const mockGetCachedMarkets = vi.fn<() => Promise<unknown[]>>();
const mockGetNearZeroPeakPriceDetailed = vi.fn();
vi.mock('../../shared/watchlist.js', () => ({
  getCachedMarkets: mockGetCachedMarkets,
  getNearZeroPeakPriceDetailed: mockGetNearZeroPeakPriceDetailed,
}));

const mockEstimateConsensusProbability = vi.fn();
vi.mock('../../mapping/consensusCalculator.js', () => ({
  estimateConsensusProbability: mockEstimateConsensusProbability,
}));

const mockCheckTimeToResolution = vi.fn(() => ({ ok: true }));
vi.mock('../../mapping/divergenceCalculator.js', () => ({
  checkTimeToResolution: (...args: unknown[]) => mockCheckTimeToResolution(...args),
}));

const mockExecuteSignal = vi.fn();
vi.mock('../../execution/executor.js', () => ({
  executeAndRecordSignal: mockExecuteSignal,
}));

vi.mock('../../shared/zones.js', () => ({
  priceZoneOf: vi.fn(() => 5 as const),
}));

vi.mock('../../db/writeQueue.js', () => ({
  enqueueWrite: vi.fn(),
}));

vi.mock('../../shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// getRedis/closeRedis are top-level imports in the module-under-test even
// though runNearZeroScan receives redis as a parameter. Stub them so tests
// never touch a real ioredis connection.
vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn(),
  closeRedis: vi.fn(),
}));

const mockCheckBookDepthForStake = vi.fn();
vi.mock('../../execution/bookDepthCheck.js', () => ({
  checkBookDepthForStake: (...args: unknown[]) => mockCheckBookDepthForStake(...args),
}));

const mockGetRecentOsintItems = vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
vi.mock('../../ingestion/osintStore.js', () => ({
  getRecentOsintItems: (...args: unknown[]) => mockGetRecentOsintItems(...(args as [])),
}));

const mockExtractTheme = vi.fn<(q: string) => string | null>(() => null);
const mockAddNearZeroPosition = vi.fn().mockResolvedValue(undefined);
const mockCountOpenNearZeroPositions = vi.fn<() => Promise<number>>().mockResolvedValue(0);
const mockCountOpenPositionsInTheme = vi.fn<() => Promise<number>>().mockResolvedValue(0);
vi.mock('../../shared/themeExtractor.js', () => ({
  extractTheme: (...args: unknown[]) => mockExtractTheme(args[0] as string),
  addNearZeroPosition: (...args: unknown[]) => mockAddNearZeroPosition(...args),
  countOpenNearZeroPositions: () => mockCountOpenNearZeroPositions(),
  countOpenPositionsInTheme: () => mockCountOpenPositionsInTheme(),
}));

// Real gamma parsers — they're pure helpers and trivial.
vi.mock('../../mapping/gamma.js', async () => {
  const actual = await vi.importActual<typeof GammaModule>('../../mapping/gamma.js');
  return {
    parseOutcomePrices: actual.parseOutcomePrices,
    parseClobTokenIds: actual.parseClobTokenIds,
    parseOutcomes: actual.parseOutcomes,
  };
});

const DEFAULT_CONFIG = {
  NEAR_ZERO_SCANNER_ENABLED: false,
  NEAR_ZERO_MIN_PRICE: 0.03,
  NEAR_ZERO_MAX_PRICE: 0.10,
  NEAR_ZERO_MIN_CONSENSUS: 0.60,
  NEAR_ZERO_MAX_STAKE_USD: 5,
  NEAR_ZERO_MAX_CANDIDATES_PER_RUN: 5,
  NEAR_ZERO_MIN_LIQUIDITY: 500,
  NEAR_ZERO_MIN_HOURS: 24,
  NEAR_ZERO_DEDUP_TTL_S: 21_600,
  NEAR_ZERO_DEDUP_TTL_S_NON_OSINT: 86_400,
  NEAR_ZERO_REQUIRE_REPRICE: false,
  NEAR_ZERO_REPRICE_LOOKBACK_DAYS: 7,
  NEAR_ZERO_REPRICE_MIN_PEAK: 0.15,
  NEAR_ZERO_EXCLUDE_KEYWORDS: '',
  NEAR_ZERO_MIN_EDGE: 0.50,
  NEAR_ZERO_MAX_STDDEV: 0.20,
  NEAR_ZERO_OSINT_SIGNAL_TTL_S: 172_800,
  NEAR_ZERO_MIN_PRICE_DROP_PCT: 0.10,
  NEAR_ZERO_MAX_PER_THEME: 1,
  NEAR_ZERO_MAX_OPEN_POSITIONS: 4,
  NEAR_ZERO_REQUIRE_OSINT: false, // off by default in tests to isolate other gates
  NEAR_ZERO_MAX_SLIPPAGE_BPS: 200,
  NEAR_ZERO_REENTRY_COOLDOWN_S: 86400,
  MIN_BET_USD: 5,
};

const mockLoadConfig = vi.fn(() => ({ ...DEFAULT_CONFIG }));
vi.mock('../../shared/config.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

// ---------------------------------------------------------------------------
// Dynamic import (after mocks are set up)
// ---------------------------------------------------------------------------

const { runNearZeroScan, isExcludedByHeuristic } = await import('../nearZeroScanner.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMarket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mkt-1',
    question: 'Will the Kharg Island terminal cease Iranian control by 2026-06-01?',
    conditionId: 'cond-1',
    clobTokenIds: JSON.stringify(['yes-token-1', 'no-token-1']),
    outcomePrices: JSON.stringify(['0.07', '0.93']),
    outcomes: JSON.stringify(['Yes', 'No']),
    active: true,
    closed: false,
    volume: '50000',
    liquidity: '5000',
    endDate: '2026-06-01T00:00:00Z',
    description: null,
    ...overrides,
  };
}

interface FakeRedisState {
  getMap: Map<string, string>;
  setCalls: { key: string; value: string; ttl?: number; mode?: string }[];
  zrangeMembers: string[];
  nxRejectKeys: Set<string>;
  scardMap: Map<string, number>;
}

function makeRedis(initial: Partial<FakeRedisState> = {}): { redis: Redis; state: FakeRedisState } {
  const state: FakeRedisState = {
    getMap: initial.getMap ?? new Map(),
    setCalls: initial.setCalls ?? [],
    zrangeMembers: initial.zrangeMembers ?? [],
    nxRejectKeys: initial.nxRejectKeys ?? new Set(),
    scardMap: initial.scardMap ?? new Map(),
  };

  const redis = {
    get: vi.fn(async (key: string) => state.getMap.get(key) ?? null),
    scard: vi.fn(async (key: string) => state.scardMap.get(key) ?? 0),
    set: vi.fn(async (...args: unknown[]) => {
      const key = args[0] as string;
      const value = args[1] as string;
      // Support the signatures we actually use:
      //   set(key, value, 'EX', ttl)          — unconditional set
      //   set(key, value, 'EX', ttl, 'NX')    — NX claim
      let ttl: number | undefined;
      let mode: string | undefined;
      for (let i = 2; i < args.length; i++) {
        const arg = args[i];
        if (arg === 'EX' && typeof args[i + 1] === 'number') {
          ttl = args[i + 1] as number;
          i++;
        } else if (arg === 'NX') {
          mode = 'NX';
        }
      }
      state.setCalls.push({ key, value, ttl, mode });
      if (mode === 'NX' && state.nxRejectKeys.has(key)) {
        return null;
      }
      state.getMap.set(key, value);
      return 'OK';
    }),
    zrangebyscore: vi.fn(async () => state.zrangeMembers),
  } as unknown as Redis;

  return { redis, state };
}

// ---------------------------------------------------------------------------
// Existing behavior: heuristic exclusion patterns
// ---------------------------------------------------------------------------

describe('nearZeroScanner.isExcludedByHeuristic', () => {
  describe('head-to-head matchup pattern', () => {
    it('excludes tennis tournament matchups', () => {
      expect(isExcludedByHeuristic('BMW Open: Zhizhen Zhang vs Luciano Darderi')).toBe(true);
      expect(
        isExcludedByHeuristic('Open Capfinances Rouen Metropole: Chloe Paquet vs Xinyu Wang'),
      ).toBe(true);
      expect(isExcludedByHeuristic('Busan: Liam Broady vs Ilya Ivashka')).toBe(true);
      expect(isExcludedByHeuristic('Barcelona Open: Reilly Opelka vs Ethan Quinn')).toBe(true);
    });

    it('excludes baseball matchups', () => {
      expect(isExcludedByHeuristic('New York Yankees vs. Tampa Bay Rays')).toBe(true);
      expect(isExcludedByHeuristic('Miami Marlins vs. Atlanta Braves')).toBe(true);
    });

    it('does not match questions without a head-to-head format', () => {
      expect(isExcludedByHeuristic('Will Bitcoin reach $75,000 in April?')).toBe(false);
      expect(isExcludedByHeuristic('Iran x Israel/US conflict ends by June 30?')).toBe(false);
      expect(isExcludedByHeuristic('Will inflation reach more than 3.5% in 2026?')).toBe(false);
      expect(
        isExcludedByHeuristic('Kharg Island no longer under Iranian control by April 30?'),
      ).toBe(false);
      expect(
        isExcludedByHeuristic('Trump announces US x Iran ceasefire end by April 21, 2026?'),
      ).toBe(false);
    });

    it('does not match lowercase "vs" without capitalized right-hand name', () => {
      expect(isExcludedByHeuristic('How does X compare vs the baseline?')).toBe(false);
    });
  });

  describe('existing patterns still match', () => {
    it('excludes championship wins', () => {
      expect(isExcludedByHeuristic('Will Team X win the championship?')).toBe(true);
    });

    it('excludes "next president" markets', () => {
      expect(isExcludedByHeuristic('Who will be the next president of Country Y?')).toBe(true);
    });

    it('excludes award wins', () => {
      expect(isExcludedByHeuristic('Will Movie Z win an Oscar?')).toBe(true);
    });

    it('excludes playoff reach markets', () => {
      expect(isExcludedByHeuristic('Will Team A make the playoff?')).toBe(true);
      expect(isExcludedByHeuristic('Will Team B reach the semifinal?')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// PR 1: shadow observability + dedup hygiene
// ---------------------------------------------------------------------------

describe('runNearZeroScan — shadow observability + dedup hygiene', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG });
    mockGetBankroll.mockResolvedValue(500);
    mockGetCachedMarkets.mockResolvedValue([]);
    mockCheckTimeToResolution.mockReturnValue({ ok: true });
    mockGetNearZeroPeakPriceDetailed.mockResolvedValue(null);
    mockExecuteSignal.mockResolvedValue({
      skipped: false,
      executionVenue: 'clob',
      entryPrice: 0.07,
    });
    mockExtractTheme.mockReturnValue(null);
    mockCountOpenNearZeroPositions.mockResolvedValue(0);
    mockCountOpenPositionsInTheme.mockResolvedValue(0);
    mockAddNearZeroPosition.mockResolvedValue(undefined);
    mockCheckBookDepthForStake.mockResolvedValue({ ok: true, expectedFillPrice: 0.07, expectedSlippageBps: 0 });
    mockGetRecentOsintItems.mockResolvedValue([]);
  });

  it('wouldTradeIfEnabled is true when all gates pass but scanner is disabled', async () => {
    const { redis } = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([makeMarket()]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, NEAR_ZERO_SCANNER_ENABLED: false });
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'strong fundamentals',
      stddev: 0.05,
      sampleCount: 3,
    });

    await runNearZeroScan(redis);

    // Execution is gated off — no signal should be sent to the executor.
    expect(mockExecuteSignal).not.toHaveBeenCalled();

    // But the shadow log must reflect that the candidate WOULD have traded.
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    const enqueueMock = vi.mocked(enqueueWrite);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [, payload] = enqueueMock.mock.calls[0]!;
    expect(payload.source).toBe('near-zero-arb');
    expect(payload.wouldBlock).toBe(false);
    const inner = payload.payload as Record<string, unknown>;
    expect(inner.wouldTradeIfEnabled).toBe(true);
    expect(inner.wouldExecute).toBe(false);
    expect(inner.scannerEnabled).toBe(false);
    expect(inner.blockedReason).toBeNull();
  });

  it('wouldBlock=true and blockedReason=stddev_too_high when only stddev gate fails', async () => {
    const { redis } = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([makeMarket()]);
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'noisy providers',
      stddev: 0.40, // > NEAR_ZERO_MAX_STDDEV (0.20); pOurSide and edge both pass
      sampleCount: 3,
    });

    await runNearZeroScan(redis);

    const { enqueueWrite } = await import('../../db/writeQueue.js');
    const enqueueMock = vi.mocked(enqueueWrite);
    const [, payload] = enqueueMock.mock.calls[0]!;
    expect(payload.wouldBlock).toBe(true);
    expect(payload.metricValue).toBeCloseTo(0.40);
    expect(payload.threshold).toBe(DEFAULT_CONFIG.NEAR_ZERO_MAX_STDDEV);
    expect((payload.payload as Record<string, unknown>).blockedReason).toBe('stddev_too_high');
  });

  it('blockedReason=consensus_below_threshold when consensus gate is first to fail', async () => {
    const { redis } = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([makeMarket()]);
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.50, // pOurSide=0.50 < MIN_CONSENSUS=0.60
      reasoning: 'uncertain',
      stddev: 0.05,
      sampleCount: 3,
    });

    await runNearZeroScan(redis);

    const { enqueueWrite } = await import('../../db/writeQueue.js');
    const enqueueMock = vi.mocked(enqueueWrite);
    const [, payload] = enqueueMock.mock.calls[0]!;
    expect(payload.wouldBlock).toBe(true);
    expect(payload.metricValue).toBeCloseTo(0.50);
    expect(payload.threshold).toBe(DEFAULT_CONFIG.NEAR_ZERO_MIN_CONSENSUS);
    expect((payload.payload as Record<string, unknown>).blockedReason).toBe('consensus_below_threshold');
  });

  it('dedup key is NOT set when the LLM call throws', async () => {
    const { redis, state } = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-throw' })]);
    mockEstimateConsensusProbability.mockRejectedValue(new Error('LLM timeout'));

    await runNearZeroScan(redis);

    const dedupSets = state.setCalls.filter((c) => c.key === 'near_zero:dedup:mkt-throw:YES');
    expect(dedupSets).toHaveLength(0);

    // In-flight NX claim still happened — that's what guards against concurrent runs.
    const inflightSets = state.setCalls.filter(
      (c) => c.key === 'near_zero:inflight:mkt-throw:YES' && c.mode === 'NX',
    );
    expect(inflightSets).toHaveLength(1);
    expect(inflightSets[0]!.ttl).toBe(300);
  });

  it('dedup key IS set after a successful evaluation even when wouldExecute=false', async () => {
    const { redis, state } = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-shadow' })]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, NEAR_ZERO_SCANNER_ENABLED: false });
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'ok',
      stddev: 0.05,
      sampleCount: 3,
    });

    await runNearZeroScan(redis);

    const dedupSets = state.setCalls.filter((c) => c.key === 'near_zero:dedup:mkt-shadow:YES');
    expect(dedupSets).toHaveLength(1);
    expect(dedupSets[0]!.ttl).toBe(DEFAULT_CONFIG.NEAR_ZERO_DEDUP_TTL_S_NON_OSINT);
    expect(dedupSets[0]!.mode).toBeUndefined();
    expect(mockExecuteSignal).not.toHaveBeenCalled();
  });

  it('uses OSINT TTL when the candidate matched an OSINT signal', async () => {
    const { redis, state } = makeRedis({
      zrangeMembers: [
        JSON.stringify({
          marketId: 'mkt-osint',
          direction: 'YES',
          headline: 'Fresh IAEA statement: Kharg operations suspended',
          urgencyScore: 9,
        }),
      ],
    });
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-osint' })]);
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'ok',
      stddev: 0.05,
      sampleCount: 3,
    });

    await runNearZeroScan(redis);

    const dedupSets = state.setCalls.filter((c) => c.key === 'near_zero:dedup:mkt-osint:YES');
    expect(dedupSets).toHaveLength(1);
    expect(dedupSets[0]!.ttl).toBe(DEFAULT_CONFIG.NEAR_ZERO_DEDUP_TTL_S);
  });

  it('skips candidate when in-flight NX claim fails (concurrent run guard)', async () => {
    const { redis, state } = makeRedis({
      nxRejectKeys: new Set(['near_zero:inflight:mkt-busy:YES']),
    });
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-busy' })]);
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'ok',
      stddev: 0.05,
      sampleCount: 3,
    });

    await runNearZeroScan(redis);

    expect(mockEstimateConsensusProbability).not.toHaveBeenCalled();
    expect(mockExecuteSignal).not.toHaveBeenCalled();
    const dedupSets = state.setCalls.filter((c) => c.key === 'near_zero:dedup:mkt-busy:YES');
    expect(dedupSets).toHaveLength(0);
  });

  it('executes and writes dedup when scanner is enabled and gates pass', async () => {
    const { redis, state } = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-live' })]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, NEAR_ZERO_SCANNER_ENABLED: true });
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'ok',
      stddev: 0.05,
      sampleCount: 3,
    });

    await runNearZeroScan(redis);

    expect(mockExecuteSignal).toHaveBeenCalledTimes(1);
    const dedupSets = state.setCalls.filter((c) => c.key === 'near_zero:dedup:mkt-live:YES');
    expect(dedupSets).toHaveLength(1);
  });

  it('skips candidates whose dedup key is already present (no LLM call)', async () => {
    const { redis, state } = makeRedis({
      getMap: new Map([['near_zero:dedup:mkt-dup:YES', '1']]),
    });
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-dup' })]);

    await runNearZeroScan(redis);

    expect(mockEstimateConsensusProbability).not.toHaveBeenCalled();
    // No inflight claim either — we bail out before the eval loop.
    const inflightSets = state.setCalls.filter((c) => c.key.startsWith('near_zero:inflight:'));
    expect(inflightSets).toHaveLength(0);
  });

  // ── Theme cap (PR 2) ──────────────────────────────────────────────────────

  it('skips LLM when theme cap is already reached', async () => {
    const { redis } = makeRedis();
    mockCountOpenPositionsInTheme.mockResolvedValue(1); // at cap (NEAR_ZERO_MAX_PER_THEME=1)
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({ id: 'mkt-iran-new', question: 'Will Iran and Israel declare a ceasefire?' }),
    ]);
    mockExtractTheme.mockReturnValue('iran-israel-conflict');

    await runNearZeroScan(redis);

    expect(mockEstimateConsensusProbability).not.toHaveBeenCalled();
    expect(mockExecuteSignal).not.toHaveBeenCalled();
  });

  it('skips LLM when global position cap is reached', async () => {
    const { redis } = makeRedis(); // state unused — scard via mockCountOpenNearZeroPositions
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-over-cap' })]);
    mockExtractTheme.mockReturnValue(null);
    mockCountOpenNearZeroPositions.mockResolvedValue(4); // at cap

    await runNearZeroScan(redis);

    expect(mockEstimateConsensusProbability).not.toHaveBeenCalled();
  });

  it('calls addNearZeroPosition after a successful execution', async () => {
    const { redis } = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-new-trade' })]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, NEAR_ZERO_SCANNER_ENABLED: true });
    mockExtractTheme.mockReturnValue('inflation');
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'ok',
      stddev: 0.05,
      sampleCount: 3,
    });

    await runNearZeroScan(redis);

    expect(mockExecuteSignal).toHaveBeenCalledTimes(1);
    expect(mockAddNearZeroPosition).toHaveBeenCalledWith(
      redis,
      'inflation',
      'mkt-new-trade',
      'YES',
    );
  });

  it('does NOT call addNearZeroPosition when executor skips the trade', async () => {
    const { redis } = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-skipped' })]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, NEAR_ZERO_SCANNER_ENABLED: true });
    mockExtractTheme.mockReturnValue('btc-price-target');
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'ok',
      stddev: 0.05,
      sampleCount: 3,
    });
    mockExecuteSignal.mockResolvedValue({ skipped: true, skipReason: 'already_open' });

    await runNearZeroScan(redis);

    expect(mockAddNearZeroPosition).not.toHaveBeenCalled();
  });

  // ── NEAR_ZERO_REQUIRE_OSINT gate (PR 3) ──────────────────────────────────

  it('blockedReason=no_osint_signal short-circuits before LLM when REQUIRE_OSINT=true', async () => {
    const { redis, state } = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-no-osint' })]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, NEAR_ZERO_REQUIRE_OSINT: true });
    // No OSINT signal → hasOsintSignal = false → early exit before LLM

    await runNearZeroScan(redis);

    // LLM must NOT be called — the whole point of the early exit
    expect(mockEstimateConsensusProbability).not.toHaveBeenCalled();

    const { enqueueWrite } = await import('../../db/writeQueue.js');
    const enqueueMock = vi.mocked(enqueueWrite);
    const [, payload] = enqueueMock.mock.calls[0]!;
    expect(payload.wouldBlock).toBe(true);
    expect(payload.metricValue).toBe(0);
    expect(payload.threshold).toBe(1);
    expect((payload.payload as Record<string, unknown>).blockedReason).toBe('no_osint_signal');

    // Dedup key must be set (non-OSINT TTL) so we don't repeat the check every cycle
    const dedupSets = state.setCalls.filter((c) => c.key === 'near_zero:dedup:mkt-no-osint:YES');
    expect(dedupSets).toHaveLength(1);
    expect(dedupSets[0]!.ttl).toBe(DEFAULT_CONFIG.NEAR_ZERO_DEDUP_TTL_S_NON_OSINT);
  });

  it('wouldTradeIfEnabled=true when REQUIRE_OSINT=true and OSINT signal exists', async () => {
    const { redis } = makeRedis({
      zrangeMembers: [
        JSON.stringify({
          marketId: 'mkt-with-osint',
          direction: 'YES',
          headline: 'Iran escalates strike threat',
          urgencyScore: 8,
        }),
      ],
    });
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-with-osint' })]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, NEAR_ZERO_REQUIRE_OSINT: true });
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'ok',
      stddev: 0.05,
      sampleCount: 3,
    });

    await runNearZeroScan(redis);

    const { enqueueWrite } = await import('../../db/writeQueue.js');
    const enqueueMock = vi.mocked(enqueueWrite);
    const [, payload] = enqueueMock.mock.calls[0]!;
    expect(payload.wouldBlock).toBe(false);
    expect((payload.payload as Record<string, unknown>).blockedReason).toBeNull();
  });

  it('passes OSINT gate when REQUIRE_OSINT=false regardless of signals', async () => {
    const { redis } = makeRedis(); // empty zrangeMembers → no OSINT signals
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-no-osint-ok' })]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, NEAR_ZERO_REQUIRE_OSINT: false });
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'ok',
      stddev: 0.05,
      sampleCount: 3,
    });

    await runNearZeroScan(redis);

    const { enqueueWrite } = await import('../../db/writeQueue.js');
    const enqueueMock = vi.mocked(enqueueWrite);
    const [, payload] = enqueueMock.mock.calls[0]!;
    // Gate passes — not blocked by OSINT
    expect((payload.payload as Record<string, unknown>).blockedReason).not.toBe('no_osint_signal');
  });

  // ── Book-depth slippage gate (PR 4) ──────────────────────────────────────

  it('skips execution when depth gate returns insufficient_depth', async () => {
    const { redis } = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-shallow' })]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, NEAR_ZERO_SCANNER_ENABLED: true });
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'ok',
      stddev: 0.05,
      sampleCount: 3,
    });
    mockCheckBookDepthForStake.mockResolvedValue({ ok: false, reason: 'insufficient_depth' });

    await runNearZeroScan(redis);

    expect(mockExecuteSignal).not.toHaveBeenCalled();
  });

  it('skips execution when depth gate returns slippage_too_high', async () => {
    const { redis } = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-slippage' })]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, NEAR_ZERO_SCANNER_ENABLED: true });
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'ok',
      stddev: 0.05,
      sampleCount: 3,
    });
    mockCheckBookDepthForStake.mockResolvedValue({
      ok: false,
      reason: 'slippage_too_high',
      expectedFillPrice: 0.085,
      expectedSlippageBps: 2142,
    });

    await runNearZeroScan(redis);

    expect(mockExecuteSignal).not.toHaveBeenCalled();
  });

  it('skips execution when CLOB book unavailable (no_book)', async () => {
    const { redis } = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-no-book' })]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, NEAR_ZERO_SCANNER_ENABLED: true });
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'ok',
      stddev: 0.05,
      sampleCount: 3,
    });
    mockCheckBookDepthForStake.mockResolvedValue({ ok: false, reason: 'no_book' });

    await runNearZeroScan(redis);

    expect(mockExecuteSignal).not.toHaveBeenCalled();
  });

  it('proceeds to execution when depth gate passes', async () => {
    const { redis } = makeRedis();
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-deep' })]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, NEAR_ZERO_SCANNER_ENABLED: true });
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'ok',
      stddev: 0.05,
      sampleCount: 3,
    });
    // default beforeEach already sets ok: true, but explicit for clarity
    mockCheckBookDepthForStake.mockResolvedValue({
      ok: true,
      expectedFillPrice: 0.07,
      expectedSlippageBps: 0,
    });

    await runNearZeroScan(redis);

    expect(mockExecuteSignal).toHaveBeenCalledTimes(1);
  });

  // ── Re-entry cooldown (PR 5) ──────────────────────────────────────────────

  it('skips LLM when re-entry cooldown key is present', async () => {
    const { redis } = makeRedis({
      getMap: new Map([['near_zero:reentry_cooldown:mkt-1:YES', '1']]),
    });
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-1' })]);
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'ok',
      stddev: 0.05,
      sampleCount: 3,
    });

    await runNearZeroScan(redis);

    expect(mockEstimateConsensusProbability).not.toHaveBeenCalled();
    expect(mockExecuteSignal).not.toHaveBeenCalled();
  });

  it('proceeds normally when re-entry cooldown key is absent', async () => {
    const { redis } = makeRedis(); // no cooldown key
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-2' })]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, NEAR_ZERO_SCANNER_ENABLED: true });
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'ok',
      stddev: 0.05,
      sampleCount: 3,
    });

    await runNearZeroScan(redis);

    expect(mockExecuteSignal).toHaveBeenCalledTimes(1);
  });

  // ── Headline enrichment (PR 5) ───────────────────────────────────────────

  it('enriches headline with additional OSINT items sharing keyword overlap', async () => {
    const { redis } = makeRedis({
      zrangeMembers: [
        JSON.stringify({
          marketId: 'mkt-enrich',
          direction: 'YES',
          headline: 'Iran threatens Kharg Island closure',
          urgencyScore: 9,
        }),
      ],
    });
    mockGetCachedMarkets.mockResolvedValue([
      makeMarket({ id: 'mkt-enrich', question: 'Will the Kharg Island terminal cease Iranian control?' }),
    ]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, NEAR_ZERO_SCANNER_ENABLED: false });
    mockGetRecentOsintItems.mockResolvedValue([
      {
        title: 'US warships positioned near Strait of Hormuz',
        keywords: ['kharg', 'hormuz', 'iran'],
        urgencyScore: 7,
        categoryId: 'geopolitical',
      },
    ]);
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'ok',
      stddev: 0.05,
      sampleCount: 3,
    });

    await runNearZeroScan(redis);

    expect(mockEstimateConsensusProbability).toHaveBeenCalledTimes(1);
    const callArgs = mockEstimateConsensusProbability.mock.calls[0]?.[0] as { headline: string };
    expect(callArgs.headline).toContain('Iran threatens Kharg Island closure');
    expect(callArgs.headline).toContain('US warships positioned');
    expect(callArgs.headline.length).toBeLessThanOrEqual(600);
  });

  it('does not enrich headline when candidate has no OSINT signal', async () => {
    const { redis } = makeRedis(); // no OSINT signal in zrangeMembers
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-no-enrich' })]);
    mockGetRecentOsintItems.mockResolvedValue([
      {
        title: 'Related headline',
        keywords: ['kharg', 'iran'],
        urgencyScore: 8,
        categoryId: 'geopolitical',
      },
    ]);
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'ok',
      stddev: 0.05,
      sampleCount: 3,
    });

    await runNearZeroScan(redis);

    const callArgs = mockEstimateConsensusProbability.mock.calls[0]?.[0] as { headline: string };
    expect(callArgs.headline).not.toContain('Related headline');
    expect(callArgs.headline).toContain('Market price:');
  });

  // ── Half-Kelly sizing (PR 5) ──────────────────────────────────────────────

  it('computes Half-Kelly stake correctly for given edge and price', async () => {
    const { redis } = makeRedis();
    // pOurSide=0.80, price=0.07: kellyFraction=(0.80-0.07)/(1-0.07)/2 ≈ 0.3925
    // halfKelly * bankroll(500) ≈ $196.2 → capped at MAX_STAKE_USD=5
    mockGetBankroll.mockResolvedValue(500);
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-kelly' })]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, NEAR_ZERO_SCANNER_ENABLED: true });
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'ok',
      stddev: 0.05,
      sampleCount: 3,
    });

    await runNearZeroScan(redis);

    expect(mockExecuteSignal).toHaveBeenCalledTimes(1);
    const signal = mockExecuteSignal.mock.calls[0]?.[0] as { stakeUsd: number };
    expect(signal.stakeUsd).toBeCloseTo(5);
  });

  it('floors stake at MIN_BET_USD when Kelly sizing computes a tiny stake', async () => {
    const { redis } = makeRedis();
    // Very small bankroll: $1. pOurSide=0.80, price=0.07: halfKelly≈0.3925 → $0.39
    // Should be bumped to MIN_BET_USD=5
    mockGetBankroll.mockResolvedValue(1);
    mockGetCachedMarkets.mockResolvedValue([makeMarket({ id: 'mkt-floor' })]);
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, NEAR_ZERO_SCANNER_ENABLED: true });
    mockEstimateConsensusProbability.mockResolvedValue({
      probability: 0.80,
      reasoning: 'ok',
      stddev: 0.05,
      sampleCount: 3,
    });

    await runNearZeroScan(redis);

    const signal = mockExecuteSignal.mock.calls[0]?.[0] as { stakeUsd: number };
    expect(signal.stakeUsd).toBe(5);
  });
});
