/**
 * Tests for POLYMARKET_TP_SL_ENABLED=false (hold-to-resolution mode).
 * Verifies that the flag suppresses stop_loss, take_profit_threshold,
 * divergence_closed, and trailing_stop exits while leaving near-res
 * routing unaffected.
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

const mockEvaluateTrailingStop = vi.fn();
vi.mock('../trailingStopExit.js', () => ({
  evaluateTrailingStop: mockEvaluateTrailingStop,
}));

vi.mock('../../shared/outcomeRecorder.js', () => ({
  inferCategory: vi.fn(() => 'geopolitical'),
  inferSource: vi.fn((s: string) => s?.split(':')[0] ?? ''),
}));

// ── Dynamic import after mocks ───────────────────────────────────────────────

const { runMonitorInner } = await import('../index.js');
// Handles to the staleExit/trendExit mock fns for the trend/stale gating tests.
const staleExitMod = await import('../staleExit.js');
const mockEvaluateStale = vi.mocked(staleExitMod.evaluateStale);
const mockRecordStaleSample = vi.mocked(staleExitMod.recordStaleSample);
const trendExitMod = await import('../trendExit.js');
const mockEvaluateTrend = vi.mocked(trendExitMod.evaluateTrend);
const mockFetchTrendSamples = vi.mocked(trendExitMod.fetchTrendSamples);
const mockComputePnlRangePct = vi.mocked(staleExitMod.computePnlRangePct);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePosition(overrides = {}) {
  return {
    marketId: 'm1',
    conditionId: 'cond1',
    clobTokenIds: ['tok-yes', 'tok-no'],
    question: 'Will X happen?',
    direction: 'YES',
    entryPrice: 0.60,
    stakeUsd: 5,
    sharesHeld: 8.33,
    consensusProbability: 0.65,
    edgeMagnitude: 0.10,
    sourcedFrom: 'osint:headline',
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

function makeBaseConfig(overrides = {}) {
  return {
    POLYMARKET_TP_SL_ENABLED: false,
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
    ...overrides,
  };
}

function makeRedis() {
  return {
    get: vi.fn(async (key: string) => {
      if (key === 'monitor:last_heavy_ms') return String(Date.now()); // force Light cycle
      return null;
    }),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    hgetall: vi.fn().mockResolvedValue(null),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POLYMARKET_TP_SL_ENABLED=false — hold-to-resolution kill switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteTakeProfit.mockResolvedValue({ success: true, marketId: 'm1', returnPct: 0 });
    mockEvaluateTrailingStop.mockReturnValue({
      shouldExit: true,
      newHwmPct: 30,
      peakPct: 30,
      floorPct: 20,
      drawdownPct: 10,
    });
  });

  it('does not fire stop_loss when return is below threshold', async () => {
    // entryPrice=0.60, currentPrice=0.45 → −25% return; STOP_LOSS_THRESHOLD=0.16 → would fire
    mockGetOpenPositions.mockResolvedValue([makePosition()]);
    mockFetchAllCurrentPrices.mockResolvedValue(
      new Map([['m1:YES', makeCurrentPrice(0.45)]]),
    );
    mockLoadConfig.mockReturnValue(makeBaseConfig());

    await runMonitorInner(makeRedis() as any);

    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
  });

  it('does not fire take_profit_threshold when return exceeds threshold', async () => {
    // entryPrice=0.60, currentPrice=0.85 → +41.7%; TAKE_PROFIT_THRESHOLD=0.25 → would fire
    mockGetOpenPositions.mockResolvedValue([makePosition()]);
    mockFetchAllCurrentPrices.mockResolvedValue(
      new Map([['m1:YES', makeCurrentPrice(0.85)]]),
    );
    mockLoadConfig.mockReturnValue(makeBaseConfig());

    await runMonitorInner(makeRedis() as any);

    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
  });

  it('does not fire divergence_closed even when model prob has reversed past market price', async () => {
    // consensusProbability=0.50, currentPrice=0.60 → price ≥ consensus → would fire
    mockGetOpenPositions.mockResolvedValue([
      makePosition({ consensusProbability: 0.50 }),
    ]);
    mockFetchAllCurrentPrices.mockResolvedValue(
      new Map([['m1:YES', makeCurrentPrice(0.60)]]),
    );
    mockLoadConfig.mockReturnValue(makeBaseConfig());

    await runMonitorInner(makeRedis() as any);

    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
  });

  it('does not fire trailing_stop even when TRAILING_STOP_ENABLED=true', async () => {
    // evaluateTrailingStop is mocked to return shouldExit=true, but trailingActive
    // must be false when POLYMARKET_TP_SL_ENABLED=false regardless of TRAILING_STOP_ENABLED.
    mockGetOpenPositions.mockResolvedValue([
      makePosition({ highWaterMarkPct: 30 }),
    ]);
    mockFetchAllCurrentPrices.mockResolvedValue(
      new Map([['m1:YES', makeCurrentPrice(0.65)]]),
    );
    mockLoadConfig.mockReturnValue(makeBaseConfig({ TRAILING_STOP_ENABLED: true }));

    await runMonitorInner(makeRedis() as any);

    expect(mockEvaluateTrailingStop).not.toHaveBeenCalled();
    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
  });

  it('still routes to near-res redeemer (price ≥ 0.95) regardless of the flag', async () => {
    // Near-res gate runs before POLYMARKET_TP_SL_ENABLED check and must be unaffected.
    mockGetOpenPositions.mockResolvedValue([makePosition()]);
    mockFetchAllCurrentPrices.mockResolvedValue(
      new Map([['m1:YES', makeCurrentPrice(0.97)]]),
    );
    mockLoadConfig.mockReturnValue(makeBaseConfig());

    await runMonitorInner(makeRedis() as any);

    expect(mockMarkPositionPendingSettlement).toHaveBeenCalledOnce();
    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
  });
});

describe('rebate-farming hold-to-resolution (REBATE_*_PCT=0 disables TP/SL)', () => {
  // Rebate inventory holds to resolution: pair legs must never be TP/SL'd
  // apart (selling one leg of a YES+NO pair converts its locked profit back
  // into a directional bet). 0 = disabled, mirroring the weather convention.
  // POLYMARKET_TP_SL_ENABLED is TRUE here — the global kill switch must NOT
  // be what protects these positions.
  function makeRebatePosition(overrides = {}) {
    return makePosition({
      sourcedFrom: 'rebate-farming',
      entryPrice: 0.5,
      sharesHeld: 10,
      consensusProbability: undefined, // rebate fills carry no model prob
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteTakeProfit.mockResolvedValue({ success: true, marketId: 'm1', returnPct: 0 });
    mockEvaluateTrailingStop.mockReturnValue({ shouldExit: false });
  });

  it('holds through a −50% drawdown when REBATE_STOP_LOSS_PCT=0', async () => {
    mockGetOpenPositions.mockResolvedValue([makeRebatePosition()]);
    mockFetchAllCurrentPrices.mockResolvedValue(
      new Map([['m1:YES', makeCurrentPrice(0.25)]]), // −50% vs 0.5 entry
    );
    mockLoadConfig.mockReturnValue(makeBaseConfig({
      POLYMARKET_TP_SL_ENABLED: true,
      REBATE_TAKE_PROFIT_PCT: 0,
      REBATE_STOP_LOSS_PCT: 0,
    }));

    await runMonitorInner(makeRedis() as any);

    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
  });

  it('holds through a +60% gain when REBATE_TAKE_PROFIT_PCT=0', async () => {
    mockGetOpenPositions.mockResolvedValue([makeRebatePosition()]);
    mockFetchAllCurrentPrices.mockResolvedValue(
      new Map([['m1:YES', makeCurrentPrice(0.80)]]), // +60% vs 0.5 entry
    );
    mockLoadConfig.mockReturnValue(makeBaseConfig({
      POLYMARKET_TP_SL_ENABLED: true,
      REBATE_TAKE_PROFIT_PCT: 0,
      REBATE_STOP_LOSS_PCT: 0,
    }));

    await runMonitorInner(makeRedis() as any);

    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
  });

  it('legacy non-zero knobs still fire the stop-loss', async () => {
    mockGetOpenPositions.mockResolvedValue([makeRebatePosition()]);
    mockFetchAllCurrentPrices.mockResolvedValue(
      new Map([['m1:YES', makeCurrentPrice(0.25)]]), // −50% ≤ −5%
    );
    mockLoadConfig.mockReturnValue(makeBaseConfig({
      POLYMARKET_TP_SL_ENABLED: true,
      REBATE_TAKE_PROFIT_PCT: 3,
      REBATE_STOP_LOSS_PCT: 5,
    }));

    await runMonitorInner(makeRedis() as any);

    expect(mockExecuteTakeProfit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'stop_loss' }),
    );
  });

  it('near-res gate (≥0.95 → pendingSettlement) remains the only exit with knobs=0', async () => {
    mockGetOpenPositions.mockResolvedValue([makeRebatePosition()]);
    mockFetchAllCurrentPrices.mockResolvedValue(
      new Map([['m1:YES', makeCurrentPrice(0.96)]]), // +92% AND ≥ 0.95
    );
    mockLoadConfig.mockReturnValue(makeBaseConfig({
      POLYMARKET_TP_SL_ENABLED: true,
      REBATE_TAKE_PROFIT_PCT: 0,
      REBATE_STOP_LOSS_PCT: 0,
    }));

    await runMonitorInner(makeRedis() as any);

    expect(mockMarkPositionPendingSettlement).toHaveBeenCalledOnce();
    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
  });

  it('never enters the stale/trend path even when STALE_EXIT_ENABLED=true and the evaluator wants out', async () => {
    // The evaluator is rigged to exit — only the !isRebateFarming gate in
    // sampleTrackingNeeded can be what protects the position.
    mockEvaluateStale.mockReturnValue({ shouldExit: true, reason: 'pnl_bleed' } as never);
    mockGetOpenPositions.mockResolvedValue([makeRebatePosition()]);
    mockFetchAllCurrentPrices.mockResolvedValue(
      new Map([['m1:YES', makeCurrentPrice(0.55)]]), // +10%: no near-res, no thresholds
    );
    mockLoadConfig.mockReturnValue(makeBaseConfig({
      POLYMARKET_TP_SL_ENABLED: true,
      REBATE_TAKE_PROFIT_PCT: 0,
      REBATE_STOP_LOSS_PCT: 0,
      STALE_EXIT_ENABLED: true,
      TREND_EXIT_ENABLED: true,
    }));

    await runMonitorInner(makeRedis() as any);

    expect(mockRecordStaleSample).not.toHaveBeenCalled();
    expect(mockEvaluateStale).not.toHaveBeenCalled();
    expect(mockExecuteTakeProfit).not.toHaveBeenCalled();
  });

  it('control: an osint position DOES reach the stale path under the same flags', async () => {
    mockEvaluateStale.mockReturnValue({
      shouldExit: true,
      rule: 'pnl_bleed',
      ageH: 5,
      trackedH: 5,
      categoryAgeH: 24,
      peakPnlPct: 10,
      currentPnlPct: 10,
      priceRangePct: 0,
    } as never);
    // Past the gate, the sampling/trend plumbing runs for real — give the
    // mocks usable returns (clearAllMocks wiped the factory defaults).
    mockRecordStaleSample.mockResolvedValue({
      peakPnlPct: 10,
      firstSeenMs: Date.now() - 3_600_000,
    } as never);
    mockFetchTrendSamples.mockResolvedValue([] as never);
    mockComputePnlRangePct.mockResolvedValue(0 as never);
    mockEvaluateTrend.mockReturnValue({
      shouldExit: false,
      currentPnlPct: 10,
      ageH: 1,
      sampleCount: 0,
      slopePctPerH: null,
      r2: null,
      blockedReason: null,
    } as never);
    mockGetOpenPositions.mockResolvedValue([
      // consensusProbability 0.9 keeps divergence_closed (0.55 < 0.9) and TP
      // (+10% < 25%) quiet so the position flows through to the stale path.
      makeRebatePosition({ sourcedFrom: 'osint:headline', consensusProbability: 0.9 }),
    ]);
    mockFetchAllCurrentPrices.mockResolvedValue(
      new Map([['m1:YES', makeCurrentPrice(0.55)]]),
    );
    mockLoadConfig.mockReturnValue(makeBaseConfig({
      POLYMARKET_TP_SL_ENABLED: true,
      REBATE_TAKE_PROFIT_PCT: 0,
      REBATE_STOP_LOSS_PCT: 0,
      STALE_EXIT_ENABLED: true,
      TREND_EXIT_ENABLED: true,
    }));

    await runMonitorInner(makeRedis() as any);

    // Proves the rig reaches sampling+evaluation for non-rebate sources, so
    // the rebate test above is skipped by the source gate alone.
    expect(mockRecordStaleSample).toHaveBeenCalled();
    expect(mockExecuteTakeProfit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'stale_exit' }),
    );
  });
});
