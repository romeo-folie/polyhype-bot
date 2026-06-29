import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TradeSignal } from '../../mapping/index.js';

vi.mock('../../shared/clob.js', () => ({
  submitClobBuy: vi.fn(),
  getClobOrderBook: vi.fn(),
  submitClobLimitBuy: vi.fn(),
  getClobOrder: vi.fn(),
  // Default passthrough: resolves to the posted-price arg (pre-VWAP behaviour).
  resolveOrderFillPrice: vi.fn(
    async (_orderId: string, _cond: string | undefined, _asset: string, _shares: number, posted: number) => posted,
  ),
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
  sumRestAboveCapNotional: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockConfig = {
  REDIS_URL: 'redis://localhost:6379',
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
  MAKER_EMPTY_BOOK_MIN_CONSENSUS: 0.65,
  MAKER_EMPTY_BOOK_MIN_EDGE: 0.20,
  MAKER_EMPTY_BOOK_MAX_STDDEV: 0.12,
  MAKER_EMPTY_BOOK_ALLOWED_SOURCES: ['oracle-lag', 'near-zero-arb', 'weather', 'sports'],
  ORACLE_LAG_MAKER_EDGE_BPS: 50,
  ORACLE_LAG_MAKER_RETRY_ON_REJECT: true,
  ORACLE_LAG_REAL_BOOK_MAKER_MAX_WAIT_MS: 0,
  SPORTS_MAKER_PREMIUM_PCT: 0.02,
  WEATHER_MAKER_POST_ONLY: true,
  WEATHER_MAKER_DISCOUNT_BPS: 500,
  WEATHER_MAX_ENTRY_PRICE: 0,
  WEATHER_EMPTY_BOOK_DISCOUNT_BPS: 0,
  WEATHER_EMPTY_BOOK_MAX_ENTRY_PRICE: 0,
  WEATHER_MAX_SIGNAL_PRICE_DRIFT: 0.08,
  WEATHER_MAX_HORIZON_DAYS: 7,
  WEATHER_REAL_BOOK_DISCOUNT_BPS: 0,
  WEATHER_EARLY_ENTRY_MAX_PRICE: 0,
  WEATHER_REST_ABOVE_CAP_ENABLED: false,
  WEATHER_REST_ABOVE_CAP_MAX_NOTIONAL_USD: 0,
  // Conviction taker-entry (OFF by default; individual tests enable it).
  WEATHER_TAKER_ENTRY_ENABLED: false,
  WEATHER_TAKER_ENTRY_MIN_EDGE: 0.15,
  WEATHER_TAKER_ENTRY_MAX_PRICE: 0.80,
  WEATHER_TAKER_ENTRY_MAX_DAILY_USD: 25,
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

const { submitClobBuy, getClobOrderBook, submitClobLimitBuy, getClobOrder, resolveOrderFillPrice, cancelClobOrder } =
  await import('../../shared/clob.js');
const { hasOpenPosition } = await import('../positionLedger.js');
const { recordExecutionMetric, recordExecutionTiming, recordExecutionEvent } =
  await import('../../shared/telemetry.js');
const { getPendingOrder, setPendingOrder, deletePendingOrder, sumRestAboveCapNotional } =
  await import('../pendingMakerOrders.js');
const { executeSignal, executeSignals, executeAndRecordSignal } = await import('../executor.js');
const positionLedgerMocks = await import('../positionLedger.js');
const bankrollMocks = await import('../../shared/bankroll.js');

const mockSubmitClob = vi.mocked(submitClobBuy);
const mockGetOrderBook = vi.mocked(getClobOrderBook);
const mockSubmitLimit = vi.mocked(submitClobLimitBuy);
const mockGetOrder = vi.mocked(getClobOrder);
const mockResolveFillPrice = vi.mocked(resolveOrderFillPrice);
const mockCancelOrder = vi.mocked(cancelClobOrder);
const mockHasPosition = vi.mocked(hasOpenPosition);
const mockRecordExecutionMetric = vi.mocked(recordExecutionMetric);
const mockRecordExecutionTiming = vi.mocked(recordExecutionTiming);
const mockRecordExecutionEvent = vi.mocked(recordExecutionEvent);
const mockGetPendingOrder = vi.mocked(getPendingOrder);
const mockSetPendingOrder = vi.mocked(setPendingOrder);
const mockDeletePendingOrder = vi.mocked(deletePendingOrder);
const mockSumRestAboveCap = vi.mocked(sumRestAboveCapNotional);

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
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('skips futures SHORT when a same-market LONG is already open (opposite-side dedup)', async () => {
    const prevFuturesEnabled = mockConfig.FUTURES_ENABLED;
    mockConfig.FUTURES_ENABLED = true;
    try {
      // Model hasOpenPosition: (marketId='ETH', direction='SHORT') → false,
      //                       (marketId='ETH', direction='LONG')  → true
      // So the SHORT signal is blocked by the existing LONG.
      mockHasPosition.mockImplementation(
        (_redis: unknown, _marketId: string, direction: string) => {
          return Promise.resolve(direction === 'LONG');
        },
      );
      const redis = makeRedis();
      const signal = makeSignal({
        marketId: 'ETH',
        isFutures: true,
        direction: 'SHORT' as unknown as TradeSignal['direction'],
        stakeUsd: 10,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await executeSignal(signal, redis as any);

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('position_already_open');
      // Must NOT place the order on any venue
      expect(mockSubmitClob).not.toHaveBeenCalled();
      expect(mockSubmitLimit).not.toHaveBeenCalled();
    } finally {
      mockConfig.FUTURES_ENABLED = prevFuturesEnabled;
    }
  });

  it('skips when stake is below floor', async () => {
    const redis = makeRedis();
    const signal = makeSignal({ stakeUsd: 0.001 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(signal, redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('stake_below_floor');
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
    expect(result.executionVenue).toBe('clob');
  });

  it('skips when idempotency key already exists', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue('1');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('already_executed');
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('executes via CLOB', async () => {
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.executionVenue).toBe('clob');
    expect(!result.skipped && !result.error).toBe(true);
    expect(mockSubmitClob).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-yes', amountUsd: 5.0 }),
    );
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it('returns an error when CLOB fails', async () => {
    const redis = makeRedis();
    mockSubmitClob.mockResolvedValue({ success: false, error: 'insufficient balance' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.executionVenue).toBe('clob');
    expect(result.error).toContain('insufficient balance');
    expect(redis.set).not.toHaveBeenCalled();
    expect(mockRecordExecutionMetric).toHaveBeenCalledWith(
      redis as any,
      'errors',
      'clob_failed',
    );
    expect(mockRecordExecutionEvent).toHaveBeenCalledWith(
      redis as any,
      'execution_attempt',
      expect.objectContaining({
        finalExecutionPath: 'error',
        errorClass: 'clob_failed',
        executionSucceeded: false,
      }),
    );
  });

  it('uses NO token id when direction is NO', async () => {
    const redis = makeRedis();

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
    expect(result.executionVenue).toBe('clob');
  });

  it('reads the touch from multi-level raw-REST-order books (bids[0] = WORST bid)', async () => {
    // The REST /book endpoint ships best-at-the-END arrays (bids ascending,
    // asks descending). Pre-fix, bids[0]/asks[0] reads saw 0.01/0.99 on this
    // 0.49/0.51 book → ~19600bps phantom spread → spread_too_wide skip.
    mockConfig.MAX_ENTRY_SPREAD_BPS = 500; // 5%
    mockGetOrderBook.mockResolvedValue({
      market: 'mkt-test',
      asset_id: 'tok-yes',
      timestamp: new Date().toISOString(),
      bids: [
        { price: '0.01', size: '5' },
        { price: '0.30', size: '20' },
        { price: '0.49', size: '100' }, // real best bid — LAST
      ],
      asks: [
        { price: '0.99', size: '5' },
        { price: '0.70', size: '20' },
        { price: '0.51', size: '100' }, // real best ask — LAST
      ],
      min_order_size: '1',
      tick_size: '0.01',
      neg_risk: false,
      last_trade_price: '0.50',
      hash: 'hash',
    });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    // Real spread = 200bps < 500 cap → executes instead of spread_too_wide.
    expect(result.skipReason).not.toBe('spread_too_wide');
    expect(result.skipped).toBe(false);
    expect(result.executionVenue).toBe('clob');
  });

  it('oracle-lag uses ORACLE_LAG_MAX_ENTRY_SPREAD_BPS override when >= 0', async () => {
    // Global threshold is 500 bps; override is 2000 bps — wide book should pass for oracle-lag
    mockConfig.MAX_ENTRY_SPREAD_BPS = 500;
    mockConfig.ORACLE_LAG_MAX_ENTRY_SPREAD_BPS = 2000;
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
    expect(result.executionVenue).toBe('clob');
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
    expect(result.executionVenue).toBe('clob');
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
    mockSubmitClob.mockReset();
    mockHasPosition.mockReset();
    mockGetCalibrationStats.mockReset();

    mockConfig.MAX_ENTRY_SPREAD_BPS = 0;
    mockGetOrderBook.mockResolvedValue(null);

    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xclob' });
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
    // The signal should have corrected edge applied
  });

  it('does not apply correction when stats is null', async () => {
    mockGetCalibrationStats.mockResolvedValue(null);

    const redis = makeRedis();
    const signal = makeSignal({ edgeMagnitude: 0.2 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(signal, redis as any);

    expect(result.skipped).toBe(false);
    expect(!result.skipped && !result.error).toBe(true);
  });
});

describe('execution mode', () => {
  beforeEach(() => {
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

    // All latency-sensitive sources route to CLOB taker directly.
    // These sources should never submit a maker limit order.
    // Note: copytrade is now maker-eligible (persistent alpha) — tested separately.
    const cases: ('spot' | 'crypto-arb')[] = ['spot', 'crypto-arb'];
    for (const source of cases) {
      mockSubmitLimit.mockClear();
      const redis = makeRedis();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await executeSignal(makeSignal({ source }), redis as any);
      expect(result.skipped).toBe(false);
      expect(result.executionVenue).toBe('clob');
      expect(result.entryOrderType).toBe('taker');
      expect(mockSubmitLimit).not.toHaveBeenCalled();
    }
  });

  it('attempts maker for copytrade signals in hybrid mode', async () => {
    mockConfig.EXECUTION_MODE = 'hybrid';
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
  });

  it('attempts maker for near-zero-arb signals in hybrid mode', async () => {
    mockConfig.EXECUTION_MODE = 'hybrid';
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
  });

  it('attempts maker for osint signals in hybrid mode', async () => {
    mockConfig.EXECUTION_MODE = 'hybrid';
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
  });

  it('oracle-lag on real book goes directly to taker — no maker order posted', async () => {
    // oracle-lag is excluded from MAKER_ELIGIBLE_SOURCES because GTC maker orders
    // can fill after market expiry (stale fill), causing expired_unresolvable losses.
    // For real books it uses the taker path (FAK/FOK per CLOB_ORDER_TYPE) for an immediate fill.
    mockConfig.EXECUTION_MODE = 'hybrid';
    // Active spread gate ensures the real-book spread-check path is exercised.
    mockConfig.MAX_ENTRY_SPREAD_BPS = 500;
    mockConfig.ORACLE_LAG_MAX_ENTRY_SPREAD_BPS = 2000; // prod default — wider than the 200bps test spread
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

    // Order book was fetched — confirms real-book path was exercised.
    expect(mockGetOrderBook).toHaveBeenCalled();
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
    expect(result.executionVenue).toBe('clob');
    expect(result.modeConfigured).toBe('taker');
    expect(result.entryExecutionPath).toBe('clob_direct');
    expect(result.entryOrderType).toBe('taker');
    expect(result.decisionBenchmark?.decisionBestAsk).toBe(0.51);
    expect(mockRecordExecutionEvent).toHaveBeenCalledTimes(1);
    const [, , payload] = mockRecordExecutionEvent.mock.calls[0]!;
    expect(payload.executionPath).toBe('clob_direct');
    expect(payload.finalExecutionPath).toBe('clob_direct');
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

  it('populates entryPrice from CLOB taker fill when available', async () => {
    const redis = makeRedis();
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
  });

  it('returns empty array for empty input', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await executeSignals([], redis as any);
    expect(results).toHaveLength(0);
  });
});

describe('executeAndRecordSignal', () => {
  const mockRecordPosition = vi.mocked(positionLedgerMocks.recordPosition);
  const mockDeductStake = vi.mocked(bankrollMocks.deductStake);

  beforeEach(() => {
    mockSubmitClob.mockReset();
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

    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xclob', shares_bought: 10 });
    mockHasPosition.mockResolvedValue(false);
  });

  it('on success: calls deductStake and recordPosition exactly once each', async () => {
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeSignal(), redis as any);

    expect(!result.skipped && !result.error).toBe(true);
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
    mockSubmitClob.mockResolvedValue({ success: false, error: 'clob rejected' });
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeSignal(), redis as any);

    expect(result.skipped || result.error).toBeTruthy();
    expect(mockDeductStake).not.toHaveBeenCalled();
    expect(mockRecordPosition).not.toHaveBeenCalled();
  });

  it('swallows recordPosition throw so a successful fill still returns success', async () => {
    // Invariant: the trade is already live on the venue and idempotency is set.
    // Propagating a ledger-write throw would mask the fill AND block retry.
    mockRecordPosition.mockRejectedValue(new Error('redis unreachable'));
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeAndRecordSignal(makeSignal(), redis as any);

    expect(!result.skipped && !result.error).toBe(true);
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
    // Weather knobs — reset to defaults every test so a failing case that
    // skips the manual reset at the bottom doesn't leak state into siblings.
    mockConfig.WEATHER_MAKER_POST_ONLY = true;
    mockConfig.WEATHER_MAKER_DISCOUNT_BPS = 500;
    mockConfig.WEATHER_MAX_ENTRY_PRICE = 0;
    mockConfig.WEATHER_EMPTY_BOOK_DISCOUNT_BPS = 0;
    mockConfig.WEATHER_EMPTY_BOOK_MAX_ENTRY_PRICE = 0;
    mockConfig.WEATHER_MAX_SIGNAL_PRICE_DRIFT = 0.08;
    // Sports: default to false in this describe block so existing ghost-book tests
    // remain valid; individual tests can override to true to verify the gate.
    mockConfig.SPORTS_REQUIRE_REAL_BOOK = false;

    mockGetOrderBook.mockResolvedValue(makeGhostBook());
    mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'order-eb' });
    mockGetOrder.mockResolvedValue(null);
    // Default passthrough: the resolver returns the posted price (pre-VWAP
    // behaviour), keeping the existing expectations valid.
    mockResolveFillPrice.mockReset();
    mockResolveFillPrice.mockImplementation(
      async (_orderId, _cond, _asset, _shares, posted) => posted,
    );
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

  it('extends the pending-key TTL to cover market resolution (endDate), not just the wait window', async () => {
    // Regression: a GTC empty-book order rests until filled/cancelled, but the
    // tracking key used to expire after only wait+grace (~1200s here). Once it
    // lapsed, a later re-emission could no longer find the resting order to
    // cancel + replace, so it posted a DUPLICATE and orphaned the original.
    const redis = makeRedis();
    const twoDaysOut = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
    await executeSignal(
      makeSignal({ source: 'oracle-lag', consensusProbability: 0.5012, direction: 'UP', endDate: twoDaysOut }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );
    expect(mockSetPendingOrder).toHaveBeenCalledOnce();
    const ttl = mockSetPendingOrder.mock.calls[0]![4] as number;
    // baseTtl = ceil(900000/1000)+300 = 1200s; endDate ~2d out must dominate.
    expect(ttl).toBeGreaterThan(150_000);
    expect(ttl).toBeLessThanOrEqual(4 * 24 * 3600); // safety cap
  });

  it('falls back to the wait-window TTL when the signal has no endDate', async () => {
    const redis = makeRedis();
    await executeSignal(
      makeSignal({ source: 'oracle-lag', consensusProbability: 0.5012, direction: 'UP' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );
    expect(mockSetPendingOrder).toHaveBeenCalledOnce();
    // ceil(MAKER_EMPTY_BOOK_MAX_WAIT_MS/1000) + 300 = 900 + 300.
    expect(mockSetPendingOrder.mock.calls[0]![4] as number).toBe(1200);
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

  it('weather YES applies DISCOUNT_BPS below bestAsk and posts post-only', async () => {
    // Ghost book: the old path would have posted near 0.82, but the new
    // relative weather quote cap binds first. outcomePrice defaults to 0.50,
    // drift cap adds 0.08 → fairValue <= 0.58, then edgeBps=150 → 0.565 → 0.56.
    mockConfig.WEATHER_MAKER_DISCOUNT_BPS = 1500;
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'weather',
        consensusProbability: 0.95,
        edgeMagnitude: 0.30,
        consensusStddev: 0.05,
        direction: 'YES',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    const call = mockSubmitLimit.mock.calls[0]![0];
    expect(call.postOnly).toBe(true);
    expect(call.price).toBeCloseTo(0.56, 2);
    expect(call.price).toBeLessThan(0.95); // well below modelProb
    mockConfig.WEATHER_MAKER_DISCOUNT_BPS = 500;
  });

  it('weather NO applies discount against NO-side ask (1 - bestBid)', async () => {
    // Ghost book: YES bestBid=0.01, bestAsk=0.99 → NO side ask = 1 - 0.01 = 0.99.
    // modelProb=P(YES)=0.05 → P(NO)=0.95 (fairValue init for NO).
    // DISCOUNT_BPS=1500 → discountedAnchor = 0.99 * 0.85 = 0.8415.
    //   fairValue = min(0.95, 0.8415) = 0.8415
    //   no-cross cap for NO = min(0.8415, 1 - 0.01 - 0.01) = 0.8415
    //   edgeBps=150 → 0.8415 - 0.015 = 0.8265 → tick-rounded 0.82
    mockConfig.WEATHER_MAKER_DISCOUNT_BPS = 1500;
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'weather',
        consensusProbability: 0.05,
        edgeMagnitude: 0.30,
        direction: 'NO',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    const call = mockSubmitLimit.mock.calls[0]![0];
    // Relative cap binds first: outcomePrice defaults to 0.50 in makeSignal,
    // drift cap adds 0.08 → fairValue <= 0.58, then edgeBps=150 → 0.565 => 0.56.
    expect(call.price).toBeCloseTo(0.56, 2);
    expect(call.postOnly).toBe(true);
    mockConfig.WEATHER_MAKER_DISCOUNT_BPS = 500;
  });

  it('weather with WEATHER_MAKER_POST_ONLY=false posts non-post-only GTC', async () => {
    mockConfig.WEATHER_MAKER_POST_ONLY = false;
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'weather',
        consensusProbability: 0.85,
        edgeMagnitude: 0.30,
        direction: 'YES',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(mockSubmitLimit).toHaveBeenCalledWith(
      expect.objectContaining({ postOnly: false }),
    );
    mockConfig.WEATHER_MAKER_POST_ONLY = true;
  });

  it('weather caps post price at WEATHER_MAX_ENTRY_PRICE for high-conviction NO', async () => {
    // Ghost book: YES bestBid=0.01, bestAsk=0.99. High-conviction NO:
    // consensusP=P(YES)=0.10 → fairValue init for NO = 0.90.
    //   discountedAnchor = 0.99 * 0.95 = 0.9405 → fairValue = min(0.90, 0.9405) = 0.90
    //   no-cross cap (NO) = 1 - 0.01 - 0.01 = 0.98 → fairValue = 0.90
    //   edgeBps=150 → would post 0.90 - 0.015 = 0.885
    // Relative quote cap binds first: outcomePrice defaults to 0.50, so
    // fairValue <= 0.58 and post price becomes 0.565 → tick-rounded 0.56.
    mockConfig.WEATHER_MAX_ENTRY_PRICE = 0.65;
    mockConfig.WEATHER_MAKER_POST_ONLY = false;
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'weather',
        consensusProbability: 0.10,
        edgeMagnitude: 0.30,
        direction: 'NO',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    const call = mockSubmitLimit.mock.calls[0]![0];
    expect(call.price).toBeLessThanOrEqual(0.65);
    expect(call.price).toBeCloseTo(0.56, 2);
    expect(call.postOnly).toBe(false);
  });

  it('weather caps empty-book post at WEATHER_EMPTY_BOOK_MAX_ENTRY_PRICE below WEATHER_MAX_ENTRY_PRICE', async () => {
    // Same ghost-book high-conviction NO as the WEATHER_MAX_ENTRY_PRICE test
    // (consensusP=0.10 → NO fairValue 0.90). WEATHER_MAX_ENTRY_PRICE=0.65 alone
    // would allow ~0.56 (after the relative-quote cap), but the stricter empty-book
    // cap of 0.45 binds first: post becomes 0.45 - edgeBps(1.5%) ≈ 0.443, tick-rounded
    // down to 0.43.
    mockConfig.WEATHER_MAX_ENTRY_PRICE = 0.65;
    mockConfig.WEATHER_EMPTY_BOOK_MAX_ENTRY_PRICE = 0.45;
    mockConfig.WEATHER_MAKER_POST_ONLY = false;
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'weather',
        consensusProbability: 0.10,
        edgeMagnitude: 0.30,
        direction: 'NO',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    const call = mockSubmitLimit.mock.calls[0]![0];
    expect(call.price).toBeLessThanOrEqual(0.45);
    expect(call.price).toBeCloseTo(0.43, 2);
  });

  it('weather WEATHER_EMPTY_BOOK_MAX_ENTRY_PRICE=0 disables the empty-book cap (falls back to WEATHER_MAX_ENTRY_PRICE)', async () => {
    // With the empty-book cap disabled, the post reverts to the WEATHER_MAX_ENTRY_PRICE
    // path's ~0.56 (relative-quote cap), confirming the new cap is the only thing
    // pulling the price down to 0.44 in the test above.
    mockConfig.WEATHER_MAX_ENTRY_PRICE = 0.65;
    mockConfig.WEATHER_EMPTY_BOOK_MAX_ENTRY_PRICE = 0;
    mockConfig.WEATHER_MAKER_POST_ONLY = false;
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'weather',
        consensusProbability: 0.10,
        edgeMagnitude: 0.30,
        direction: 'NO',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    const call = mockSubmitLimit.mock.calls[0]![0];
    expect(call.price).toBeCloseTo(0.56, 2);
  });

  it('weather WEATHER_MAX_ENTRY_PRICE=0 disables the cap (no-op)', async () => {
    // Same high-conviction NO setup, but cap disabled — post price reflects
    // modelProb - edgeBps = 0.90 - 0.015 = 0.885 (no 0.65 clamp).
    // beforeEach already sets WEATHER_MAX_ENTRY_PRICE = 0.
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'weather',
        consensusProbability: 0.10,
        edgeMagnitude: 0.30,
        direction: 'NO',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    const call = mockSubmitLimit.mock.calls[0]![0];
    expect(call.price).toBeCloseTo(0.56, 2);
  });

  it('weather refuses to post materially above the scanner quote even if absolute cap allows it', async () => {
    mockConfig.WEATHER_MAX_ENTRY_PRICE = 0.65;
    mockConfig.WEATHER_MAX_SIGNAL_PRICE_DRIFT = 0.02;
    mockConfig.WEATHER_MAKER_POST_ONLY = false;
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'weather',
        consensusProbability: 0.10,
        edgeMagnitude: 0.30,
        direction: 'NO',
        outcomePrice: 0.44,
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    const call = mockSubmitLimit.mock.calls[0]![0];
    expect(call.price).toBeLessThanOrEqual(0.46);
  });

  it('weather conviction discount posts proportional to fair value, bypassing the flat empty-book cap', async () => {
    // High-conviction NO: consensusP=0.10 → NO fairValue 0.90. With conviction pricing
    // active (2000 bps = 20% off model FV), post = 0.90*(1-0.20) - edge(1.5%) ≈ 0.705 → 0.70.
    // The legacy WEATHER_EMPTY_BOOK_MAX_ENTRY_PRICE=0.45 is set but MUST be ignored — the
    // old flat cap pinned this same signal to ~0.43 (see the legacy cap test above), which
    // is exactly the conviction-blind behaviour that starved fills.
    mockConfig.WEATHER_EMPTY_BOOK_DISCOUNT_BPS = 2000;
    mockConfig.WEATHER_MAX_ENTRY_PRICE = 0.75;
    mockConfig.WEATHER_EMPTY_BOOK_MAX_ENTRY_PRICE = 0.45;
    mockConfig.WEATHER_MAKER_POST_ONLY = false;
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'weather',
        consensusProbability: 0.10,
        edgeMagnitude: 0.30,
        direction: 'NO',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    const call = mockSubmitLimit.mock.calls[0]![0];
    expect(call.price).toBeCloseTo(0.70, 2);
    expect(call.price).toBeGreaterThan(0.45); // legacy flat cap bypassed
  });

  it('bracket-opposite leg posts the target SHARE count, not stakeUsd/discounted-price', async () => {
    // Regression for the bracket oversizing bug: the scanner sizes the leg's dollar
    // stake at the Gamma mid, but the executor posts at a deeply discounted maker
    // price. Dividing stakeUsd by that price inflated the share count by
    // gammaMid/postedPrice (2.5–6.7× in shadow logs). With _bracketTargetShares the
    // leg must post exactly the primary's share count regardless of the post price.
    mockConfig.WEATHER_MAKER_POST_ONLY = false;
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'weather',
        direction: 'NO',
        consensusProbability: 0.10, // NO fair value 0.90 → posts ≈ 0.88
        edgeMagnitude: 0.30,
        stakeUsd: 5, // dollar exposure estimate (gammaMid-derived), NOT the sizer
        _isBracketOpposite: true,
        _bracketTargetShares: 12,
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    const call = mockSubmitLimit.mock.calls[0]![0];
    expect(call.size).toBe(12);
    // Prove the size is NOT stake-derived: 5 / ~0.88 ≈ 5.7, far from 12.
    expect(call.size).not.toBeCloseTo(5 / call.price, 1);
  });

  it('non-bracket weather leg still sizes by stakeUsd / posted price', async () => {
    // Control: without _bracketTargetShares the maker order size is the usual
    // stakeUsd/price, so the share-count override is the only thing that changes sizing.
    mockConfig.WEATHER_MAKER_POST_ONLY = false;
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'weather',
        direction: 'NO',
        consensusProbability: 0.10,
        edgeMagnitude: 0.30,
        stakeUsd: 5,
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    const call = mockSubmitLimit.mock.calls[0]![0];
    expect(call.size).toBeCloseTo(5 / call.price, 6);
  });

  it('weather conviction discount scales the post price WITH conviction', async () => {
    // The headline behavioural change: two NO entries with different model conviction
    // must rest at different prices (the old flat cap pinned both to the same ~0.43).
    //   high conviction: NO fv 0.90 → 0.90*0.80 - 0.015 ≈ 0.70
    //   low  conviction: NO fv 0.70 → 0.70*0.80 - 0.015 ≈ 0.54
    mockConfig.WEATHER_EMPTY_BOOK_DISCOUNT_BPS = 2000;
    mockConfig.WEATHER_MAX_ENTRY_PRICE = 0.75;
    mockConfig.WEATHER_EMPTY_BOOK_MAX_ENTRY_PRICE = 0.45;
    mockConfig.WEATHER_MAKER_POST_ONLY = false;

    const redisHigh = makeRedis();
    await executeSignal(
      makeSignal({
        marketId: 'mkt-high',
        clobTokenIds: ['tok-yes-h', 'tok-no-h'],
        source: 'weather',
        consensusProbability: 0.10,
        edgeMagnitude: 0.30,
        direction: 'NO',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redisHigh as any,
    );
    const priceHigh = mockSubmitLimit.mock.calls[0]![0].price;
    mockSubmitLimit.mockClear();

    const redisLow = makeRedis();
    await executeSignal(
      makeSignal({
        marketId: 'mkt-low',
        clobTokenIds: ['tok-yes-l', 'tok-no-l'],
        source: 'weather',
        consensusProbability: 0.30,
        edgeMagnitude: 0.30,
        direction: 'NO',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redisLow as any,
    );
    const priceLow = mockSubmitLimit.mock.calls[0]![0].price;

    expect(priceHigh).toBeGreaterThan(priceLow);
    expect(priceHigh).toBeCloseTo(0.70, 2);
    expect(priceLow).toBeCloseTo(0.54, 2);
  });

  it('weather WEATHER_MAX_ENTRY_PRICE ceiling still binds under conviction pricing', async () => {
    // Very high conviction (NO fv 0.95). 0.95*0.80 = 0.76 would exceed the absolute
    // ceiling, so WEATHER_MAX_ENTRY_PRICE=0.65 caps it: 0.65 - edge(1.5%) ≈ 0.635 → 0.63.
    mockConfig.WEATHER_EMPTY_BOOK_DISCOUNT_BPS = 2000;
    mockConfig.WEATHER_MAX_ENTRY_PRICE = 0.65;
    mockConfig.WEATHER_EMPTY_BOOK_MAX_ENTRY_PRICE = 0.45;
    mockConfig.WEATHER_MAKER_POST_ONLY = false;
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'weather',
        consensusProbability: 0.05,
        edgeMagnitude: 0.30,
        direction: 'NO',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    const call = mockSubmitLimit.mock.calls[0]![0];
    expect(call.price).toBeCloseTo(0.63, 2);
    expect(call.price).toBeLessThanOrEqual(0.65);
  });

  it('weather conviction pricing bypasses the signal-drift cap (model edge over stale quote)', async () => {
    // outcomePrice=0.20 (stale ghost quote) with NO fv 0.90. Legacy mode would clamp to
    // outcomePrice + WEATHER_MAX_SIGNAL_PRICE_DRIFT = 0.28; conviction pricing bets the
    // model edge instead → ≈0.70, bounded only by WEATHER_MAX_ENTRY_PRICE.
    mockConfig.WEATHER_EMPTY_BOOK_DISCOUNT_BPS = 2000;
    mockConfig.WEATHER_MAX_ENTRY_PRICE = 0.75;
    mockConfig.WEATHER_MAX_SIGNAL_PRICE_DRIFT = 0.08;
    mockConfig.WEATHER_MAKER_POST_ONLY = false;
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'weather',
        consensusProbability: 0.10,
        edgeMagnitude: 0.30,
        direction: 'NO',
        outcomePrice: 0.20,
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    const call = mockSubmitLimit.mock.calls[0]![0];
    expect(call.price).toBeCloseTo(0.70, 2);
    expect(call.price).toBeGreaterThan(0.28); // drift cap bypassed
  });

  it('weather conviction discount applies to YES entries too', async () => {
    // Symmetry check: high-conviction YES (consensusP=0.90 → YES fv 0.90) rests at the
    // same conviction-discounted ~0.70 as the NO case.
    mockConfig.WEATHER_EMPTY_BOOK_DISCOUNT_BPS = 2000;
    mockConfig.WEATHER_MAX_ENTRY_PRICE = 0.75;
    mockConfig.WEATHER_EMPTY_BOOK_MAX_ENTRY_PRICE = 0.45;
    mockConfig.WEATHER_MAKER_POST_ONLY = false;
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'weather',
        consensusProbability: 0.90,
        edgeMagnitude: 0.30,
        direction: 'YES',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    const call = mockSubmitLimit.mock.calls[0]![0];
    expect(call.price).toBeCloseTo(0.70, 2);
    expect(call.price).toBeGreaterThan(0.45);
  });

  it('weather refuses to post when WEATHER_MAX_ENTRY_PRICE < tick floor', async () => {
    // Tick floor inside resolveMakerPrice would lift a sub-tick price above the
    // cap; defense-in-depth branch refuses to post in that case rather than
    // silently overpay. Setting cap=0.005 with tick=0.01 hits the edge case.
    mockConfig.WEATHER_MAX_ENTRY_PRICE = 0.005;
    mockConfig.WEATHER_MAKER_POST_ONLY = false;
    const redis = makeRedis();
    const result = await executeSignal(
      makeSignal({
        source: 'weather',
        consensusProbability: 0.10,
        edgeMagnitude: 0.30,
        direction: 'NO',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(result.skipped).toBe(true);
    expect(mockSubmitLimit).not.toHaveBeenCalled();
  });

  it('weather refuses to post when WEATHER_EMPTY_BOOK_MAX_ENTRY_PRICE < tick floor', async () => {
    // Sub-tick empty-book cap: resolveMakerPrice's tick floor would lift the price
    // back to 0.01, above the 0.005 cap, and the WEATHER_MAX_ENTRY_PRICE guard
    // (set higher here) would let it through. The empty-book defense-in-depth guard
    // must refuse to post rather than silently overpay.
    mockConfig.WEATHER_MAX_ENTRY_PRICE = 0.65;
    mockConfig.WEATHER_EMPTY_BOOK_MAX_ENTRY_PRICE = 0.005;
    mockConfig.WEATHER_MAKER_POST_ONLY = false;
    const redis = makeRedis();
    const result = await executeSignal(
      makeSignal({
        source: 'weather',
        consensusProbability: 0.10,
        edgeMagnitude: 0.30,
        direction: 'NO',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(result.skipped).toBe(true);
    expect(mockSubmitLimit).not.toHaveBeenCalled();
  });

  it('non-weather source does not apply the weather entry-price cap', async () => {
    // near-zero-arb with same high-conviction setup should NOT be clamped to 0.65.
    mockConfig.WEATHER_MAX_ENTRY_PRICE = 0.65;
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'near-zero-arb',
        consensusProbability: 0.10,
        edgeMagnitude: 0.50,
        direction: 'NO',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    const call = mockSubmitLimit.mock.calls[0]![0];
    // Without weather cap: fairValue = 0.90, price ≈ 0.885
    expect(call.price).toBeGreaterThan(0.80);
  });

  it('non-weather source does not apply the weather discount', async () => {
    // near-zero-arb on the ghost book should NOT be discounted by
    // WEATHER_MAKER_DISCOUNT_BPS. Only weather source gets the knob applied.
    mockConfig.WEATHER_MAKER_DISCOUNT_BPS = 5000; // extreme — would be obvious if applied
    const redis = makeRedis();
    await executeSignal(
      makeSignal({
        source: 'near-zero-arb',
        consensusProbability: 0.95,
        edgeMagnitude: 0.50,
        direction: 'YES',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    const call = mockSubmitLimit.mock.calls[0]![0];
    // Without discount: fairValue = min(0.95, 0.99 - 0.01) = 0.95; price = 0.95 - 0.015 = 0.935
    expect(call.price).toBeGreaterThan(0.90);
    mockConfig.WEATHER_MAKER_DISCOUNT_BPS = 500;
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

  it('blocks sports signal on ghost book when SPORTS_REQUIRE_REAL_BOOK=true', async () => {
    // Ghost book + sports + SPORTS_REQUIRE_REAL_BOOK=true → no_clob_book skip.
    // The bot should not enter a position it can only exit at resolution.
    mockConfig.SPORTS_REQUIRE_REAL_BOOK = true;
    const redis = makeRedis();
    const result = await executeSignal(
      makeSignal({ source: 'sports', consensusProbability: 0.595, direction: 'YES' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('no_clob_book');
    expect(mockSubmitLimit).not.toHaveBeenCalled();
  });

  it('blocks sports signal on ghost book even when MAX_ENTRY_SPREAD_BPS=0 (spread gating off)', async () => {
    // Regression guard: needsBookCheck includes sports when SPORTS_REQUIRE_REAL_BOOK=true,
    // so setting MAX_ENTRY_SPREAD_BPS=0 cannot bypass the ghost-book gate.
    mockConfig.SPORTS_REQUIRE_REAL_BOOK = true;
    mockConfig.MAX_ENTRY_SPREAD_BPS = 0;
    const redis = makeRedis();
    const result = await executeSignal(
      makeSignal({ source: 'sports', consensusProbability: 0.595, direction: 'YES' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('no_clob_book');
    expect(mockSubmitLimit).not.toHaveBeenCalled();
  });

  it('blocks sports signal when book fetch fails (getClobOrderBook returns null)', async () => {
    // fetchBookAndBenchmark returns {} when the CLOB call fails, leaving
    // decisionBestBid/Ask as undefined — neither emptyBook nor oneSidedBook
    // detects this. The sports-specific check blocks on !isFinite(bid|ask).
    mockConfig.SPORTS_REQUIRE_REAL_BOOK = true;
    mockGetOrderBook.mockResolvedValue(null); // simulate fetch failure
    const redis = makeRedis();
    const result = await executeSignal(
      makeSignal({ source: 'sports', consensusProbability: 0.65, direction: 'YES' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('no_clob_book');
    expect(mockSubmitLimit).not.toHaveBeenCalled();
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

    // The weather-specific empty-book path still uses the weather branch, not
    // the oracle-lag override. In legacy mode (conviction discount off) the
    // WEATHER_MAX_SIGNAL_PRICE_DRIFT=0.08 quote-relative cap binds: outcomePrice 0.50
    // + 0.08 = 0.58, minus the 150bps (1.5%) empty-book edge ≈ 0.565 → 0.56.
    expect(mockSubmitLimit).toHaveBeenCalledWith(expect.objectContaining({ price: 0.56 }));
  });

  it('near-zero-arb empty-book GTC fills immediately (taker) — no persist-and-poll', async () => {
    // Non-post-only GTC for sources that allow taker fallback in empty-book
    // mode (near-zero-arb, etc.). If real liquidity exists in the matching
    // engine, the order fills as a taker in the same cycle. Weather was the
    // canonical case here until WEATHER_MAKER_POST_ONLY shipped — it's now
    // strictly post-only and covered by the dedicated post-only tests.
    mockSubmitLimit.mockResolvedValueOnce({
      success: true,
      order_id: 'order-nz-taker',
      shares_bought: 5.88,
    });
    const redis = makeRedis();
    const result = await executeSignal(
      makeSignal({
        source: 'near-zero-arb',
        consensusProbability: 0.08,
        edgeMagnitude: 0.50,
        consensusStddev: 0.05,
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
      expect.any(String),
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

  it('weather: HOLDS an expired unfilled pending order (preserves CLOB queue priority — no cancel, no re-post)', async () => {
    // Queue-priority fix: a weather maker past expiresAt is held resting (the
    // CLOB order is untouched, keeping its time priority) rather than
    // cancelled+reposted. Covers BOTH expiry-cancel sites — the pre-cycle
    // cleanup AND the resume path — since a cancel at either would surface here.
    mockGetPendingOrder.mockResolvedValue({
      orderId: 'order-wx',
      tokenId: 'tok-yes',
      price: 0.50,
      size: 10,
      postedAt: Date.now() - 7_200_000,
      expiresAt: Date.now() - 3_600_000, // expired 1h ago
      consensusP: 0.65,
      direction: 'YES',
      source: 'weather',
    });
    mockGetOrder.mockResolvedValue({
      id: 'order-wx', status: 'open', owner: '0x1', maker_address: '0x1',
      market: 'mkt-test', asset_id: 'tok-yes', side: 'BUY',
      original_size: '10', size_matched: '0', price: '0.50',
      associate_trades: [], outcome: 'YES', created_at: Date.now() - 7_200_000,
      expiration: '', order_type: 'GTC',
    });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'weather' }), redis as any);

    expect(result.entryExecutionPath).toBe('maker_pending');
    expect(mockCancelOrder).not.toHaveBeenCalled(); // never churned on time
    expect(mockSubmitLimit).not.toHaveBeenCalled();  // not re-posted
    expect(redis.set).not.toHaveBeenCalled();        // idempotency unset — resumes next cycle
  });

  it('weather: clears the stale key and re-posts when CLOB reports the resting order CANCELLED (external/manual cancel)', async () => {
    // Root-cause fix: a manually/externally cancelled weather maker leaves its
    // maker:open key behind. Nothing else reconciles an external cancel (the
    // revalidation rules only delete on THEIR triggers; the reconciler only
    // clears after linking a real fill), so the key would otherwise strand
    // re-entry until its TTL — the scanner re-emits, lands in this resume poll
    // every cycle, and returns maker_not_filled forever. When the poll sees the
    // order CANCELLED with zero fill, clear the key and fall through to re-post.
    mockConfig.WEATHER_MAX_ENTRY_PRICE = 0.6;
    mockGetPendingOrder.mockResolvedValue({
      orderId: 'order-wx-cxl', tokenId: 'tok-yes', price: 0.49, size: 10,
      postedAt: Date.now() - 3_600_000, expiresAt: Date.now() + 600_000,
      consensusP: 0.7, direction: 'YES', source: 'weather',
    });
    // First poll (resume) → the cancelled order; later polls → the fresh re-post.
    mockGetOrder
      .mockResolvedValueOnce({
        id: 'order-wx-cxl', status: 'canceled', owner: '0x1', maker_address: '0x1',
        market: 'mkt-test', asset_id: 'tok-yes', side: 'BUY',
        original_size: '10', size_matched: '0', price: '0.49',
        associate_trades: [], outcome: 'YES', created_at: Date.now() - 3_600_000,
        expiration: '', order_type: 'GTC',
      })
      .mockResolvedValue({
        id: 'order-wx-new', status: 'open', owner: '0x1', maker_address: '0x1',
        market: 'mkt-test', asset_id: 'tok-yes', side: 'BUY',
        original_size: '10', size_matched: '0', price: '0.49',
        associate_trades: [], outcome: 'YES', created_at: Date.now(),
        expiration: '', order_type: 'GTC',
      });
    mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'order-wx-new' });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeSignal(makeSignal({ source: 'weather' }), redis as any);

    // The stale key for the cancelled order is cleared (re-entry unblocked)…
    expect(mockDeletePendingOrder).toHaveBeenCalledWith(redis, 'mkt-test', 'YES');
    // …and a fresh order is posted instead of holding the cancelled one.
    expect(mockSubmitLimit).toHaveBeenCalled();

    mockConfig.WEATHER_MAX_ENTRY_PRICE = 0;
  });

  it('weather: leaves the key and does NOT re-post when the resting order is GONE from CLOB (possible unattributed fill)', async () => {
    // Contrast: a null getClobOrder (order vanished without a CANCELLED status)
    // may be an async fill the reconciler still needs the key's metadata to
    // link — so the key is preserved and we report pending, unchanged.
    mockGetPendingOrder.mockResolvedValue({
      orderId: 'order-wx-gone', tokenId: 'tok-yes', price: 0.49, size: 10,
      postedAt: Date.now() - 3_600_000, expiresAt: Date.now() + 600_000,
      consensusP: 0.7, direction: 'YES', source: 'weather',
    });
    mockGetOrder.mockResolvedValue(null); // gone from CLOB

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'weather' }), redis as any);

    expect(result.entryExecutionPath).toBe('maker_pending'); // reported pending, held
    expect(mockDeletePendingOrder).not.toHaveBeenCalled();   // key preserved for reconciler
    expect(mockSubmitLimit).not.toHaveBeenCalled();          // not re-posted
  });

  it('non-weather (oracle-lag): still cancels an expired unfilled pending order (queue-hold is weather-only)', async () => {
    // Regression guard: the hold is scoped to weather. Short-lived sources keep
    // the expiry cancel (+ re-post) — they should not rest stale.
    mockGetPendingOrder.mockResolvedValue({
      orderId: 'order-ol',
      tokenId: 'tok-yes',
      price: 0.50,
      size: 10,
      postedAt: Date.now() - 7_200_000,
      expiresAt: Date.now() - 3_600_000, // expired
      consensusP: 0.55,
      direction: 'UP',
      source: 'oracle-lag',
    });
    mockGetOrder.mockResolvedValue({
      id: 'order-ol', status: 'open', owner: '0x1', maker_address: '0x1',
      market: 'mkt-test', asset_id: 'tok-yes', side: 'BUY',
      original_size: '10', size_matched: '0', price: '0.50',
      associate_trades: [], outcome: 'UP', created_at: Date.now() - 7_200_000,
      expiration: '', order_type: 'GTC',
    });
    mockCancelOrder.mockResolvedValue(true);

    const redis = makeRedis();
    await executeSignal(
      makeSignal({ source: 'oracle-lag', direction: 'UP', consensusProbability: 0.55 }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(mockCancelOrder).toHaveBeenCalled(); // expired non-weather → cancelled
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
    expect(!result.skipped && !result.error).toBe(true);
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
    expect(!result.skipped && !result.error).toBe(true);
    // Residual open size should be cancelled
    expect(mockCancelOrder).toHaveBeenCalledWith('order-partial');
    // Pending record cleaned up
    expect(mockDeletePendingOrder).toHaveBeenCalled();
    // Idempotency key set (partial fill counts as a real fill)
    expect(redis.set).toHaveBeenCalled();
  });

  it('weather: an EXPIRED order that partially filled still records the fill (held branch handles fills, not just holds)', async () => {
    // The hold for weather takes the poll branch regardless of expiresAt, so a
    // fill that landed on a now-expired weather order must still be detected and
    // recorded — the residual cancelled, the fill booked, idempotency set — not
    // silently held forever.
    mockGetPendingOrder.mockResolvedValue({
      orderId: 'order-wx-partial',
      tokenId: 'tok-yes',
      price: 0.50,
      size: 10,
      postedAt: Date.now() - 7_200_000,
      expiresAt: Date.now() - 3_600_000, // expired 1h ago
      consensusP: 0.65,
      direction: 'YES',
      source: 'weather',
    });
    mockGetOrder.mockResolvedValue({
      id: 'order-wx-partial', status: 'open', owner: '0x1', maker_address: '0x1',
      market: 'mkt-test', asset_id: 'tok-yes', side: 'BUY',
      original_size: '10', size_matched: '4', price: '0.50', // partial fill
      associate_trades: [], outcome: 'YES', created_at: Date.now() - 7_200_000,
      expiration: '', order_type: 'GTC',
    });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'weather' }), redis as any);

    expect(!result.skipped && !result.error).toBe(true);
    expect(mockCancelOrder).toHaveBeenCalledWith('order-wx-partial'); // residual cancelled
    expect(mockDeletePendingOrder).toHaveBeenCalled();
    expect(mockSubmitLimit).not.toHaveBeenCalled();                   // no re-post
    expect(redis.set).toHaveBeenCalled();                             // fill recorded (idempotency)
  });

  it('prices a resumed fill at the trade VWAP, not the posted limit price', async () => {
    // GTC posted at 0.63 crossed the book at post time and actually filled at
    // 0.55 — the recorded stake and entryPrice must reflect the actual cost.
    mockGetPendingOrder.mockResolvedValue({
      orderId: 'order-vwap',
      tokenId: 'tok-yes',
      price: 0.63,
      size: 7.94,
      postedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 600_000,
      consensusP: 0.65,
      direction: 'YES',
    });
    mockGetOrder.mockResolvedValue({
      id: 'order-vwap',
      status: 'filled',
      owner: '0x1',
      maker_address: '0x1',
      // Distinct from the signal's conditionId ('cond-test') to assert the
      // trades query is scoped by the ORDER's market field.
      market: 'cond-from-order',
      asset_id: 'tok-yes',
      side: 'BUY',
      original_size: '7.94',
      size_matched: '7.94',
      price: '0.63',
      associate_trades: ['trade-1'],
      outcome: 'YES',
      created_at: Date.now() - 60_000,
      expiration: '',
      order_type: 'GTC',
    });
    mockResolveFillPrice.mockResolvedValue(0.55);

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'oracle-lag' }), redis as any);

    expect(result.skipped).toBe(false);
    // Scoped by the ORDER's condition id (OpenOrder.market) and asset_id —
    // both authoritative from the fetched order, not the stored blob/signal.
    expect(mockResolveFillPrice).toHaveBeenCalledWith(
      'order-vwap', 'cond-from-order', 'tok-yes', 7.94, 0.63,
    );
    // entryPrice = actual VWAP, NOT the posted 0.63
    expect(result.entryPrice).toBe(0.55);
    // stake = matched × VWAP (7.94 × 0.55 = 4.367), NOT matched × posted (5.0022)
    expect(result.signal.stakeUsd).toBeCloseTo(7.94 * 0.55, 6);
  });

  it('records the posted price when the resolver falls back (VWAP unattributable)', async () => {
    mockGetPendingOrder.mockResolvedValue({
      orderId: 'order-noattr',
      tokenId: 'tok-yes',
      price: 0.63,
      size: 7.94,
      postedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 600_000,
      consensusP: 0.65,
      direction: 'YES',
    });
    mockGetOrder.mockResolvedValue({
      id: 'order-noattr',
      status: 'filled',
      owner: '0x1',
      maker_address: '0x1',
      market: 'cond-test',
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
    // Default passthrough mock returns the posted price — the resolver's
    // contract when fills can't be attributed (it never throws).

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'oracle-lag' }), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.entryPrice).toBe(0.63);
    expect(result.signal.stakeUsd).toBeCloseTo(7.94 * 0.63, 6);
  });

  it('uses the order asset_id (not the stored blob tokenId) for fill-price resolution', async () => {
    // A stale/corrupt blob tokenId must not drive the cross-asset price flip —
    // the freshly fetched order's asset_id is authoritative.
    mockGetPendingOrder.mockResolvedValue({
      orderId: 'order-asset',
      tokenId: 'tok-stale-blob',
      price: 0.63,
      size: 7.94,
      postedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 600_000,
      consensusP: 0.65,
      direction: 'YES',
    });
    mockGetOrder.mockResolvedValue({
      id: 'order-asset',
      status: 'filled',
      owner: '0x1',
      maker_address: '0x1',
      market: 'cond-test',
      asset_id: 'tok-yes-authoritative',
      side: 'BUY',
      original_size: '7.94',
      size_matched: '7.94',
      price: '0.63',
      associate_trades: ['trade-1'],
      outcome: 'YES',
      created_at: Date.now() - 60_000,
      expiration: '',
      order_type: 'GTC',
    });

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeSignal(makeSignal({ source: 'oracle-lag' }), redis as any);

    expect(mockResolveFillPrice).toHaveBeenCalledWith(
      'order-asset', 'cond-test', 'tok-yes-authoritative', 7.94, 0.63,
    );
  });

  it('re-reads the matched size after cancelling a partial-fill residual', async () => {
    // Fills can land between the initial order read and the cancel confirming.
    // The recorded shares/stake must use the FINAL matched size, and a residual
    // that finished filling during the cancel is reported as a full fill.
    mockGetPendingOrder.mockResolvedValue({
      orderId: 'order-race',
      tokenId: 'tok-yes',
      price: 0.63,
      size: 7.94,
      postedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 600_000,
      consensusP: 0.65,
      direction: 'YES',
    });
    const baseOrder = {
      id: 'order-race',
      status: 'open',
      owner: '0x1',
      maker_address: '0x1',
      market: 'cond-test',
      asset_id: 'tok-yes',
      side: 'BUY',
      original_size: '7.94',
      price: '0.63',
      associate_trades: [],
      outcome: 'YES',
      created_at: Date.now() - 60_000,
      expiration: '',
      order_type: 'GTC',
    };
    mockGetOrder
      .mockResolvedValueOnce({ ...baseOrder, size_matched: '3.97' }) // initial read: partial
      .mockResolvedValueOnce({ ...baseOrder, status: 'filled', size_matched: '7.94' }); // post-cancel re-read

    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal({ source: 'oracle-lag' }), redis as any);

    expect(result.skipped).toBe(false);
    expect(mockCancelOrder).toHaveBeenCalledWith('order-race');
    // Final matched size (7.94) recorded, not the stale pre-cancel 3.97
    expect(result.sharesFilled).toBeCloseTo(7.94, 6);
    expect(result.signal.stakeUsd).toBeCloseTo(7.94 * 0.63, 6);
    // Residual finished during cancel → full fill, not partial
    expect(result.entryExecutionPath).toBe('maker_fill');
    expect(mockResolveFillPrice).toHaveBeenCalledWith(
      'order-race', 'cond-test', 'tok-yes', 7.94, 0.63,
    );
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

  describe('entry price cap (per-source override + global fallback)', () => {
    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockConfig as any).MAX_ENTRY_PRICE = 0.55;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockConfig as any).FV_MAX_ENTRY_PRICE = 0.98;
    });

    afterEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (mockConfig as any).MAX_ENTRY_PRICE;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (mockConfig as any).FV_MAX_ENTRY_PRICE;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockConfig as any).WEATHER_MAX_ENTRY_PRICE = 0; // restore to top-level mockConfig default
      // Restore keys mutated by fv-scanner edge-at-fill tests
      mockConfig.EXECUTION_MODE = 'taker';
      mockConfig.MAKER_MAX_WAIT_MS = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (mockConfig as any).FV_REAL_BOOK_DISCOUNT_BPS;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (mockConfig as any).FV_YES_MIN_EDGE;
    });

    it('skips a non-futures signal when outcomePrice exceeds the global cap', async () => {
      const redis = makeRedis();
      const result = await executeSignal(
        makeSignal({ outcomePrice: 0.60 }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        redis as any,
      );
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('entry_price_above_cap');
    });

    it('does not skip when outcomePrice is at the global cap', async () => {
      const redis = makeRedis();
      const result = await executeSignal(
        makeSignal({ outcomePrice: 0.55 }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        redis as any,
      );
      expect(result.skipReason).not.toBe('entry_price_above_cap');
    });

    it('does not gate futures signals regardless of outcomePrice', async () => {
      const redis = makeRedis();
      try {
        const result = await executeSignal(
          makeSignal({ isFutures: true, outcomePrice: 0.99, marketId: 'BTC' }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          redis as any,
        );
        expect(result.skipReason).not.toBe('entry_price_above_cap');
      } catch (err) {
        // HL client throws in test env — confirm the cap gate was not the cause
        expect((err as Error).message).not.toContain('entry_price_above_cap');
      }
    });

    it('is inactive when MAX_ENTRY_PRICE is 0', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockConfig as any).MAX_ENTRY_PRICE = 0;
      const redis = makeRedis();
      const result = await executeSignal(
        makeSignal({ outcomePrice: 0.99 }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        redis as any,
      );
      expect(result.skipReason).not.toBe('entry_price_above_cap');
    });

    it('fv-scanner uses FV_MAX_ENTRY_PRICE instead of global cap', async () => {
      // global cap = 0.55, fv cap = 0.98 — price of 0.90 must pass
      const redis = makeRedis();
      const result = await executeSignal(
        makeSignal({ source: 'fv-scanner', outcomePrice: 0.90 }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        redis as any,
      );
      expect(result.skipReason).not.toBe('entry_price_above_cap');
    });

    it('fv-scanner is still blocked when outcomePrice exceeds FV_MAX_ENTRY_PRICE', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockConfig as any).FV_MAX_ENTRY_PRICE = 0.95;
      const redis = makeRedis();
      const result = await executeSignal(
        makeSignal({ source: 'fv-scanner', outcomePrice: 0.97 }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        redis as any,
      );
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('entry_price_above_cap');
    });

    it('fv-scanner: blocks when CLOB ask has repriced above pModel − minEdge', async () => {
      // Gamma mid at scan time was 0.505, but CLOB bestAsk is now 0.90.
      // raw fill = 0.90 * (1 − 200bps) = 0.882 → tick-rounded down to 0.88;
      // edge at fill = 0.90 − 0.88 = 0.02 < 0.10 → reject
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockConfig as any).EXECUTION_MODE = 'maker';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockConfig as any).MAKER_MAX_WAIT_MS = 10;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockConfig as any).FV_REAL_BOOK_DISCOUNT_BPS = 200;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockConfig as any).FV_YES_MIN_EDGE = 0.10;
      mockGetOrderBook.mockResolvedValue({
        market: 'mkt-test',
        asset_id: 'tok-yes',
        timestamp: new Date().toISOString(),
        bids: [{ price: '0.88', size: '100' }],
        asks: [{ price: '0.90', size: '100' }],
        min_order_size: '1',
        tick_size: '0.01',
        neg_risk: false,
        last_trade_price: '0.89',
        hash: 'hash',
      });
      const redis = makeRedis();
      const result = await executeSignal(
        makeSignal({
          source: 'fv-scanner',
          outcomePrice: 0.505, // stale Gamma mid
          consensusProbability: 0.90,
          direction: 'YES',
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        redis as any,
      );
      expect(result.skipped).toBe(true);
      // skipReason is the raw compound string; normalizeSkipReason splits it into
      // enum='liquidity_gate' + detail='fv_edge_killed_by_slippage' for DB storage
      expect(result.skipReason).toBe('liquidity_gate:fv_edge_killed_by_slippage');
    });

    it('fv-scanner: allows entry when CLOB ask is low enough to preserve edge', async () => {
      // bestAsk=0.78; raw fill = 0.78 * 0.98 = 0.7644 → tick-rounded down to 0.76;
      // edge at fill = 0.90 − 0.76 = 0.14 ≥ 0.10 → proceed
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockConfig as any).EXECUTION_MODE = 'maker';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockConfig as any).MAKER_MAX_WAIT_MS = 10;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockConfig as any).FV_REAL_BOOK_DISCOUNT_BPS = 200;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockConfig as any).FV_YES_MIN_EDGE = 0.10;
      mockGetOrderBook.mockResolvedValue({
        market: 'mkt-test',
        asset_id: 'tok-yes',
        timestamp: new Date().toISOString(),
        bids: [{ price: '0.76', size: '100' }],
        asks: [{ price: '0.78', size: '100' }],
        min_order_size: '1',
        tick_size: '0.01',
        neg_risk: false,
        last_trade_price: '0.77',
        hash: 'hash',
      });
      mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'order-fv-1' });
      mockGetOrder.mockResolvedValue({
        id: 'order-fv-1',
        status: 'filled',
        owner: '0x1',
        maker_address: '0x1',
        market: 'mkt-test',
        asset_id: 'tok-yes',
        side: 'BUY',
        original_size: '6',
        size_matched: '6',
        price: '0.7644',
        associate_trades: [],
        outcome: 'YES',
        created_at: Date.now(),
        expiration: '',
        order_type: 'GTC',
      });
      const redis = makeRedis();
      const result = await executeSignal(
        makeSignal({
          source: 'fv-scanner',
          outcomePrice: 0.505,
          consensusProbability: 0.90,
          direction: 'YES',
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        redis as any,
      );
      expect(result.skipped).toBe(false);
      expect(result.skipReason).not.toBe('liquidity_gate:fv_edge_killed_by_slippage');
    });

    it('weather uses WEATHER_MAX_ENTRY_PRICE instead of global cap', async () => {
      // global cap = 0.55, weather cap = 0.65 (set in beforeEach) — price of 0.62 must pass
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockConfig as any).WEATHER_MAX_ENTRY_PRICE = 0.65;
      const redis = makeRedis();
      const result = await executeSignal(
        makeSignal({ source: 'weather', outcomePrice: 0.62 }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        redis as any,
      );
      expect(result.skipReason).not.toBe('entry_price_above_cap');
    });
  });
});

describe('weather rest-above-cap (caps as clamps, not eligibility filters)', () => {
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

  function makeRealBook() {
    return {
      market: 'mkt-test',
      asset_id: 'tok-yes',
      timestamp: new Date().toISOString(),
      bids: [{ price: '0.68', size: '100' }],
      asks: [{ price: '0.72', size: '100' }],
      min_order_size: '1',
      tick_size: '0.01',
      neg_risk: false,
      last_trade_price: '0.70',
      hash: 'hash',
    };
  }

  // Pre-resolution-day weather entry whose market price (0.80) is above the
  // effective cap min(EARLY=0.55, MAX=0.75) = 0.55.
  function makeOutOfRangeSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
    return makeSignal({
      source: 'weather',
      direction: 'YES',
      outcomePrice: 0.80,
      consensusProbability: 0.90,
      edgeMagnitude: 0.25,
      consensusStddev: 0.01,
      _isResolutionDay: false,
      ...overrides,
    });
  }

  beforeEach(() => {
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
    mockSumRestAboveCap.mockReset();

    mockRecordExecutionMetric.mockResolvedValue(undefined);
    mockRecordExecutionTiming.mockResolvedValue(undefined);
    mockRecordExecutionEvent.mockResolvedValue(undefined);
    mockGetCalibrationStats.mockResolvedValue(null);
    mockGetPendingOrder.mockResolvedValue(null);
    mockSetPendingOrder.mockResolvedValue(undefined);
    mockDeletePendingOrder.mockResolvedValue(undefined);
    mockSumRestAboveCap.mockResolvedValue(0);

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
    // Spread guardrail ON so the ghost-book check runs (needsBookCheck gate);
    // ghost books bypass spreadTooWide via the emptyBook branch.
    mockConfig.MAX_ENTRY_SPREAD_BPS = 500;
    mockConfig.WEATHER_MAKER_POST_ONLY = true;
    mockConfig.WEATHER_MAKER_DISCOUNT_BPS = 0;
    mockConfig.WEATHER_MAX_ENTRY_PRICE = 0.75;
    mockConfig.WEATHER_EMPTY_BOOK_DISCOUNT_BPS = 2000;
    mockConfig.WEATHER_EMPTY_BOOK_MAX_ENTRY_PRICE = 0;
    mockConfig.WEATHER_MAX_SIGNAL_PRICE_DRIFT = 0;
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (mockConfig as any).WEATHER_EARLY_ENTRY_MAX_PRICE = 0.55;
    (mockConfig as any).WEATHER_REST_ABOVE_CAP_ENABLED = true;
    (mockConfig as any).WEATHER_REST_ABOVE_CAP_MAX_NOTIONAL_USD = 100;
    (mockConfig as any).WEATHER_REAL_BOOK_DISCOUNT_BPS = 0;
    /* eslint-enable @typescript-eslint/no-explicit-any */

    mockGetOrderBook.mockResolvedValue(makeGhostBook());
    mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'order-rac' });
    mockGetOrder.mockResolvedValue(null);
    mockCancelOrder.mockResolvedValue(true);
    mockHasPosition.mockResolvedValue(false);
  });

  afterEach(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    delete (mockConfig as any).WEATHER_EARLY_ENTRY_MAX_PRICE;
    delete (mockConfig as any).WEATHER_REST_ABOVE_CAP_ENABLED;
    delete (mockConfig as any).WEATHER_REST_ABOVE_CAP_MAX_NOTIONAL_USD;
    delete (mockConfig as any).WEATHER_REAL_BOOK_DISCOUNT_BPS;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    mockConfig.EXECUTION_MODE = 'taker';
    mockConfig.WEATHER_MAX_ENTRY_PRICE = 0;
    mockConfig.WEATHER_EMPTY_BOOK_DISCOUNT_BPS = 0;
    mockConfig.WEATHER_MAKER_DISCOUNT_BPS = 500;
    mockConfig.WEATHER_MAX_SIGNAL_PRICE_DRIFT = 0.08;
    mockConfig.MAX_ENTRY_SPREAD_BPS = 0;
  });

  it('legacy: skips out-of-range weather entry when the knob is OFF', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockConfig as any).WEATHER_REST_ABOVE_CAP_ENABLED = false;
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeOutOfRangeSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('entry_price_above_cap');
    expect(mockSubmitLimit).not.toHaveBeenCalled();
  });

  it('knob ON: out-of-range empty-book entry posts a resting maker clamped below the cap', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeOutOfRangeSignal(), redis as any);

    // Not skipped at the price gate — posted as a resting GTC instead.
    expect(result.skipReason).not.toBe('entry_price_above_cap');
    expect(result.entryExecutionPath).toBe('maker_pending');
    expect(mockSubmitLimit).toHaveBeenCalledOnce();
    // FV 0.90 × (1 − 20%) = 0.72 → ceiling'd to EARLY cap 0.55 → minus 150bps
    // empty-book edge = 0.535 → tick-rounded down to 0.53. Never above the cap.
    const submitted = mockSubmitLimit.mock.calls[0]![0] as { price: number };
    expect(submitted.price).toBeLessThanOrEqual(0.55);
    expect(submitted.price).toBeCloseTo(0.53, 5);
    // Cohort tag persisted on the pending blob for the pool gate + analysis.
    expect(mockSetPendingOrder).toHaveBeenCalledWith(
      expect.anything(),
      'mkt-test',
      'YES',
      expect.objectContaining({ restAboveCap: true }),
      expect.any(Number),
    );
  });

  it('knob ON: size-up sanctioned signals above cap keep the legacy skip', async () => {
    const redis = makeRedis();
    const result = await executeSignal(
      makeOutOfRangeSignal({ sizeUpSanctioned: true }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('entry_price_above_cap');
    expect(mockSubmitLimit).not.toHaveBeenCalled();
  });

  it('knob ON: patient real-book price above cap is CLAMPED to the cap, not rejected', async () => {
    // Real book at 0.68/0.72; patient discount 200bps → raw post 0.7056 → 0.70,
    // which exceeds the pre-res-day cap 0.55 → clamped to 0.55 (legacy behaviour
    // rejected with maker_price_above_cap → entry_price_above_cap skip).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockConfig as any).WEATHER_REAL_BOOK_DISCOUNT_BPS = 200;
    mockConfig.EXECUTION_MODE = 'maker';
    mockConfig.MAX_ENTRY_SPREAD_BPS = 0; // real-book spread (571bps) is not under test
    mockGetOrderBook.mockResolvedValue(makeRealBook());
    const redis = makeRedis();
    const result = await executeSignal(makeOutOfRangeSignal(), redis as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(result.skipReason).not.toBe('entry_price_above_cap');
    expect(mockSubmitLimit).toHaveBeenCalledOnce();
    const submitted = mockSubmitLimit.mock.calls[0]![0] as { price: number };
    expect(submitted.price).toBeCloseTo(0.55, 5);
    expect(mockSetPendingOrder).toHaveBeenCalledWith(
      expect.anything(),
      'mkt-test',
      'YES',
      expect.objectContaining({ restAboveCap: true }),
      expect.any(Number),
    );
  });

  it('plain real-book path (WEATHER_REAL_BOOK_DISCOUNT_BPS=0) clamps the post AND persists the resting order', async () => {
    // With the patient discount disabled, weather real-book makers use the
    // bid-anchored global pricing (isWeatherPatient=false). For _restAboveCap
    // signals that anchor tracks the above-cap market (bid 0.68), so without
    // path-independent clamping the order would post unclamped above 0.55 —
    // and without the _restAboveCap persistence arm the accepted order would be
    // cancelled by the generic wait loop instead of resting, never counting
    // toward the sumRestAboveCapNotional pool.
    // WEATHER_REAL_BOOK_DISCOUNT_BPS is already 0 in this describe's beforeEach.
    mockConfig.EXECUTION_MODE = 'maker';
    mockConfig.MAX_ENTRY_SPREAD_BPS = 0;
    mockGetOrderBook.mockResolvedValue(makeRealBook());
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeOutOfRangeSignal(), redis as any);

    expect(mockSubmitLimit).toHaveBeenCalledOnce();
    const submitted = mockSubmitLimit.mock.calls[0]![0] as { price: number };
    expect(submitted.price).toBeLessThanOrEqual(0.55);
    expect(mockSubmitClob).not.toHaveBeenCalled(); // and never a taker buy
    // The accepted order RESTS (pending lifecycle), tagged for the pool gate.
    expect(result.entryExecutionPath).toBe('maker_pending');
    expect(mockCancelOrder).not.toHaveBeenCalled(); // not cancelled by the wait loop
    expect(mockSetPendingOrder).toHaveBeenCalledWith(
      expect.anything(),
      'mkt-test',
      'YES',
      expect.objectContaining({ restAboveCap: true }),
      expect.any(Number),
    );
  });

  it('resumes an existing rest-above-cap order even when the signal is back IN range (no double-post)', async () => {
    // Crossing case: a rest-above-cap GTC posted on a prior scan still rests;
    // the market then drops below the cap, so the re-emitted signal carries no
    // _restAboveCap flag — and with WEATHER_REAL_BOOK_DISCOUNT_BPS=0 neither
    // patient nor empty-book conditions hold. The lifecycle lookup must still
    // find the pending order and resume it instead of posting a duplicate.
    mockConfig.EXECUTION_MODE = 'maker';
    mockConfig.MAX_ENTRY_SPREAD_BPS = 0;
    mockGetOrderBook.mockResolvedValue(makeRealBook());
    mockGetPendingOrder.mockResolvedValue({
      orderId: 'order-resting',
      tokenId: 'tok-yes',
      price: 0.55,
      size: 9,
      postedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 3_600_000,
      consensusP: 0.9,
      direction: 'YES',
      source: 'weather',
      restAboveCap: true,
    });
    mockGetOrder.mockResolvedValue({
      id: 'order-resting',
      status: 'LIVE',
      size_matched: '0',
      original_size: '9',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const redis = makeRedis();
    const result = await executeSignal(
      makeOutOfRangeSignal({ outcomePrice: 0.50 }), // back in range
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(mockSubmitLimit).not.toHaveBeenCalled(); // resumed, no duplicate post
    expect(mockCancelOrder).not.toHaveBeenCalled(); // resting order left alone
    expect(result.entryExecutionPath).toBe('maker_pending');
  });

  it('hybrid mode: rest-above-cap maker failure NEVER falls through to a taker buy', async () => {
    // Real book + hybrid: a non-price-cap maker failure (order rejected at
    // submit) used to fall through to the taker fallback, which would
    // market-buy at the above-cap outcomePrice — the exact adverse entry the
    // cap exists to prevent. The _restAboveCap guard must terminate instead.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockConfig as any).WEATHER_REAL_BOOK_DISCOUNT_BPS = 200;
    mockConfig.EXECUTION_MODE = 'hybrid';
    mockConfig.MAX_ENTRY_SPREAD_BPS = 0;
    mockGetOrderBook.mockResolvedValue(makeRealBook());
    mockSubmitLimit.mockResolvedValue({ success: false, error: 'maker_order_rejected' });
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeOutOfRangeSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('entry_price_above_cap');
    expect(mockSubmitClob).not.toHaveBeenCalled(); // no taker buy
  });

  it('knob OFF: patient real-book price above cap still rejects (legacy guard intact)', async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (mockConfig as any).WEATHER_REST_ABOVE_CAP_ENABLED = false;
    (mockConfig as any).WEATHER_REAL_BOOK_DISCOUNT_BPS = 200;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    mockConfig.EXECUTION_MODE = 'maker';
    mockConfig.MAX_ENTRY_SPREAD_BPS = 0; // real-book spread (571bps) is not under test
    mockGetOrderBook.mockResolvedValue(makeRealBook());
    const redis = makeRedis();
    // In-range at the gate (0.50 ≤ 0.55) but the patient post price (0.70)
    // exceeds the cap → defense-in-depth rejects, no order is placed.
    const result = await executeSignal(
      makeOutOfRangeSignal({ outcomePrice: 0.50 }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('entry_price_above_cap');
    expect(mockSubmitLimit).not.toHaveBeenCalled();
  });

  it('rest-above-cap pool full: refuses the post with resting_notional_cap (no taker fallback)', async () => {
    mockSumRestAboveCap.mockResolvedValue(96); // 96 + ~5 notional > 100 cap
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeOutOfRangeSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('resting_notional_cap');
    expect(mockSubmitLimit).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('pool cap unset (0) fails closed: no rest-above-cap post is placed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockConfig as any).WEATHER_REST_ABOVE_CAP_MAX_NOTIONAL_USD = 0;
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeOutOfRangeSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('resting_notional_cap');
    expect(mockSumRestAboveCap).not.toHaveBeenCalled();
    expect(mockSubmitLimit).not.toHaveBeenCalled();
  });

  it('in-range weather entries are never gated by the pool cap and carry no cohort tag', async () => {
    const redis = makeRedis();
    const result = await executeSignal(
      makeOutOfRangeSignal({ outcomePrice: 0.50 }), // ≤ 0.55 → in-range
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(result.skipReason).not.toBe('resting_notional_cap');
    expect(mockSumRestAboveCap).not.toHaveBeenCalled();
    expect(mockSubmitLimit).toHaveBeenCalledOnce();
    const pendingBlob = mockSetPendingOrder.mock.calls[0]![3] as { restAboveCap?: boolean };
    expect(pendingBlob.restAboveCap).toBeUndefined();
  });

  it('bracket-opposite legs persist isBracketOpposite on the pending blob', async () => {
    const redis = makeRedis();
    const result = await executeSignal(
      makeOutOfRangeSignal({
        direction: 'NO',
        consensusProbability: 0.10, // NO side fair value 0.90
        outcomePrice: 0.85,
        _isBracketOpposite: true,
        _bracketTargetShares: 10,
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(result.skipReason).not.toBe('entry_price_above_cap');
    expect(mockSetPendingOrder).toHaveBeenCalledWith(
      expect.anything(),
      'mkt-test',
      'NO',
      expect.objectContaining({ isBracketOpposite: true }),
      expect.any(Number),
    );
  });
});

describe('weather conviction taker entry', () => {
  // A wide real book (bid 0.30 / ask 0.62) that would normally be skipped with
  // spread_too_wide (~6957 bps ≫ 500). The taker crosses to the ask, so spread is
  // irrelevant. min_order_size 1 keeps a $5 stake above the floor.
  function wideRealBook(askPrice = '0.62', bidPrice = '0.30') {
    return {
      market: 'mkt-test',
      asset_id: 'tok-yes',
      timestamp: new Date().toISOString(),
      bids: [{ price: bidPrice, size: '500' }],
      asks: [{ price: askPrice, size: '500' }],
      min_order_size: '1',
      tick_size: '0.01',
      neg_risk: false,
      last_trade_price: '0.50',
      hash: 'hash',
    };
  }

  function makeTakerRedis() {
    return {
      get: vi.fn<(k: string) => Promise<string | null>>().mockResolvedValue(null),
      set: vi.fn<() => Promise<'OK'>>().mockResolvedValue('OK'),
      incrbyfloat: vi.fn<() => Promise<string>>().mockResolvedValue('5'),
      expire: vi.fn<() => Promise<number>>().mockResolvedValue(1),
    };
  }

  function weatherSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
    return makeSignal({
      source: 'weather',
      direction: 'YES',
      consensusProbability: 0.85, // YES win prob; edge vs ask 0.62 = 0.23 ≥ 0.15
      stakeUsd: 5,
      _isResolutionDay: true, // taker is res-day-only; override to false for pre-res-day cases
      ...overrides,
    });
  }

  beforeEach(() => {
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
    mockHasPosition.mockResolvedValue(false);
    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xclob' });
    mockCancelOrder.mockResolvedValue(true);

    // Maker mode so tryExecuteViaClobMaker runs (taker mode bypasses it for real books).
    mockConfig.EXECUTION_MODE = 'maker';
    mockConfig.MAKER_MAX_WAIT_MS = 10;
    mockConfig.MAKER_POLL_INTERVAL_MS = 1;
    mockConfig.MAX_ENTRY_SPREAD_BPS = 500; // 5% — wide book would normally skip
    mockConfig.WEATHER_MAKER_POST_ONLY = true; // real-book weather is strict-maker by default
    // Production value (300): makes isWeatherPatient true → exercises the path where a
    // taker fill would otherwise be misfiled as a pending maker (regression guard).
    mockConfig.WEATHER_REAL_BOOK_DISCOUNT_BPS = 300;
    mockConfig.WEATHER_TAKER_ENTRY_ENABLED = true;
    mockConfig.WEATHER_TAKER_ENTRY_MIN_EDGE = 0.15;
    mockConfig.WEATHER_TAKER_ENTRY_MAX_PRICE = 0.80;
    mockConfig.WEATHER_TAKER_ENTRY_MAX_DAILY_USD = 25;

    mockGetOrderBook.mockResolvedValue(wideRealBook());
    // Crossing limit fills immediately as a taker — CLOB returns shares_bought/cost/price.
    // shares_bought (8) ≥ size (5/price ≈ 7.1) so isImmediateFullFill fires → inline record.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'taker-1', shares_bought: 8, cost: 4.96, price: 0.62 } as any);
    mockGetOrder.mockResolvedValue({
      id: 'taker-1',
      status: 'filled',
      owner: '0x1',
      maker_address: '0x1',
      market: 'mkt-test',
      asset_id: 'tok-yes',
      side: 'BUY',
      original_size: '8',
      size_matched: '8',
      price: '0.62',
      associate_trades: [],
      outcome: 'YES',
      created_at: Date.now(),
      expiration: '',
      order_type: 'GTC',
    });
  });

  afterEach(() => {
    mockConfig.WEATHER_TAKER_ENTRY_ENABLED = false;
    mockConfig.WEATHER_MAKER_POST_ONLY = true;
    mockConfig.WEATHER_REAL_BOOK_DISCOUNT_BPS = 0;
    mockConfig.EXECUTION_MODE = 'taker';
    mockConfig.MAX_ENTRY_SPREAD_BPS = 0;
  });

  it('crosses to take a wide-spread real-book winner (bypasses spread_too_wide, postOnly:false, edge-capped price)', async () => {
    const redis = makeTakerRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(weatherSignal(), redis as any);

    expect(result.skipReason).not.toBe('spread_too_wide');
    // limit = min(MAX_PRICE 0.80, modelWin 0.85 − MIN_EDGE 0.15 = 0.70) = 0.70,
    // floored at the ask 0.62 → 0.70; postOnly MUST be false to cross.
    expect(mockSubmitLimit).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-yes', price: 0.70, postOnly: false }),
    );
    // Daily circuit breaker reserves the stake.
    expect(redis.incrbyfloat).toHaveBeenCalledWith(
      expect.stringContaining('weather:taker_daily:'),
      5,
    );
  });

  it('records a full taker fill INLINE — not as a pending maker (production WEATHER_REAL_BOOK_DISCOUNT_BPS=300)', async () => {
    // Regression guard: with the discount knob at its production value isWeatherPatient
    // is true, so a confirmed full fill must still be recorded immediately (it spent
    // the USDC) rather than deferred to the next cron resume as 'maker_pending'.
    expect(mockConfig.WEATHER_REAL_BOOK_DISCOUNT_BPS).toBe(300);
    const redis = makeTakerRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(weatherSignal(), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.executionVenue).toBe('clob');
    expect(result.error).toBeFalsy();
    expect(result.entryExecutionPath).toBe('clob_direct');
    expect(result.entryOrderType).toBe('taker');
  });

  it('persists a PARTIAL taker fill as pending — residual tracked for next-cycle resume', async () => {
    // shares_bought (3) < size (≈7.1) → isImmediateFullFill false → setPendingOrder.
    // Regression guard for the `|| weatherTakerGate` arm of the pending-persist
    // condition (so partials are tracked consistently regardless of the discount knob).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'taker-partial', shares_bought: 3, cost: 1.86, price: 0.62 } as any);
    const redis = makeTakerRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(weatherSignal(), redis as any);

    expect(result.entryExecutionPath).toBe('maker_pending');
    expect(mockSetPendingOrder).toHaveBeenCalledWith(
      expect.anything(),
      'mkt-test',
      'YES',
      expect.objectContaining({ orderId: 'taker-partial', price: 0.70 }),
      expect.any(Number),
    );
  });

  function restingPendingOrder(orderId = 'resting-1', price = 0.55) {
    mockGetPendingOrder.mockResolvedValue({
      orderId,
      tokenId: 'tok-yes',
      price,
      size: 9,
      direction: 'YES',
      postedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 600_000,
      consensusP: 0.85,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    mockGetOrder.mockResolvedValue({
      id: orderId,
      status: 'live',
      owner: '0x1',
      maker_address: '0x1',
      market: 'mkt-test',
      asset_id: 'tok-yes',
      side: 'BUY',
      original_size: '9',
      size_matched: '0', // genuinely resting, unfilled
      price: String(price),
      associate_trades: [],
      outcome: 'YES',
      created_at: Date.now(),
      expiration: '',
      order_type: 'GTC',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  it('pre-empts a stranded resting maker on res-day — cancels it and crosses to take', async () => {
    // The ghost-era 0.55 bid won't fill (winner drifted up) and the FV rule keeps it
    // (cheap = value-positive). On res-day with the taker eligible we cancel it and take.
    restingPendingOrder('resting-1', 0.55);
    const redis = makeTakerRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(weatherSignal(), redis as any);

    expect(mockCancelOrder).toHaveBeenCalledWith('resting-1'); // stranded bid cancelled
    expect(mockDeletePendingOrder).toHaveBeenCalled(); // key freed
    expect(mockSubmitLimit).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-yes', price: 0.70, postOnly: false }),
    );
    expect(result.entryExecutionPath).toBe('clob_direct'); // taker took
    expect(result.entryOrderType).toBe('taker');
  });

  it('pre-empts at WEATHER_REAL_BOOK_DISCOUNT_BPS=0 too (pending-check is taker-aware, not discount-gated)', async () => {
    mockConfig.WEATHER_REAL_BOOK_DISCOUNT_BPS = 0; // isWeatherPatient false → only the wantTaker arm fires the pending-check
    restingPendingOrder('resting-0bps', 0.55);
    const redis = makeTakerRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(weatherSignal(), redis as any);

    expect(mockCancelOrder).toHaveBeenCalledWith('resting-0bps');
    expect(mockSubmitLimit).toHaveBeenCalledWith(
      expect.objectContaining({ price: 0.70, postOnly: false }),
    );
    expect(result.entryExecutionPath).toBe('clob_direct');
    expect(result.entryOrderType).toBe('taker');
  });

  it('does NOT pre-empt when the cancel is unconfirmed (no double exposure)', async () => {
    restingPendingOrder('resting-stuck', 0.55);
    mockCancelOrder.mockResolvedValue(false); // cancel never confirms (order stays live)
    const redis = makeTakerRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(weatherSignal(), redis as any);

    expect(mockCancelOrder).toHaveBeenCalledWith('resting-stuck'); // attempted
    expect(mockSubmitLimit).not.toHaveBeenCalled(); // but did NOT take — no duplicate
    expect(redis.incrbyfloat).not.toHaveBeenCalled();
    expect(result.entryExecutionPath).not.toBe('maker_fill'); // no fill recorded
  });

  // A resting CLOB order at a given matched size. mockGetOrder is called twice on the
  // pre-empt path: the pending-check poll, then the post-cancel race re-read.
  function clobOrder(sizeMatched: string, status = 'live') {
    return {
      id: 'resting-raced', status, owner: '0x1', maker_address: '0x1',
      market: 'mkt-test', asset_id: 'tok-yes', side: 'BUY',
      original_size: '9', size_matched: sizeMatched, price: '0.55',
      associate_trades: [], outcome: 'YES', created_at: Date.now(),
      expiration: '', order_type: 'GTC',
    };
  }
  function racedPending() {
    mockGetPendingOrder.mockResolvedValue({
      orderId: 'resting-raced', tokenId: 'tok-yes', price: 0.55, size: 9,
      direction: 'YES', postedAt: Date.now() - 60_000, expiresAt: Date.now() + 600_000,
      consensusP: 0.85,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  it('does NOT take if a fill raced the pre-empt cancel (re-read shows matched > 0)', async () => {
    racedPending();
    mockGetOrder
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(clobOrder('0') as any) // pending-check poll → resting
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(clobOrder('9') as any); // race re-read → it filled
    const redis = makeTakerRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(weatherSignal(), redis as any);

    expect(mockCancelOrder).toHaveBeenCalledWith('resting-raced');
    expect(mockSubmitLimit).not.toHaveBeenCalled(); // no duplicate take
    expect(mockDeletePendingOrder).not.toHaveBeenCalled(); // key left → next scan records the fill
    expect(redis.incrbyfloat).not.toHaveBeenCalled();
    expect(result.entryExecutionPath).not.toBe('maker_fill');
  });

  it('does NOT take if the resting order is unreadable after the pre-empt cancel (null)', async () => {
    racedPending();
    mockGetOrder
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(clobOrder('0') as any) // poll → resting
      .mockResolvedValueOnce(null); // race re-read → gone/unreadable (possibly fully filled)
    const redis = makeTakerRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(weatherSignal(), redis as any);

    expect(mockCancelOrder).toHaveBeenCalledWith('resting-raced');
    expect(mockSubmitLimit).not.toHaveBeenCalled(); // conservative: do not take on unknown state
    expect(mockDeletePendingOrder).not.toHaveBeenCalled();
    expect(result.entryExecutionPath).not.toBe('maker_fill');
  });

  it('does NOT take if the post-cancel matched size is unparseable (NaN → hold, not take)', async () => {
    racedPending();
    mockGetOrder
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(clobOrder('0') as any) // poll → resting
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(clobOrder('') as any); // race re-read → garbage matched size
    const redis = makeTakerRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(weatherSignal(), redis as any);

    expect(mockCancelOrder).toHaveBeenCalledWith('resting-raced');
    expect(mockSubmitLimit).not.toHaveBeenCalled(); // uncertain state → never take
    expect(mockDeletePendingOrder).not.toHaveBeenCalled();
    expect(result.entryExecutionPath).not.toBe('maker_fill');
  });

  it('holds (does NOT pre-empt) a resting order when NOT taker-eligible (ghost book)', async () => {
    mockGetOrderBook.mockResolvedValue(wideRealBook('0.99', '0.01')); // ghost → wantTaker false
    restingPendingOrder('resting-ghost', 0.43);
    const redis = makeTakerRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(weatherSignal(), redis as any);

    expect(result.entryExecutionPath).toBe('maker_pending'); // held for queue priority
    expect(mockCancelOrder).not.toHaveBeenCalled(); // not pre-empted
    expect(mockSubmitLimit).not.toHaveBeenCalled();
    expect(redis.incrbyfloat).not.toHaveBeenCalled();
  });

  it('forced taker weather signal skips on a ghost book instead of falling back to maker', async () => {
    mockGetOrderBook.mockResolvedValue(wideRealBook('0.99', '0.01')); // ghost → no real ask to take
    const redis = makeTakerRedis();
    const result = await executeSignal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      weatherSignal({ _forceTakerEntry: true } as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('no_clob_book');
    expect(mockSubmitLimit).not.toHaveBeenCalled();
    expect(redis.incrbyfloat).not.toHaveBeenCalled();
  });

  it('is res-day-only: does NOT take a pre-resolution-day bracket', async () => {
    const redis = makeTakerRedis();
    const result = await executeSignal(
      weatherSignal({ _isResolutionDay: false }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    // Not taker-eligible pre-res-day → wide book hits the normal spread_too_wide skip.
    expect(result.skipReason).toBe('spread_too_wide');
    expect(mockSubmitLimit).not.toHaveBeenCalled();
    expect(redis.incrbyfloat).not.toHaveBeenCalled();
  });

  it('does NOT take a sanctioned size-up — it stays on the maker path (mid-cap discipline preserved)', async () => {
    const redis = makeTakerRedis();
    const result = await executeSignal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      weatherSignal({ sizeUpSanctioned: true } as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
    );

    // Not taker-eligible → wide book hits the normal spread_too_wide skip; no reserve.
    expect(result.skipReason).toBe('spread_too_wide');
    expect(redis.incrbyfloat).not.toHaveBeenCalled();
    if (mockSubmitLimit.mock.calls.length > 0) {
      const arg = mockSubmitLimit.mock.calls[0][0] as { postOnly?: boolean };
      expect(arg.postOnly).not.toBe(false);
    }
  });

  it('fires even when MAX_ENTRY_SPREAD_BPS=0 (taker flag is independent of the spread guard)', async () => {
    // Regression for the P2 review finding: the taker gate needs the live book, so it
    // must fetch even when the generic spread guard is disabled (0 = off). Without the
    // needsBookCheck fix the book is never read → weatherTakerEligible stays false →
    // silent maker fallback.
    mockConfig.MAX_ENTRY_SPREAD_BPS = 0;
    const redis = makeTakerRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(weatherSignal(), redis as any);

    expect(mockSubmitLimit).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-yes', price: 0.70, postOnly: false }),
    );
    expect(result.entryExecutionPath).toBe('clob_direct');
    expect(result.entryOrderType).toBe('taker');
  });

  it('uses the NO-side ask and NO token when direction is NO', async () => {
    const redis = makeTakerRedis();
    // NO win prob = 1 − 0.10 = 0.90; vs NO-side ask 0.62 → edge 0.28.
    // limit = min(0.80, 0.90 − 0.15 = 0.75) = 0.75, floored at ask 0.62 → 0.75.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeSignal(weatherSignal({ direction: 'NO', consensusProbability: 0.10 }), redis as any);

    expect(mockSubmitLimit).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-no', price: 0.75, postOnly: false }),
    );
  });

  it('does NOT take when disabled — spread_too_wide skip is unchanged (no regression)', async () => {
    mockConfig.WEATHER_TAKER_ENTRY_ENABLED = false;
    const redis = makeTakerRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(weatherSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('spread_too_wide');
    expect(mockSubmitLimit).not.toHaveBeenCalled();
    expect(redis.incrbyfloat).not.toHaveBeenCalled();
  });

  it('does NOT take when model edge is below WEATHER_TAKER_ENTRY_MIN_EDGE', async () => {
    const redis = makeTakerRedis();
    // modelWin 0.70 vs ask 0.62 → edge 0.08 < 0.15 → ineligible → wide book skips.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(weatherSignal({ consensusProbability: 0.70 }), redis as any);

    expect(result.skipReason).toBe('spread_too_wide');
    expect(mockSubmitLimit).not.toHaveBeenCalled();
  });

  it('does NOT take when the ask is above WEATHER_TAKER_ENTRY_MAX_PRICE', async () => {
    mockGetOrderBook.mockResolvedValue(wideRealBook('0.82', '0.50')); // ask 0.82 > 0.80
    const redis = makeTakerRedis();
    // modelWin 0.999, edge vs 0.82 = 0.179 ≥ 0.15, but ask > MAX_PRICE → ineligible.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(weatherSignal({ consensusProbability: 0.999 }), redis as any);

    expect(result.skipReason).toBe('spread_too_wide');
    expect(mockSubmitLimit).not.toHaveBeenCalled();
  });

  it('falls back to the maker path when the daily circuit breaker is hit', async () => {
    const redis = makeTakerRedis();
    // 24 already spent + 5 stake = 29 > 25 cap → ineligible. Daily key only.
    redis.get.mockImplementation((k: string) =>
      Promise.resolve(k.includes('taker_daily') ? '24' : null),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(weatherSignal(), redis as any);

    expect(result.skipReason).toBe('spread_too_wide'); // bypass not granted → wide book skips
    expect(mockSubmitLimit).not.toHaveBeenCalled();
    expect(redis.incrbyfloat).not.toHaveBeenCalled();
  });

  it('does NOT take a ghost/empty book (nothing real to cross)', async () => {
    mockGetOrderBook.mockResolvedValue(wideRealBook('0.99', '0.01')); // ghost: bid<0.04, ask>0.96
    const redis = makeTakerRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeSignal(weatherSignal(), redis as any);

    // Ghost book → empty-book maker path, never the taker crossing price (0.70).
    if (mockSubmitLimit.mock.calls.length > 0) {
      const arg = mockSubmitLimit.mock.calls[0][0] as { postOnly?: boolean; price?: number };
      expect(arg.postOnly).not.toBe(false); // not a taker
      expect(arg.price).not.toBe(0.70);
    }
    expect(redis.incrbyfloat).not.toHaveBeenCalled();
  });

  it('excludes bracket-opposite legs (they remain maker liquidity)', async () => {
    const redis = makeTakerRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      weatherSignal({ _isBracketOpposite: true } as any),
      redis as any,
    );

    // Not taker-eligible → wide book hits the normal spread_too_wide skip.
    expect(result.skipReason).toBe('spread_too_wide');
    expect(redis.incrbyfloat).not.toHaveBeenCalled();
  });
});
