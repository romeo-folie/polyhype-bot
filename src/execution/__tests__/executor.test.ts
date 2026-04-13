import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TradeSignal } from '../../mapping/index.js';

vi.mock('../../shared/simmer.js', () => ({
  submitTrade: vi.fn(),
  resolveSimmerMarketId: vi.fn(),
  getMarketContext: vi.fn<() => Promise<null>>().mockResolvedValue(null),
  SimmerError: class SimmerError extends Error {
    statusCode: number;
    body: unknown;
    constructor(message: string, statusCode: number, body: unknown) {
      super(message);
      this.name = 'SimmerError';
      this.statusCode = statusCode;
      this.body = body;
    }
  },
}));

vi.mock('../../shared/clob.js', () => ({
  submitClobBuy: vi.fn(),
  getClobOrderBook: vi.fn(),
  submitClobLimitBuy: vi.fn(),
  getClobOrder: vi.fn(),
  cancelClobOrder: vi.fn(),
}));

vi.mock('../../shared/governor.js', () => ({
  checkGlobalGovernor: vi.fn().mockResolvedValue({ ok: true, elapsedMs: 1000, minIntervalMs: 100 }),
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
}));

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockConfig = {
  REDIS_URL: 'redis://localhost:6379',
  SIMMER_API_KEY: 'test-key',
  DIVERGENCE_THRESHOLD: 0.1,
  OPENAI_API_KEY: 'test-openai',
  FUTURES_ENABLED: false,
  CALIBRATION_ENABLED: true,
  CALIBRATION_MIN_SAMPLES: 20,
  MIN_BET_USD: 1, // low floor for tests — individual test cases set stakeUsd below this
  EXECUTION_MODE: 'taker',
  MAKER_MAX_WAIT_MS: 0,
  MAKER_POLL_INTERVAL_MS: 10,
  MAKER_PRICE_EDGE_BPS: 0,
  TAKER_MIN_EDGE: 0,
  TAKER_MIN_EDGE_CATEGORIES: {},
  TAIL_TAKER_BLOCK: false,
  TAIL_PRICE_THRESHOLD: 0.2,
  TAIL_TAKER_OVERRIDE_EDGE: 0.2,
  CLOB_FALLBACK_ENABLED: true,
};

const mockLoadConfig = vi.fn(() => mockConfig);

