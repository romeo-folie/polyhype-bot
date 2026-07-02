import { describe, it, expect, beforeEach, vi } from 'vitest';

// handleExternallyClosedPosition (2026-07-02 review): when the prune path finds
// a ledger row whose HL position is gone and a native stop trigger was resting,
// it must record an outcome (previously the trade silently vanished from
// analytics) and cancel a still-resting trigger.

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({ FUTURES_ENABLED: true }),
}));
vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn(),
  closeRedis: vi.fn(),
  refreshLock: vi.fn(),
  reacquireLockAfterExpiry: vi.fn(),
}));
vi.mock('../../shared/hyperliquid.js', () => ({ getHyperliquid: vi.fn() }));
vi.mock('../../execution/telegram.js', () => ({
  notifyTradeError: vi.fn(),
  notifyTakeProfitExecuted: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../execution/positionLedger.js', () => ({
  closePosition: vi.fn(),
  getOpenPositions: vi.fn(),
  hasOpenPosition: vi.fn(),
  recordPosition: vi.fn(),
  updateHighWaterMark: vi.fn(),
}));
vi.mock('../../arb/confluenceScorer.js', () => ({ scoreConfluence: vi.fn() }));
const mockRecordPositionOutcome = vi.fn().mockResolvedValue(undefined);
vi.mock('../../shared/positionOutcomeRecorder.js', () => ({
  recordPositionOutcome: (...args: unknown[]) => mockRecordPositionOutcome(...args),
}));
vi.mock('../../db/writeQueue.js', () => ({ enqueueWrite: vi.fn() }));
vi.mock('../../futures/hlMomentumScanner.js', () => ({
  isMemeSymbol: vi.fn().mockReturnValue(false),
  momentumCooldownKey: vi.fn(),
}));
vi.mock('../../futures/hlAssetCtxCache.js', () => ({
  getAllCachedAssetCtxs: vi.fn(),
  fundingRateToApr: vi.fn(),
}));

const { handleExternallyClosedPosition } = await import('../futuresMonitor.js');

const mockGetOrderStatus = vi.fn();
const mockCancelOrder = vi.fn();
const mockGetUserFillsByTime = vi.fn();
const hl = {
  getOrderStatus: mockGetOrderStatus,
  cancelOrder: mockCancelOrder,
  getUserFillsByTime: mockGetUserFillsByTime,
} as never;
const redis = {} as never;

function makePosition(overrides: Record<string, unknown> = {}) {
  return {
    marketId: 'kBONK',
    symbol: 'kBONK',
    question: 'kBONK perpetual',
    direction: 'SHORT' as const,
    entryPrice: 0.01,
    stakeUsd: 30,
    edgeMagnitude: 0,
    sourcedFrom: 'hl-momentum',
    openedAt: new Date('2026-07-02T00:45:00Z').toISOString(),
    executionVenue: 'hyperliquid' as const,
    isFutures: true,
    nativeStopOid: 555,
    nativeStopPx: 0.010258,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetOrderStatus.mockResolvedValue({ status: 'filled', origSz: 3000, remainingSz: 0, filledSz: 3000 });
  mockCancelOrder.mockResolvedValue({ success: true });
  mockGetUserFillsByTime.mockResolvedValue([]);
});

describe('handleExternallyClosedPosition', () => {
  it('is a no-op for positions without a native stop', async () => {
    await handleExternallyClosedPosition(redis, hl, makePosition({ nativeStopOid: undefined }));
    expect(mockRecordPositionOutcome).not.toHaveBeenCalled();
    expect(mockGetOrderStatus).not.toHaveBeenCalled();
  });

  it('records a native-stop outcome with direction-adjusted return from the close fill', async () => {
    // SHORT closed by a buy fill ('B') above entry → a loss
    mockGetUserFillsByTime.mockResolvedValue([
      { coin: 'kBONK', px: 0.01026, sz: 3000, side: 'B', time: 1, closedPnl: -0.78 },
      { coin: 'ETH', px: 3500, sz: 0.1, side: 'B', time: 2, closedPnl: 0 },
    ]);
    await handleExternallyClosedPosition(redis, hl, makePosition());
    expect(mockRecordPositionOutcome).toHaveBeenCalledTimes(1);
    const opts = mockRecordPositionOutcome.mock.calls[0]?.[2] as {
      result: string; returnPct: number; exitReason: string;
    };
    expect(opts.result).toBe('lost');
    expect(opts.returnPct).toBeCloseTo(-2.6, 1);
    expect(opts.exitReason).toContain('native_trigger_stop');
  });

  it('falls back to the trigger price when no close fill is recoverable', async () => {
    mockGetUserFillsByTime.mockRejectedValue(new Error('api down'));
    await handleExternallyClosedPosition(redis, hl, makePosition());
    const opts = mockRecordPositionOutcome.mock.calls[0]?.[2] as { returnPct: number };
    // (0.010258 − 0.01)/0.01 = +2.58% price move against a SHORT
    expect(opts.returnPct).toBeCloseTo(-2.58, 2);
  });

  it('cancels a still-resting trigger and labels the outcome an external close', async () => {
    mockGetOrderStatus.mockResolvedValue({ status: 'open', origSz: 3000, remainingSz: 3000, filledSz: 0 });
    mockGetUserFillsByTime.mockResolvedValue([
      { coin: 'kBONK', px: 0.0099, sz: 3000, side: 'B', time: 1, closedPnl: 0.3 },
    ]);
    await handleExternallyClosedPosition(redis, hl, makePosition());
    expect(mockCancelOrder).toHaveBeenCalledWith('kBONK', 555);
    const opts = mockRecordPositionOutcome.mock.calls[0]?.[2] as {
      result: string; exitReason: string;
    };
    expect(opts.exitReason).toContain('External close');
    expect(opts.result).toBe('won');
  });

  it('skips the outcome (previous behaviour) when nothing is recoverable', async () => {
    mockGetOrderStatus.mockResolvedValue({ status: 'canceled', origSz: 0, remainingSz: 0, filledSz: 0 });
    mockGetUserFillsByTime.mockResolvedValue([]);
    await handleExternallyClosedPosition(redis, hl, makePosition());
    expect(mockRecordPositionOutcome).not.toHaveBeenCalled();
  });

  it('never throws on API failures', async () => {
    mockGetOrderStatus.mockRejectedValue(new Error('boom'));
    await expect(
      handleExternallyClosedPosition(redis, hl, makePosition()),
    ).resolves.toBeUndefined();
    expect(mockRecordPositionOutcome).not.toHaveBeenCalled();
  });
});
