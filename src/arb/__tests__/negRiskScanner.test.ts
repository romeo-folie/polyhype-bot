import { describe, it, expect, beforeEach, vi } from 'vitest';
import type * as GammaModule from '../../mapping/gamma.js';

// ---------------------------------------------------------------------------
// Mocks — must come before dynamic import
// ---------------------------------------------------------------------------

const mockGetClobOrderBook = vi.fn();
const mockSubmitClobBuy = vi.fn<() => Promise<{ success: boolean; error?: string }>>();
vi.mock('../../shared/clob.js', () => ({
  getClobOrderBook: mockGetClobOrderBook,
  submitClobBuy: mockSubmitClobBuy,
  CLOB_MIN_ORDER_USD: 1.0,
}));

const mockGetBankroll = vi.fn<() => Promise<number>>();
const mockDeductStake = vi.fn<() => Promise<number>>();
vi.mock('../../shared/bankroll.js', () => ({
  getBankroll: mockGetBankroll,
  deductStake: mockDeductStake,
}));

const mockRecordPosition = vi.fn<() => Promise<void>>().mockResolvedValue();
vi.mock('../../execution/positionLedger.js', () => ({
  recordPosition: mockRecordPosition,
}));

const mockNotifyUnhedged = vi.fn<() => Promise<void>>().mockResolvedValue();
vi.mock('../../execution/telegram.js', () => ({
  notifyUnhedgedNegRiskPosition: mockNotifyUnhedged,
}));

const mockCheckGlobalGovernor = vi.fn().mockResolvedValue({ ok: true, elapsedMs: 0, minIntervalMs: 1333 });
const mockRecordGlobalTrade = vi.fn<() => Promise<void>>().mockResolvedValue();
vi.mock('../../shared/governor.js', () => ({
  checkGlobalGovernor: mockCheckGlobalGovernor,
  recordGlobalTrade: mockRecordGlobalTrade,
}));

vi.mock('../../shared/zones.js', () => ({
  priceZoneOf: vi.fn(() => 'zone3'),
}));

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    CLOB_FALLBACK_ENABLED: true,
    ARB_ENABLED: true,
    NEGRISK_ARB_ENABLED: false,
    NEGRISK_ARB_MIN_EDGE: 0.01,
    NEGRISK_ARB_MAX_STAKE_FRACTION: 0.03,
    NEGRISK_ARB_FEE_RATE: 0.0,
    NEGRISK_ARB_MIN_COVERAGE: 0.90,
    NEGRISK_ARB_MAX_OUTCOMES: 30,
    NEGRISK_ARB_DEDUP_TTL_S: 600,
    NEGRISK_ARB_MAX_EVENTS: 50,
    NEGRISK_ARB_MAX_PER_RUN: 1,
    NEGRISK_ARB_SCAN_INTERVAL_MS: 30000,
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

const mockGetNegRiskEvents = vi.fn<() => Promise<unknown[]>>();
vi.mock('../../mapping/gamma.js', async () => {
  const actual =
    await vi.importActual<typeof GammaModule>('../../mapping/gamma.js');
  return {
    getNegRiskEvents: mockGetNegRiskEvents,
    parseOutcomePrices: actual.parseOutcomePrices,
    parseClobTokenIds: actual.parseClobTokenIds,
  };
});

const { scanNegRiskArb, executeNegRiskArb, runNegRiskArbScan } = await import(
  '../negRiskScanner.js'
);

// ---------------------------------------------------------------------------
// Redis mock
// ---------------------------------------------------------------------------

function makeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return null;
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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeNegRiskEvent(
  overrides: Record<string, unknown> = {},
  numMarkets = 3,
) {
  const markets = Array.from({ length: numMarkets }, (_, i) => ({
    id: `market-${(i + 1).toString()}`,
    question: `Outcome ${(i + 1).toString()}?`,
    conditionId: `cond-${(i + 1).toString()}`,
    clobTokenIds: `["yes-token-${(i + 1).toString()}","no-token-${(i + 1).toString()}"]`,
    outcomePrices: `["${(0.3).toFixed(2)}","${(0.7).toFixed(2)}"]`,
    outcomes: ['Yes', 'No'],
    active: true,
    closed: false,
    volume: '1000',
    liquidity: '500',
    endDate: null,
    description: null,
    feesEnabled: false,
    ...(overrides.marketOverrides as Record<string, unknown> ?? {}),
  }));

  return {
    id: 'event-1',
    title: 'Test NegRisk Event',
    slug: 'test-negrisk',
    active: true,
    closed: false,
    negRisk: true,
    markets,
    ...overrides,
  };
}

/** Build a mock CLOB orderbook with a single ask level. */
function makeOrderbook(price: number, size: number) {
  return {
    asks: [{ price: price.toString(), size: size.toString() }],
    bids: [{ price: (price - 0.01).toString(), size: '10' }],
  };
}