vi.mock('../../shared/config.js', () => ({
  loadConfig: mockLoadConfig,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetCalibrationStats = vi.fn<(...args: any[]) => any>().mockResolvedValue(null);
vi.mock('../../shared/calibration.js', () => ({
  getCalibrationStats: mockGetCalibrationStats,
  applyCalibrationCorrection: vi.fn((edge: number, stats: any, min: number) => {
    if (!stats || stats.sampleSize < min) return edge;
    return edge * stats.edgeCorrectionFactor;
  }),
}));

vi.mock('../../shared/outcomeRecorder.js', () => ({
  inferCategory: vi.fn(() => 'geopolitical'),
}));

vi.mock('../../shared/telemetry.js', () => ({
  recordExecutionMetric: vi.fn().mockResolvedValue(undefined),
  recordExecutionTiming: vi.fn().mockResolvedValue(undefined),
  recordExecutionEvent: vi.fn().mockResolvedValue(undefined),
}));

const { submitTrade, resolveSimmerMarketId } = await import('../../shared/simmer.js');
const { submitClobBuy, getClobOrderBook, submitClobLimitBuy, getClobOrder, cancelClobOrder } =
  await import('../../shared/clob.js');
const { hasOpenPosition } = await import('../positionLedger.js');
const { recordExecutionMetric, recordExecutionTiming, recordExecutionEvent } =
  await import('../../shared/telemetry.js');
const { executeSignal, executeSignals } = await import('../executor.js');

const mockSubmit = vi.mocked(submitTrade);
const mockResolve = vi.mocked(resolveSimmerMarketId);
const mockSubmitClob = vi.mocked(submitClobBuy);
const mockGetOrderBook = vi.mocked(getClobOrderBook);
const mockSubmitLimit = vi.mocked(submitClobLimitBuy);
const mockGetOrder = vi.mocked(getClobOrder);
const mockCancelOrder = vi.mocked(cancelClobOrder);
const mockHasPosition = vi.mocked(hasOpenPosition);
const mockRecordExecutionMetric = vi.mocked(recordExecutionMetric);
const mockRecordExecutionTiming = vi.mocked(recordExecutionTiming);
const mockRecordExecutionEvent = vi.mocked(recordExecutionEvent);

function makeSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    marketId: 'mkt-test',
    conditionId: 'cond-test',
    clobTokenIds: ['tok-yes', 'tok-no'],
    question: 'Will X happen?',
    direction: 'YES',
    stakeUsd: 5.0,
    edgeMagnitude: 0.2,
    consensusProbability: 0.7,
    consensusStddev: 0.01,
    outcomePrice: 0.5,
    halfKellyFraction: 0.1,
    sourcedFrom: 'Breaking news headline',
    reasoning: 'Strong signal',
    ...overrides,
  };
}

function makeRedis() {
  return {
    get: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
    set: vi.fn<() => Promise<'OK'>>().mockResolvedValue('OK'),
  };
}

describe('executeSignal', () => {
  beforeEach(() => {
    mockSubmit.mockReset();
    mockResolve.mockReset();
    mockSubmitClob.mockReset();
    mockGetOrderBook.mockReset();
    mockSubmitLimit.mockReset();
    mockGetOrder.mockReset();
    mockCancelOrder.mockReset();
    mockHasPosition.mockReset();
    mockGetCalibrationStats.mockReset();
    mockRecordExecutionMetric.mockReset();
    mockRecordExecutionTiming.mockReset();
    mockRecordExecutionEvent.mockReset();
    mockRecordExecutionMetric.mockResolvedValue(undefined);
    mockRecordExecutionTiming.mockResolvedValue(undefined);
    mockRecordExecutionEvent.mockResolvedValue(undefined);
    mockGetCalibrationStats.mockResolvedValue(null);

    mockConfig.EXECUTION_MODE = 'taker';
    mockConfig.MAKER_MAX_WAIT_MS = 0;
    mockConfig.MAKER_POLL_INTERVAL_MS = 10;
    mockConfig.MAKER_PRICE_EDGE_BPS = 0;
    mockConfig.TAKER_MIN_EDGE = 0;
    mockConfig.TAKER_MIN_EDGE_CATEGORIES = {};
    mockConfig.TAIL_TAKER_BLOCK = false;
    mockConfig.TAIL_PRICE_THRESHOLD = 0.2;
    mockConfig.TAIL_TAKER_OVERRIDE_EDGE = 0.2;

    // Default: available in Simmer, Simmer succeeds, no open position
    mockResolve.mockResolvedValue('simmer-uuid-123');
    mockSubmit.mockResolvedValue({ success: true, tx_hash: '0xabc' });
    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xclob' });
    mockGetOrderBook.mockResolvedValue(null);
    mockSubmitLimit.mockResolvedValue({ success: false, error: 'maker_reject' });
    mockGetOrder.mockResolvedValue(null);
    mockCancelOrder.mockResolvedValue(true);
    mockHasPosition.mockResolvedValue(false);
  });

  it('skips when already holding position in same market+direction', async () => {
    mockHasPosition.mockResolvedValue(true);
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('position_already_open');
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('skips when stake is below floor', async () => {
    const redis = makeRedis();
    const signal = makeSignal({ stakeUsd: 0.001 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(signal, redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('stake_below_floor');
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('bypasses taker edge gate for copytrade signals', async () => {
    mockConfig.EXECUTION_MODE = 'hybrid';
    mockConfig.TAKER_MIN_EDGE = 0.5; // 50% threshold
    const redis = makeRedis();

    // Signal with 1% edge (0.01) would usually be blocked by 50% threshold
    const signal = makeSignal({
      edgeMagnitude: 0.01,
      source: 'copytrade',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(signal, redis as any);

    expect(result.skipped).toBe(false);
    expect(result.executionVenue).toBe('simmer');
  });

  it('skips when idempotency key already exists', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue('1');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('already_executed');
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('executes via Simmer when market is available there', async () => {
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.executionVenue).toBe('simmer');
    expect(result.tradeResult?.success).toBe(true);
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ market_id: 'simmer-uuid-123', side: 'yes', amount: 5.0 }),
    );
    expect(mockSubmitClob).not.toHaveBeenCalled();
    // 1 for idempotency, 1 for recordGlobalTrade (if applicable)
    // Actually, recordGlobalTrade is mocked now, so it shouldn't hit the passed-in mock redis.
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it('falls back to CLOB when market is not in Simmer catalogue', async () => {
    const redis = makeRedis();
    mockResolve.mockResolvedValue(null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.executionVenue).toBe('clob');
    expect(result.tradeResult?.success).toBe(true);
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockSubmitClob).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-yes', amountUsd: 5.0 }),
    );
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(mockRecordExecutionMetric).toHaveBeenCalledWith(
      redis as any,
      'clob_fallback',
      'simmer_market_missing',
    );
    expect(mockRecordExecutionMetric).toHaveBeenCalledWith(
      redis as any,
      'clob_fallback_success',
      'simmer_market_missing',
    );
    expect(mockRecordExecutionEvent).toHaveBeenCalledWith(
      redis as any,
      'execution_attempt',
      expect.objectContaining({
        executionPath: 'clob_fallback',
        finalExecutionPath: 'clob_fallback',
        finalVenue: 'clob',
        fallbackReason: 'simmer_market_missing',
        executionSucceeded: true,
      }),
    );
  });

  it('falls back to CLOB when Simmer says market not found', async () => {
    const redis = makeRedis();
    mockSubmit.mockResolvedValue({ success: false, error: 'Market not found' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.executionVenue).toBe('clob');
    expect(result.tradeResult?.success).toBe(true);
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockSubmitClob).toHaveBeenCalledTimes(1);
  });

  it('returns an error when CLOB fallback fails', async () => {
    const redis = makeRedis();
    mockResolve.mockResolvedValue(null);
    mockSubmitClob.mockResolvedValue({ success: false, error: 'insufficient balance' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.executionVenue).toBe('clob');
    expect(result.error).toContain('insufficient balance');
    expect(result.tradeResult?.success).toBe(false);
    expect(redis.set).not.toHaveBeenCalled();
    expect(mockRecordExecutionMetric).toHaveBeenCalledWith(
      redis as any,
      'errors',
      'clob_fallback_failed',
    );
    expect(mockRecordExecutionEvent).toHaveBeenCalledWith(
      redis as any,
      'execution_attempt',
      expect.objectContaining({
        finalExecutionPath: 'error',
        errorClass: 'clob_fallback_failed',
        executionSucceeded: false,
      }),
    );
  });

  it('does not fallback to CLOB on non-market Simmer errors', async () => {
    const redis = makeRedis();
    mockSubmit.mockRejectedValue(new Error('network timeout'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.executionVenue).toBe('simmer');
    expect(result.error).toContain('network timeout');
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('uses NO token id when direction is NO during CLOB fallback', async () => {
    const redis = makeRedis();
    mockResolve.mockResolvedValue(null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeSignal(makeSignal({ direction: 'NO' }), redis as any);

    expect(mockSubmitClob).toHaveBeenCalledWith(expect.objectContaining({ tokenId: 'tok-no' }));
  });
});

describe('calibration correction', () => {
  beforeEach(() => {
    mockSubmit.mockReset();
    mockResolve.mockReset();
    mockSubmitClob.mockReset();
    mockHasPosition.mockReset();
    mockGetCalibrationStats.mockReset();

    mockResolve.mockResolvedValue('simmer-uuid-123');
    mockSubmit.mockResolvedValue({ success: true, tx_hash: '0xabc' });
    mockHasPosition.mockResolvedValue(false);
  });

  it('applies calibration correction when stats are available', async () => {
    mockGetCalibrationStats.mockResolvedValue({
      category: 'geopolitical',
      sampleSize: 30,
      winRate: 0.5,
      avgReturn: 0,
      edgeCorrectionFactor: 0.8,
      buckets: [],
    });

    const redis = makeRedis();
    const signal = makeSignal({ edgeMagnitude: 0.2 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(signal, redis as any);

    expect(result.skipped).toBe(false);
    // The signal passed to Simmer should have corrected edge in reasoning
    expect(mockSubmit).toHaveBeenCalled();
  });

  it('does not apply correction when stats is null', async () => {
    mockGetCalibrationStats.mockResolvedValue(null);

    const redis = makeRedis();
    const signal = makeSignal({ edgeMagnitude: 0.2 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(signal, redis as any);

    expect(result.skipped).toBe(false);
    expect(result.tradeResult?.success).toBe(true);
  });
});

describe('execution mode', () => {
  beforeEach(() => {
    mockSubmit.mockReset();
    mockResolve.mockReset();
    mockSubmitClob.mockReset();
    mockGetOrderBook.mockReset();
    mockSubmitLimit.mockReset();
    mockGetOrder.mockReset();
    mockCancelOrder.mockReset();
    mockHasPosition.mockReset();
    mockGetCalibrationStats.mockReset();
    mockRecordExecutionMetric.mockReset();
    mockRecordExecutionTiming.mockReset();
    mockRecordExecutionEvent.mockReset();
    mockRecordExecutionMetric.mockResolvedValue(undefined);
    mockRecordExecutionTiming.mockResolvedValue(undefined);
    mockRecordExecutionEvent.mockResolvedValue(undefined);
    mockGetCalibrationStats.mockResolvedValue(null);

    mockConfig.EXECUTION_MODE = 'taker';
    mockConfig.MAKER_MAX_WAIT_MS = 0;
    mockConfig.MAKER_POLL_INTERVAL_MS = 10;
    mockConfig.MAKER_PRICE_EDGE_BPS = 0;
    mockConfig.TAKER_MIN_EDGE = 0;
    mockConfig.TAIL_TAKER_BLOCK = false;
    mockConfig.TAIL_PRICE_THRESHOLD = 0.2;
    mockConfig.TAIL_TAKER_OVERRIDE_EDGE = 0.2;

    mockResolve.mockResolvedValue('simmer-uuid-123');
    mockSubmit.mockResolvedValue({ success: true, tx_hash: '0xabc' });
    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xclob' });
    mockGetOrderBook.mockResolvedValue(null);
    mockSubmitLimit.mockResolvedValue({ success: false, error: 'maker_reject' });
    mockGetOrder.mockResolvedValue(null);
    mockCancelOrder.mockResolvedValue(true);
    mockHasPosition.mockResolvedValue(false);
  });

  it('executes maker path when EXECUTION_MODE=maker and maker fills', async () => {
    mockConfig.EXECUTION_MODE = 'maker';
    mockConfig.MAKER_MAX_WAIT_MS = 10;

    mockResolve.mockResolvedValue('simmer-uuid-123');
    mockGetOrderBook.mockResolvedValue({
      market: 'mkt-test',
      asset_id: 'tok-yes',
      timestamp: new Date().toISOString(),
      bids: [{ price: '0.49', size: '100' }],
      asks: [{ price: '0.51', size: '100' }],
      min_order_size: '1',
      tick_size: '0.01',
      neg_risk: false,
      last_trade_price: '0.50',
      hash: 'hash',
    });
    mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'order-1' });
    mockGetOrder.mockResolvedValue({
      id: 'order-1',
      status: 'filled',
      owner: '0x1',
      maker_address: '0x1',
      market: 'mkt-test',
      asset_id: 'tok-yes',
      side: 'BUY',
      original_size: '10',
      size_matched: '10',
      price: '0.49',
      associate_trades: [],
      outcome: 'YES',
      created_at: Date.now(),
      expiration: '',
      order_type: 'GTC',
    });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'osint' }), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.executionVenue).toBe('clob');
    expect(result.modeConfigured).toBe('maker');
    expect(result.entryExecutionPath).toBe('maker_fill');
    expect(result.entryOrderType).toBe('maker');
    expect(result.decisionBenchmark?.decisionBestAsk).toBe(0.51);
    expect(result.entryPrice).toBe(0.49);
    expect(result.sharesFilled).toBe(10);
    expect(result.decisionBenchmark?.makerPriceImprovementUsd).toBeCloseTo((0.51 - 0.49) * 10, 6);
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockRecordExecutionMetric).toHaveBeenCalledWith(
      redis as any,
      'maker_attempted',
      'count',
    );
    expect(mockRecordExecutionMetric).toHaveBeenCalledWith(redis as any, 'maker_filled', 'count');
    expect(mockRecordExecutionMetric).toHaveBeenCalledWith(
      redis as any,
      'maker_full_fill',
      'count',
    );
    expect(mockRecordExecutionTiming).toHaveBeenCalledWith(
      redis as any,
      'maker_wait_ms',
      expect.any(Number),
    );
    expect(mockRecordExecutionEvent).toHaveBeenCalledWith(
      redis as any,
      'execution_attempt',
      expect.objectContaining({
        executionPath: 'maker_fill',
        finalExecutionPath: 'maker_fill',
        finalOrderType: 'maker',
        makerFillStatus: 'full',
        counterfactualImmediateTakerPrice: 0.51,
        counterfactualImmediateTakerShares: expect.closeTo(5 / 0.51, 6),
        makerPriceImprovementBps: expect.closeTo(((0.51 - 0.49) / 0.51) * 10000, 6),
        makerPriceImprovementUsd: expect.closeTo((0.51 - 0.49) * 10, 6),
        executionSucceeded: true,
      }),
    );
  });

  it('records maker timeout telemetry when maker mode does not fill', async () => {
    mockConfig.EXECUTION_MODE = 'maker';
    mockConfig.MAKER_MAX_WAIT_MS = 0;

    mockGetOrderBook.mockResolvedValue({
      market: 'mkt-test',
      asset_id: 'tok-yes',
      timestamp: new Date().toISOString(),
      bids: [{ price: '0.49', size: '100' }],
      asks: [{ price: '0.51', size: '100' }],
      min_order_size: '1',
      tick_size: '0.01',
      neg_risk: false,
      last_trade_price: '0.50',
      hash: 'hash',
    });
    mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'order-timeout' });
    mockCancelOrder.mockResolvedValue(true);

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'osint' }), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('maker_not_filled');
    expect(mockRecordExecutionMetric).toHaveBeenCalledWith(redis as any, 'maker_timeout', 'count');
    expect(mockRecordExecutionEvent).toHaveBeenCalledWith(
      redis as any,
      'execution_attempt',
      expect.objectContaining({
        finalExecutionPath: 'maker_timeout',
        skipReason: 'maker_not_filled',
        makerFillStatus: 'timeout',
        executionSucceeded: false,
      }),
    );
  });

  it('skips maker for non-osint sources (latency-sensitive)', async () => {
    mockConfig.EXECUTION_MODE = 'hybrid';
    mockConfig.MAKER_MAX_WAIT_MS = 10;
    mockResolve.mockResolvedValue('simmer-uuid-123');
    mockGetOrderBook.mockResolvedValue({
      market: 'mkt-test',
      asset_id: 'tok-yes',
      timestamp: new Date().toISOString(),
      bids: [{ price: '0.49', size: '100' }],
      asks: [{ price: '0.51', size: '100' }],
      min_order_size: '1',
      tick_size: '0.01',
      neg_risk: false,
      last_trade_price: '0.50',
      hash: 'hash',
    });
    mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'order-eligible-test' });

    // spot routes through Simmer; crypto-arb bypasses Simmer entirely
    // (resolver returns null) and goes straight to CLOB taker.
    // These latency-sensitive sources should never submit a maker limit order.
    // Note: copytrade is now maker-eligible (persistent alpha) — tested separately.
    const cases: { source: 'spot' | 'crypto-arb'; venue: 'simmer' | 'clob' }[] = [
      { source: 'spot', venue: 'simmer' },
      { source: 'crypto-arb', venue: 'clob' },
    ];
    for (const { source, venue } of cases) {
      mockSubmitLimit.mockClear();
      const redis = makeRedis();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await executeSignal(makeSignal({ source }), redis as any);
      expect(result.skipped).toBe(false);
      expect(result.executionVenue).toBe(venue);
      expect(result.entryOrderType).toBe('taker');
      expect(mockSubmitLimit).not.toHaveBeenCalled();
    }
  });

  it('attempts maker for osint signals in hybrid mode', async () => {
    mockConfig.EXECUTION_MODE = 'hybrid';
    mockConfig.MAKER_MAX_WAIT_MS = 10;
    mockResolve.mockResolvedValue('simmer-uuid-123');
    mockGetOrderBook.mockResolvedValue({
      market: 'mkt-test',
      asset_id: 'tok-yes',
      timestamp: new Date().toISOString(),
      bids: [{ price: '0.49', size: '100' }],
      asks: [{ price: '0.51', size: '100' }],
      min_order_size: '1',
      tick_size: '0.01',
      neg_risk: false,
      last_trade_price: '0.50',
      hash: 'hash',
    });
    mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'order-osint' });
    mockGetOrder.mockResolvedValue({
      id: 'order-osint',
      status: 'filled',
      owner: '0x1',
      maker_address: '0x1',
      market: 'mkt-test',
      asset_id: 'tok-yes',
      side: 'BUY',
      original_size: '10',
      size_matched: '10',
      price: '0.49',
      associate_trades: [],
      outcome: 'YES',
      created_at: Date.now(),
      expiration: '',
      order_type: 'GTC',
    });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'osint' }), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.executionVenue).toBe('clob');
    expect(result.entryOrderType).toBe('maker');
    expect(mockSubmitLimit).toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('skips taker when edge below TAKER_MIN_EDGE in hybrid mode', async () => {
    mockConfig.EXECUTION_MODE = 'hybrid';
    mockConfig.TAKER_MIN_EDGE = 0.3;
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ edgeMagnitude: 0.1 }), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('taker_edge_below_min:geopolitical');
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('respects category-specific TAKER_MIN_EDGE overrides', async () => {
    mockConfig.EXECUTION_MODE = 'taker';
    mockConfig.TAKER_MIN_EDGE = 0.05;
    mockConfig.TAKER_MIN_EDGE_CATEGORIES = { geopolitical: 0.15 };
    const redis = makeRedis();

    // 10% edge should be blocked by 15% category limit, even though global 5% allows it
    const signal = makeSignal({ edgeMagnitude: 0.1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(signal, redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('taker_edge_below_min:geopolitical');
  });

  it('captures a direct taker decision benchmark when an order book is available', async () => {
    mockConfig.EXECUTION_MODE = 'taker';
    mockGetOrderBook.mockResolvedValue({
      market: 'mkt-test',
      asset_id: 'tok-yes',
      timestamp: new Date().toISOString(),
      bids: [{ price: '0.49', size: '100' }],
      asks: [{ price: '0.51', size: '100' }],
      min_order_size: '1',
      tick_size: '0.01',
      neg_risk: false,
      last_trade_price: '0.50',
      hash: 'hash',
    });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.executionVenue).toBe('simmer');
    expect(result.modeConfigured).toBe('taker');
    expect(result.entryExecutionPath).toBe('taker_direct');
    expect(result.entryOrderType).toBe('taker');
    expect(result.decisionBenchmark?.decisionBestAsk).toBe(0.51);
    expect(mockRecordExecutionEvent).toHaveBeenCalledTimes(1);
    const [, , payload] = mockRecordExecutionEvent.mock.calls[0]!;
    expect(payload.executionPath).toBe('taker_direct');
    expect(payload.finalExecutionPath).toBe('taker_direct');
    expect(payload.finalOrderType).toBe('taker');
    expect(payload.decisionBestBid).toBe(0.49);
    expect(payload.decisionBestAsk).toBe(0.51);
    expect(payload.decisionMidPrice).toBe(0.5);
    expect(payload.decisionSpreadBps).toBeCloseTo(400, 6);
    expect(payload.counterfactualImmediateTakerPrice).toBe(0.51);
    expect(payload.counterfactualImmediateTakerShares).toBeCloseTo(5 / 0.51, 6);
    expect(payload.counterfactualImmediateTakerCostUsd).toBeCloseTo(5, 6);
    expect(payload.executionSucceeded).toBe(true);
  });

  it('populates entryPrice from Simmer fill when available', async () => {
    const redis = makeRedis();
    mockSubmit.mockResolvedValue({
      success: true,
      tx_hash: '0xabc',
      price: 0.52,
      shares_bought: 100,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ outcomePrice: 0.5 }), redis as any);

    expect(result.entryPrice).toBe(0.52);
    expect(result.sharesFilled).toBe(100);
  });

  it('populates entryPrice from CLOB taker fill when available', async () => {
    const redis = makeRedis();
    mockResolve.mockResolvedValue(null);
    mockSubmitClob.mockResolvedValue({
      success: true,
      tx_hash: '0xclob',
      price: 0.53,
      shares_bought: 100,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ outcomePrice: 0.5 }), redis as any);

    expect(result.entryPrice).toBe(0.53);
    expect(result.sharesFilled).toBe(100);
  });
});

describe('executeSignals', () => {
  beforeEach(() => {
    mockSubmit.mockReset();
    mockResolve.mockReset();
    mockSubmitClob.mockReset();
    mockGetOrderBook.mockReset();
    mockSubmitLimit.mockReset();
    mockGetOrder.mockReset();
    mockCancelOrder.mockReset();
    mockHasPosition.mockReset();
    mockGetCalibrationStats.mockReset();
    mockGetCalibrationStats.mockResolvedValue(null);

    mockConfig.EXECUTION_MODE = 'taker';
    mockConfig.MAKER_MAX_WAIT_MS = 0;
    mockConfig.MAKER_POLL_INTERVAL_MS = 10;
    mockConfig.MAKER_PRICE_EDGE_BPS = 0;
    mockConfig.TAKER_MIN_EDGE = 0;
    mockConfig.TAIL_TAKER_BLOCK = false;
    mockConfig.TAIL_PRICE_THRESHOLD = 0.2;
    mockConfig.TAIL_TAKER_OVERRIDE_EDGE = 0.2;

    mockResolve.mockResolvedValue('simmer-uuid-123');
    mockSubmit.mockResolvedValue({ success: true, tx_hash: '0xabc' });
    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xclob' });
    mockGetOrderBook.mockResolvedValue(null);
    mockSubmitLimit.mockResolvedValue({ success: false, error: 'maker_reject' });
    mockGetOrder.mockResolvedValue(null);
    mockCancelOrder.mockResolvedValue(true);
    mockHasPosition.mockResolvedValue(false);
  });

  it('processes all signals and returns results', async () => {
    const redis = makeRedis();

    const signals = [makeSignal({ marketId: 'a' }), makeSignal({ marketId: 'b' })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await executeSignals(signals, redis as any);

    expect(results).toHaveLength(2);
    expect(mockSubmit).toHaveBeenCalledTimes(2);
  });

  it('returns empty array for empty input', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await executeSignals([], redis as any);
    expect(results).toHaveLength(0);
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});
