import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockGetAssetContext = vi.fn();
vi.mock('../../shared/hyperliquid.js', () => ({
  getHyperliquid: () => ({ getAssetContext: mockGetAssetContext }),
}));

import { getCachedAssetCtx, fundingRateToApr } from '../hlAssetCtxCache.js';

function makeRedis(overrides: {
  get?: (key: string) => Promise<string | null>;
  setex?: (key: string, ttl: number, value: string) => Promise<'OK'>;
  del?: (key: string) => Promise<number>;
} = {}) {
  return {
    get: vi.fn(overrides.get ?? (() => Promise.resolve(null))),
    setex: vi.fn(overrides.setex ?? (() => Promise.resolve('OK' as const))),
    del: vi.fn(overrides.del ?? (() => Promise.resolve(1))),
  };
}

const freshCtx = { fundingRate: 0.0001, openInterest: 1_000_000, markPrice: 70_000 };

describe('fundingRateToApr', () => {
  it('converts hourly funding rate to annual APR percent (24 * 365 * 100)', () => {
    // 0.0001/hr × 8760hr × 100% = 87.6%
    expect(fundingRateToApr(0.0001)).toBeCloseTo(87.6, 3);
  });

  it('handles zero', () => {
    expect(fundingRateToApr(0)).toBe(0);
  });

  it('handles negative rates (shorts paying longs)', () => {
    expect(fundingRateToApr(-0.0001)).toBeCloseTo(-87.6, 3);
  });
});

describe('getCachedAssetCtx — cache hit', () => {
  beforeEach(() => {
    mockGetAssetContext.mockReset();
  });

  it('returns parsed ctx from cache and does not call HL', async () => {
    const redis = makeRedis({
      get: () => Promise.resolve(JSON.stringify(freshCtx)),
    });
    const result = await getCachedAssetCtx('BTC', redis as never, 60);
    expect(result).toEqual(freshCtx);
    expect(mockGetAssetContext).not.toHaveBeenCalled();
    expect(redis.setex).not.toHaveBeenCalled();
  });
});

describe('getCachedAssetCtx — cache miss', () => {
  beforeEach(() => {
    mockGetAssetContext.mockReset();
  });

  it('fetches from HL and writes to cache', async () => {
    mockGetAssetContext.mockResolvedValue(freshCtx);
    const redis = makeRedis();
    const result = await getCachedAssetCtx('BTC', redis as never, 60);
    expect(result).toEqual(freshCtx);
    expect(mockGetAssetContext).toHaveBeenCalledWith('BTC');
    expect(redis.setex).toHaveBeenCalledWith(
      'hl:asset-ctx:BTC',
      60,
      JSON.stringify(freshCtx),
    );
  });
});

describe('getCachedAssetCtx — malformed cache entry', () => {
  beforeEach(() => {
    mockGetAssetContext.mockReset();
  });

  it('deletes the malformed entry, refetches from HL, and returns fresh ctx', async () => {
    mockGetAssetContext.mockResolvedValue(freshCtx);
    const redis = makeRedis({
      get: () => Promise.resolve('not valid json{{{'),
    });
    const result = await getCachedAssetCtx('BTC', redis as never, 60);
    expect(result).toEqual(freshCtx);
    expect(redis.del).toHaveBeenCalledWith('hl:asset-ctx:BTC');
    expect(mockGetAssetContext).toHaveBeenCalledWith('BTC');
  });

  it('still refetches even when the cleanup del() throws', async () => {
    mockGetAssetContext.mockResolvedValue(freshCtx);
    const redis = makeRedis({
      get: () => Promise.resolve('not valid json'),
      del: () => Promise.reject(new Error('del boom')),
    });
    const result = await getCachedAssetCtx('BTC', redis as never, 60);
    expect(result).toEqual(freshCtx);
  });
});

describe('getCachedAssetCtx — Redis resilience', () => {
  beforeEach(() => {
    mockGetAssetContext.mockReset();
  });

  it('treats redis.get() throwing as a cache miss and still returns the HL ctx', async () => {
    mockGetAssetContext.mockResolvedValue(freshCtx);
    const redis = makeRedis({
      get: () => Promise.reject(new Error('redis down')),
    });
    const result = await getCachedAssetCtx('BTC', redis as never, 60);
    expect(result).toEqual(freshCtx);
    expect(mockGetAssetContext).toHaveBeenCalledWith('BTC');
  });

  it('returns the HL ctx even when redis.setex() fails (write cache is non-fatal)', async () => {
    mockGetAssetContext.mockResolvedValue(freshCtx);
    const redis = makeRedis({
      setex: () => Promise.reject(new Error('setex boom')),
    });
    const result = await getCachedAssetCtx('BTC', redis as never, 60);
    expect(result).toEqual(freshCtx);
  });
});

describe('getCachedAssetCtx — HL fetch failure', () => {
  beforeEach(() => {
    mockGetAssetContext.mockReset();
  });

  it('returns null (caller treats as voter-skip, signal continues)', async () => {
    mockGetAssetContext.mockRejectedValue(new Error('hl boom'));
    const redis = makeRedis();
    const result = await getCachedAssetCtx('BTC', redis as never, 60);
    expect(result).toBeNull();
  });

  it('returns null when both cache is empty and HL fetch fails', async () => {
    mockGetAssetContext.mockRejectedValue(new Error('hl boom'));
    const redis = makeRedis({ get: () => Promise.resolve(null) });
    const result = await getCachedAssetCtx('BTC', redis as never, 60);
    expect(result).toBeNull();
  });
});
