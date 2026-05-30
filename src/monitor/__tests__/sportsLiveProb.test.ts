/**
 * Tests for the sports live-prob Redis substitution in runMonitorInner.
 * Verifies that:
 *  1. Live model probability overrides stored consensusProbability for divergence-close.
 *  2. Redis GET errors fall back to stored consensus without crashing the cycle.
 *  3. Missing key falls back to stored consensus.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks — must come before dynamic import ──────────────────────────

vi.mock('dotenv/config', () => ({}));

const mockLoadConfig = vi.fn();
vi.mock('../../shared/config.js', () => ({ loadConfig: mockLoadConfig }));

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../shared/assets.js', () => ({ isCryptoAsset: vi.fn(() => false) }));
vi.mock('../../shared/feedSingleton.js', () => ({
  getPriceFeed: vi.fn(() => ({ watch: vi.fn().mockResolvedValue(undefined) })),
  destroyPriceFeed: vi.fn(),
}));
vi.mock('../../shared/clobProbe.js', () => ({ runClobProbe: vi.fn() }));
vi.mock('../../db/writeQueue.js', () => ({ enqueueWrite: vi.fn() }));

vi.mock('../reconciliation.js', () => ({
  runReconciliation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../resolutionRedeemer.js', () => ({
  redeemResolvedPositions: vi.fn().mockResolvedValue([]),
}));

const mockGetOpenPositions = vi.fn();
const mockMarkPositionPendingSettlement = vi.fn().mockResolvedValue(undefined);
const mockUpdateHighWaterMark = vi.fn().mockResolvedValue(undefined);
vi.mock('../../execution/positionLedger.js', () => ({
  getOpenPositions: mockGetOpenPositions,
  markPositionPendingSettlement: mockMarkPositionPendingSettlement,
  updateHighWaterMark: mockUpdateHighWaterMark,
}));

const mockFetchAllCurrentPrices = vi.fn();
vi.mock('../priceFetcher.js', () => ({
  fetchAllCurrentPrices: mockFetchAllCurrentPrices,
}));

const mockExecuteTakeProfit = vi.fn();
vi.mock('../takeProfitExecutor.js', () => ({
  executeTakeProfit: mockExecuteTakeProfit,
}));

vi.mock('../staleExit.js', () => ({
  evaluateStale: vi.fn(() => ({ shouldExit: false })),
  recordStaleSample: vi.fn().mockResolvedValue(undefined),
  computePnlRangePct: vi.fn(() => 0),
  markStaleCooldown: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../trendExit.js', () => ({
  evaluateTrend: vi.fn(() => ({ shouldExit: false })),
  fetchTrendSamples: vi.fn().mockResolvedValue([]),
}));

vi.mock('../weatherNearResExit.js', () => ({
  evaluateWeatherNearRes: vi.fn(() => ({ shouldFire: false, hoursLeft: 99 })),
}));

vi.mock('../../shared/outcomeRecorder.js', () => ({
  inferCategory: vi.fn(() => 'sports-nba'),
  inferSource: vi.fn((s: string) => {
    if (s?.startsWith('sports:')) return 'sports';
    return s?.split(':')[0] ?? '';
  }),
}));

// ── Dynamic import after mocks ───────────────────────────────────────────────

const { runMonitorInner } = await import('../index.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePosition(overrides = {}) {
  return {
    marketId: 'm1',
    conditionId: 'cond1',
    clobTokenIds: ['tok-yes', 'tok-no'],
    question: 'Will the Lakers beat the Warriors?',
    direction: 'YES',
    // entryPrice=0.60, currentPrice=0.65 → +8.3% return, well below the 25% TP threshold.
    // consensusProbability=0.70 > currentPrice 0.65 → no divergence_closed on stored consensus.
    entryPrice: 0.60,
    stakeUsd: 5,
    sharesHeld: 8.33,
    consensusProbability: 0.70,
    edgeMagnitude: 0.10,
    sourcedFrom: 'sports:nba:game1',
    openedAt: new Date().toISOString(),
    executionVenue: 'clob',
    pendingSettlement: false,
    reconciliationStatus: undefined,
    highWaterMarkPct: undefined,
    ...overrides,
  };
}

function makeCurrentPrice(yesPrice: number) {
  return {
    marketId: 'm1',
    direction: 'YES',
    currentOutcomePrice: yesPrice,
    currentYesPrice: yesPrice,
  };
}

function makeBaseConfig() {
  return {
    POLYMARKET_TP_SL_ENABLED: true,
    TIERED_LOGIC_ENABLED: true,
    TRAILING_STOP_ENABLED: false,
    TAKE_PROFIT_THRESHOLD: 0.25,
    STOP_LOSS_THRESHOLD: 0.16,
    SPORTS_TAKE_PROFIT: 0.25,
    SPORTS_STOP_LOSS: 0.45,
    MONITOR_NEAR_RES_PRICE_THRESHOLD: 0.95,
    ORACLE_LAG_EXIT_ENABLED: false,
    STALE_EXIT_ENABLED: false,
    TREND_EXIT_ENABLED: false,
    WEATHER_NEAR_RES_ENABLED: false,
    WEATHER_NEAR_RES_HOURS: 2,
    WEATHER_NEAR_RES_MIN_LOSS_PCT: 0.05,
    ZONE_AWARE_SL_ENABLED: false,
    ZONE_AWARE_SL_EXTREME_LOW: 0.1,
    ZONE_AWARE_SL_EXTREME_HIGH: 0.9,
    ZONE_AWARE_SL_MIN_ABS_MOVE: 0.05,
    COPYTRADE_SPORTS_HOLD_TO_RES: false,
    SHORT_DURATION_HOURS: 4,
    MONITOR_HEAVY_INTERVAL_MIN: 60,
    NEAR_RES_ENABLED: false,
    MAKER_EXIT_ENABLED: false,
    MAKER_EXIT_ELIGIBLE_REASONS: [],
    REBATE_TAKE_PROFIT_PCT: 0.5,
    REBATE_STOP_LOSS_PCT: 1,
  };
}

function makeRedis(overrides: Record<string, (key: string) => unknown> = {}) {
  return {
    get: vi.fn(async (key: string) => {
      if (key === 'monitor:last_heavy_ms') return String(Date.now()); // force Light cycle
      if (overrides.get) return overrides.get(key);
      return null;
    }),
    set: vi.fn().mockResolvedValue('OK'),
    hgetall: vi.fn().mockResolvedValue(null),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('sports live-prob Redis substitution in runMonitorInner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(makeBaseConfig());
    mockExecuteTakeProfit.mockResolvedValue({ success: true, marketId: 'm1', returnPct: 0 });
  });

  it('uses live prob from Redis to trigger divergence_closed when model reverses past market price', async () => {
    // entryPrice=0.60, currentPrice=0.65 → +8.3% (below 25% TP)
    // Stored consensus = 0.70 → 0.65 < 0.70 → NO divergence_closed with stored
    // Live prob = 0.60 → 0.65 ≥ 0.60 → divergence_closed!
    const position = makePosition({ consensusProbability: 0.70 });
    const currentYesPrice = 0.65;

    mockGetOpenPositions.mockResolvedValue([position]);
    mockFetchAllCurrentPrices.mockResolvedValue(
      new Map([['m1:YES', makeCurrentPrice(currentYesPrice)]]),
    );

    const redis = makeRedis({
      get: (key: string) => {
        if (key === 'sports:live_prob:m1') return '0.60';
        return null;
      },
    });

    await runMonitorInner(redis as any);

    expect(mockExecuteTakeProfit).toHaveBeenCalledOnce();
    const call = mockExecuteTakeProfit.mock.calls[0]![0];
    expect(call.reason).toBe('divergence_closed');
  });

  it('falls back to stored consensus when Redis GET throws — no crash, no spurious exit', async () => {
    // entryPrice=0.60, currentPrice=0.65 → +8.3% (below 25% TP)
    // Stored consensus = 0.70 → 0.65 < 0.70 → no divergence_closed
    // Redis GET throws → falls back to stored 0.70 → still no exit
    const position = makePosition({ consensusProbability: 0.70 });
    const currentYesPrice = 0.65;

    mockGetOpenPositions.mockResolvedValue([position]);
    mockFetchAllCurrentPrices.mockResolvedValue(
      new Map([['m1:YES', makeCurrentPrice(currentYesPrice)]]),
    );

    const redis = {
      get: vi.fn(async (key: string) => {
        if (key === 'monitor:last_heavy_ms') return String(Date.now());
        if (key === 'sports:live_prob:m1') throw new Error('Redis connection lost');
        return null;
      }),
      set: vi.fn().mockResolvedValue('OK'),
      hgetall: vi.fn().mockResolvedValue(null),
    };

    await expect(runMonitorInner(redis as any)).resolves.toBeUndefined();
    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
  });

  it('uses stored consensus when live-prob key is absent (null from Redis)', async () => {
    // entryPrice=0.60, currentPrice=0.65 → +8.3% (below 25% TP)
    // Stored consensus = 0.70 → 0.65 < 0.70 → no divergence_closed
    // redis.get returns null → no substitution → still no exit
    const position = makePosition({ consensusProbability: 0.70 });
    const currentYesPrice = 0.65;

    mockGetOpenPositions.mockResolvedValue([position]);
    mockFetchAllCurrentPrices.mockResolvedValue(
      new Map([['m1:YES', makeCurrentPrice(currentYesPrice)]]),
    );

    const redis = makeRedis(); // all gets return null

    await runMonitorInner(redis as any);

    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
  });

  it('triggers divergence_closed for a NO position when live prob rises above current YES price', async () => {
    // consensusProbability is always P(YES) — invariant must hold for NO positions.
    // NO position: we hold NO tokens because model said P(YES)=0.30.
    // entryPrice=0.62 (NO price at entry; YES was 0.38), currentYesPrice=0.35 → currentNOPrice=0.65.
    // Return = (0.65-0.62)/0.62 ≈ 4.8% — below 25% TP, no stop-loss.
    // Stored consensus P(YES)=0.30 → divergence_closed: 0.35 ≤ 0.30 → false (no exit).
    // Live prob P(YES)=0.38 → divergence_closed: 0.35 ≤ 0.38 → true (exit!).
    const position = makePosition({
      direction: 'NO',
      entryPrice: 0.62,
      consensusProbability: 0.30,
      sourcedFrom: 'sports:nba:game1',
    });
    const currentYesPrice = 0.35;
    const currentNoPrice = 1 - currentYesPrice;

    mockGetOpenPositions.mockResolvedValue([position]);
    mockFetchAllCurrentPrices.mockResolvedValue(
      new Map([['m1:NO', {
        marketId: 'm1',
        direction: 'NO',
        currentOutcomePrice: currentNoPrice,
        currentYesPrice,
      }]]),
    );

    const redis = makeRedis({
      get: (key: string) => {
        if (key === 'sports:live_prob:m1') return '0.38';
        return null;
      },
    });

    await runMonitorInner(redis as any);

    expect(mockExecuteTakeProfit).toHaveBeenCalledOnce();
    const call = mockExecuteTakeProfit.mock.calls[0]![0];
    expect(call.reason).toBe('divergence_closed');
  });

  it('does not read sports:live_prob for non-sports positions', async () => {
    const position = makePosition({ sourcedFrom: 'osint:some-headline' });

    mockGetOpenPositions.mockResolvedValue([position]);
    mockFetchAllCurrentPrices.mockResolvedValue(
      new Map([['m1:YES', makeCurrentPrice(0.65)]]),
    );

    const redis = makeRedis();
    await runMonitorInner(redis as any);

    const liveProbCalls = (redis.get as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([key]: [string]) => key.startsWith('sports:live_prob:'),
    );
    expect(liveProbCalls).toHaveLength(0);
  });
});
