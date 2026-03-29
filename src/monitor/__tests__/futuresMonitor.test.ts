import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock Config
jest.unstable_mockModule('../../shared/config.js', () => ({
  loadConfig: jest.fn().mockReturnValue({
    FUTURES_ENABLED: true,
    FUTURES_STOP_LOSS_PCT: -1.5,
    FUTURES_TAKE_PROFIT_PCT: 3.0,
    FUTURES_MAX_HOLD_HOURS: 24,
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
const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
};

jest.unstable_mockModule('../../shared/redis.js', () => ({
  getRedis: jest.fn().mockReturnValue(mockRedis),
  closeRedis: jest.fn(),
}));

// Mock Hyperliquid Client
const mockGetOpenPositions = jest.fn();
const mockPlaceMarketOrder = jest.fn();
jest.unstable_mockModule('../../shared/hyperliquid.js', () => ({
  getHyperliquid: jest.fn().mockReturnValue({
    getOpenPositions: mockGetOpenPositions,
    placeMarketOrder: mockPlaceMarketOrder,
  }),
}));

// Mock Telegram
jest.unstable_mockModule('../../execution/telegram.js', () => ({
  notifyTakeProfitExecuted: jest.fn(),
}));

const { runFuturesMonitorWorker } = await import('../futuresMonitor.js');

describe('futuresMonitor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Control the infinite loop and speed up tests by mocking setTimeout to throw
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => {
      if (typeof fn === 'function') fn();
      throw new Error('TEST_COMPLETE');
    });
    
    // Default mock behavior
    mockGetOpenPositions.mockResolvedValue([]);
    mockPlaceMarketOrder.mockResolvedValue({ success: true });
    mockRedis.get.mockResolvedValue(null);
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
          marginUsed: '1000' 
        } 
      },
    ]);

    await runTick();

    expect(mockPlaceMarketOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BTC',
      isBuy: false, // Closing LONG
      reduceOnly: true,
    }));
  });

  it('triggers TP when price rises above +3.0%', async () => {
    mockGetOpenPositions.mockResolvedValue([
      { 
        symbol: 'ETH', 
        position: { 
          szi: '1.0', 
          entryPx: '3000', 
          unrealizedPnl: '100', // +3.33%
          marginUsed: '600' 
        } 
      },
    ]);

    await runTick();

    expect(mockPlaceMarketOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'ETH',
      isBuy: false,
    }));
  });

  it('does NOT trigger exit when price move is within neutral bounds', async () => {
    mockGetOpenPositions.mockResolvedValue([
      { 
        symbol: 'SOL', 
        position: { 
          szi: '10', 
          entryPx: '140', 
          unrealizedPnl: '7', // +0.5%
          marginUsed: '280' 
        } 
      },
    ]);

    await runTick();

    expect(mockPlaceMarketOrder).not.toHaveBeenCalled();
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
          marginUsed: '1000' 
        } 
      },
    ]);

    // Mock first seen time as 25 hours ago
    const longAgo = Date.now() - (25 * 3600 * 1000);
    mockRedis.get.mockResolvedValue(longAgo.toString());

    await runTick();

    expect(mockPlaceMarketOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol,
      reduceOnly: true,
    }));
  });
});
