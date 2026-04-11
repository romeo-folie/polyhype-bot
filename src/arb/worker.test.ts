import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArbitrageWorker } from './worker.js';
import { runArbScan } from './scanner.js';

// Config override pattern for per-test rate-limit configs
let configOverride: Record<string, unknown> = {};

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
    BINANCE_SYMBOLS: 'btcusdt,ethusdt,solusdt',
    SPOT_CRYPTO_ASSETS: 'bitcoin,ethereum,solana',
    ARB_GLOBAL_MAX_TRADES_PER_MIN: 45,
    ...configOverride,
  })),
}));

// Mock scanner
vi.mock('./scanner.js', () => ({
  runArbScan: vi.fn().mockResolvedValue([]),
}));

vi.mock('../shared/assets.js', () => ({
  BINANCE_SYMBOL_TO_ASSET: {
    btcusdt: 'bitcoin',
    ethusdt: 'ethereum',
    solusdt: 'solana',
  },
  ASSET_SEARCH_QUERIES: {
    bitcoin: ['BTC'],
    ethereum: ['ETH'],
    solana: ['SOL'],
  },
}));

// Mock cryptoArbScanner
const mockScanCryptoArb = vi.fn().mockResolvedValue([]);
vi.mock('./cryptoArbScanner.js', () => ({
  scanCryptoArb: (...args: unknown[]) => mockScanCryptoArb(...args),
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

// Mock telemetry (all no-ops)
vi.mock('../shared/telemetry.js', () => ({
  recordCryptoArbGate: vi.fn().mockResolvedValue(undefined),
  recordCryptoArbEvent: vi.fn().mockResolvedValue(undefined),
  recordCryptoArbMetric: vi.fn().mockResolvedValue(undefined),
  recordCopytradeFilter: vi.fn().mockResolvedValue(undefined),
  recordCopytradeMalformed: vi.fn().mockResolvedValue(undefined),
  recordCopytradeMetric: vi.fn().mockResolvedValue(undefined),
}));

// Mock simmer (auto-redeem setting)
vi.mock('../shared/simmer.js', () => ({
  setAgentAutoRedeem: vi.fn().mockResolvedValue(undefined),
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
  hincrby: vi.fn().mockResolvedValue(1),
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

// Mock Chainlink feed + oracle-lag scanner — worker.start() constructs both
// unconditionally. Without these mocks, the feed would try to open a real
// WebSocket to wss://ws-live-data.polymarket.com and the scanner would hit
// Gamma, making the tests flaky/network-bound.
vi.mock('../spot/feeds/chainlinkFeed.js', () => ({
  ChainlinkFeed: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    getLatest: vi.fn().mockReturnValue(null),
    getMoveSince: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock('./oracleLagScanner.js', () => ({
  OracleLagScanner: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('ArbitrageWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configOverride = {}; // Reset config override
    // Re-apply implementations cleared by clearAllMocks
    mockRedis.on.mockImplementation(
      (event: string, callback: (channel: string, msg: string) => void) => {
        if (event === 'message') {
          onRedisMessage = callback;
        }
      },
    );
    mockRedis.subscribe.mockResolvedValue(1);
    mockRedis.unsubscribe.mockResolvedValue(1);
    mockRedis.get.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.zrange.mockResolvedValue([]);
    mockRedis.hincrby.mockResolvedValue(1);
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

    // triggerScan is fire-and-forget inside the handler — wait for async completion
    await vi.waitFor(() => expect(runArbScan).toHaveBeenCalled(), { timeout: 500 });

    worker.stop();
  });

  it('should respect rate limiting (governor)', async () => {
    // Override config so start() sets rate limit to 1 trade/min (overrides constructor arg)
    configOverride = {
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 1,
      ARB_MAX_TRADES_PER_MIN: 1,
      CRYPTO_ARB_MAX_TRADES_PER_MIN: 1,
    };
    const worker = new ArbitrageWorker({ baselineIntervalMs: 100 });
    await worker.start();

    const callback = onRedisMessage!;

    // 1st trigger
    await callback('spot:price_moved', JSON.stringify({ symbol: 'btcusdt', price: 65100 }));
    // 2nd trigger (should be ignored by governor if interval too short)
    await callback('spot:price_moved', JSON.stringify({ symbol: 'btcusdt', price: 65200 }));

    // triggerScan is fire-and-forget — wait for first scan to complete, then assert count
    await vi.waitFor(() => expect(runArbScan).toHaveBeenCalledTimes(1), { timeout: 500 });

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
      currentPmPrice: 0.6,
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

    // Use a very high maxTradesPerMin so the shared governor doesn't throttle the
    // crypto-arb per-trade check (the regular triggerScan also updates lastAnyTradeTime).
    configOverride = {
      ARB_GLOBAL_MAX_TRADES_PER_MIN: 100000,
      ARB_MAX_TRADES_PER_MIN: 100000,
      CRYPTO_ARB_MAX_TRADES_PER_MIN: 100000,
    };
    const worker = new ArbitrageWorker({ baselineIntervalMs: 100000 });
    await worker.start();

    const callback = onRedisMessage!;

    // The per-trade governor checks Date.now() against lastAnyTradeTime (set by triggerScan).
    // Both triggerScan and triggerCryptoArb fire concurrently from the same callback.
    // triggerScan sets lastAnyTradeTime early, so we need Date.now() to advance
    // enough between each call so the crypto arb governor check passes.
    let dateNowCalls = 0;
    const realDateNow = Date.now.bind(Date);
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      dateNowCalls++;
      // Advance by 10ms per call (more than enough for 100000 trades/min = 0.6ms min interval)
      return realDateNow() + dateNowCalls * 10;
    });

    await callback(
      'spot:price_moved',
      JSON.stringify({ symbol: 'btcusdt', price: 65000, timestamp: realDateNow() }),
    );

    // Wait for async crypto arb to complete
    await new Promise((r) => setTimeout(r, 100));

    dateNowSpy.mockRestore();

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
