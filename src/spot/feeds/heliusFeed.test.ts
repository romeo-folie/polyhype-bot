import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HeliusFeed } from './heliusFeed.js';
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
  set: vi.fn().mockReturnThis(),
};

vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn(() => mockRedis),
  closeRedis: vi.fn(),
}));

// Mock Solana and Pyth
vi.mock('@solana/web3.js', () => ({
  Connection: vi.fn(() => ({
    onAccountChange: vi.fn((addr, callback) => {
       // Store callback to simulate account change
       (global as any)._onAccountChangeCallback = callback;
       return 1; // subId
    }),
    removeAccountChangeListener: vi.fn(),
  })),
  PublicKey: vi.fn((addr) => ({ toString: () => addr })),
}));

vi.mock('@pythnetwork/client', () => ({
  parsePriceData: vi.fn(() => ({
    aggregate: { price: 200.50 },
  })),
}));

describe('HeliusFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize and subscribe to Pyth accounts', async () => {
    const feed = new HeliusFeed('fake-key', ['SOL']);
    await feed.start();

    const { Connection } = await import('@solana/web3.js');
    expect(Connection).toHaveBeenCalled();
  });

  it('should parse Pyth update and update Redis', async () => {
    const feed = new HeliusFeed('fake-key', ['SOL']);
    await feed.start();

    // Simulate account change
    const mockAccountInfo = {
      data: Buffer.alloc(100),
      executable: false,
      lamports: 1000,
      owner: null as any,
    };
    
    const callback = (global as any)._onAccountChangeCallback;
    await callback(mockAccountInfo);

    expect(mockRedis.pipeline).toHaveBeenCalled();
  });
});
