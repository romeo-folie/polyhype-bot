import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';

// Native-stop executor wiring (2026-07-02 review): after a successful
// hl-momentum entry with HL_NATIVE_STOP_ENABLED, a reduce-only stop-market
// trigger rests exchange-side at the effective software-stop distance × buffer,
// and the oid/px are persisted to the ledger row.

const mockConfig = {
  FUTURES_ENABLED: true,
  FUTURES_GLOBAL_MAX_MARGIN_USD: 200,
  FUTURES_MAX_PER_TRADE_USD: 30,
  FUTURES_DEFAULT_LEVERAGE: 10,
  FUTURES_MAX_LOSS_ROE_PCT: 25,
  HL_FUNDING_GATE_ENABLED: false,
  HL_MAKER_ENTRIES_ENABLED: false,
  HL_MOMENTUM_MEME_SYMBOLS: 'wifusdt,bonkusdt,penguusdt',
  HL_MOMENTUM_PRIMARY_LOOKBACK_MS: 194_400_000,
  HL_MOMENTUM_MEME_ATR_SLTP_ENABLED: true,
  HL_MOMENTUM_MEME_SL_ATR_MULT: 1.5,
  HL_MOMENTUM_MEME_SL_FLOOR_PCT: 8,
  HL_MOMENTUM_MEME_SL_CEIL_PCT: 20,
  HL_MOMENTUM_MEME_TP_ATR_MULT: 3.0,
  HL_MOMENTUM_ATR_SLTP_ENABLED: true,
  HL_MOMENTUM_SL_ATR_MULT: 2.75,
  HL_MOMENTUM_SL_FLOOR_PCT: 1.5,
  HL_MOMENTUM_SL_CEIL_PCT: 6,
  HL_MOMENTUM_TP_ATR_MULT: 3.0,
  HL_MOMENTUM_STOP_LOSS_PCT: 8.5,
  HL_MOMENTUM_CONTRARIAN_STOP_LOSS_PCT: 15,
  HL_NATIVE_STOP_ENABLED: true,
  HL_NATIVE_STOP_BUFFER_MULT: 1.15,
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

const mockRecordPosition = vi.fn();
vi.mock('../positionLedger.js', () => ({
  hasOpenPosition: vi.fn().mockResolvedValue(false),
  recordPosition: (...args: unknown[]) => mockRecordPosition(...args),
}));

const mockEnqueueWrite = vi.fn().mockResolvedValue(undefined);
vi.mock('../../db/writeQueue.js', () => ({ enqueueWrite: mockEnqueueWrite }));

vi.mock('../telegram.js', () => ({
  notifyTradeExecuted: vi.fn().mockResolvedValue(undefined),
  notifyTradeError: vi.fn().mockResolvedValue(undefined),
}));

const mockComputeATR = vi.fn().mockResolvedValue(null);
vi.mock('../../arb/indicators.js', () => ({
  computeATR: (...args: unknown[]) => mockComputeATR(...args),
}));

const mockPlaceMarketOrder = vi.fn();
const mockPlaceStopTrigger = vi.fn();
const mockGetOpenPositions = vi.fn();
vi.mock('../../shared/hyperliquid.js', () => ({
  getHyperliquid: vi.fn().mockReturnValue({
    getClearinghouseState: vi.fn().mockResolvedValue({
      marginSummary: { accountValue: '1000' },
      assetPositions: [],
    }),
    getOpenPositions: (...args: unknown[]) => mockGetOpenPositions(...args),
    getAssetContext: vi.fn().mockRejectedValue(new Error('ctx unavailable in test')),
    placeMarketOrder: mockPlaceMarketOrder,
    placeStopTrigger: (...args: unknown[]) => mockPlaceStopTrigger(...args),
  }),
  resolveHlSymbol: vi.fn().mockReturnValue(undefined),
}));

const { executeSignal, executeAndRecordSignal } = await import('../executor.js');

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
  mockPlaceMarketOrder.mockResolvedValue({ success: true, txHash: '123', price: 100 });
  mockPlaceStopTrigger.mockResolvedValue({ success: true, oid: 4242, triggerPx: 97.12 });
  // Margin pre-check call returns empty; post-entry size lookup returns the position.
  mockGetOpenPositions
    .mockResolvedValueOnce([])
    .mockResolvedValue([
      { symbol: 'BTC', position: { szi: '0.3', entryPx: '100', marginUsed: '3' } },
    ]);
});

