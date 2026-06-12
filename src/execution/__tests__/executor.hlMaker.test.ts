import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';

// Mock Config — literal on purpose: maker knobs use sub-schema-minimum waits to
// keep the timeout test fast (the code reads cfg values directly).
const mockConfig = {
  FUTURES_ENABLED: true,
  FUTURES_GLOBAL_MAX_MARGIN_USD: 200,
  FUTURES_MAX_PER_TRADE_USD: 30,
  FUTURES_DEFAULT_LEVERAGE: 10,
  HL_FUNDING_GATE_ENABLED: false,
  HL_MAX_ADVERSE_FUNDING_BPS: 1,
  HL_MAKER_ENTRIES_ENABLED: true,
  HL_MAKER_WAIT_SEC: 1,
  HL_MAKER_POLL_INTERVAL_SEC: 0.2,
  HL_MOMENTUM_MEME_SYMBOLS: 'wifusdt,bonkusdt,penguusdt',
  HL_MOMENTUM_PRIMARY_LOOKBACK_MS: 194_400_000,
  FUTURES_ATR_SL_MULT: 1.5,
  FUTURES_ATR_TP_MULT: 3.0,
  HL_MOMENTUM_SL_ATR_MULT: 2.75,
  HL_MOMENTUM_SL_FLOOR_PCT: 1.5,
  HL_MOMENTUM_SL_CEIL_PCT: 6,
  HL_MOMENTUM_TP_ATR_MULT: 3.0,
  HL_TIME_EXIT_SHADOW_ENABLED: false,
  HL_TIME_EXIT_SHADOW_HOURS: 8,
  HL_DRY_RUN: false,
  EXECUTION_MODE: 'taker',
  CALIBRATION_ENABLED: false,
  MIN_BET_USD: 5,
  SIZE_UP_ELIGIBLE_SOURCES: 'weather',
};
const mockLoadConfig = vi.fn(() => ({ ...mockConfig }));
vi.mock('../../shared/config.js', () => ({ loadConfig: () => mockLoadConfig() }));

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('../positionLedger.js', () => ({
  hasOpenPosition: vi.fn().mockResolvedValue(false),
  recordPosition: vi.fn(),
}));

vi.mock('../../db/writeQueue.js', () => ({ enqueueWrite: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../telegram.js', () => ({
  notifyTradeExecuted: vi.fn().mockResolvedValue(undefined),
  notifyTradeError: vi.fn().mockResolvedValue(undefined),
}));

// ATR snapshot at entry — controlled per test (null = unavailable).
const mockComputeATR = vi.fn().mockResolvedValue(null);
vi.mock('../../arb/indicators.js', () => ({
  computeATR: (...args: unknown[]) => mockComputeATR(...args),
}));

// Mock Hyperliquid Client — full maker surface.
const mockPlaceMarketOrder = vi.fn();
const mockPlaceRestingOrder = vi.fn();
const mockGetOrderStatus = vi.fn();
const mockCancelOrder = vi.fn();
const mockGetBestBidAsk = vi.fn();
vi.mock('../../shared/hyperliquid.js', () => ({
  getHyperliquid: vi.fn().mockReturnValue({
    getClearinghouseState: vi.fn().mockResolvedValue({
      marginSummary: { accountValue: '1000' },
      assetPositions: [],
    }),
    getOpenPositions: vi.fn().mockResolvedValue([]),
    getAssetContext: vi.fn().mockRejectedValue(new Error('ctx unavailable in test')),
    placeMarketOrder: mockPlaceMarketOrder,
    placeRestingOrder: mockPlaceRestingOrder,
    getOrderStatus: mockGetOrderStatus,
    cancelOrder: mockCancelOrder,
    getBestBidAsk: mockGetBestBidAsk,
  }),
  resolveHlSymbol: vi.fn().mockReturnValue(undefined),
}));

const { executeSignal } = await import('../executor.js');

function makeHlSignal(overrides: Record<string, unknown> = {}) {
  return {
    marketId: 'BTC',
    question: 'HL momentum LONG BTC',
    direction: 'LONG' as const,
    stakeUsd: 30,
    edgeMagnitude: 0.7,
    outcomePrice: 0,
    isFutures: true,
    leverage: 10,
    sourcedFrom: 'hl-momentum',
    source: 'hl-momentum' as const,
    ...overrides,
  };
}

