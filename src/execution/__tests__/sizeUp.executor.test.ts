/**
 * Executor-path tests for evaluateSizeUp gate logic.
 *
 * Exercises the ineligibility paths (no_share_count, stake_cap_too_small)
 * and the happy path (stake clamped to topUpStakeCap, isSizeUp=true) through
 * executeAndRecordSignal so evaluateSizeUp is exercised end-to-end rather
 * than as isolated arithmetic assertions.
 *
 * All signals route to CLOB; submitClobBuy is the venue mock for the happy-path execution.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TradeSignal } from '../../mapping/index.js';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../shared/clob.js', () => ({
  submitClobBuy: vi.fn(),
  getClobOrderBook: vi.fn().mockResolvedValue(null),
  submitClobLimitBuy: vi.fn(),
  getClobOrder: vi.fn(),
  // Passthrough: resolves to the posted-price arg (no VWAP attribution in tests).
  resolveOrderFillPrice: vi.fn(
    async (_orderId: string, _cond: string | undefined, _asset: string, _shares: number, posted: number) => posted,
  ),
  cancelClobOrder: vi.fn(),
  CLOB_MIN_ORDER_USD: 1.0,
}));

vi.mock('../../shared/governor.js', () => ({
  checkGlobalGovernor: vi.fn().mockResolvedValue({ ok: true, elapsedMs: 1, minIntervalMs: 100 }),
  recordGlobalTrade: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn().mockReturnValue({
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    expire: vi.fn().mockResolvedValue(1),
    incrbyfloat: vi.fn().mockResolvedValue(1),
  }),
}));

vi.mock('../positionLedger.js', () => ({
  hasOpenPosition: vi.fn(),
  getPosition: vi.fn(),
  recordPosition: vi.fn().mockResolvedValue(undefined),
  sizeUpPosition: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../shared/bankroll.js', () => ({
  deductStake: vi.fn().mockResolvedValue(undefined),
  getBankroll: vi.fn().mockResolvedValue(500), // $500 × WEATHER_MAX_STAKE_FRACTION=0.02 = $10 path cap
}));

vi.mock('../pendingMakerOrders.js', () => ({
  getPendingOrder: vi.fn().mockResolvedValue(null),
  setPendingOrder: vi.fn().mockResolvedValue(undefined),
  deletePendingOrder: vi.fn().mockResolvedValue(undefined),
  sumRestAboveCapNotional: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../shared/calibration.js', () => ({
  getCalibrationStats: vi.fn().mockResolvedValue(null),
  getBucketCorrection: vi.fn().mockReturnValue(1),
}));

vi.mock('../../shared/outcomeRecorder.js', () => ({
  inferCategory: vi.fn().mockReturnValue('weather'),
}));

vi.mock('../../shared/telemetry.js', () => ({
  recordArbLatency: vi.fn().mockResolvedValue(undefined),
  recordExecutionMetric: vi.fn().mockResolvedValue(undefined),
  recordExecutionTiming: vi.fn().mockResolvedValue(undefined),
  recordExecutionEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db/writeQueue.js', () => ({
  enqueueWrite: vi.fn(),
}));

vi.mock('../../monitor/staleExit.js', () => ({
  clearStaleState: vi.fn(),
  isStaleCooldownActive: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../shared/closedGuard.js', () => ({
  markRecentlyClosed: vi.fn(),
  isRecentlyResolved: vi.fn().mockResolvedValue(false),
}));

// ── Config ─────────────────────────────────────────────────────────────────

const mockConfig = {
  REDIS_URL: 'redis://localhost:6379',
  DIVERGENCE_THRESHOLD: 0.1,
  OPENAI_API_KEY: 'test-openai',
  FUTURES_ENABLED: false,
  CALIBRATION_ENABLED: false,
  CALIBRATION_MIN_SAMPLES: 20,
  CALIBRATION_MIN_BUCKET_SAMPLES: 5,
  MIN_BET_USD: 5,
  EXECUTION_MODE: 'taker',
  MAKER_MAX_WAIT_MS: 0,
  MAKER_POLL_INTERVAL_MS: 10,
  MAKER_PRICE_EDGE_BPS: 0,
  MAKER_EMPTY_BOOK_MAX_WAIT_MS: 900_000,
  MAKER_EMPTY_BOOK_EDGE_BPS: 150,
  EMPTY_BOOK_BID_THRESHOLD: 0.04,
  EMPTY_BOOK_ASK_THRESHOLD: 0.96,
  TAKER_MIN_EDGE: 0,
  TAKER_MIN_EDGE_CATEGORIES: {},
  TAIL_TAKER_BLOCK: false,
  TAIL_PRICE_THRESHOLD: 0.2,
  TAIL_TAKER_OVERRIDE_EDGE: 0.2,
  MAX_ENTRY_SPREAD_BPS: 0,
  ORACLE_LAG_MAX_ENTRY_SPREAD_BPS: -1,
  CLOB_FALLBACK_ENABLED: true,
  MAKER_EMPTY_BOOK_MIN_CONSENSUS: 0.65,
  MAKER_EMPTY_BOOK_MIN_EDGE: 0.20,
  MAKER_EMPTY_BOOK_MAX_STDDEV: 0.12,
  MAKER_EMPTY_BOOK_ALLOWED_SOURCES: ['oracle-lag', 'near-zero-arb', 'weather', 'sports'],
  ORACLE_LAG_MAKER_EDGE_BPS: 50,
  ORACLE_LAG_MAKER_RETRY_ON_REJECT: true,
  ORACLE_LAG_REAL_BOOK_MAKER_MAX_WAIT_MS: 0,
  SPORTS_MAKER_PREMIUM_PCT: 0.02,
  SPORTS_REQUIRE_REAL_BOOK: false,
  WEATHER_MAKER_POST_ONLY: false,
  WEATHER_MAKER_DISCOUNT_BPS: 500,
  WEATHER_MAX_ENTRY_PRICE: 0.65,
  WEATHER_MAX_SIGNAL_PRICE_DRIFT: 0.08,
  WEATHER_MAX_STAKE_FRACTION: 0.02,
  WEATHER_MAX_STAKE_USD: 0,
  MAX_ENTRY_PRICE: 0.65,
  FV_MAX_ENTRY_PRICE: 0,
  CONVICTION_MULTIPLIER_ENABLED: false,
  CONVICTION_SIGNAL_TTL_S: 3600,
  CONVICTION_BONUS_PER_SOURCE: 0.5,
  CONVICTION_MAX_MULTIPLIER: 2.0,
  SIZE_UP_ENABLED: true,
  SIZE_UP_ELIGIBLE_SOURCES: 'weather',
  SIZE_UP_MAX_TOPUPS: 1,
  SIZE_UP_MIN_EDGE: 0,
  SIZE_UP_MAX_ENTRY_DRIFT: 0.15,
  // Conviction gates — default OFF (0) so the existing stake/drift tests are
  // unaffected; individual tests below override to exercise each gate.
  SIZE_UP_MIN_CONFIDENCE_RISE: 0,
  SIZE_UP_MAX_ADVERSE_DRIFT: 0,
  SIZE_UP_REQUIRE_REAL_BOOK: true,
  WEATHER_KELLY_SHRINK_WEIGHT: 0.4,
  // 0 = legacy: size-ups reuse the entry caps (WEATHER_MAX_STAKE_FRACTION/_USD).
  SIZE_UP_MAX_STAKE_FRACTION: 0,
  SIZE_UP_MAX_STAKE_USD: 0,
  // Weather empty-book/maker knobs — needed for the Fix E execution-price tests
  // that drive the empty-book maker route. Defensive `> 0` checks in the executor
  // mean omitted knobs are simply inert, but set the ones the route reads.
  WEATHER_EMPTY_BOOK_DISCOUNT_BPS: 0,
  WEATHER_EMPTY_BOOK_MAX_ENTRY_PRICE: 0,
  WEATHER_EARLY_ENTRY_MAX_PRICE: 0,
  WEATHER_REST_ABOVE_CAP_ENABLED: false,
  WEATHER_REST_ABOVE_CAP_MAX_NOTIONAL_USD: 0,
  MAKER_EMPTY_BOOK_MIN_CONSENSUS: 0.5,
  MAKER_EMPTY_BOOK_MIN_EDGE: 0,
  MAKER_EMPTY_BOOK_MAX_STDDEV: 1,
};

const mockLoadConfig = vi.fn(() => mockConfig);
vi.mock('../../shared/config.js', () => ({ loadConfig: mockLoadConfig }));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import type { Position } from '../positionLedger.js';

const { submitClobBuy, getClobOrderBook, submitClobLimitBuy, getClobOrder } = await import('../../shared/clob.js');
const { hasOpenPosition, getPosition, sizeUpPosition } = await import('../positionLedger.js');
const { executeAndRecordSignal } = await import('../executor.js');
const { enqueueWrite } = await import('../../db/writeQueue.js');

const mockEnqueueWrite = vi.mocked(enqueueWrite);
const mockSubmitClob   = vi.mocked(submitClobBuy);
const mockGetOrderBook = vi.mocked(getClobOrderBook);
const mockSubmitLimit  = vi.mocked(submitClobLimitBuy);
const mockGetOrder     = vi.mocked(getClobOrder);
const mockHasPosition  = vi.mocked(hasOpenPosition);
const mockGetPosition  = vi.mocked(getPosition);
const mockSizeUpPos    = vi.mocked(sizeUpPosition);

// ── Helpers ────────────────────────────────────────────────────────────────

function makeWeatherSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    marketId: 'weather-mkt-x',
    conditionId: 'cond-x',
    clobTokenIds: ['tok-yes', 'tok-no'],
    question: 'Will it snow in Chicago?',
    direction: 'YES',
    stakeUsd: 8.0, // intentionally exceeds topUpStakeCap=5 to test clamping
    edgeMagnitude: 0.15,
    consensusProbability: 0.65,
    consensusStddev: 0.02,
    outcomePrice: 0.50,
    halfKellyFraction: 0.1,
    sourcedFrom: 'weather-forecast',
    reasoning: 'High edge',
    source: 'weather',
    // These exercise the resolution-day size-up path, which the scanner sanctions.
    sizeUpSanctioned: true,
    ...overrides,
  };
}

function makeExistingPosition(overrides: Partial<Position> = {}): Position {
  return {
    marketId: 'weather-mkt-x',
    question: 'Will it snow in Chicago?',
    direction: 'YES',
    entryPrice: 0.45,
    stakeUsd: 5.0,   // existing stake: topUpStakeCap = 10 - 5 = 5
    edgeMagnitude: 0.15,
    // Entry conviction baseline (P(YES)). The conviction-rise gate compares the
    // current signal's consensusProbability against this. Present by default so the
    // gate has a baseline; the no_confidence_baseline test overrides it to undefined.
    consensusProbability: 0.55,
    sourcedFrom: 'weather-scanner',
    openedAt: new Date('2026-05-24T08:00:00Z').toISOString(),
    executionVenue: 'clob',
    sharesHeld: 11.0,
    topUpCount: 0,
    pendingSettlement: false,
    ...overrides,
  };
}

function makeRedis() {
  return {
    get: vi.fn().mockResolvedValue(null), // idempotency key not set
    set: vi.fn().mockResolvedValue('OK'),
    expire: vi.fn().mockResolvedValue(1),
    zremrangebyscore: vi.fn().mockResolvedValue(0),
    zadd: vi.fn().mockResolvedValue(1),
    zrangebyscore: vi.fn().mockResolvedValue([]),
    incrbyfloat: vi.fn().mockResolvedValue(1),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('evaluateSizeUp via executeAndRecordSignal — executor path', () => {
  beforeEach(() => {
    mockHasPosition.mockReset();
    mockGetPosition.mockReset();
    mockSubmitClob.mockReset();
    mockSizeUpPos.mockReset();

    mockSizeUpPos.mockResolvedValue(undefined);

    // Weather signal: alreadyHolding=true (YES side), holdingOpposite=false (NO side)
    mockHasPosition.mockImplementation(
      async (_redis: unknown, _marketId: string, dir: string) => dir === 'YES',
    );
  });

  it('off resolution day: unsanctioned size-up skips as position_already_open (never reaches evaluateSizeUp)', async () => {
    // sizeUpSanctioned=false simulates an off-day fresh-entry scan hitting an
    // already-held bracket. The gate must skip BEFORE evaluateSizeUp/getPosition.
    mockGetPosition.mockResolvedValue(makeExistingPosition({ sharesHeld: 20, stakeUsd: 5 }));
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal({ sizeUpSanctioned: false }), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('position_already_open');
    expect(mockGetPosition).not.toHaveBeenCalled();
    expect(mockSizeUpPos).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('no_share_count: returns size_up_ineligible when existing position has sharesHeld=0', async () => {
    mockGetPosition.mockResolvedValue(makeExistingPosition({ sharesHeld: 0 }));
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('size_up_ineligible');
    expect(mockSizeUpPos).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('stake_cap_too_small: returns size_up_ineligible when remaining cap < MIN_BET_USD', async () => {
    // stakeUsd=9.5 → topUpStakeCap = 10 - 9.5 = 0.5, which is < MIN_BET_USD=5
    mockGetPosition.mockResolvedValue(makeExistingPosition({ stakeUsd: 9.5, sharesHeld: 21 }));
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('size_up_ineligible');
    expect(mockSizeUpPos).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('entry_drift_too_high: returns size_up_ineligible when current price drifted > SIZE_UP_MAX_ENTRY_DRIFT above entry', async () => {
    // entryPrice=0.30, outcomePrice=0.50 → drift=0.20, exceeds SIZE_UP_MAX_ENTRY_DRIFT=0.15
    mockGetPosition.mockResolvedValue(makeExistingPosition({ entryPrice: 0.30, stakeUsd: 5, sharesHeld: 11 }));
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal({ outcomePrice: 0.50 }), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('size_up_ineligible');
    expect(mockSizeUpPos).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('zero entry price: drift gate is skipped for zero-basis healed positions (no false positive)', async () => {
    // A position healed with no recoverable cost basis (entryPrice=0, e.g. Ankara
    // 2416074) must NOT be drift-blocked: drift against a 0 basis is just
    // outcomePrice, which exceeds any sane SIZE_UP_MAX_ENTRY_DRIFT and would
    // permanently block every top-up of that position.
    mockGetPosition.mockResolvedValue(makeExistingPosition({ entryPrice: 0, stakeUsd: 5, sharesHeld: 11 }));
    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xclob', shares_bought: 10 });
    const redis = makeRedis();

    // outcomePrice 0.50 − entry 0 = 0.50 > SIZE_UP_MAX_ENTRY_DRIFT=0.15: the old
    // gate returned entry_drift_too_high here; the zero-basis guard must proceed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal({ outcomePrice: 0.50 }), redis as any);

    expect(result.skipped).toBeFalsy();
    expect(result.skipReason).not.toBe('size_up_ineligible');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).isSizeUp).toBe(true);
    expect(mockSizeUpPos).toHaveBeenCalledOnce();
  });

  it('entry_drift_within_limit: allows size-up when drift is at or below SIZE_UP_MAX_ENTRY_DRIFT', async () => {
    // entryPrice=0.40, outcomePrice=0.50 → drift=0.10, within SIZE_UP_MAX_ENTRY_DRIFT=0.15
    mockGetPosition.mockResolvedValue(makeExistingPosition({ entryPrice: 0.40, stakeUsd: 5, sharesHeld: 11 }));
    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xclob', shares_bought: 10 });
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal({ outcomePrice: 0.50 }), redis as any);

    expect(result.skipped).toBeFalsy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).isSizeUp).toBe(true);
  });

  it('happy path: clamps stake to topUpStakeCap and returns isSizeUp=true', async () => {
    // existingStake=5, topUpStakeCap=5; signal.stakeUsd=8 is clamped to 5
    mockGetPosition.mockResolvedValue(makeExistingPosition({ stakeUsd: 5, sharesHeld: 11 }));
    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xclob', shares_bought: 10 });
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal(), redis as any);

    expect(result.skipped).toBeFalsy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).isSizeUp).toBe(true);
    expect(mockSizeUpPos).toHaveBeenCalledOnce();
    // Verify stake was clamped to topUpStakeCap=5 before execution
    // sizeUpPosition(redis, marketId, direction, additionalShares, additionalStake, fillPrice)
    const additionalStakeArg = mockSizeUpPos.mock.calls[0]![4];
    expect(additionalStakeArg).toBe(5);
  });

  it('WEATHER_MAX_STAKE_USD hard cap: topUpStakeCap reduced when USD cap tighter than fraction cap', async () => {
    // bankroll=500, WEATHER_MAX_STAKE_FRACTION=0.02 → fractionCap=10
    // WEATHER_MAX_STAKE_USD=8 → pathMaxStake=min(10,8)=8
    // existingStake=3 → topUpStakeCap=8-3=5, which ≥ MIN_BET_USD=5 → eligible
    mockLoadConfig.mockReturnValueOnce({ ...mockConfig, WEATHER_MAX_STAKE_USD: 8 });
    mockGetPosition.mockResolvedValue(makeExistingPosition({ stakeUsd: 3, sharesHeld: 7 }));
    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xclob', shares_bought: 10 });
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal(), redis as any);

    expect(result.skipped).toBeFalsy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).isSizeUp).toBe(true);
    // topUpStakeCap=5; signal.stakeUsd=8 clamped to 5
    const additionalStakeArg = mockSizeUpPos.mock.calls[0]![4];
    expect(additionalStakeArg).toBe(5);
  });

  it('WEATHER_MAX_STAKE_USD hard cap: stake_cap_too_small when USD cap leaves < MIN_BET_USD room', async () => {
    // WEATHER_MAX_STAKE_USD=8 → pathMaxStake=8
    // existingStake=5 → topUpStakeCap=8-5=3, which < MIN_BET_USD=5 → ineligible
    mockLoadConfig.mockReturnValueOnce({ ...mockConfig, WEATHER_MAX_STAKE_USD: 8 });
    mockGetPosition.mockResolvedValue(makeExistingPosition({ stakeUsd: 5, sharesHeld: 11 }));
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('size_up_ineligible');
    expect(mockSizeUpPos).not.toHaveBeenCalled();
  });

  it('SIZE_UP_MAX_STAKE_FRACTION: unlocks top-up room above the entry cap for a cap-sized entry', async () => {
    // Entry cap = bankroll(500) × WEATHER_MAX_STAKE_FRACTION(0.02) = $10. A
    // cap-sized entry (existingStake=9.5) has $0.50 of room → legacy behavior
    // blocks (stake_cap_too_small, asserted in an earlier test). With the
    // size-up fraction 0.03 the cap becomes $15 → room $5.50 ≥ MIN_BET → the
    // top-up fires, clamped to the new cap's room.
    mockLoadConfig.mockReturnValue({ ...mockConfig, SIZE_UP_MAX_STAKE_FRACTION: 0.03 });
    mockGetPosition.mockResolvedValue(makeExistingPosition({ stakeUsd: 9.5, sharesHeld: 21 }));
    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xclob', shares_bought: 10 });
    const redis = makeRedis();

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await executeAndRecordSignal(makeWeatherSignal(), redis as any);

      expect(result.skipped).toBeFalsy();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).isSizeUp).toBe(true);
      // signal.stakeUsd=8 clamped to topUpStakeCap = 15 - 9.5 = 5.5
      const additionalStakeArg = mockSizeUpPos.mock.calls[0]![4];
      expect(additionalStakeArg).toBeCloseTo(5.5, 6);
    } finally {
      mockLoadConfig.mockReturnValue(mockConfig);
    }
  });

  it('SIZE_UP_MAX_STAKE_USD: its own hard ceiling binds the size-up cap, not WEATHER_MAX_STAKE_USD', async () => {
    // fractionCap = 500 × 0.04 = $20, SIZE_UP_MAX_STAKE_USD=12 → pathMaxStake=12.
    // existingStake=9.5 → room $2.50 < MIN_BET → ineligible even though the
    // fraction alone would have allowed it. Proves the size-up USD ceiling is
    // applied (and that WEATHER_MAX_STAKE_USD=0 is not what binds).
    mockLoadConfig.mockReturnValue({
      ...mockConfig,
      SIZE_UP_MAX_STAKE_FRACTION: 0.04,
      SIZE_UP_MAX_STAKE_USD: 12,
    });
    mockGetPosition.mockResolvedValue(makeExistingPosition({ stakeUsd: 9.5, sharesHeld: 21 }));
    const redis = makeRedis();

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await executeAndRecordSignal(makeWeatherSignal(), redis as any);

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('size_up_ineligible');
      expect(mockSizeUpPos).not.toHaveBeenCalled();
    } finally {
      mockLoadConfig.mockReturnValue(mockConfig);
    }
  });

  it('size-up knobs at 0 fall back to the legacy entry caps', async () => {
    // SIZE_UP_MAX_STAKE_FRACTION=0 + SIZE_UP_MAX_STAKE_USD=0 (the defaults in
    // this harness) → pathMaxStake = entry cap $10; existingStake=9.5 → room
    // $0.50 < MIN_BET → blocked, exactly the legacy behavior.
    mockGetPosition.mockResolvedValue(makeExistingPosition({ stakeUsd: 9.5, sharesHeld: 21 }));
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('size_up_ineligible');
    expect(mockSizeUpPos).not.toHaveBeenCalled();
  });
});

// ── Gate A: conviction must have RISEN since entry ─────────────────────────────
describe('evaluateSizeUp — conviction-rise gate (SIZE_UP_MIN_CONFIDENCE_RISE)', () => {
  beforeEach(() => {
    mockHasPosition.mockReset();
    mockGetPosition.mockReset();
    mockSubmitClob.mockReset();
    mockSizeUpPos.mockReset();
    mockSizeUpPos.mockResolvedValue(undefined);
    mockHasPosition.mockImplementation(async (_r: unknown, _m: string, dir: string) => dir === 'YES');
  });
  afterEach(() => mockLoadConfig.mockReturnValue(mockConfig));

  it('confidence_not_risen: blocks when the model held-prob barely moved (delta < rise)', async () => {
    // Entry P(YES)=0.62, current=0.63 → confidence delta 0.01 < required 0.04.
    mockLoadConfig.mockReturnValue({ ...mockConfig, SIZE_UP_MIN_CONFIDENCE_RISE: 0.04 });
    mockGetPosition.mockResolvedValue(makeExistingPosition({ consensusProbability: 0.62, stakeUsd: 5, sharesHeld: 11 }));
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal({ consensusProbability: 0.63 }), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('size_up_ineligible');
    expect(mockSizeUpPos).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('confidence rose: allows the top-up when the model firmed in our favour (delta ≥ rise)', async () => {
    // Entry P(YES)=0.55, current=0.65 → delta 0.10 ≥ 0.04.
    mockLoadConfig.mockReturnValue({ ...mockConfig, SIZE_UP_MIN_CONFIDENCE_RISE: 0.04 });
    mockGetPosition.mockResolvedValue(makeExistingPosition({ consensusProbability: 0.55, stakeUsd: 5, sharesHeld: 11 }));
    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xclob', shares_bought: 10 });
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal({ consensusProbability: 0.65 }), redis as any);

    expect(result.skipped).toBeFalsy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).isSizeUp).toBe(true);
    expect(mockSizeUpPos).toHaveBeenCalledOnce();
  });

  it('NO position: held-prob is computed from (1 − P(YES)); a firming NO passes', async () => {
    // NO side held-prob = 1 − P(YES). Entry P(YES)=0.45 → held 0.55; current P(YES)=0.33
    // → held 0.67 → delta 0.12 ≥ 0.04. A naive P(YES) comparison would see a DROP.
    mockLoadConfig.mockReturnValue({ ...mockConfig, SIZE_UP_MIN_CONFIDENCE_RISE: 0.04 });
    mockHasPosition.mockImplementation(async (_r: unknown, _m: string, dir: string) => dir === 'NO');
    mockGetPosition.mockResolvedValue(
      makeExistingPosition({ direction: 'NO', consensusProbability: 0.45, entryPrice: 0.45, stakeUsd: 5, sharesHeld: 11 }),
    );
    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xclob', shares_bought: 10 });
    const redis = makeRedis();

    const result = await executeAndRecordSignal(
      makeWeatherSignal({ direction: 'NO', consensusProbability: 0.33, outcomePrice: 0.50 }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(result.skipped).toBeFalsy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).isSizeUp).toBe(true);
  });

  it('no_confidence_baseline: fails closed when the entry consensus is missing', async () => {
    // A healed/orphan position with no stored consensusProbability has no baseline
    // to compare against — refuse rather than top up blind.
    mockLoadConfig.mockReturnValue({ ...mockConfig, SIZE_UP_MIN_CONFIDENCE_RISE: 0.04 });
    mockGetPosition.mockResolvedValue(
      makeExistingPosition({ consensusProbability: undefined, stakeUsd: 5, sharesHeld: 11 }),
    );
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal({ consensusProbability: 0.80 }), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('size_up_ineligible');
    expect(mockSizeUpPos).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });
});

// ── Gate B: confirming-drift band (SIZE_UP_MAX_ADVERSE_DRIFT) ──────────────────
describe('evaluateSizeUp — confirming-drift band (SIZE_UP_MAX_ADVERSE_DRIFT)', () => {
  beforeEach(() => {
    mockHasPosition.mockReset();
    mockGetPosition.mockReset();
    mockSubmitClob.mockReset();
    mockSizeUpPos.mockReset();
    mockSizeUpPos.mockResolvedValue(undefined);
    mockHasPosition.mockImplementation(async (_r: unknown, _m: string, dir: string) => dir === 'YES');
  });
  afterEach(() => mockLoadConfig.mockReturnValue(mockConfig));

  it('adverse_drift_too_high: blocks averaging DOWN when the price got cheaper than entry', async () => {
    // Entry 0.55, current 0.45 → drift −0.10, beyond the −0.06 adverse bound. This is
    // the "it got cheaper, add more" tilt the band exists to stop.
    mockLoadConfig.mockReturnValue({ ...mockConfig, SIZE_UP_MAX_ADVERSE_DRIFT: 0.06 });
    mockGetPosition.mockResolvedValue(makeExistingPosition({ entryPrice: 0.55, stakeUsd: 5, sharesHeld: 11 }));
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal({ outcomePrice: 0.45 }), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('size_up_ineligible');
    expect(mockSizeUpPos).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('within band: allows a top-up when the price is only mildly below entry (confirming)', async () => {
    // Entry 0.55, current 0.50 → drift −0.05, inside the −0.06 adverse bound.
    mockLoadConfig.mockReturnValue({ ...mockConfig, SIZE_UP_MAX_ADVERSE_DRIFT: 0.06 });
    mockGetPosition.mockResolvedValue(makeExistingPosition({ entryPrice: 0.55, stakeUsd: 5, sharesHeld: 11 }));
    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xclob', shares_bought: 10 });
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal({ outcomePrice: 0.50 }), redis as any);

    expect(result.skipped).toBeFalsy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).isSizeUp).toBe(true);
  });
});

// ── Gate C: shrunk-edge floor (replaces the raw-edge floor) ────────────────────
describe('evaluateSizeUp — shrunk-edge floor (SIZE_UP_MIN_EDGE on market-shrunk edge)', () => {
  beforeEach(() => {
    mockHasPosition.mockReset();
    mockGetPosition.mockReset();
    mockSubmitClob.mockReset();
    mockSizeUpPos.mockReset();
    mockSizeUpPos.mockResolvedValue(undefined);
    mockHasPosition.mockImplementation(async (_r: unknown, _m: string, dir: string) => dir === 'YES');
  });
  afterEach(() => mockLoadConfig.mockReturnValue(mockConfig));

  it('edge_below_floor: a high-RAW-edge but market-divergent size-up fails the shrunk floor', async () => {
    // YES held 0.60 @ price 0.50 → raw edge 0.10 (would pass a raw≥0.05 floor), but
    // shrunk edge = shrinkWeight(0.4) × 0.10 = 0.04 < 0.05. The raw floor rewarded
    // exactly this disagreement; the shrunk floor (what we size on) blocks it.
    mockLoadConfig.mockReturnValue({ ...mockConfig, SIZE_UP_MIN_EDGE: 0.05 });
    mockGetPosition.mockResolvedValue(makeExistingPosition({ entryPrice: 0.45, stakeUsd: 5, sharesHeld: 11 }));
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal({ consensusProbability: 0.60, outcomePrice: 0.50 }), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('size_up_ineligible');
    expect(mockSizeUpPos).not.toHaveBeenCalled();
  });

  it('passes the shrunk floor when the edge is genuinely large', async () => {
    // YES held 0.72 @ price 0.50 → raw edge 0.22, shrunk 0.088 ≥ 0.05.
    mockLoadConfig.mockReturnValue({ ...mockConfig, SIZE_UP_MIN_EDGE: 0.05 });
    mockGetPosition.mockResolvedValue(makeExistingPosition({ entryPrice: 0.45, stakeUsd: 5, sharesHeld: 11 }));
    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xclob', shares_bought: 10 });
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal({ consensusProbability: 0.72, outcomePrice: 0.50 }), redis as any);

    expect(result.skipped).toBeFalsy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).isSizeUp).toBe(true);
  });
});

// ── Fix E: size-up execution-price discipline (maker route) ────────────────────
describe('evaluateSizeUp — execution-price discipline (SIZE_UP_REQUIRE_REAL_BOOK)', () => {
  function makeBook(bids: { price: string; size: string }[], asks: { price: string; size: string }[]) {
    return {
      market: 'mkt', asset_id: 'tok-yes', timestamp: new Date('2026-06-11T00:00:00Z').toISOString(),
      bids, asks, min_order_size: '1', tick_size: '0.01', neg_risk: false,
      last_trade_price: '0.50', hash: 'h',
    };
  }
  // A two-sided ghost book (0.01 wall / 0.99 wall) routes a weather size-up through
  // the empty-book maker path. The entry-spread guardrail (MAX_ENTRY_SPREAD_BPS>0)
  // must be active for the executor to populate the benchmark that classifies the
  // book as a ghost; with it at 0 the size-up takes the bid-anchored real-book path.
  const makerCfg = {
    ...mockConfig,
    EXECUTION_MODE: 'maker',
    WEATHER_MAKER_POST_ONLY: true,
    MAKER_EMPTY_BOOK_MAX_WAIT_MS: 1,
    MAX_ENTRY_SPREAD_BPS: 500,
  };

  beforeEach(() => {
    mockHasPosition.mockReset();
    mockGetPosition.mockReset();
    mockSubmitClob.mockReset();
    mockSubmitLimit.mockReset();
    mockGetOrderBook.mockReset();
    mockGetOrder.mockReset();
    mockSizeUpPos.mockReset();
    mockSizeUpPos.mockResolvedValue(undefined);
    mockGetOrder.mockResolvedValue(null);
    mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'order-eb' });
    mockHasPosition.mockImplementation(async (_r: unknown, _m: string, dir: string) => dir === 'YES');
    mockGetPosition.mockResolvedValue(makeExistingPosition({ entryPrice: 0.45, stakeUsd: 5, sharesHeld: 11 }));
    mockLoadConfig.mockReturnValue(makerCfg);
  });
  afterEach(() => {
    mockLoadConfig.mockReturnValue(mockConfig);
    mockGetOrderBook.mockResolvedValue(null);
  });

  it('clamps the maker post price to the side mid — never pays above market to add', async () => {
    // Two-sided ghost book 0.01 / 0.99 → mid 0.50. Without the clamp the conviction
    // price (model FV ≈ 0.65, posted ~0.64) would rest above mid; Fix E pulls it down
    // to 0.50 so a top-up never pays above the current market.
    mockGetOrderBook.mockResolvedValue(makeBook([{ price: '0.01', size: '100' }], [{ price: '0.99', size: '100' }]));
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeAndRecordSignal(makeWeatherSignal({ consensusProbability: 0.65, outcomePrice: 0.50 }), redis as any);

    expect(mockSubmitLimit).toHaveBeenCalledOnce();
    const postedPrice = mockSubmitLimit.mock.calls[0]![0].price;
    expect(postedPrice).toBeLessThanOrEqual(0.50 + 1e-9);
    expect(postedPrice).toBeCloseTo(0.50, 6);
  });

  it('NO direction on a real two-sided book clamps to the NO mid (not 1 − mid)', async () => {
    // Real-book patient path (WEATHER_REAL_BOOK_DISCOUNT_BPS>0, spread guard off): the
    // NO-token book is loaded, so its mid IS the NO mid. Fix E must clamp to it, NOT to
    // 1 − mid — which would post far below the NO market and never fill. NO book bid
    // 0.50 / ask 0.55 → NO mid 0.525; patient price ≈0.53 > mid → clamp to 0.52. The
    // buggy 1 − mid path would have posted ≈0.47.
    mockLoadConfig.mockReturnValue({
      ...makerCfg,
      MAX_ENTRY_SPREAD_BPS: 0,
      WEATHER_REAL_BOOK_DISCOUNT_BPS: 300,
    });
    mockHasPosition.mockImplementation(async (_r: unknown, _m: string, dir: string) => dir === 'NO');
    mockGetPosition.mockResolvedValue(makeExistingPosition({ direction: 'NO', entryPrice: 0.50, stakeUsd: 5, sharesHeld: 11 }));
    mockGetOrderBook.mockResolvedValue(makeBook([{ price: '0.50', size: '100' }], [{ price: '0.55', size: '100' }]));
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeAndRecordSignal(makeWeatherSignal({ direction: 'NO', consensusProbability: 0.40, outcomePrice: 0.55 }), redis as any);

    expect(mockSubmitLimit).toHaveBeenCalledOnce();
    const postedPrice = mockSubmitLimit.mock.calls[0]![0].price;
    expect(postedPrice).toBeGreaterThan(0.48); // NOT the buggy 1 − mid ≈ 0.47
    expect(postedPrice).toBeCloseTo(0.52, 6);
  });

  it('refuses to add into a one-sided book (no two-sided market) when the spread guard is off', async () => {
    // With MAX_ENTRY_SPREAD_BPS=0 the upstream one-sided-book guard is inactive, so an
    // asks-only book reaches the maker path with a null mid. SIZE_UP_REQUIRE_REAL_BOOK
    // then refuses the add before any order is posted (size_up_no_real_book).
    mockLoadConfig.mockReturnValue({ ...makerCfg, MAX_ENTRY_SPREAD_BPS: 0 });
    mockGetOrderBook.mockResolvedValue(makeBook([], [{ price: '0.50', size: '100' }]));
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal({ consensusProbability: 0.65, outcomePrice: 0.50 }), redis as any);

    expect(mockSubmitLimit).not.toHaveBeenCalled();
    expect(mockSizeUpPos).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
  });

  it('hybrid mode: a no-real-book refusal is terminal — does NOT fall through to a taker buy', async () => {
    // A size-up is maker-only. In hybrid mode a maker failure normally falls back to a
    // taker buy; for size_up_no_real_book that would re-buy from the one-sided book the
    // maker path just refused (and at the ask, above mid). The terminal guard must stop
    // it: submitClobBuy (taker) is never called.
    mockLoadConfig.mockReturnValue({
      ...makerCfg,
      EXECUTION_MODE: 'hybrid',
      MAX_ENTRY_SPREAD_BPS: 0,
      WEATHER_REAL_BOOK_DISCOUNT_BPS: 300,
    });
    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xtaker', shares_bought: 10 });
    mockGetOrderBook.mockResolvedValue(makeBook([], [{ price: '0.50', size: '100' }]));
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal({ consensusProbability: 0.65, outcomePrice: 0.50 }), redis as any);

    expect(mockSubmitLimit).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled(); // no taker fallback
    expect(mockSizeUpPos).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
  });
});

// ── Shadow mode: SIZE_UP_ENABLED=false never executes, only shadow-logs ────────
describe('evaluateSizeUp — shadow mode (SIZE_UP_ENABLED=false)', () => {
  beforeEach(() => {
    mockHasPosition.mockReset();
    mockGetPosition.mockReset();
    mockSubmitClob.mockReset();
    mockSubmitLimit.mockReset();
    mockSizeUpPos.mockReset();
    mockEnqueueWrite.mockReset();
    mockSizeUpPos.mockResolvedValue(undefined);
    mockHasPosition.mockImplementation(async (_r: unknown, _m: string, dir: string) => dir === 'YES');
  });
  afterEach(() => mockLoadConfig.mockReturnValue(mockConfig));

  it('all gates pass → feature_disabled: nothing executes, a would-fire shadow row is written', async () => {
    // The shadow-mode invariant: even when every conviction gate would pass, with the
    // feature off evaluateSizeUp returns feature_disabled, so no order is placed and no
    // ledger mutation happens — only the would_size_up shadow row is enqueued.
    mockLoadConfig.mockReturnValue({ ...mockConfig, SIZE_UP_ENABLED: false });
    mockGetPosition.mockResolvedValue(makeExistingPosition({ stakeUsd: 5, sharesHeld: 11 }));
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('size_up_ineligible');
    expect(mockSizeUpPos).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
    expect(mockSubmitLimit).not.toHaveBeenCalled();
    expect(mockEnqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ kind: 'would_size_up', wouldBlock: false }),
    );
  });

  it('conviction gate blocks in shadow mode → wouldBlock:true shadow row, still no execution', async () => {
    // Confidence did not rise (0.62→0.63 < 0.04). In shadow mode this records a
    // wouldBlock:true row so we can see the gate firing, and still executes nothing.
    mockLoadConfig.mockReturnValue({ ...mockConfig, SIZE_UP_ENABLED: false, SIZE_UP_MIN_CONFIDENCE_RISE: 0.04 });
    mockGetPosition.mockResolvedValue(makeExistingPosition({ consensusProbability: 0.62, stakeUsd: 5, sharesHeld: 11 }));
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeWeatherSignal({ consensusProbability: 0.63 }), redis as any);

    expect(result.skipped).toBe(true);
    expect(mockSizeUpPos).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
    expect(mockEnqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ kind: 'would_size_up', wouldBlock: true, payload: expect.objectContaining({ reason: 'confidence_not_risen' }) }),
    );
  });
});