describe('executor native stop trigger placement', () => {
  it('rests a reduce-only trigger after a successful entry and persists oid/px to the ledger', async () => {
    const result = await executeAndRecordSignal(makeHlSignal() as never, mockRedis);
    expect(result.skipped).toBe(false);
    expect(result.error).toBeUndefined();

    expect(mockPlaceStopTrigger).toHaveBeenCalledTimes(1);
    const call = mockPlaceStopTrigger.mock.calls[0]?.[0] as {
      symbol: string; isBuy: boolean; sizeBase: number; triggerPx: number;
    };
    expect(call.symbol).toBe('BTC');
    // Closing a LONG sells
    expect(call.isBuy).toBe(false);
    expect(call.sizeBase).toBeCloseTo(0.3);
    // No ATR snapshot → fixed 8.5% ROE at 10x = 0.85% price × 1.15 buffer
    expect(call.triggerPx).toBeCloseTo(100 * (1 - 0.0085 * 1.15), 6);

    expect(result.nativeStopOid).toBe(4242);
    expect(result.nativeStopPx).toBeCloseTo(97.12);
    const recorded = mockRecordPosition.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(recorded).toBeDefined();
    expect(recorded.nativeStopOid).toBe(4242);
    expect(recorded.nativeStopPx).toBeCloseTo(97.12);
  });

  it('places the trigger above entry for SHORT entries', async () => {
    const result = await executeSignal(makeHlSignal({ direction: 'SHORT' }), mockRedis);
    expect(result.skipped).toBe(false);
    const call = mockPlaceStopTrigger.mock.calls[0]?.[0] as { isBuy: boolean; triggerPx: number };
    expect(call.isBuy).toBe(true);
    expect(call.triggerPx).toBeGreaterThan(100);
  });

  it('caps the trigger at the ROE backstop when the ATR design stop is wider (meme floor case)', async () => {
    // Meme entry: ATR 0.69% × 1.5 = 1.03% clamps up to the 8% floor, but the
    // −25% ROE backstop at 10x = 2.5% price binds first — the trigger must
    // anchor to 2.5%, not 8%.
    mockComputeATR.mockResolvedValue({ atr: 0.0001, atrPct: 0.69 });
    mockGetOpenPositions.mockReset();
    mockGetOpenPositions
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { symbol: 'kBONK', position: { szi: '-3000', entryPx: '100', marginUsed: '3' } },
      ]);
    const result = await executeSignal(makeHlSignal({ marketId: 'kBONK' }), mockRedis);
    expect(result.skipped).toBe(false);
    const call = mockPlaceStopTrigger.mock.calls[0]?.[0] as { triggerPx: number };
    expect(call.triggerPx).toBeCloseTo(100 * (1 - 0.025 * 1.15), 6);
  });

  it('does not place a trigger when the flag is off', async () => {
    mockLoadConfig.mockReturnValue({ ...mockConfig, HL_NATIVE_STOP_ENABLED: false });
    const result = await executeSignal(makeHlSignal(), mockRedis);
    expect(result.skipped).toBe(false);
    expect(mockPlaceStopTrigger).not.toHaveBeenCalled();
    expect(result.nativeStopOid).toBeUndefined();
  });

  it('never fails the entry when trigger placement fails', async () => {
    mockPlaceStopTrigger.mockResolvedValue({ success: false, error: 'boom' });
    const result = await executeSignal(makeHlSignal(), mockRedis);
    expect(result.skipped).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.nativeStopOid).toBeUndefined();
  });

  it('skips the trigger when the position is not visible yet', async () => {
    mockGetOpenPositions.mockReset();
    mockGetOpenPositions.mockResolvedValue([]);
    const result = await executeSignal(makeHlSignal(), mockRedis);
    expect(result.skipped).toBe(false);
    expect(mockPlaceStopTrigger).not.toHaveBeenCalled();
  });
});
