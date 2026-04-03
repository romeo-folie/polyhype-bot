import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HeliusFeed } from './heliusFeed.js';
import WebSocket from 'ws';

// Mock Redis singleton
const mockPipeline = {
  hset: vi.fn().mockReturnThis(),
  publish: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue([]),
};

const mockRedis = {
  pipeline: vi.fn(() => mockPipeline),
};

vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn(() => mockRedis),
  closeRedis: vi.fn(),
}));

// vi.mock factories are hoisted before variable declarations, so use vi.hoisted
// to define the constructor mock in a way that's safe to reference inside the factory.
const mockWsCtor = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    send: vi.fn(),
    terminate: vi.fn(),
    removeAllListeners: vi.fn(),
  })),
);

// Provide both default and named export to match:
//   source: `import { WebSocket } from 'ws'`
//   test:   `import WebSocket from 'ws'`
vi.mock('ws', () => ({
  default: mockWsCtor,
  WebSocket: mockWsCtor,
}));

describe('HeliusFeed (Hermes)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize and subscribe to price feeds on open', async () => {
    const feed = new HeliusFeed('fake-key', ['SOL', 'BTC']);

    // Catch the 'open' callback
    let openCallback: () => void = () => {};
    const mockWs = {
      on: vi.fn((event, cb) => {
        if (event === 'open') openCallback = cb;
      }),
      send: vi.fn(),
    };
    (WebSocket as unknown as any).mockReturnValue(mockWs);

    await feed.start();

    // Trigger open
    openCallback();

    expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('subscribe'));
    expect(mockWs.send).toHaveBeenCalledWith(
      expect.stringContaining('0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d'),
    );
  });

  it('should handle price_update messages and update Redis', async () => {
    const feed = new HeliusFeed('fake-key', ['SOL']);

    let messageCallback: (data: string) => void = () => {};
    const mockWs = {
      on: vi.fn((event, cb) => {
        if (event === 'message') messageCallback = cb;
      }),
      send: vi.fn(),
    };
    (WebSocket as unknown as any).mockReturnValue(mockWs);

    await feed.start();

    // Simulate Hermes message
    const mockMsg = {
      type: 'price_update',
      price_feed: {
        id: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
        price: {
          price: '20050',
          expo: -2,
        },
      },
    };

    messageCallback(JSON.stringify(mockMsg));

    // handleUpdate is fire-and-forget (void) — wait for the pipeline write to settle
    await vi.waitFor(() => {
      expect(mockRedis.pipeline).toHaveBeenCalled();
    });
    expect(mockPipeline.hset).toHaveBeenCalledWith('spot:prices', 'sol', '200.5');
    expect(mockPipeline.publish).toHaveBeenCalledWith(
      'spot:price_moved',
      expect.stringContaining('sol'),
    );
  });
});
