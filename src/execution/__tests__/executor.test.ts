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
  CLOB_MIN_ORDER_USD: 1.0,
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
  recordPosition: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../shared/bankroll.js', () => ({
  deductStake: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../pendingMakerOrders.js', () => ({
  getPendingOrder: vi.fn(),
  setPendingOrder: vi.fn(),
  deletePendingOrder: vi.fn(),
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
  SIMMER_VENUE_ENABLED: true,
  MAKER_EMPTY_BOOK_MIN_CONSENSUS: 0.65,
  MAKER_EMPTY_BOOK_MIN_EDGE: 0.20,
  MAKER_EMPTY_BOOK_MAX_STDDEV: 0.12,
  MAKER_EMPTY_BOOK_ALLOWED_SOURCES: ['oracle-lag', 'near-zero-arb', 'weather', 'sports'],
  ORACLE_LAG_MAKER_EDGE_BPS: 50,
  ORACLE_LAG_MAKER_RETRY_ON_REJECT: true,
  ORACLE_LAG_REAL_BOOK_MAKER_MAX_WAIT_MS: 0,
  SPORTS_MAKER_PREMIUM_PCT: 0.02,
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
const { getPendingOrder, setPendingOrder, deletePendingOrder } =
  await import('../pendingMakerOrders.js');
