import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockGetPortfolio = jest.fn<() => Promise<{ balance_usdc: number }>>();

jest.unstable_mockModule('../simmer.js', () => ({
  getPortfolio: mockGetPortfolio,
}));

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.unstable_mockModule('../logger.js', () => ({
  logger: mockLogger,
}));

const { getBankroll, setBankroll, deductStake, creditProceeds, _resetCacheForTests } =
  await import('../bankroll.js');

describe('bankroll', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset module-level cache state between tests so each test starts fresh.
    _resetCacheForTests();
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 100 });
  });

  it('returns live Simmer balance', async () => {
    const result = await getBankroll();
    expect(result).toBe(100);
    expect(mockGetPortfolio).toHaveBeenCalledTimes(1);
  });

  it('returns updated balance when Simmer balance changes', async () => {
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 85.5 });
    const result = await getBankroll();
    expect(result).toBeCloseTo(85.5);
  });

  it('accepts optional redis parameter for backward compat', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getBankroll({} as any);
    expect(result).toBe(100);
  });

  it('logs error when balance is zero', async () => {
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 0 });
    const result = await getBankroll();
    expect(result).toBe(0);
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[bankroll] live balance is zero or negative — all trades will be skipped',
      expect.objectContaining({ balanceUsdc: 0 }),
    );
  });

  it('logs warning when balance is suspiciously low', async () => {
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 0.5 });
    const result = await getBankroll();
    expect(result).toBe(0.5);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[bankroll] live balance is suspiciously low',
      expect.objectContaining({ balanceUsdc: 0.5 }),
    );
  });

  it('caches balance within TTL — does not call Simmer on rapid successive calls', async () => {
    await getBankroll(); // populates cache
    await getBankroll(); // cache hit
    await getBankroll(); // cache hit
    expect(mockGetPortfolio).toHaveBeenCalledTimes(1);
  });

  it('refreshes balance after TTL expires', async () => {
    // Populate cache with 100
    await getBankroll();
    expect(mockGetPortfolio).toHaveBeenCalledTimes(1);

    // Expire the cache by resetting lastFetchTime to 0
    _resetCacheForTests();
    // But keep lastKnownBalance non-null by doing a successful fetch first
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 100 });
    await getBankroll();
    _resetCacheForTests(); // expire again

    // Now next call with different balance value should fetch fresh
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 120 });
    const result = await getBankroll();
    expect(result).toBe(120);
  });

  it('falls back to last known balance on Simmer API failure', async () => {
    // First call succeeds — caches balance
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 200 });
    await getBankroll();

    // Expire cache so next call attempts Simmer
    _resetCacheForTests();
    // Preserve lastKnownBalance by re-populating via a successful call, then expiring
    // Actually _resetCacheForTests clears lastKnownBalance too — we need to re-seed it:
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 200 });
    await getBankroll(); // repopulates lastKnownBalance = 200

    // Now expire only the time (simulate by using the real module: set lastFetchTime to 0)
    // Since _resetCacheForTests clears both, we instead just force a fresh expired state
    // by mocking Date.now to return far future on the next call. Simplest: just call
    // _resetCacheForTests and immediately make the next getBankroll call fail — but that
    // also clears lastKnownBalance. So we need a two-step: fetch (cache), then fail.
    // The trick: after a successful fetch, lastKnownBalance IS set. _resetCacheForTests
    // clears it. So use a workaround: don't reset, just let the cache expire naturally
    // by mocking Date.now for just this test.
    const realDateNow = Date.now;
    Date.now = () => realDateNow() + 20_000; // pretend 20s have passed

    try {
      mockGetPortfolio.mockRejectedValue(new Error('Simmer API returned HTTP 503'));
      const result = await getBankroll();
      expect(result).toBe(200);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[bankroll] Simmer API failed — using last known balance',
        expect.objectContaining({ lastKnownBalance: 200 }),
      );
    } finally {
      Date.now = realDateNow;
    }
  });

  it('setBankroll is a no-op', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(setBankroll({} as any, 42)).resolves.toBeUndefined();
  });

  it('deductStake is a no-op returning void', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(deductStake({} as any, 25)).resolves.toBeUndefined();
  });

  it('creditProceeds is a no-op returning void', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(creditProceeds({} as any, 30)).resolves.toBeUndefined();
  });
});

// Note: cold-start throw path tested in bankroll.coldstart.test.ts
