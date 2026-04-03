import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkGlobalGovernor, recordGlobalTrade } from './governor.js';
import { loadConfig } from './config.js';

// Mock Config
vi.mock('./config.js', () => ({
  loadConfig: vi.fn(() => ({
    ARB_GLOBAL_MAX_TRADES_PER_MIN: 60, // 1 trade per second
  })),
}));

// Mock Redis
const mockRedis = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  zrange: vi.fn().mockResolvedValue([]),
};

describe('Global Governor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should allow trade when no recent trade recorded in Redis', async () => {
    mockRedis.get.mockResolvedValue(null);
    const result = await checkGlobalGovernor(mockRedis as any, 'polymarket');

    expect(result.ok).toBe(true);
    expect(mockRedis.get).toHaveBeenCalledWith('governor:last_trade_at');
  });

  it('should throttle when trade was too recent', async () => {
    const now = Date.now();
    mockRedis.get.mockResolvedValue((now - 100).toString()); // 100ms ago

    const result = await checkGlobalGovernor(mockRedis as any, 'polymarket');

    expect(result.ok).toBe(false);
    expect(result.elapsedMs).toBeLessThan(1000); // 60 trades/min = 1000ms interval
  });

  it('should bypass for hyperliquid', async () => {
    mockRedis.get.mockResolvedValue(Date.now().toString()); // exactly now

    // Even if PM is throttled, HL should pass
    const result = await checkGlobalGovernor(mockRedis as any, 'hyperliquid');

    expect(result.ok).toBe(true);
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('should record trade in Redis', async () => {
    mockRedis.set.mockResolvedValue('OK');
    await recordGlobalTrade(mockRedis as any, 'polymarket');

    expect(mockRedis.set).toHaveBeenCalledWith('governor:last_trade_at', expect.any(String));
  });
});
