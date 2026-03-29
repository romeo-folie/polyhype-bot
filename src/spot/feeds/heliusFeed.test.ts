import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HeliusFeed } from './heliusFeed.js';

// Mock Redis singleton
const mockRedis = {
  pipeline: vi.fn(() => ({
    hset: vi.fn().mockReturnThis(),
    publish: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  })),
};

vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn(() => mockRedis),
  closeRedis: vi.fn(),
}));

// Mock WebSocket
const mockWs = {
  on: vi.fn(),
  send: vi.fn(),
  terminate: vi.fn(),
  removeAllListeners: vi.fn(),
};

vi.mock('ws', () => {
  return {
    default: vi.fn(() => mockWs),
    WebSocket: vi.fn(() => mockWs),
  };
});

describe('HeliusFeed (Pyth Hermes)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize and subscribe to price feeds on open', async () => {
    const feed = new HeliusFeed('fake-key', ['SOL']);
    await feed.start();

    // Verify WebSocket was initialized
    expect(vi.mocked(mockWs.on)).toHaveBeenCalledWith('open', expect.any(Function));

    // Simulate open event
    const openHandler = vi.mocked(mockWs.on).mock.calls.find(c => c[0] === 'open')?.[1] as () => void;
    openHandler();

    expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('subscribe'));
  });

  it('should parse Pyth update and update Redis', async () => {
    const feed = new HeliusFeed('fake-key', ['SOL']);
    await feed.start();

    // Simulate message event
    const messageHandler = vi.mocked(mockWs.on).mock.calls.find(c => c[0] === 'message')?.[1] as (data: string) => void;
    
    // Pyth Hermes mock message
    const rawMessage = JSON.stringify({
      type: 'price_update',
      price_feed: {
        id: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', // SOL
        price: { price: '14550000000', expo: -8 } // $145.50
      }
    });

    await messageHandler(rawMessage);

    expect(mockRedis.pipeline).toHaveBeenCalled();
  });
});