/** Build an opportunity for executor tests. */
function makeOpportunity(
  overrides: Partial<Parameters<typeof executeNegRiskArb>[0]> = {},
) {
  const legs = [
    { marketId: 'm1', question: 'O1?', yesTokenId: 'yt1', bestAsk: 0.30, bestAskSize: 100, feesEnabled: false },
    { marketId: 'm2', question: 'O2?', yesTokenId: 'yt2', bestAsk: 0.30, bestAskSize: 100, feesEnabled: false },
    { marketId: 'm3', question: 'O3?', yesTokenId: 'yt3', bestAsk: 0.30, bestAskSize: 100, feesEnabled: false },
  ];
  return {
    eventId: 'ev1',
    eventTitle: 'Test Event',
    legs,
    sumAsks: 0.90,
    totalFeesPerShare: 0,
    edge: 0.10,
    grossEdge: 0.10,
    coverageRatio: 1.0,
    minDepthShares: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: scanNegRiskArb
// ---------------------------------------------------------------------------

describe('scanNegRiskArb', () => {
  let redis: ReturnType<typeof makeRedis>;

  beforeEach(() => {
    redis = makeRedis();
    vi.clearAllMocks();
  });

  it('discovers arb when sum(CLOB asks) < 1.0', async () => {
    // 3 outcomes × 0.30 Gamma price = 0.90 < 1.0 → passes stage 1
    mockGetNegRiskEvents.mockResolvedValue([makeNegRiskEvent()]);
    // CLOB books also at 0.30 → sumAsks = 0.90, edge = 0.10
    mockGetClobOrderBook.mockResolvedValue(makeOrderbook(0.30, 50));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opps = await scanNegRiskArb(redis as any);
    expect(opps).toHaveLength(1);
    expect(opps[0]!.edge).toBeCloseTo(0.10, 4);
    expect(opps[0]!.grossEdge).toBeCloseTo(0.10, 4);
    expect(opps[0]!.sumAsks).toBeCloseTo(0.90, 4);
    expect(opps[0]!.legs).toHaveLength(3);
    expect(opps[0]!.coverageRatio).toBe(1.0);
  });

  it('quick-rejects when Gamma prices sum >= 1.0 (stage 1)', async () => {
    // 3 outcomes × 0.35 = 1.05 >= 1.0 → no CLOB fetch
    mockGetNegRiskEvents.mockResolvedValue([
      makeNegRiskEvent({ marketOverrides: { outcomePrices: '["0.35","0.65"]' } }),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opps = await scanNegRiskArb(redis as any);
    expect(opps).toHaveLength(0);
    expect(mockGetClobOrderBook).not.toHaveBeenCalled();
  });

  it('rejects events with too many outcomes', async () => {
    mockGetNegRiskEvents.mockResolvedValue([makeNegRiskEvent({}, 35)]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opps = await scanNegRiskArb(redis as any);
    expect(opps).toHaveLength(0);
    expect(mockGetClobOrderBook).not.toHaveBeenCalled();
  });

  it('rejects events with fewer than 2 active markets', async () => {
    mockGetNegRiskEvents.mockResolvedValue([makeNegRiskEvent({}, 1)]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opps = await scanNegRiskArb(redis as any);
    expect(opps).toHaveLength(0);
  });

  it('rejects events below coverage threshold', async () => {
    // 3 markets, but only 2 have orderbooks → coverage = 0.67 < 0.90
    mockGetNegRiskEvents.mockResolvedValue([makeNegRiskEvent()]);
    let callCount = 0;
    mockGetClobOrderBook.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) return makeOrderbook(0.30, 50);
      return null; // third market has no book
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opps = await scanNegRiskArb(redis as any);
    expect(opps).toHaveLength(0);
  });

  it('rejects when net edge < MIN_EDGE after CLOB asks', async () => {
    // Gamma prices sum to 0.90 (passes stage 1), but CLOB asks are higher
    mockGetNegRiskEvents.mockResolvedValue([makeNegRiskEvent()]);
    // CLOB asks at 0.34 each → sumAsks = 1.02, edge = -0.02
    mockGetClobOrderBook.mockResolvedValue(makeOrderbook(0.34, 50));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opps = await scanNegRiskArb(redis as any);
    expect(opps).toHaveLength(0);
  });

  it('skips deduped events via NX claim', async () => {
    // Pre-set dedup key
    redis._store.set('arb:negrisk:attempted:event-1', '1');
    mockGetNegRiskEvents.mockResolvedValue([makeNegRiskEvent()]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opps = await scanNegRiskArb(redis as any);
    expect(opps).toHaveLength(0);
    expect(mockGetClobOrderBook).not.toHaveBeenCalled();
  });

  it('claims dedup key during scan (not just execution)', async () => {
    mockGetNegRiskEvents.mockResolvedValue([makeNegRiskEvent()]);
    mockGetClobOrderBook.mockResolvedValue(makeOrderbook(0.30, 50));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await scanNegRiskArb(redis as any);
    // Key should be set via NX
    expect(redis._store.has('arb:negrisk:attempted:event-1')).toBe(true);
  });

  it('returns empty when no events', async () => {
    mockGetNegRiskEvents.mockResolvedValue([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opps = await scanNegRiskArb(redis as any);
    expect(opps).toHaveLength(0);
  });

  it('sorts opportunities by edge descending', async () => {
    // Two events: ev-low has high asks (small edge), ev-high has low asks (big edge)
    const event1 = makeNegRiskEvent({
      id: 'ev-low',
      marketOverrides: { outcomePrices: '["0.32","0.68"]' },
    });
    const event2 = makeNegRiskEvent({
      id: 'ev-high',
      marketOverrides: { outcomePrices: '["0.25","0.75"]' },
    });

    mockGetNegRiskEvents.mockResolvedValue([event1, event2]);

    // Track which event's tokens are being fetched
    let fetchCount = 0;
    mockGetClobOrderBook.mockImplementation(async () => {
      fetchCount++;
      // First 3 fetches are for ev-low (ask=0.32), next 3 for ev-high (ask=0.25)
      if (fetchCount <= 3) return makeOrderbook(0.32, 50);
      return makeOrderbook(0.25, 50);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opps = await scanNegRiskArb(redis as any);
    expect(opps).toHaveLength(2);
    // ev-high (edge=0.25) should come first
    expect(opps[0]!.eventId).toBe('ev-high');
    expect(opps[0]!.edge).toBeGreaterThan(opps[1]!.edge);
  });
});

// ---------------------------------------------------------------------------
// Tests: executeNegRiskArb
// ---------------------------------------------------------------------------

describe('executeNegRiskArb', () => {
  let redis: ReturnType<typeof makeRedis>;

  beforeEach(() => {
    redis = makeRedis();
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetBankroll.mockResolvedValue(10000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('executes all legs and reports success', async () => {
    mockSubmitClobBuy.mockResolvedValue({ success: true });

    const opp = makeOpportunity();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resultPromise = executeNegRiskArb(opp, redis as any);
    // Advance timers for inter-leg delays
    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.lastFilledLegIndex).toBe(2);
    expect(result.totalLegs).toBe(3);
    expect(result.legResults).toHaveLength(3);
    expect(result.legResults.every((r) => r.success)).toBe(true);
    expect(mockSubmitClobBuy).toHaveBeenCalledTimes(3);
    expect(mockDeductStake).toHaveBeenCalledOnce();
    expect(mockRecordGlobalTrade).toHaveBeenCalledOnce();
  });

  it('returns stake_too_small when bankroll is insufficient', async () => {
    mockGetBankroll.mockResolvedValue(50); // 50 * 0.03 = 1.50 < 2.0

    const opp = makeOpportunity();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeNegRiskArb(opp, redis as any);

    expect(result.success).toBe(false);
    expect(result.error).toBe('stake_too_small');
    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
  });

  it('returns leg_below_minimum when a leg costs less than $1', async () => {
    mockGetBankroll.mockResolvedValue(100); // budget = 100*0.03 = 3, shares = 3/0.90 = 3.33
    // 3.33 * 0.30 = ~1.0 — borderline. Make ask tiny to trigger.
    const opp = makeOpportunity({
      legs: [
        { marketId: 'm1', question: 'O1?', yesTokenId: 'yt1', bestAsk: 0.05, bestAskSize: 100, feesEnabled: false },
        { marketId: 'm2', question: 'O2?', yesTokenId: 'yt2', bestAsk: 0.30, bestAskSize: 100, feesEnabled: false },
        { marketId: 'm3', question: 'O3?', yesTokenId: 'yt3', bestAsk: 0.30, bestAskSize: 100, feesEnabled: false },
      ],
      sumAsks: 0.65,
      minDepthShares: 2, // 2 * 0.05 = 0.10 < 1.0
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeNegRiskArb(opp, redis as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain('leg_below_minimum');
    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
  });

  it('aborts cleanly on first leg failure', async () => {
    mockSubmitClobBuy.mockResolvedValue({ success: false, error: 'rejected' });

    const opp = makeOpportunity();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeNegRiskArb(opp, redis as any);

    expect(result.success).toBe(false);
    expect(result.error).toBe('first_leg_failed');
    expect(result.lastFilledLegIndex).toBe(-1);
    expect(result.totalCostUsd).toBe(0);
    expect(mockSubmitClobBuy).toHaveBeenCalledTimes(1);
    // Should NOT deduct stake or record position
    expect(mockDeductStake).not.toHaveBeenCalled();
    expect(mockRecordPosition).not.toHaveBeenCalled();
    // Should clear dedup key so scanner can retry
    expect(redis.del).toHaveBeenCalled();
  });

  it('handles partial fill — records unhedged positions and alerts', async () => {
    // First two legs succeed, third fails
    mockSubmitClobBuy
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'no_fill' });

    const opp = makeOpportunity();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resultPromise = executeNegRiskArb(opp, redis as any);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toBe('partial_fill:2/3');
    expect(result.lastFilledLegIndex).toBe(1);
    expect(result.totalCostUsd).toBeGreaterThan(0);

    // Should record 2 unhedged positions (filled legs)
    expect(mockRecordPosition).toHaveBeenCalledTimes(2);
    // Verify sharesHeld is set
    const firstCall = mockRecordPosition.mock.calls[0]!;
    expect(firstCall[1].sharesHeld).toBeDefined();
    expect(firstCall[1].sourcedFrom).toContain('negrisk-arb:unhedged');

    // Should deduct stake for filled legs
    expect(mockDeductStake).toHaveBeenCalledOnce();

    // Should send Telegram alert
    expect(mockNotifyUnhedged).toHaveBeenCalledOnce();
    expect(mockNotifyUnhedged.mock.calls[0]![0]).toMatchObject({
      eventId: 'ev1',
      filledLegs: 2,
      totalLegs: 3,
    });
  });

  it('records global trade BEFORE execution starts', async () => {
    const callOrder: string[] = [];
    mockRecordGlobalTrade.mockImplementation(async () => {
      callOrder.push('recordGlobalTrade');
    });
    mockSubmitClobBuy.mockImplementation(async () => {
      callOrder.push('submitClobBuy');
      return { success: true };
    });

    const opp = makeOpportunity();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resultPromise = executeNegRiskArb(opp, redis as any);
    await vi.advanceTimersByTimeAsync(1000);
    await resultPromise;

    expect(callOrder[0]).toBe('recordGlobalTrade');
    expect(callOrder[1]).toBe('submitClobBuy');
  });

  it('caps shares at minimum orderbook depth', async () => {
    mockSubmitClobBuy.mockResolvedValue({ success: true });

    // minDepthShares=10 is the binding constraint (bankroll would allow more)
    const opp = makeOpportunity({ minDepthShares: 10 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resultPromise = executeNegRiskArb(opp, redis as any);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.numShares).toBe(10);
    // total cost = 10 * 0.90 = 9.0
    expect(result.totalCostUsd).toBeCloseTo(9.0, 4);
  });
});

// ---------------------------------------------------------------------------
// Tests: runNegRiskArbScan (orchestrator)
// ---------------------------------------------------------------------------

describe('runNegRiskArbScan', () => {
  let redis: ReturnType<typeof makeRedis>;

  beforeEach(() => {
    redis = makeRedis();
    vi.clearAllMocks();
  });

  it('shadow-logs opportunities without executing when disabled', async () => {
    // Config has NEGRISK_ARB_ENABLED: false (default in mock)
    mockGetNegRiskEvents.mockResolvedValue([makeNegRiskEvent()]);
    mockGetClobOrderBook.mockResolvedValue(makeOrderbook(0.30, 50));

    const { logger } = await import('../../shared/logger.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runNegRiskArbScan(redis as any);

    // Should have shadow-logged
    expect(logger.info).toHaveBeenCalledWith(
      '[negrisk-arb] opportunity found (shadow)',
      expect.objectContaining({ wouldExecute: false }),
    );
    // Should NOT have submitted any CLOB buys
    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
  });

  it('returns early when ARB_ENABLED is false', async () => {
    const { loadConfig } = await import('../../shared/config.js');
    vi.mocked(loadConfig).mockReturnValueOnce({
      ARB_ENABLED: false,
      CLOB_FALLBACK_ENABLED: true,
    } as ReturnType<typeof loadConfig>);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runNegRiskArbScan(redis as any);
    expect(mockGetNegRiskEvents).not.toHaveBeenCalled();
  });

  it('returns early when CLOB_FALLBACK_ENABLED is false', async () => {
    const { loadConfig } = await import('../../shared/config.js');
    vi.mocked(loadConfig).mockReturnValueOnce({
      ARB_ENABLED: true,
      CLOB_FALLBACK_ENABLED: false,
    } as ReturnType<typeof loadConfig>);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runNegRiskArbScan(redis as any);
    expect(mockGetNegRiskEvents).not.toHaveBeenCalled();
  });

  it('logs "no opportunities" when scan finds nothing', async () => {
    mockGetNegRiskEvents.mockResolvedValue([]);

    const { logger } = await import('../../shared/logger.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runNegRiskArbScan(redis as any);

    expect(logger.debug).toHaveBeenCalledWith(
      '[negrisk-arb] scan complete — no opportunities',
    );
  });
});
