import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArbitrageWorker } from './worker.js';
import { runArbScan } from './scanner.js';
import { getRedis } from '../shared/redis.js';

// Mock Config
vi.mock('../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    ARB_ENABLED: true,
    CLOB_FALLBACK_ENABLED: true,
  })),
}));

// Mock scanner
vi.mock('./scanner.js', () => ({
  runArbScan: vi.fn().mockResolvedValue([]),
}));

// Mock Redis with Pub/Sub listeners
const mockRedis = {
  subscribe: vi.fn().mockResolvedValue(1),
  unsubscribe: vi.fn().mockResolvedValue(1),
  on: vi.fn((event, callback) => {
    if (event === 'message') {
      (global as any)._onRedisMessageCallback = callback;
    }
  }),
  pipeline: vi.fn(() => ({
      exec: vi.fn().mockResolvedValue([]),
  })),
};

vi.mock('../shared/redis.js', () => ({
  getRedis: vi.fn(() => mockRedis),
  getSubscriberRedis: vi.fn(() => mockRedis),
  closeRedis: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

describe('ArbitrageWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should subscribe to spot:price_moved and baseline scan', async () => {
    const worker = new ArbitrageWorker({ baselineIntervalMs: 100 });
    await worker.start();

    expect(mockRedis.subscribe).toHaveBeenCalledWith('spot:price_moved');
    expect(mockRedis.on).toHaveBeenCalledWith('message', expect.any(Function));

    // Cleanup worker timer
    worker.stop();
  });

  it('should trigger scan on spot:price_moved event', async () => {
    const worker = new ArbitrageWorker({ baselineIntervalMs: 10000 });
    await worker.start();

    // Simulate message from Redis Pub/Sub
    const callback = (global as any)._onRedisMessageCallback;
    await callback('spot:price_moved', JSON.stringify({ symbol: 'btcusdt', price: 65000 }));

    expect(runArbScan).toHaveBeenCalled();
    
    worker.stop();
  });

  it('should respect rate limiting (governor)', async () => {
     // Config with high rate limit for testing
     const worker = new ArbitrageWorker({ baselineIntervalMs: 100, maxTradesPerMin: 1 });
     await worker.start();

     const callback = (global as any)._onRedisMessageCallback;
     
     // 1st trigger
     await callback('spot:price_moved', JSON.stringify({ symbol: 'btcusdt', price: 65100 }));
     // 2nd trigger (should be ignored by governor if interval too short)
     await callback('spot:price_moved', JSON.stringify({ symbol: 'btcusdt', price: 65200 }));

     // Scan only called once because governor throttles it
     expect(runArbScan).toHaveBeenCalledTimes(1);
     
     worker.stop();
  });
});