const mockRedis = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  exists: vi.fn().mockResolvedValue(0),
  incrbyfloat: vi.fn().mockResolvedValue('30'),
  expire: vi.fn().mockResolvedValue(1),
  sadd: vi.fn().mockResolvedValue(1),
} as unknown as Redis;

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue({ ...mockConfig });
  mockComputeATR.mockResolvedValue(null);
  mockGetBestBidAsk.mockResolvedValue({ bestBid: 49_990, bestAsk: 50_010 });
  mockPlaceRestingOrder.mockResolvedValue({ success: true, oid: 777, price: 49_990 });
  mockCancelOrder.mockResolvedValue({ success: true });
});

describe('hl-momentum post-only maker entries', () => {
  it('uses a resting ALO order at the bid and reports a maker fill', async () => {
    mockGetOrderStatus.mockResolvedValue({ status: 'filled', origSz: 1, remainingSz: 0, filledSz: 1 });

    const result = await executeSignal(makeHlSignal() as never, mockRedis);

    expect(mockPlaceMarketOrder).not.toHaveBeenCalled();
    expect(mockPlaceRestingOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'BTC', isBuy: true, limitPrice: 49_990, leverage: 10 }),
    );
    expect(result.skipped).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.entryOrderType).toBe('maker');
    expect(result.entryPrice).toBe(49_990);
  });

  it('posts at the ask for SHORT signals', async () => {
    mockGetOrderStatus.mockResolvedValue({ status: 'filled', origSz: 1, remainingSz: 0, filledSz: 1 });

    await executeSignal(makeHlSignal({ direction: 'SHORT' }) as never, mockRedis);

    expect(mockPlaceRestingOrder).toHaveBeenCalledWith(
      expect.objectContaining({ isBuy: false, limitPrice: 50_010 }),
    );
  });

  it('cancels on timeout and skips with maker_not_filled — no taker fallback', async () => {
    mockGetOrderStatus.mockResolvedValue({ status: 'open', origSz: 1, remainingSz: 1, filledSz: 0 });

    const result = await executeSignal(makeHlSignal() as never, mockRedis);

    expect(mockCancelOrder).toHaveBeenCalledWith('BTC', 777);
    expect(mockPlaceMarketOrder).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('maker_not_filled');
  });

  it('treats an ALO would-cross rejection as not-filled, not an error', async () => {
    mockPlaceRestingOrder.mockResolvedValue({
      success: false,
      error: 'Post only order would have immediately matched, bbo was 50000',
    });

    const result = await executeSignal(makeHlSignal() as never, mockRedis);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('alo_would_cross');
    expect(mockPlaceMarketOrder).not.toHaveBeenCalled();
  });

  it('scales the recorded stake on a partial fill at timeout', async () => {
    // open while waiting; after the cancel the final check shows 40% filled
    mockGetOrderStatus
      .mockResolvedValue({ status: 'open', origSz: 10, remainingSz: 10, filledSz: 0 })
      .mockResolvedValueOnce({ status: 'open', origSz: 10, remainingSz: 10, filledSz: 0 });
    mockCancelOrder.mockImplementation(() => {
      mockGetOrderStatus.mockResolvedValue({ status: 'canceled', origSz: 10, remainingSz: 6, filledSz: 4 });
      return Promise.resolve({ success: true });
    });

    const result = await executeSignal(makeHlSignal({ stakeUsd: 30 }) as never, mockRedis);

    expect(result.skipped).toBe(false);
    expect(result.entryOrderType).toBe('maker');
    expect(result.signal.stakeUsd).toBeCloseTo(12, 5); // 30 × 0.4
  });

  it('records the filled part when an external cancel lands after a partial fill', async () => {
    // HL margin-cancels the resting order mid-wait with 30% already filled.
    mockGetOrderStatus.mockResolvedValue({ status: 'canceled', origSz: 10, remainingSz: 7, filledSz: 3 });

    const result = await executeSignal(makeHlSignal({ stakeUsd: 30 }) as never, mockRedis);

    expect(result.skipped).toBe(false);
    expect(result.entryOrderType).toBe('maker');
    expect(result.signal.stakeUsd).toBeCloseTo(9, 5); // 30 × 0.3
  });

  it('skips cleanly when an external cancel lands with zero fill', async () => {
    mockGetOrderStatus.mockResolvedValue({ status: 'canceled', origSz: 10, remainingSz: 10, filledSz: 0 });

    const result = await executeSignal(makeHlSignal() as never, mockRedis);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('order_canceled');
  });

  it('falls back to taker market orders when the maker knob is off', async () => {
    mockLoadConfig.mockReturnValue({ ...mockConfig, HL_MAKER_ENTRIES_ENABLED: false });
    mockPlaceMarketOrder.mockResolvedValue({ success: true, txHash: '0xtx', price: 50_000 });

    const result = await executeSignal(makeHlSignal() as never, mockRedis);

    expect(mockPlaceRestingOrder).not.toHaveBeenCalled();
    expect(mockPlaceMarketOrder).toHaveBeenCalled();
    expect(result.entryOrderType).toBe('taker');
  });

  it('keeps taker execution for non-hl-momentum futures sources', async () => {
    mockPlaceMarketOrder.mockResolvedValue({ success: true, txHash: '0xtx', price: 50_000 });

    const result = await executeSignal(
      makeHlSignal({ sourcedFrom: 'hl-funding', source: 'hl-funding' }) as never,
      mockRedis,
    );

    expect(mockPlaceRestingOrder).not.toHaveBeenCalled();
    expect(mockPlaceMarketOrder).toHaveBeenCalled();
    expect(result.entryOrderType).toBe('taker');
  });
});

