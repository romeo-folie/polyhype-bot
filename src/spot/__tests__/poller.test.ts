import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    SPOT_CRYPTO_ASSETS: 'bitcoin,ethereum',
    SPOT_COMMODITY_ASSETS: 'CL=F,GC=F',
  }),
}));

// Mock Redis
const mockPipeline = {
  zadd: vi.fn().mockReturnThis(),
  zremrangebyscore: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
  expire: vi.fn().mockReturnThis(),
  exec: vi.fn<() => Promise<unknown>>().mockResolvedValue([]),
};

const mockRedis = {
  pipeline: vi.fn().mockReturnValue(mockPipeline),
  zrangebyscore: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
  zrange: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
};

vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn().mockReturnValue(mockRedis),
}));

// Mock global fetch
const mockFetch = vi.fn<typeof globalThis.fetch>();
globalThis.fetch = mockFetch as typeof globalThis.fetch;

const { fetchCryptoPrices, fetchCommodityPrice, storePrice, getPriceAtLookback, pollSpotPrices } =
  await import('../poller.js');

beforeEach(() => {
  mockFetch.mockReset();
  mockPipeline.zadd.mockClear();
  mockPipeline.exec.mockClear();
  mockRedis.zrangebyscore.mockReset();
  mockRedis.zrange.mockReset();
});

describe('fetchCryptoPrices', () => {
  it('returns prices from CoinGecko response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        bitcoin: { usd: 67000, last_updated_at: 1700000000 },
        ethereum: { usd: 3500, last_updated_at: 1700000001 },
      }),
    } as Response);

    const prices = await fetchCryptoPrices(['bitcoin', 'ethereum']);

    expect(prices).toHaveLength(2);
    expect(prices[0]).toEqual({
      assetId: 'bitcoin',
      price: 67000,
      timestamp: 1700000000000,
    });
    expect(prices[1]).toEqual({
      assetId: 'ethereum',
      price: 3500,
      timestamp: 1700000001000,
    });
  });

  it('returns empty array for empty input', async () => {
    const prices = await fetchCryptoPrices([]);
    expect(prices).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    } as Response);

    await expect(fetchCryptoPrices(['bitcoin'])).rejects.toThrow('CoinGecko API error: 429');
  });

  it('skips assets missing from response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        bitcoin: { usd: 67000, last_updated_at: 1700000000 },
        // ethereum missing
      }),
    } as Response);

    const prices = await fetchCryptoPrices(['bitcoin', 'ethereum']);
    expect(prices).toHaveLength(1);
    expect(prices[0]!.assetId).toBe('bitcoin');
  });
});

describe('fetchCommodityPrice', () => {
  it('parses Yahoo Finance chart response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        chart: {
          result: [{ meta: { regularMarketPrice: 75.42 } }],
        },
      }),
    } as Response);

    const price = await fetchCommodityPrice('CL=F');

    expect(price).not.toBeNull();
    expect(price!.assetId).toBe('CL=F');
    expect(price!.price).toBe(75.42);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('CL%3DF'),
      expect.objectContaining({
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }),
    );
  });

  it('returns null when price is missing', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ chart: { result: [{ meta: {} }] } }),
    } as Response);

    const price = await fetchCommodityPrice('GC=F');
    expect(price).toBeNull();
  });

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as Response);

    await expect(fetchCommodityPrice('INVALID')).rejects.toThrow('Yahoo Finance API error');
  });
});

describe('storePrice', () => {
  it('stores price in Redis pipeline', async () => {
    await storePrice({ assetId: 'bitcoin', price: 67000, timestamp: 1700000000000 });

    expect(mockPipeline.zadd).toHaveBeenCalledWith(
      'spot:prices:bitcoin',
      1700000000000,
      '1700000000000:67000',
    );
    expect(mockPipeline.zremrangebyscore).toHaveBeenCalled();
    expect(mockPipeline.set).toHaveBeenCalledWith(
      'spot:last:bitcoin',
      JSON.stringify({ price: 67000, timestamp: 1700000000000 }),
    );
    expect(mockPipeline.exec).toHaveBeenCalledTimes(1);
  });
});

describe('getPriceAtLookback', () => {
  it('returns price closest to target timestamp', async () => {
    // Use a fixed reference point to avoid timing drift between mock setup and function call
    const now = Date.now();
    const targetTs = now - 300_000;
    // Entry at targetTs - 10s (10s before target) and targetTs + 5s (5s after target)
    // The one at +5s is closer to target
    mockRedis.zrangebyscore.mockResolvedValue([
      `${targetTs - 10_000}:65000`,
      `${targetTs + 5_000}:66000`,
    ]);

    const price = await getPriceAtLookback('bitcoin', 300_000);
    expect(price).toBe(66000);
  });

  it('falls back to oldest entry when no entries around target', async () => {
    mockRedis.zrangebyscore.mockResolvedValue([]);
    mockRedis.zrange.mockResolvedValue(['1700000000000:64000']);

    const price = await getPriceAtLookback('bitcoin', 300_000);
    expect(price).toBe(64000);
  });

  it('returns null when no data exists', async () => {
    mockRedis.zrangebyscore.mockResolvedValue([]);
    mockRedis.zrange.mockResolvedValue([]);

    const price = await getPriceAtLookback('bitcoin', 300_000);
    expect(price).toBeNull();
  });
});

describe('pollSpotPrices', () => {
  it('fetches and stores prices from both sources', async () => {
    // CoinGecko response
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          bitcoin: { usd: 67000, last_updated_at: 1700000000 },
        }),
      } as Response)
      // Yahoo Finance responses
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          chart: { result: [{ meta: { regularMarketPrice: 75.42 } }] },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          chart: { result: [{ meta: { regularMarketPrice: 2050.0 } }] },
        }),
      } as Response);

    const prices = await pollSpotPrices();

    // bitcoin from crypto + CL=F and GC=F from commodities
    expect(prices.length).toBeGreaterThanOrEqual(1);
    expect(mockPipeline.exec).toHaveBeenCalled();
  });
});
