import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BinanceFeed } from './binanceFeed.js';
import { getRedis } from '../../shared/redis.js';

// Mock Redis singleton
const mockRedis = {
  pipeline: vi.fn(() => ({
    zadd: vi.fn().mockReturnThis(),
    zremrangebyscore: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    publish: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  })),
  set: vi.fn().mockResolvedValue('OK'),
  on: vi.fn(),
};

vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn(() => mockRedis),
  closeRedis: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

// Mock WebSocket
const mockWs = {
  on: vi.fn(),
  send: vi.fn(),
  terminate: vi.fn(),
};

vi.mock('ws', () => {
  return {
    default: vi.fn(() => mockWs),
    WebSocket: vi.fn(() => mockWs),
  };
});

describe('BinanceFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize and subscribe to tickers', async () => {
    const feed = new BinanceFeed(['btcusdt', 'ethusdt']);
    feed.start();

    // Verify WebSocket was initialized
    expect(vi.mocked(mockWs.on)).toHaveBeenCalledWith('open', expect.any(Function));
    expect(vi.mocked(mockWs.on)).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('should parse ticker messages and update Redis', async () => {
    const feed = new BinanceFeed(['btcusdt']);
    feed.start();

    // Simulate WS onMessage handler
    const messageHandler = vi.mocked(mockWs.on).mock.calls.find((call) => call[0] === 'message')?.[1] as (data: string) => void;
    
    // Binance ticker format (s: symbol, c: close price, E: event time)
    const rawMessage = JSON.stringify({
      s: 'BTCUSDT',
      c: '65000.50',
      E: Date.now(),
    });

    await messageHandler(rawMessage);

    const redis = getRedis();
    expect(redis.pipeline).toHaveBeenCalled();
  });
});