const { executeSignal, executeSignals, executeAndRecordSignal } = await import('../executor.js');
const positionLedgerMocks = await import('../positionLedger.js');
const bankrollMocks = await import('../../shared/bankroll.js');

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
const mockGetPendingOrder = vi.mocked(getPendingOrder);
const mockSetPendingOrder = vi.mocked(setPendingOrder);
const mockDeletePendingOrder = vi.mocked(deletePendingOrder);

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
    mockGetPendingOrder.mockReset();
    mockSetPendingOrder.mockReset();
    mockDeletePendingOrder.mockReset();
    mockRecordExecutionMetric.mockResolvedValue(undefined);
    mockRecordExecutionTiming.mockResolvedValue(undefined);
    mockRecordExecutionEvent.mockResolvedValue(undefined);
    mockGetCalibrationStats.mockResolvedValue(null);
    mockGetPendingOrder.mockResolvedValue(null);
    mockSetPendingOrder.mockResolvedValue(undefined);
    mockDeletePendingOrder.mockResolvedValue(undefined);

    mockConfig.EXECUTION_MODE = 'taker';
    mockConfig.MAKER_MAX_WAIT_MS = 0;
    mockConfig.MAKER_POLL_INTERVAL_MS = 10;
    mockConfig.MAKER_PRICE_EDGE_BPS = 0;
    mockConfig.MAKER_EMPTY_BOOK_MAX_WAIT_MS = 900_000;

    mockConfig.MAKER_EMPTY_BOOK_EDGE_BPS = 150;
    mockConfig.EMPTY_BOOK_BID_THRESHOLD = 0.04;
    mockConfig.EMPTY_BOOK_ASK_THRESHOLD = 0.96;
    mockConfig.TAKER_MIN_EDGE = 0;
    mockConfig.TAKER_MIN_EDGE_CATEGORIES = {};
    mockConfig.TAIL_TAKER_BLOCK = false;
    mockConfig.TAIL_PRICE_THRESHOLD = 0.2;
    mockConfig.TAIL_TAKER_OVERRIDE_EDGE = 0.2;
    mockConfig.MAX_ENTRY_SPREAD_BPS = 0;
    mockConfig.SIMMER_VENUE_ENABLED = true;

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

  it('skips when entry spread exceeds MAX_ENTRY_SPREAD_BPS', async () => {
    mockConfig.MAX_ENTRY_SPREAD_BPS = 500; // 5%
    // Use a wide but non-ghost book: bid=0.30 > EMPTY_BOOK_BID_THRESHOLD(0.04)
    // so it is NOT classified as a ghost book, just a wide real book.
    mockGetOrderBook.mockResolvedValue({
      market: 'mkt-test',
      asset_id: 'tok-yes',
      timestamp: new Date().toISOString(),
      bids: [{ price: '0.30', size: '100' }],
      asks: [{ price: '0.70', size: '100' }], // ~5714 bps spread > 500 ceiling
      min_order_size: '1',
      tick_size: '0.01',
      neg_risk: false,
      last_trade_price: '0.50',
      hash: 'hash',
    });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('spread_too_wide');
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('executes when entry spread is within MAX_ENTRY_SPREAD_BPS', async () => {
    mockConfig.MAX_ENTRY_SPREAD_BPS = 500; // 5%
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
  });

  it('oracle-lag uses ORACLE_LAG_MAX_ENTRY_SPREAD_BPS override when >= 0', async () => {
    // Global threshold is 500 bps; override is 2000 bps — wide book should pass for oracle-lag
    mockConfig.MAX_ENTRY_SPREAD_BPS = 500;
    mockConfig.ORACLE_LAG_MAX_ENTRY_SPREAD_BPS = 2000;
    mockConfig.SIMMER_VENUE_ENABLED = false;
    mockGetOrderBook.mockResolvedValue({
      market: 'mkt-test',
      asset_id: 'tok-yes',
      timestamp: new Date().toISOString(),
      bids: [{ price: '0.46', size: '100' }],
      asks: [{ price: '0.54', size: '100' }], // 1600 bps — blocked by global (500), passes override (2000)
      min_order_size: '1',
      tick_size: '0.01',
      neg_risk: false,
      last_trade_price: '0.50',
      hash: 'hash',
    });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'oracle-lag' }), redis as any);

    expect(result.skipped).toBe(false);
    mockConfig.SIMMER_VENUE_ENABLED = true;
    mockConfig.ORACLE_LAG_MAX_ENTRY_SPREAD_BPS = -1;
  });

  it('oracle-lag falls back to global MAX_ENTRY_SPREAD_BPS when override is -1', async () => {
    mockConfig.MAX_ENTRY_SPREAD_BPS = 500;
    mockConfig.ORACLE_LAG_MAX_ENTRY_SPREAD_BPS = -1; // disabled → use global
    // Wide but non-ghost book: bid=0.30 > EMPTY_BOOK_BID_THRESHOLD(0.04)
    mockGetOrderBook.mockResolvedValue({
      market: 'mkt-test',
      asset_id: 'tok-yes',
      timestamp: new Date().toISOString(),
      bids: [{ price: '0.30', size: '100' }],
      asks: [{ price: '0.70', size: '100' }], // ~5714 bps — exceeds global 500 bps
      min_order_size: '1',
      tick_size: '0.01',
      neg_risk: false,
      last_trade_price: '0.50',
      hash: 'hash',
    });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'oracle-lag' }), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('spread_too_wide');
  });

  it('skips when CLOB book is one-sided (missing bid side)', async () => {
    mockConfig.MAX_ENTRY_SPREAD_BPS = 500;
    mockGetOrderBook.mockResolvedValue({
      market: 'mkt-test',
      asset_id: 'tok-yes',
      timestamp: new Date().toISOString(),
      bids: [],
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

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('one_sided_book');
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('skips when CLOB book is one-sided (missing ask side)', async () => {
    mockConfig.MAX_ENTRY_SPREAD_BPS = 500;
    mockGetOrderBook.mockResolvedValue({
      market: 'mkt-test',
      asset_id: 'tok-yes',
      timestamp: new Date().toISOString(),
      bids: [{ price: '0.49', size: '100' }],
      asks: [],
      min_order_size: '1',
      tick_size: '0.01',
      neg_risk: false,
      last_trade_price: '0.50',
      hash: 'hash',
    });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('one_sided_book');
  });

  it('does not trigger spread gate when book fetch returns null', async () => {
    mockConfig.MAX_ENTRY_SPREAD_BPS = 500;
    mockGetOrderBook.mockResolvedValue(null);

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.executionVenue).toBe('simmer');
  });

  it('bypasses entry spread gate for copytrade signals', async () => {
    mockConfig.MAX_ENTRY_SPREAD_BPS = 500;
    mockGetOrderBook.mockResolvedValue({
      market: 'mkt-test',
      asset_id: 'tok-yes',
      timestamp: new Date().toISOString(),
      bids: [{ price: '0.01', size: '100' }],
      asks: [{ price: '0.99', size: '100' }],
      min_order_size: '1',
      tick_size: '0.01',
      neg_risk: false,
      last_trade_price: '0.50',
      hash: 'hash',
    });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'copytrade' }), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.executionVenue).toBe('simmer');
  });

  it('reuses prefetched CLOB book for maker path (no double-fetch)', async () => {
    mockConfig.MAX_ENTRY_SPREAD_BPS = 500;
    mockConfig.EXECUTION_MODE = 'maker';
    mockConfig.MAKER_MAX_WAIT_MS = 10;
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
    await executeSignal(makeSignal({ source: 'osint' }), redis as any);

    // Gate fetches once; maker reuses, so total call count stays at 1.
    expect(mockGetOrderBook).toHaveBeenCalledTimes(1);
  });
});

