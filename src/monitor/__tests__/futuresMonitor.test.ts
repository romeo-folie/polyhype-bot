import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock Config
jest.unstable_mockModule('../../shared/config.js', () => ({
  loadConfig: jest.fn().mockReturnValue({
    FUTURES_ENABLED: true,
    FUTURES_STOP_LOSS_PCT: -1.5,
    FUTURES_TAKE_PROFIT_PCT: 3.0,
  }),
}));

// Mock Logger
jest.unstable_mockModule('../../shared/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

// Mock Redis
jest.unstable_mockModule('../../shared/redis.js', () => ({
  getRedis: jest.fn().mockReturnValue({}),
  closeRedis: jest.fn(),
}));

// Mock Hyperliquid Client
const mockGetOpenPositions = jest.fn();
const mockClosePosition = jest.fn();
jest.unstable_mockModule('../../shared/hyperliquid.js', () => ({
  getHyperliquid: jest.fn().mockReturnValue({
    getOpenPositions: mockGetOpenPositions,
    closePosition: mockClosePosition,
  }),
}));

// Mock Position Ledger
jest.unstable_mockModule('../../execution/positionLedger.js', () => ({
  closePosition: jest.fn(),
}));

const { runFuturesMonitorWorker } = await import('../futuresMonitor.js');

describe('futuresMonitor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Prevent the loop from running forever in tests
    // (We'll use a mocked setTimeout or just test a single tick internally)
    // Actually, we'll wrap the inner loop logic or just let the worker run and throw an exception to stop it.
    // For this test, we'll mock setTimeout to resolve and then throw an error to exit the loop.
    vi.mock('node:timers', () => ({
       setTimeout: vi.fn(),
    }));
  });

  it('triggers SL when price falls below -1.5%', async () => {
    // 1. Mock a losing position
    mockGetOpenPositions.mockResolvedValueOnce([
      {
        symbol: 'BTC',
        position: {
          szi: '0.1', // LONG
          entryPx: '50000',
          unrealizedPnl: '-100', // -2.0% (100 / 5000)
          marginUsed: '1000',
        },
      },
    ]);

    // 2. Wrap execution in a timeout or throw to break the loop
    // For this unit test, we'll modify the loop to run once if a flag is set, 
    // but here we'll just mock the client to return empty after the first call.
    mockGetOpenPositions.mockResolvedValue([]);
    mockClosePosition.mockResolvedValue({ success: true });

    // Since runFuturesMonitorWorker is an infinite loop, we'll use a Promise.race
    // to stop the test after it executes the first tick.
    const workerPromise = runFuturesMonitorWorker();
    
    // Give it a tiny bit of time to tick
    await new Promise(r => setTimeout(r, 100));

    expect(mockClosePosition).toHaveBeenCalledWith('BTC');
  });

  it('triggers TP when price rises above +3.0%', async () => {
    // 1. Mock a winning position
    mockGetOpenPositions.mockResolvedValueOnce([
      {
        symbol: 'ETH',
        position: {
          szi: '1.0', // LONG
          entryPx: '3000',
          unrealizedPnl: '100', // +3.33% (100 / 3000)
          marginUsed: '600',
        },
      },
    ]);

    mockGetOpenPositions.mockResolvedValue([]);
    mockClosePosition.mockResolvedValue({ success: true });

    runFuturesMonitorWorker();
    await new Promise(r => setTimeout(r, 100));

    expect(mockClosePosition).toHaveBeenCalledWith('ETH');
  });

  it('does NOT trigger exit when price move is within neutral bounds', async () => {
    // 1. Mock a stable position (+0.5% move)
    mockGetOpenPositions.mockResolvedValueOnce([
      {
        symbol: 'SOL',
        position: {
          szi: '10', // LONG
          entryPx: '140',
          unrealizedPnl: '7', // +0.5%
          marginUsed: '280',
        },
      },
    ]);

    mockGetOpenPositions.mockResolvedValue([]);
    
    runFuturesMonitorWorker();
    await new Promise(r => setTimeout(r, 100));

    expect(mockClosePosition).not.toHaveBeenCalled();
  });
});
