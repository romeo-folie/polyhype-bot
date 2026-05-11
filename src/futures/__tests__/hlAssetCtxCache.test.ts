import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockGetAssetContext = vi.fn();
vi.mock('../../shared/hyperliquid.js', () => ({
  getHyperliquid: () => ({ getAssetContext: mockGetAssetContext }),
}));

import { getCachedAssetCtx, fundingRateToApr, getOrSetOiBaseline } from '../hlAssetCtxCache.js';

function makeRedis(overrides: {
  get?: (key: string) => Promise<string | null>;
  setex?: (key: string, ttl: number, value: string) => Promise<'OK'>;
  del?: (key: string) => Promise<number>;
  set?: (...args: unknown[]) => Promise<string | null>;
} = {}) {
  return {
    get: vi.fn(overrides.get ?? (() => Promise.resolve(null))),
    setex: vi.fn(overrides.setex ?? (() => Promise.resolve('OK' as const))),
    del: vi.fn(overrides.del ?? (() => Promise.resolve(1))),
    // SET NX EX returns 'OK' on success, null when key already exists.
    set: vi.fn(overrides.set ?? (() => Promise.resolve('OK' as string | null))),
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

// ---------------------------------------------------------------------------
// getOrSetOiBaseline (issue #265 Sub-PR 2)
// ---------------------------------------------------------------------------

describe('getOrSetOiBaseline — baseline mechanics', () => {
  it('returns null on first tick, calls SET NX (not setex) with correct TTL', async () => {
    const redis = makeRedis({ get: () => Promise.resolve(null) });
    const result = await getOrSetOiBaseline('BTC', redis as never, 1_000_000, 70_000, 900);
    expect(result).toBeNull(); // neutral tick — no prior baseline
    expect(redis.setex).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledWith(
      'hl:oi-baseline:BTC',
      expect.stringContaining('"oi":1000000'),
      'EX', 900, 'NX',
    );
  });

  it('returns the stored baseline when one already exists (no SET called)', async () => {
    const stored = { oi: 950_000, markPrice: 68_000, ts: Date.now() - 300_000 };
    const redis = makeRedis({ get: () => Promise.resolve(JSON.stringify(stored)) });
    const result = await getOrSetOiBaseline('BTC', redis as never, 1_000_000, 70_000, 900);
    expect(result).toEqual(stored);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('deletes a malformed baseline, attempts fresh SET NX, returns null', async () => {
    const redis = makeRedis({ get: () => Promise.resolve('bad json{') });
    const result = await getOrSetOiBaseline('BTC', redis as never, 1_000_000, 70_000, 900);
    expect(result).toBeNull();
    expect(redis.del).toHaveBeenCalledWith('hl:oi-baseline:BTC');
    expect(redis.set).toHaveBeenCalled();
  });

  it('still returns null (neutral tick) when redis.get() throws', async () => {
    const redis = makeRedis({ get: () => Promise.reject(new Error('redis down')) });
    const result = await getOrSetOiBaseline('BTC', redis as never, 1_000_000, 70_000, 900);
    expect(result).toBeNull();
  });

  it('reads the winner key when NX race is lost (returns existing baseline, not null)', async () => {
    // Sequence: GET → null (key just expired), SET NX → null (another process beat us),
    // second GET → returns what the winner wrote. Caller gets the baseline, not null.
    const winner = { oi: 1_050_000, markPrice: 71_000, ts: Date.now() - 5_000 };
    let getCallCount = 0;
    const redis = makeRedis({
      get: () => {
        getCallCount++;
        // First GET: miss; second GET (after NX loss): returns winner's value
        return Promise.resolve(getCallCount >= 2 ? JSON.stringify(winner) : null);
      },
      set: () => Promise.resolve(null), // null = NX lost (key already set by other process)
    });
    const result = await getOrSetOiBaseline('BTC', redis as never, 1_000_000, 70_000, 900);
    expect(result).toEqual(winner);
  });

  it('returns null when NX race is lost AND second GET also fails', async () => {
    const redis = makeRedis({
      get: () => Promise.resolve(null), // always miss
      set: () => Promise.resolve(null), // NX lost
    });
    // Second GET will also return null → neutral tick, no crash.
    const result = await getOrSetOiBaseline('BTC', redis as never, 1_000_000, 70_000, 900);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getAllCachedAssetCtxs — bulk cache
// ---------------------------------------------------------------------------

const mockGetAllAssetContexts = vi.fn();
// Override the mock for bulk tests to expose getAllAssetContexts.
vi.mock('../../shared/hyperliquid.js', () => ({
  getHyperliquid: () => ({
    getAssetContext: mockGetAssetContext,
    getAllAssetContexts: mockGetAllAssetContexts,
  }),
}));

import { getAllCachedAssetCtxs } from '../hlAssetCtxCache.js';

const bulkMap = {
  BTC: { fundingRate: 0.0001, openInterest: 1_000_000, markPrice: 70_000 },
  ETH: { fundingRate: -0.00005, openInterest: 500_000, markPrice: 3_500 },
};

describe('getAllCachedAssetCtxs — cache hit', () => {
  it('returns parsed map from cache without calling HL', async () => {
    const redis = makeRedis({ get: () => Promise.resolve(JSON.stringify(bulkMap)) });
    const result = await getAllCachedAssetCtxs(redis as never, 120);
    expect(result).toEqual(bulkMap);
    expect(mockGetAllAssetContexts).not.toHaveBeenCalled();
  });
});

describe('getAllCachedAssetCtxs — cache miss', () => {
  beforeEach(() => { mockGetAllAssetContexts.mockReset(); });

  it('fetches from HL, caches, and returns result', async () => {
    mockGetAllAssetContexts.mockResolvedValue(bulkMap);
    const redis = makeRedis();
    const result = await getAllCachedAssetCtxs(redis as never, 120);
    expect(result).toEqual(bulkMap);
    expect(mockGetAllAssetContexts).toHaveBeenCalledOnce();
    expect(redis.setex).toHaveBeenCalledWith('hl:asset-ctx:all', 120, JSON.stringify(bulkMap));
  });

  it('returns {} and does not throw when HL fetch fails', async () => {
    mockGetAllAssetContexts.mockRejectedValue(new Error('network error'));
    const redis = makeRedis();
    const result = await getAllCachedAssetCtxs(redis as never, 120);
    expect(result).toEqual({});
  });
});

describe('getAllCachedAssetCtxs — malformed cache entry', () => {
  beforeEach(() => { mockGetAllAssetContexts.mockReset(); });

  it('deletes malformed entry, refetches, and returns fresh map', async () => {
    mockGetAllAssetContexts.mockResolvedValue(bulkMap);
    const redis = makeRedis({ get: () => Promise.resolve('not valid json{{{') });
    const result = await getAllCachedAssetCtxs(redis as never, 120);
    expect(result).toEqual(bulkMap);
    expect(redis.del).toHaveBeenCalledWith('hl:asset-ctx:all');
    expect(mockGetAllAssetContexts).toHaveBeenCalledOnce();
  });
});