describe('calibration correction', () => {
  beforeEach(() => {
    mockSubmit.mockReset();
    mockResolve.mockReset();
    mockSubmitClob.mockReset();
    mockHasPosition.mockReset();
    mockGetCalibrationStats.mockReset();

    mockConfig.MAX_ENTRY_SPREAD_BPS = 0;
    mockGetOrderBook.mockResolvedValue(null);

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
    mockConfig.MAX_ENTRY_SPREAD_BPS = 0;

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

  it('attempts maker for copytrade signals in hybrid mode', async () => {
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
    mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'order-copytrade' });
    mockGetOrder.mockResolvedValue({
      id: 'order-copytrade',
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
    const result = await executeSignal(makeSignal({ source: 'copytrade' }), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.executionVenue).toBe('clob');
    expect(result.entryOrderType).toBe('maker');
    expect(mockSubmitLimit).toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('attempts maker for near-zero-arb signals in hybrid mode', async () => {
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
    mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'order-nza' });
    mockGetOrder.mockResolvedValue({
      id: 'order-nza',
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
    const result = await executeSignal(makeSignal({ source: 'near-zero-arb' }), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.executionVenue).toBe('clob');
    expect(result.entryOrderType).toBe('maker');
    expect(mockSubmitLimit).toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
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

  it('oracle-lag on real book goes directly to taker — no maker order posted', async () => {
    // oracle-lag is excluded from MAKER_ELIGIBLE_SOURCES because GTC maker orders
    // can fill after market expiry (stale fill), causing expired_unresolvable losses.
    // For real books it uses FAK taker for an immediate fill.
    mockConfig.EXECUTION_MODE = 'hybrid';
    mockResolve.mockResolvedValue(null); // no Simmer; goes straight to CLOB taker
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
    mockSubmitClob.mockResolvedValue({ success: true, shares_bought: 10 });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'oracle-lag', clobTokenIds: ['tok-yes', 'tok-no'] }), redis as any);

    // No maker order posted — oracle-lag is not maker-eligible for real books.
    expect(mockSubmitLimit).not.toHaveBeenCalled();
    expect(mockCancelOrder).not.toHaveBeenCalled();
    // Taker fired directly.
    expect(mockSubmitClob).toHaveBeenCalledOnce();
    expect(result.skipped).toBe(false);
    expect(result.entryOrderType).toBe('taker');
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
    mockConfig.MAX_ENTRY_SPREAD_BPS = 0;

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

describe('executeAndRecordSignal', () => {
  const mockRecordPosition = vi.mocked(positionLedgerMocks.recordPosition);
  const mockDeductStake = vi.mocked(bankrollMocks.deductStake);

  beforeEach(() => {
    mockSubmit.mockReset();
    mockResolve.mockReset();
    mockHasPosition.mockReset();
    mockGetCalibrationStats.mockReset();
    mockGetCalibrationStats.mockResolvedValue(null);
    mockRecordPosition.mockReset();
    mockDeductStake.mockReset();
    mockRecordPosition.mockResolvedValue(undefined);
    mockDeductStake.mockResolvedValue(undefined);

    mockConfig.EXECUTION_MODE = 'taker';
    mockConfig.TAKER_MIN_EDGE = 0;
    mockConfig.MAX_ENTRY_SPREAD_BPS = 0;
    mockConfig.SIMMER_VENUE_ENABLED = true;

    mockResolve.mockResolvedValue('simmer-uuid-123');
    mockHasPosition.mockResolvedValue(false);
  });

  it('on success: calls deductStake and recordPosition exactly once each', async () => {
    mockSubmit.mockResolvedValue({ success: true, tx_hash: '0xabc', shares_bought: 10 });
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeSignal(), redis as any);

    expect(result.tradeResult?.success).toBe(true);
    expect(mockDeductStake).toHaveBeenCalledTimes(1);
    expect(mockRecordPosition).toHaveBeenCalledTimes(1);
  });

  it('on skip: does not call deductStake or recordPosition', async () => {
    mockHasPosition.mockResolvedValue(true); // force position_already_open skip
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(mockDeductStake).not.toHaveBeenCalled();
    expect(mockRecordPosition).not.toHaveBeenCalled();
  });

  it('on venue failure: does not call deductStake or recordPosition', async () => {
    mockSubmit.mockResolvedValue({ success: false, error: 'simmer rejected' });
    mockSubmitClob.mockResolvedValue({ success: false, error: 'clob rejected' });
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeSignal(), redis as any);

    expect(result.tradeResult?.success).not.toBe(true);
    expect(mockDeductStake).not.toHaveBeenCalled();
    expect(mockRecordPosition).not.toHaveBeenCalled();
  });

  it('swallows recordPosition throw so a successful fill still returns success', async () => {
    // Invariant: the trade is already live on the venue and idempotency is set.
    // Propagating a ledger-write throw would mask the fill AND block retry.
    mockSubmit.mockResolvedValue({ success: true, tx_hash: '0xabc', shares_bought: 10 });
    mockRecordPosition.mockRejectedValue(new Error('redis unreachable'));
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeSignal(), redis as any);

    expect(result.tradeResult?.success).toBe(true);
    // deductStake still ran first before recordPosition threw.
    expect(mockDeductStake).toHaveBeenCalledTimes(1);
  });
});

describe('empty-book maker route', () => {
  function makeGhostBook() {
    return {
      market: 'mkt-test',
      asset_id: 'tok-yes',
      timestamp: new Date().toISOString(),
      bids: [{ price: '0.01', size: '100' }],
      asks: [{ price: '0.99', size: '100' }],
      min_order_size: '1',
      tick_size: '0.01',
      neg_risk: false,
      last_trade_price: '0.50',
      hash: 'hash',
    };
  }

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
    mockGetPendingOrder.mockReset();
    mockSetPendingOrder.mockReset();
    mockDeletePendingOrder.mockReset();

    mockRecordExecutionMetric.mockResolvedValue(undefined);
    mockRecordExecutionTiming.mockResolvedValue(undefined);
    mockRecordExecutionEvent.mockResolvedValue(undefined);
    mockGetCalibrationStats.mockResolvedValue(null);
    mockGetPendingOrder.mockResolvedValue(null);
    mockSetPendingOrder.mockResolvedValue(undefined);
    mockDeletePendingOrder.mockResolvedValue(undefined);

    mockConfig.EXECUTION_MODE = 'hybrid';
    mockConfig.MAKER_MAX_WAIT_MS = 0;
    mockConfig.MAKER_POLL_INTERVAL_MS = 10;
    mockConfig.MAKER_PRICE_EDGE_BPS = 0;
    mockConfig.MAKER_EMPTY_BOOK_MAX_WAIT_MS = 900_000;

    mockConfig.MAKER_EMPTY_BOOK_EDGE_BPS = 150;
    mockConfig.EMPTY_BOOK_BID_THRESHOLD = 0.04;
    mockConfig.EMPTY_BOOK_ASK_THRESHOLD = 0.96;
    mockConfig.TAKER_MIN_EDGE = 0;
    mockConfig.TAKER_MIN_EDGE_CATEGORIES = {};
    mockConfig.TAIL_TAKER_BLOCK = false;
    mockConfig.TAIL_PRICE_THRESHOLD = 0.2;
    mockConfig.TAIL_TAKER_OVERRIDE_EDGE = 0.2;
    mockConfig.MAX_ENTRY_SPREAD_BPS = 500;
    mockConfig.SIMMER_VENUE_ENABLED = false; // skip Simmer so spread gate always fires

    mockGetOrderBook.mockResolvedValue(makeGhostBook());
    mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'order-eb' });
    mockGetOrder.mockResolvedValue(null);
    mockCancelOrder.mockResolvedValue(true);
    mockHasPosition.mockResolvedValue(false);
    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xclob' });
  });

  it('skips with no_clob_book in taker mode (empty-book maker not reachable)', async () => {
    mockConfig.EXECUTION_MODE = 'taker';
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'osint' }), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('no_clob_book');
    expect(mockSubmitLimit).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('skips with no_clob_book for non-maker-eligible source on ghost book', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'spot' }), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('no_clob_book');
    expect(mockSubmitLimit).not.toHaveBeenCalled();
  });

  it('skips with empty_book_source_blocked for osint source on ghost book', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'osint' }), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('empty_book_source_blocked');
    expect(mockSubmitLimit).not.toHaveBeenCalled();
  });

  it('oracle-lag uses ORACLE_LAG_MAKER_EDGE_BPS (50), posting 1 tick below fair (0.49)', async () => {
    // The shared MAKER_EMPTY_BOOK_EDGE_BPS=150 rounds oracle-lag's 0.5012 fair
    // value down to 0.48 — out of reach on 15m binaries that resolve in
    // ~11 min. The per-source override posts at 0.49 (1 tick below fair),
    // inside the indicative and still safe under post-only.
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'oracle-lag',
        consensusProbability: 0.5012,
        direction: 'UP',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    // fair 0.5012 − 50 bps (0.005) = 0.4962 → roundDown to tick 0.01 → 0.49.
    expect(mockSubmitLimit).toHaveBeenCalledWith(expect.objectContaining({ price: 0.49 }));
  });

  it('near-zero-arb still uses MAKER_EMPTY_BOOK_EDGE_BPS (150) — oracle-lag knob is source-scoped', async () => {
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'near-zero-arb',
        consensusProbability: 0.70,
        direction: 'YES',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    // fair 0.70 − 150 bps (0.015) = 0.685 → roundDown to tick 0.01 → 0.68.
    expect(mockSubmitLimit).toHaveBeenCalledWith(expect.objectContaining({ price: 0.68 }));
  });

  it('oracle-lag bypasses consensus/edge/stddev gates (structural-edge source)', async () => {
    // Oracle-lag's real scanner emits consensusProbability ≈ 0.5012 and
    // edgeMagnitude ≈ 0.0015 — neither clears the LLM-conviction gates. The
    // source whitelist is the contract; timing edge replaces conviction.
    const redis = makeRedis();
    const result = await executeSignal(
      makeSignal({
        source: 'oracle-lag',
        consensusProbability: 0.5012,
        edgeMagnitude: 0.0015,
        consensusStddev: 0.5, // would normally trip MAX_STDDEV=0.12
        direction: 'UP',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(result.skipped).toBe(false);
    expect(result.entryExecutionPath).toBe('maker_pending');
    expect(mockSubmitLimit).toHaveBeenCalledOnce();
  });

  it('near-zero-arb still subject to consensus/edge/stddev gates (non-structural source)', async () => {
    // Narrow-source bypass — only oracle-lag gets the structural-edge pass.
    // near-zero-arb is LLM-driven and keeps the conviction guards.
    const redis = makeRedis();
    const result = await executeSignal(
      makeSignal({
        source: 'near-zero-arb',
        consensusProbability: 0.5012,
        direction: 'YES',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('empty_book_weak_consensus');
    expect(mockSubmitLimit).not.toHaveBeenCalled();
  });

  it('weather bypasses consensus/edge/stddev gates (structural-edge source)', async () => {
    // Weather edge is physics-based (forecast vs observed temp), not LLM
    // conviction. Like oracle-lag, its edgeMagnitude and consensusProbability
    // encode real-world signal rather than LLM opinion, so the conviction
    // gates are bypassed via the structural-edge path.
    const redis = makeRedis();
    const result = await executeSignal(
      makeSignal({
        source: 'weather',
        consensusProbability: 0.08,  // typical NO trade: modelP(YES) near zero
        edgeMagnitude: 0.10,         // below MAKER_EMPTY_BOOK_MIN_EDGE=0.20
        consensusStddev: 0.4,        // above MAKER_EMPTY_BOOK_MAX_STDDEV=0.12
        direction: 'NO',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(result.skipped).toBe(false);
    expect(result.entryExecutionPath).toBe('maker_pending');
    expect(mockSubmitLimit).toHaveBeenCalledOnce();
  });

  it('sports bypasses consensus/edge/stddev gates (structural-edge source)', async () => {
    // Sports edge comes from a live ESPN score model, not LLM consensus.
    // The Astros/Guardians signal that triggered this fix had consensus=0.595
    // (inside the MIN_CONSENSUS=0.65 weak band) and edge=0.15 (below MIN_EDGE=0.20).
    const redis = makeRedis();
    const result = await executeSignal(
      makeSignal({
        source: 'sports',
        consensusProbability: 0.595,
        edgeMagnitude: 0.15,  // below MAKER_EMPTY_BOOK_MIN_EDGE=0.20
        consensusStddev: 0.5, // would trip MAX_STDDEV=0.12 on non-structural sources
        direction: 'YES',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(result.skipped).toBe(false);
    expect(result.entryExecutionPath).toBe('maker_pending');
    expect(mockSubmitLimit).toHaveBeenCalledOnce();
  });

  it('sports CLOB balance rejection skips as no_clob_book (not "book not actually empty")', async () => {
    // When the CLOB wallet has insufficient funds the order is rejected with a
    // balance error, not a post-only crossing. The executor must not mislabel
    // this as "book not actually empty" — the book may genuinely be empty.
    mockSubmitLimit.mockResolvedValue({
      success: false,
      error: 'not enough balance / allowance: the balance is not enough',
    });
    const redis = makeRedis();
    const result = await executeSignal(
      makeSignal({ source: 'sports', consensusProbability: 0.595, direction: 'YES' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('no_clob_book');
    expect(mockSubmitLimit).toHaveBeenCalledOnce();
  });

  it('sports YES anchors maker price near market price (not model probability)', async () => {
    // Root-cause fix: model says Reds=59.4%, market (stale) at 46.5%.
    // Old behaviour: post at 0.594 − 1.5% ≈ 0.58 → immediate -21% paper loss.
    // New behaviour: anchor at market + 2% premium, capped at model.
    //   marketSide = 0.465, nearMarket = 0.485, model = 0.594
    //   fairValue  = min(0.485, 0.594) = 0.485
    //   price      = 0.485 − 0.015 (EDGE_BPS=150) = 0.47
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'sports',
        consensusProbability: 0.594,
        outcomePrice: 0.465, // stale Polymarket mid (pre-game price for Reds)
        edgeMagnitude: 0.129,
        direction: 'YES',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(mockSubmitLimit).toHaveBeenCalledWith(expect.objectContaining({ price: 0.47 }));
  });

  it('sports NO anchors maker price near market NO price (not model probability)', async () => {
    // Nationals winning 2-0 but market (stale) still shows Braves at 56.5%.
    // direction=NO means we buy the NO token (betting Nationals win).
    //   consensusProbability = 0.328 (Braves YES model prob)
    //   outcomePrice = 0.565 (Braves YES market price)
    //   NO market price = 1 − 0.565 = 0.435
    //   nearMarket  = 0.435 + 0.02 = 0.455
    //   model fair  = 1 − 0.328   = 0.672
    //   fairValue   = min(0.455, 0.672) = 0.455
    //   price       = 0.455 − 0.015 = 0.44
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'sports',
        consensusProbability: 0.328,
        outcomePrice: 0.565, // stale Braves YES price
        edgeMagnitude: 0.237,
        direction: 'NO',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(mockSubmitLimit).toHaveBeenCalledWith(expect.objectContaining({ price: 0.44 }));
  });

  it('sports maker price caps at model when market + premium exceeds model fair value', async () => {
    // If the stale market is already close to model, use the model price not
    // the (slightly higher) near-market anchor.
    //   consensusProbability = 0.62, outcomePrice = 0.61
    //   nearMarket = 0.61 + 0.02 = 0.63 > model = 0.62
    //   fairValue  = min(0.63, 0.62) = 0.62
    //   price      = 0.62 − 0.015 = 0.605 → 0.60
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'sports',
        consensusProbability: 0.62,
        outcomePrice: 0.61,
        edgeMagnitude: 0.11,
        direction: 'YES',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(mockSubmitLimit).toHaveBeenCalledWith(expect.objectContaining({ price: 0.60 }));
  });

  it('weather uses MAKER_EMPTY_BOOK_EDGE_BPS (150), not oracle-lag override', async () => {
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'weather',
        consensusProbability: 0.08,
        edgeMagnitude: 0.10,
        direction: 'NO',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    // direction=NO: fair value = 1 - consensusProbability = 1 - 0.08 = 0.92
    // price = 0.92 − 150 bps (0.015) = 0.905 → roundDown to tick 0.01 → 0.90
    expect(mockSubmitLimit).toHaveBeenCalledWith(expect.objectContaining({ price: 0.90 }));
  });

  it('weather empty-book GTC fills immediately (taker) — no persist-and-poll', async () => {
    // Non-post-only GTC for weather: if real liquidity exists in the matching
    // engine, the order fills as a taker in the same cycle.
    mockSubmitLimit.mockResolvedValueOnce({
      success: true,
      order_id: 'order-weather-taker',
      shares_bought: 5.88,
    });
    const redis = makeRedis();
    const result = await executeSignal(
      makeSignal({
        source: 'weather',
        consensusProbability: 0.08,
        edgeMagnitude: 0.10,
        consensusStddev: 0.4,
        direction: 'NO',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(result.skipped).toBe(false);
    expect(result.entryExecutionPath).toBe('maker_fill');
    expect(mockSubmitLimit).toHaveBeenCalledOnce();
    expect(mockSetPendingOrder).not.toHaveBeenCalled();
  });

  it('routes to fair-value maker and returns pending on ghost book (YES direction)', async () => {
    const redis = makeRedis();
    const result = await executeSignal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSignal({ source: 'oracle-lag', consensusProbability: 0.65, direction: 'YES' }),
      redis as any,
    );

    expect(result.skipped).toBe(false);
    expect(result.entryExecutionPath).toBe('maker_pending');
    expect(result.entryOrderType).toBe('maker');
    expect(mockSubmitLimit).toHaveBeenCalledOnce();
    // Fair-value: 0.65 - 50bps (0.005) = 0.645 → roundDown to tick 0.01 → 0.64
    // (oracle-lag uses ORACLE_LAG_MAKER_EDGE_BPS; see per-source rationale in
    // config.ts. Other sources still use MAKER_EMPTY_BOOK_EDGE_BPS=150.)
    expect(mockSubmitLimit).toHaveBeenCalledWith(expect.objectContaining({ price: 0.64 }));
    expect(mockSetPendingOrder).toHaveBeenCalledOnce();
    // No taker fallback — ghost book has no market makers
    expect(mockSubmitClob).not.toHaveBeenCalled();
    // Idempotency key NOT set — will resume on next cron cycle
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('uses inverted fair-value price for NO direction on ghost book', async () => {
    const redis = makeRedis();
    await executeSignal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSignal({ source: 'oracle-lag', consensusProbability: 0.65, direction: 'NO' }),
      redis as any,
    );

    // Fair-value for NO: 1 - 0.65 = 0.35; minus 50 bps (0.005) = 0.345 → roundDown → 0.34
    expect(mockSubmitLimit).toHaveBeenCalledWith(expect.objectContaining({ price: 0.34 }));
  });

  it('retries once on post-only reject with re-fetched book (oracle-lag)', async () => {
    // First post at 0.5012-fair → 0.50 (edge=50bps rounds to 0.49 but scenario:
    // consensusProbability=0.55 to make the math distinct between attempts).
    // Reject → re-fetch book with a seller now at 0.50 → fair caps to 0.49 →
    // new price 0.48. Second post succeeds.
    mockSubmitLimit
      .mockResolvedValueOnce({ success: false, error: 'post-only: would cross' })
      .mockResolvedValueOnce({ success: true, order_id: 'order-retry-1' });

    // executeSignal pre-check + tryExecuteViaClobMaker first fetch both see the
    // ghost book. The retry fetch sees a seller at 0.50 (why the first post was
    // rejected in reality).
    const ghostBook = {
      market: 'mkt-test',
      asset_id: 'tok-yes',
      timestamp: new Date().toISOString(),
      bids: [{ price: '0.01', size: '100' }],
      asks: [{ price: '0.99', size: '100' }],
      min_order_size: '1',
      tick_size: '0.01',
      neg_risk: false,
      last_trade_price: '0.50',
      hash: 'hash-empty',
    };
    const thinBook = {
      market: 'mkt-test',
      asset_id: 'tok-yes',
      timestamp: new Date().toISOString(),
      bids: [{ price: '0.01', size: '100' }],
      asks: [{ price: '0.50', size: '10' }],
      min_order_size: '1',
      tick_size: '0.01',
      neg_risk: false,
      last_trade_price: '0.50',
      hash: 'hash-thin',
    };
    mockGetOrderBook
      .mockResolvedValueOnce(ghostBook)
      .mockResolvedValueOnce(ghostBook)
      .mockResolvedValueOnce(thinBook);

    const redis = makeRedis();
    const result = await executeSignal(
      makeSignal({ source: 'oracle-lag', consensusProbability: 0.55, direction: 'UP' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(mockSubmitLimit).toHaveBeenCalledTimes(2);
    // First attempt: fair 0.55 - 50bps = 0.545 → tick 0.54
    expect(mockSubmitLimit).toHaveBeenNthCalledWith(1, expect.objectContaining({ price: 0.54 }));
    // Retry: fair capped to 0.50 - 0.01 = 0.49; 0.49 - 50bps = 0.485 → tick 0.48
    expect(mockSubmitLimit).toHaveBeenNthCalledWith(2, expect.objectContaining({ price: 0.48 }));
    expect(result.skipped).toBe(false);
    expect(result.entryExecutionPath).toBe('maker_pending');
    // Pending row should reflect the retry's price/order_id
    expect(mockSetPendingOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ orderId: 'order-retry-1', price: 0.48 }),
      expect.any(Number),
    );
  });

  it('does NOT retry for non-oracle-lag sources (scope guard)', async () => {
    mockSubmitLimit.mockResolvedValueOnce({ success: false, error: 'post-only: would cross' });

    const redis = makeRedis();
    await executeSignal(
      makeSignal({ source: 'near-zero-arb', consensusProbability: 0.70, direction: 'YES' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(mockSubmitLimit).toHaveBeenCalledOnce();
  });

  it('does NOT retry when ORACLE_LAG_MAKER_RETRY_ON_REJECT=false', async () => {
    mockConfig.ORACLE_LAG_MAKER_RETRY_ON_REJECT = false;
    try {
      mockSubmitLimit.mockResolvedValueOnce({ success: false, error: 'post-only: would cross' });

      const redis = makeRedis();
      await executeSignal(
        makeSignal({ source: 'oracle-lag', consensusProbability: 0.55, direction: 'UP' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        redis as any,
      );

      expect(mockSubmitLimit).toHaveBeenCalledOnce();
    } finally {
      mockConfig.ORACLE_LAG_MAKER_RETRY_ON_REJECT = true;
    }
  });

  it('does NOT retry on non-post-only failures (timeout / network / signer)', async () => {
    // Indeterminate failures — first order may or may not have landed.
    // Retrying could create duplicate live exposure, so the guard must bail out.
    mockSubmitLimit.mockResolvedValueOnce({ success: false, error: 'request timed out after 15000ms' });

    const redis = makeRedis();
    await executeSignal(
      makeSignal({ source: 'oracle-lag', consensusProbability: 0.55, direction: 'UP' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(mockSubmitLimit).toHaveBeenCalledOnce();
  });

  it('resumes active pending order that is not yet filled — returns pending again', async () => {
    mockGetPendingOrder.mockResolvedValue({
      orderId: 'order-resume',
      tokenId: 'tok-yes',
      price: 0.63,
      size: 7.94,
      postedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 600_000,
      consensusP: 0.65,
      direction: 'YES',
    });
    mockGetOrder.mockResolvedValue({
      id: 'order-resume',
      status: 'open',
      owner: '0x1',
      maker_address: '0x1',
      market: 'mkt-test',
      asset_id: 'tok-yes',
      side: 'BUY',
      original_size: '7.94',
      size_matched: '0',
      price: '0.63',
      associate_trades: [],
      outcome: 'YES',
      created_at: Date.now() - 60_000,
      expiration: '',
      order_type: 'GTC',
    });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'oracle-lag' }), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.entryExecutionPath).toBe('maker_pending');
    // Resumed existing order — no re-post
    expect(mockSubmitLimit).not.toHaveBeenCalled();
    // Idempotency key NOT set (must resume on next cycle too)
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('resumes pending order that has since filled — returns success and sets idempotency', async () => {
    mockGetPendingOrder.mockResolvedValue({
      orderId: 'order-filled',
      tokenId: 'tok-yes',
      price: 0.63,
      size: 7.94,
      postedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 600_000,
      consensusP: 0.65,
      direction: 'YES',
    });
    mockGetOrder.mockResolvedValue({
      id: 'order-filled',
      status: 'filled',
      owner: '0x1',
      maker_address: '0x1',
      market: 'mkt-test',
      asset_id: 'tok-yes',
      side: 'BUY',
      original_size: '7.94',
      size_matched: '7.94',
      price: '0.63',
      associate_trades: [],
      outcome: 'YES',
      created_at: Date.now() - 60_000,
      expiration: '',
      order_type: 'GTC',
    });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'oracle-lag' }), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.tradeResult?.success).toBe(true);
    expect(result.entryOrderType).toBe('maker');
    // Idempotency key set on fill
    expect(redis.set).toHaveBeenCalled();
    // Pending order record cleaned up after fill
    expect(mockDeletePendingOrder).toHaveBeenCalled();
    // No re-post
    expect(mockSubmitLimit).not.toHaveBeenCalled();
  });

  it('partial fill on resume cancels residual open size before returning', async () => {
    mockGetPendingOrder.mockResolvedValue({
      orderId: 'order-partial',
      tokenId: 'tok-yes',
      price: 0.63,
      size: 7.94,
      postedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 600_000,
      consensusP: 0.65,
      direction: 'YES',
    });
    // Only half filled
    mockGetOrder.mockResolvedValue({
      id: 'order-partial',
      status: 'open',
      owner: '0x1',
      maker_address: '0x1',
      market: 'mkt-test',
      asset_id: 'tok-yes',
      side: 'BUY',
      original_size: '7.94',
      size_matched: '3.97', // partial fill
      price: '0.63',
      associate_trades: [],
      outcome: 'YES',
      created_at: Date.now() - 60_000,
      expiration: '',
      order_type: 'GTC',
    });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'oracle-lag' }), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.tradeResult?.success).toBe(true);
    // Residual open size should be cancelled
    expect(mockCancelOrder).toHaveBeenCalledWith('order-partial');
    // Pending record cleaned up
    expect(mockDeletePendingOrder).toHaveBeenCalled();
    // Idempotency key set (partial fill counts as a real fill)
    expect(redis.set).toHaveBeenCalled();
  });

  it('cycle-start cleanup cancels expired pending order and re-posts new order', async () => {
    const expiredOrder = {
      orderId: 'order-expired',
      tokenId: 'tok-yes',
      price: 0.63,
      size: 7.94,
      postedAt: Date.now() - 1_200_000,
      expiresAt: Date.now() - 300_000, // expired 5 min ago
      consensusP: 0.65,
      direction: 'YES',
    };
    // Cycle-start cleanup sees expired order; tryExecuteViaClobMaker sees null after cleanup
    mockGetPendingOrder
      .mockResolvedValueOnce(expiredOrder)
      .mockResolvedValueOnce(null);

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'oracle-lag' }), redis as any);

    // Expired order was cancelled
    expect(mockCancelOrder).toHaveBeenCalledWith('order-expired');
    // Redis key deleted
    expect(mockDeletePendingOrder).toHaveBeenCalled();
    // New order posted for this cycle
    expect(mockSubmitLimit).toHaveBeenCalled();
    expect(mockSetPendingOrder).toHaveBeenCalled();
    expect(result.skipped).toBe(false);
    expect(result.entryExecutionPath).toBe('maker_pending');
  });

  it('returns no_clob_book when empty-book order is rejected — no taker fallback in hybrid mode', async () => {
    mockSubmitLimit.mockResolvedValue({ success: false, error: 'post_only_would_cross' });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'oracle-lag' }), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('no_clob_book');
    // Ghost book — taker fallback is suppressed even in hybrid mode
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('spread_too_wide still fires for non-ghost wide books (regression)', async () => {
    // Real market maker present but spread is wide — NOT a ghost book (bid > 0.04 threshold)
    mockGetOrderBook.mockResolvedValue({
      market: 'mkt-test',
      asset_id: 'tok-yes',
      timestamp: new Date().toISOString(),
      bids: [{ price: '0.40', size: '100' }],
      asks: [{ price: '0.65', size: '100' }], // ~4615 bps > 500 ceiling
      min_order_size: '1',
      tick_size: '0.01',
      neg_risk: false,
      last_trade_price: '0.50',
      hash: 'hash',
    });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'osint' }), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('spread_too_wide');
    expect(mockSubmitLimit).not.toHaveBeenCalled();
  });

  describe('API migration blackout gate', () => {
    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockConfig as any).API_MIGRATION_CUTOVER_DATE = '2026-04-28';
    });

    afterEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (mockConfig as any).API_MIGRATION_CUTOVER_DATE;
    });

    it('blocks a market whose endDate is on the cutover date', async () => {
      const redis = makeRedis();
      const result = await executeSignal(
        makeSignal({ endDate: '2026-04-28T20:00:00Z' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        redis as any,
      );
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('pre_migration_blackout');
      expect(mockSubmit).not.toHaveBeenCalled();
    });

    it('blocks a market whose endDate is after the cutover date', async () => {
      const redis = makeRedis();
      const result = await executeSignal(
        makeSignal({ endDate: '2026-05-10T12:00:00Z' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        redis as any,
      );
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('pre_migration_blackout');
    });

    it('does not block a market that resolves before the cutover date', async () => {
      const redis = makeRedis();
      const result = await executeSignal(
        makeSignal({ endDate: '2026-04-27T23:59:59Z' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        redis as any,
      );
      expect(result.skipReason).not.toBe('pre_migration_blackout');
    });

    it('does not block when endDate is absent', async () => {
      const redis = makeRedis();
      const result = await executeSignal(
        makeSignal({ endDate: undefined }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        redis as any,
      );
      expect(result.skipReason).not.toBe('pre_migration_blackout');
    });

    it('does not block futures signals regardless of endDate', async () => {
      const redis = makeRedis();
      try {
        const result = await executeSignal(
          makeSignal({ isFutures: true, endDate: '2026-05-01T00:00:00Z', marketId: 'BTC' }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          redis as any,
        );
        // If it returned, confirm the gate didn't fire
        expect(result.skipReason).not.toBe('pre_migration_blackout');
      } catch (err) {
        // HL client throws (not configured in test env) — gate was not hit
        expect((err as Error).message).not.toContain('pre_migration_blackout');
      }
    });

    it('is inactive when API_MIGRATION_CUTOVER_DATE is not set', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (mockConfig as any).API_MIGRATION_CUTOVER_DATE;
      const redis = makeRedis();
      const result = await executeSignal(
        makeSignal({ endDate: '2026-05-01T00:00:00Z' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        redis as any,
      );
      expect(result.skipReason).not.toBe('pre_migration_blackout');
    });
  });
});
