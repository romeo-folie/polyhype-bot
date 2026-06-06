import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkGlobalGovernor, recordGlobalTrade, reserveGovernorSlots } from './governor.js';

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
  eval: vi.fn(),
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

describe('reserveGovernorSlots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reserves and pre-stamps via a single atomic eval (check + write in one script)', async () => {
    mockRedis.eval.mockResolvedValue([1, '-1']); // no prior trade

    const result = await reserveGovernorSlots(mockRedis as any, 'polymarket', 2);

    expect(result.ok).toBe(true);
    expect(result.elapsedMs).toBe(Infinity);
    expect(result.minIntervalMs).toBe(1000); // 60/min
    // One atomic eval; the plain GET/SET pair must NOT be used (that is the
    // TOCTOU gap this primitive exists to close).
    expect(mockRedis.eval).toHaveBeenCalledOnce();
    expect(mockRedis.get).not.toHaveBeenCalled();
    expect(mockRedis.set).not.toHaveBeenCalled();
    // The script receives now, minInterval and count so the pre-stamp lands
    // at now + (count-1)*minInterval.
    const args = mockRedis.eval.mock.calls[0] as unknown[];
    expect(args[2]).toBe('governor:last_trade_at');
    expect(args[5]).toBe('2'); // count
  });

  it('returns ok:false without consuming slots when the interval has not elapsed', async () => {
    mockRedis.eval.mockResolvedValue([0, '200']); // 200ms since last trade

    const result = await reserveGovernorSlots(mockRedis as any, 'polymarket', 2);

    expect(result.ok).toBe(false);
    expect(result.elapsedMs).toBe(200);
    expect(result.minIntervalMs).toBe(1000);
  });

  it('count=1 uses the same single-slot threshold as checkGlobalGovernor', async () => {
    mockRedis.eval.mockResolvedValue([1, '1500']);

    const result = await reserveGovernorSlots(mockRedis as any, 'polymarket', 1);

    expect(result.ok).toBe(true);
    const args = mockRedis.eval.mock.calls[0] as unknown[];
    expect(args[5]).toBe('1');
  });

  it('bypasses for hyperliquid and for count<=0 without touching Redis', async () => {
    expect((await reserveGovernorSlots(mockRedis as any, 'hyperliquid', 2)).ok).toBe(true);
    expect((await reserveGovernorSlots(mockRedis as any, 'polymarket', 0)).ok).toBe(true);
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });
});