describe('hl-momentum frozen ATR SL/TP capture (non-meme)', () => {
  it('freezes clamp(ATR×mult) SL and unclamped TP on the execution result', async () => {
    mockGetOrderStatus.mockResolvedValue({ status: 'filled', origSz: 1, remainingSz: 0, filledSz: 1 });
    mockComputeATR.mockResolvedValue({ atr: 500, atrPct: 1.0 }); // 1% 15m ATR

    const result = await executeSignal(makeHlSignal() as never, mockRedis);

    // SL = clamp(1.0 × 2.75, 1.5, 6) = 2.75; TP = 1.0 × 3.0 = 3.0
    expect(result.memeAtrSlPct).toBeCloseTo(2.75, 5);
    expect(result.memeAtrTpPct).toBeCloseTo(3.0, 5);
  });

  it('applies the SL floor for very quiet symbols', async () => {
    mockGetOrderStatus.mockResolvedValue({ status: 'filled', origSz: 1, remainingSz: 0, filledSz: 1 });
    mockComputeATR.mockResolvedValue({ atr: 100, atrPct: 0.2 }); // 0.2% ATR → raw SL 0.55

    const result = await executeSignal(makeHlSignal() as never, mockRedis);

    expect(result.memeAtrSlPct).toBeCloseTo(1.5, 5); // floor
  });

  it('leaves the ATR fields unset when no ATR snapshot is available', async () => {
    mockGetOrderStatus.mockResolvedValue({ status: 'filled', origSz: 1, remainingSz: 0, filledSz: 1 });
    mockComputeATR.mockResolvedValue(null); // monitor must fall back to fixed thresholds

    const result = await executeSignal(makeHlSignal() as never, mockRedis);

    expect(result.memeAtrSlPct).toBeUndefined();
    expect(result.memeAtrTpPct).toBeUndefined();
  });

  it('records the time-exit shadow entry when the experiment knob is on', async () => {
    mockLoadConfig.mockReturnValue({ ...mockConfig, HL_TIME_EXIT_SHADOW_ENABLED: true });
    mockGetOrderStatus.mockResolvedValue({ status: 'filled', origSz: 1, remainingSz: 0, filledSz: 1 });

    await executeSignal(makeHlSignal() as never, mockRedis);

    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^hl:time_exit_shadow:BTC:\d+$/),
      expect.stringContaining('"entryPrice":49990'),
      'EX',
      expect.any(Number),
    );
    expect(mockRedis.sadd).toHaveBeenCalledWith(
      'hl:time_exit_shadow:index',
      expect.stringMatching(/^hl:time_exit_shadow:BTC:\d+$/),
    );
  });
});
