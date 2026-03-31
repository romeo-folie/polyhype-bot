import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArbitrageWorker } from './worker.js';
import { runArbScan } from './scanner.js';

// Mock Config
vi.mock('../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    ARB_ENABLED: true,
    CLOB_FALLBACK_ENABLED: true,
    CRYPTO_ARB_ENABLED: true,
    CRYPTO_ARB_MIN_EDGE: 0.08,
    CRYPTO_ARB_MAX_STAKE_FRACTION: 0.03,
    CRYPTO_ARB_DEDUP_TTL_S: 300,
    CRYPTO_ARB_MARKET_CACHE_TTL_S: 3600,
  })),
}));

// Mock scanner
vi.mock('./scanner.js', () => ({
  runArbScan: vi.fn().mockResolvedValue([]),
}));

// Mock cryptoArbScanner
const mockScanCryptoArb = vi.fn().mockResolvedValue([]);
vi.mock('./cryptoArbScanner.js', () => ({
  scanCryptoArb: (...args: unknown[]) => mockScanCryptoArb(...args),
  BINANCE_SYMBOL_TO_ASSET: {
    btcusdt: 'bitcoin',
    ethusdt: 'ethereum',
    solusdt: 'solana',
  },
}));

// Mock executor
const mockExecuteSignal = vi.fn().mockResolvedValue({ skipped: true, skipReason: 'test' });
vi.mock('../execution/executor.js', () => ({
  executeSignal: (...args: unknown[]) => mockExecuteSignal(...args),
}));

// Mock positionLedger
vi.mock('../execution/positionLedger.js', () => ({
  recordPosition: vi.fn().mockResolvedValue(undefined),
}));

// Mock bankroll
vi.mock('../shared/bankroll.js', () => ({
  deductStake: vi.fn().mockResolvedValue(undefined),
}));

// Mock Redis with Pub/Sub listeners
// Local capture of the Redis pub/sub message callback — avoids global namespace
// pollution that could cause collisions if test files run concurrently.
let onRedisMessage: ((channel: string, msg: string) => void) | null = null;

const mockRedis = {
  subscribe: vi.fn().mockResolvedValue(1),
  unsubscribe: vi.fn().mockResolvedValue(1),
  on: vi.fn((event: string, callback: (channel: string, msg: string) => void) => {
    if (event === 'message') {
      onRedisMessage = callback;
    }
  }),
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  zrange: vi.fn().mockResolvedValue([]),
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
    const callback = onRedisMessage!;
    await callback('spot:price_moved', JSON.stringify({ symbol: 'btcusdt', price: 65000 }));

    expect(runArbScan).toHaveBeenCalled();

    worker.stop();
  });

  it('should respect rate limiting (governor)', async () => {
     // Config with high rate limit for testing
     const worker = new ArbitrageWorker({ baselineIntervalMs: 100, maxTradesPerMin: 1 });
     await worker.start();

     const callback = onRedisMessage!;

     // 1st trigger
     await callback('spot:price_moved', JSON.stringify({ symbol: 'btcusdt', price: 65100 }));
     // 2nd trigger (should be ignored by governor if interval too short)
     await callback('spot:price_moved', JSON.stringify({ symbol: 'btcusdt', price: 65200 }));

     // Scan only called once because governor throttles it
     expect(runArbScan).toHaveBeenCalledTimes(1);

     worker.stop();
  });

  it('should trigger crypto arb on spot:price_moved with known symbol', async () => {
    const mockOpp = {
      marketId: 'mkt-btc-100k',
      conditionId: 'cond-1',
      clobTokenIds: ['yes-tok', 'no-tok'],
      question: 'Will Bitcoin be above $100,000?',
      direction: 'YES' as const,
      tokenId: 'yes-tok',
      currentPmPrice: 0.60,
      fairValuePrice: 0.75,
      edge: 0.13,
      stakeUsd: 3.9,
      assetId: 'bitcoin',
    };

    mockScanCryptoArb.mockResolvedValueOnce([mockOpp]);
    mockExecuteSignal.mockResolvedValueOnce({
      signal: {},
      skipped: false,
      tradeResult: { success: true, tx_hash: '0xabc' },
      executionVenue: 'simmer',
    });

    const worker = new ArbitrageWorker({ baselineIntervalMs: 100000 });
    await worker.start();

    const callback = onRedisMessage!;
    await callback('spot:price_moved', JSON.stringify({ symbol: 'btcusdt', price: 65000, timestamp: Date.now() }));

    // Wait for async crypto arb to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(mockScanCryptoArb).toHaveBeenCalledTimes(1);
    expect(mockExecuteSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        marketId: 'mkt-btc-100k',
        direction: 'YES',
        stakeUsd: 3.9,
        sourcedFrom: 'crypto-arb:bitcoin',
      }),
      expect.anything(),
    );

    worker.stop();
  });
});
