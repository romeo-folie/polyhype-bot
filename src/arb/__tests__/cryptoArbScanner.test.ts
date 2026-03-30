import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SpotMove } from '../../spot/thresholdDetector.js';
import type { Redis } from 'ioredis';

// --- Mocks ---

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    CRYPTO_ARB_ENABLED: true,
    CRYPTO_ARB_MIN_EDGE: 0.08,
    CRYPTO_ARB_MAX_STAKE_FRACTION: 0.03,
    CRYPTO_ARB_DEDUP_TTL_S: 300,
    CRYPTO_ARB_MARKET_CACHE_TTL_S: 3600,
    ARB_FEE_RATE: 0.02,
    MAX_BET_FRACTION: 0.1,
    WS_ENABLED: false,
  })),
}));

const mockFindCorrelatedMarkets = vi.fn();
vi.mock('../../spot/marketCorrelator.js', () => ({
  findCorrelatedMarkets: (...args: unknown[]) => mockFindCorrelatedMarkets(...args),
}));

const mockEstimateFastConsensus = vi.fn();
vi.mock('../../spot/fastPathConsensus.js', () => ({
  estimateFastConsensus: (...args: unknown[]) => mockEstimateFastConsensus(...args),
}));

vi.mock('../../shared/feedSingleton.js', () => ({
  getPriceFeed: vi.fn(() => ({
    getCachedPrice: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock('../../shared/bankroll.js', () => ({
  getBankroll: vi.fn().mockResolvedValue(1000),
}));

const mockRedis = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
};

function makeMove(overrides: Partial<SpotMove> = {}): SpotMove {
  return {
    assetId: 'bitcoin',
    currentPrice: 65000,
    referencePrice: 62000,
    changePercent: 4.84,
    windowMinutes: 5,
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMarket(overrides: Record<string, unknown> = {}) {
  return {
    marketId: 'mkt-1',
    conditionId: 'cond-1',
    clobTokenIds: ['yes-tok', 'no-tok'],
    question: 'Will Bitcoin be above $100,000 on June 30, 2026?',
    description: null,
    currentYesPrice: 0.60,
    correlationDirection: 'positive' as const,
    ...overrides,
  };
}

describe('cryptoArbScanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue('OK');
  });

  it('detects YES edge on price-target market', async () => {
    const { scanCryptoArb } = await import('../cryptoArbScanner.js');

    mockFindCorrelatedMarkets.mockResolvedValue([makeMarket()]);
    mockEstimateFastConsensus.mockResolvedValue({
      probability: 0.75,
      reasoning: 'formula',
      method: 'formula',
      stddev: 0,
    });

    const opps = await scanCryptoArb(makeMove(), mockRedis as never);

    expect(opps).toHaveLength(1);
    expect(opps[0]!.direction).toBe('YES');
    // edge = |0.75 - 0.60| - 0.02 = 0.13
    expect(opps[0]!.edge).toBeCloseTo(0.13, 2);
    expect(opps[0]!.tokenId).toBe('yes-tok');
    expect(opps[0]!.marketId).toBe('mkt-1');
  });

  it('detects NO edge when fair value below PM price', async () => {
    const { scanCryptoArb } = await import('../cryptoArbScanner.js');

    mockFindCorrelatedMarkets.mockResolvedValue([makeMarket({ currentYesPrice: 0.45 })]);
    mockEstimateFastConsensus.mockResolvedValue({
      probability: 0.30,
      reasoning: 'formula',
      method: 'formula',
      stddev: 0,
    });

    const opps = await scanCryptoArb(makeMove(), mockRedis as never);

    expect(opps).toHaveLength(1);
    expect(opps[0]!.direction).toBe('NO');
    // edge = |0.30 - 0.45| - 0.02 = 0.13
    expect(opps[0]!.edge).toBeCloseTo(0.13, 2);
    expect(opps[0]!.tokenId).toBe('no-tok');
  });

  it('returns empty when edge below threshold', async () => {
    const { scanCryptoArb } = await import('../cryptoArbScanner.js');

    mockFindCorrelatedMarkets.mockResolvedValue([makeMarket({ currentYesPrice: 0.60 })]);
    // edge = |0.65 - 0.60| - 0.02 = 0.03 < 0.08
    mockEstimateFastConsensus.mockResolvedValue({
      probability: 0.65,
      reasoning: 'formula',
      method: 'formula',
      stddev: 0,
    });

    const opps = await scanCryptoArb(makeMove(), mockRedis as never);
    expect(opps).toHaveLength(0);
  });

  it('skips market when dedup key exists', async () => {
    const { scanCryptoArb } = await import('../cryptoArbScanner.js');

    mockFindCorrelatedMarkets.mockResolvedValue([makeMarket()]);
    mockEstimateFastConsensus.mockResolvedValue({
      probability: 0.75,
      reasoning: 'formula',
      method: 'formula',
      stddev: 0,
    });

    // Simulate dedup key exists for this market+direction
    mockRedis.get.mockImplementation((key: string) => {
      if (key === 'arb:crypto:mkt-1:YES') return Promise.resolve('1');
      return Promise.resolve(null);
    });

    const opps = await scanCryptoArb(makeMove(), mockRedis as never);
    expect(opps).toHaveLength(0);
  });

  it('uses cached markets when available', async () => {
    const { scanCryptoArb } = await import('../cryptoArbScanner.js');

    const cachedMarkets = [makeMarket()];
    mockRedis.get.mockImplementation((key: string) => {
      if (key === 'crypto:markets:bitcoin') return Promise.resolve(JSON.stringify(cachedMarkets));
      return Promise.resolve(null);
    });

    mockEstimateFastConsensus.mockResolvedValue({
      probability: 0.75,
      reasoning: 'formula',
      method: 'formula',
      stddev: 0,
    });

    const opps = await scanCryptoArb(makeMove(), mockRedis as never);

    expect(opps).toHaveLength(1);
    // findCorrelatedMarkets should NOT be called when cache hit
    expect(mockFindCorrelatedMarkets).not.toHaveBeenCalled();
  });

  it('skips market when estimateFastConsensus returns method=llm', async () => {
    const { scanCryptoArb } = await import('../cryptoArbScanner.js');

    mockFindCorrelatedMarkets.mockResolvedValue([makeMarket()]);
    mockEstimateFastConsensus.mockResolvedValue({
      probability: 0.75,
      reasoning: 'llm fallback',
      method: 'llm',
      stddev: 0.05,
    });

    const opps = await scanCryptoArb(makeMove(), mockRedis as never);

    expect(opps).toHaveLength(0);
    expect(mockEstimateFastConsensus).toHaveBeenCalledTimes(1);
  });

  it('returns empty for unknown asset without error', async () => {
    const { scanCryptoArb } = await import('../cryptoArbScanner.js');

    const opps = await scanCryptoArb(
      makeMove({ assetId: 'unknown-coin' }),
      mockRedis as never,
    );

    expect(opps).toHaveLength(0);
    expect(mockFindCorrelatedMarkets).not.toHaveBeenCalled();
  });
});

// ── computeVolatility ───────────────────────────────────────────────────────

function makeRedisWithPrices(prices: (number | null)[]): Redis {
  // Encode as "timestamp:price" sorted-set members (only the value part matters)
  const entries = prices.map((p, i) =>
    p != null ? `${String(1000 + i)}:${String(p)}` : `${String(1000 + i)}:NaN`,
  );
  return {
    zrange: vi.fn().mockResolvedValue(entries),
  } as unknown as Redis;
}

describe('computeVolatility', () => {
  it('returns null when fewer than 2 entries', async () => {
    const { computeVolatility } = await import('../cryptoArbScanner.js');
    const redis = { zrange: vi.fn().mockResolvedValue(['1000:50000']) } as unknown as Redis;
    expect(await computeVolatility('btcusdt', redis)).toBeNull();
  });

  it('computes mean absolute percentage change correctly', async () => {
    const { computeVolatility } = await import('../cryptoArbScanner.js');
    // 100 → 110 → 99 → changes: +10%, -10%
    // MAPC = (0.10 + 0.10) / 2 = 0.10
    const redis = makeRedisWithPrices([100, 110, 99]);
    const vol = await computeVolatility('btcusdt', redis);
    expect(vol).not.toBeNull();
    expect(vol!).toBeCloseTo(0.10, 5);
  });

  it('forward-fills invalid entries instead of creating gaps', async () => {
    const { computeVolatility } = await import('../cryptoArbScanner.js');
    // 100, NaN (filled to 100), 110 → changes: 0%, +10%
    // MAPC = (0 + 0.10) / 2 = 0.05  (not 0.10 which a gap would produce)
    const redis = makeRedisWithPrices([100, null, 110]);
    const vol = await computeVolatility('btcusdt', redis);
    expect(vol).not.toBeNull();
    expect(vol!).toBeCloseTo(0.05, 5);
  });

  it('returns null when all entries are invalid', async () => {
    const { computeVolatility } = await import('../cryptoArbScanner.js');
    const redis = makeRedisWithPrices([null, null, null]);
    expect(await computeVolatility('btcusdt', redis)).toBeNull();
  });
});

// ── Volatility gate ─────────────────────────────────────────────────────────

describe('scanCryptoArb — volatility gate', () => {
  const gatedConfig = {
    CRYPTO_ARB_ENABLED: true,
    CRYPTO_ARB_VOLATILITY_GATE_ENABLED: true,
    CRYPTO_ARB_MIN_VOLATILITY: 0.005,
    CRYPTO_ARB_MAX_VOLATILITY: 0.10,
    CRYPTO_ARB_MIN_EDGE: 0.08,
    CRYPTO_ARB_MAX_STAKE_FRACTION: 0.03,
    CRYPTO_ARB_DEDUP_TTL_S: 300,
    CRYPTO_ARB_MARKET_CACHE_TTL_S: 3600,
    ARB_FEE_RATE: 0.02,
    MAX_BET_FRACTION: 0.1,
    WS_ENABLED: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips scan when volatility is below floor (flat market)', async () => {
    const { loadConfig } = await import('../../shared/config.js');
    vi.mocked(loadConfig).mockReturnValue(gatedConfig as never);

    const { scanCryptoArb } = await import('../cryptoArbScanner.js');

    // Very low vol: 100 → 100.001 → 100.002 → ~0.001% each step
    const redis = makeRedisWithPrices([100, 100.001, 100.002]);
    const opps = await scanCryptoArb(makeMove({ assetId: 'bitcoin' }), redis as never);
    expect(opps).toHaveLength(0);
  });

  it('skips scan when volatility exceeds ceiling (too spiky)', async () => {
    const { loadConfig } = await import('../../shared/config.js');
    vi.mocked(loadConfig).mockReturnValue(gatedConfig as never);

    const { scanCryptoArb } = await import('../cryptoArbScanner.js');

    // Very high vol: 100 → 150 → 75 → 50% each step
    const redis = makeRedisWithPrices([100, 150, 75]);
    const opps = await scanCryptoArb(makeMove({ assetId: 'bitcoin' }), redis as never);
    expect(opps).toHaveLength(0);
  });
});
