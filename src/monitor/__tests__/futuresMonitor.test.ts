import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock Config
vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    FUTURES_ENABLED: true,
    FUTURES_STOP_LOSS_PCT: -1.5,
    FUTURES_TAKE_PROFIT_PCT: 3.0,
    FUTURES_MAX_HOLD_HOURS: 24,
  }),
}));

// Mock Logger
vi.mock('../../shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock Redis
const mockRedis = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  eval: vi.fn().mockResolvedValue(1),
};

vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn().mockReturnValue(mockRedis),
  closeRedis: vi.fn(),
  refreshLock: vi.fn().mockResolvedValue('refreshed'),
  reacquireLockAfterExpiry: vi.fn().mockResolvedValue(true),
}));

// Mock Hyperliquid Client
const mockGetOpenPositions = vi.fn();
const mockClosePosition = vi.fn();
vi.mock('../../shared/hyperliquid.js', () => ({
  getHyperliquid: vi.fn().mockReturnValue({
    getOpenPositions: mockGetOpenPositions,
    closePosition: mockClosePosition,
  }),
}));

// Mock Position Ledger
const mockGetLedgerPositions = vi.fn();
const mockCloseLedgerPosition = vi.fn();
const mockHasOpenPosition = vi.fn().mockResolvedValue(true); // default: ledger row exists → no backfill
const mockRecordPosition = vi.fn().mockResolvedValue(undefined);
const mockUpdateHighWaterMark = vi.fn().mockResolvedValue(undefined);
vi.mock('../../execution/positionLedger.js', () => ({
  getOpenPositions: mockGetLedgerPositions,
  closePosition: mockCloseLedgerPosition,
  hasOpenPosition: mockHasOpenPosition,
  recordPosition: mockRecordPosition,
  updateHighWaterMark: mockUpdateHighWaterMark,
}));

// Mock Telegram
vi.mock('../../execution/telegram.js', () => ({
  notifyTradeError: vi.fn(),
  notifyTakeProfitExecuted: vi.fn(),
}));

const { runFuturesMonitorWorker } = await import('../futuresMonitor.js');

describe('futuresMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Break the while(true) loop after one tick.
    // We throw WITHOUT calling fn() so the Promise constructor rejects (uncaught resolve
    // would swallow the throw). The rejection propagates past the inner try/catch
    // (which only wraps the work, not the bottom sleep) and bubbles up to runTick.
    vi.spyOn(global, 'setTimeout').mockImplementation((_fn: any) => {
      throw new Error('TEST_COMPLETE');
    });

    // Default mock behavior
    mockGetOpenPositions.mockResolvedValue([]);
    mockGetLedgerPositions.mockResolvedValue([]);
    mockClosePosition.mockResolvedValue({ success: true });
    mockCloseLedgerPosition.mockResolvedValue(undefined);
  });

  async function runTick() {
    try {
      await runFuturesMonitorWorker();
    } catch (e: any) {
      if (e.message !== 'TEST_COMPLETE') throw e;
    }
  }

  it('triggers SL when price falls below -1.5%', async () => {
    mockGetOpenPositions.mockResolvedValue([
      {
        symbol: 'BTC',
        position: {
          szi: '0.1',
          entryPx: '50000',
          unrealizedPnl: '-100', // -2.0% (100 / 5000)
          marginUsed: '1000',
        },
      },
    ]);

    await runTick();

    expect(mockClosePosition).toHaveBeenCalledWith('BTC');
  });

  it('triggers TP when price rises above +3.0%', async () => {
    mockGetOpenPositions.mockResolvedValue([
      {
        symbol: 'ETH',
        position: {
          szi: '1.0',
          entryPx: '3000',
          unrealizedPnl: '100', // +3.33%
          marginUsed: '600',
        },
      },
    ]);

    await runTick();

    expect(mockClosePosition).toHaveBeenCalledWith('ETH');
  });

  it('does NOT trigger exit when price move is within neutral bounds', async () => {
    mockGetOpenPositions.mockResolvedValue([
      {
        symbol: 'SOL',
        position: {
          szi: '10',
          entryPx: '140',
          unrealizedPnl: '7', // +0.5%
          marginUsed: '280',
        },
      },
    ]);

    await runTick();

    expect(mockClosePosition).not.toHaveBeenCalled();
  });

  it('triggers exit when Max Hold Hours is exceeded', async () => {
    const symbol = 'BTC';
    mockGetOpenPositions.mockResolvedValue([
      {
        symbol,
        position: {
          szi: '0.1',
          entryPx: '50000',
          unrealizedPnl: '0',
          marginUsed: '1000',
        },
      },
    ]);

    // Provide ledger entry with openedAt 25 hours ago
    const longAgo = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    mockGetLedgerPositions.mockResolvedValue([
      {
        marketId: symbol,
        openedAt: longAgo,
        isFutures: true,
        direction: 'LONG',
        question: `News Futures: ${symbol} LONG`,
        entryPrice: 50000,
        stakeUsd: 10,
      },
    ]);

    await runTick();

    expect(mockClosePosition).toHaveBeenCalledWith(symbol);
  });
});
