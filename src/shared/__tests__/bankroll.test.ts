import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetPortfolio = vi.fn<() => Promise<{ balance_usdc: number }>>();

vi.mock('../simmer.js', () => ({
  getPortfolio: mockGetPortfolio,
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock('../logger.js', () => ({
  logger: mockLogger,
}));

const { getBankroll, setBankroll, deductStake, creditProceeds, _resetCacheForTests } =
  await import('../bankroll.js');

describe('bankroll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCacheForTests();
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 100 });
  });

  it('returns Simmer balance only', async () => {
    const result = await getBankroll();
    expect(result).toBe(100);
    expect(mockGetPortfolio).toHaveBeenCalledTimes(1);
  });

  it('logs simmer live balance', async () => {
    await getBankroll();
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[bankroll] simmer live balance',
      expect.objectContaining({ simmerUsdc: 100 }),
    );
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
      '[bankroll] total balance is zero or negative — all trades will be skipped',
      expect.objectContaining({ totalUsdc: 0 }),
    );
  });

  it('logs warning when balance is suspiciously low', async () => {
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 0.5 });
    const result = await getBankroll();
    expect(result).toBeCloseTo(0.5);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[bankroll] total balance is suspiciously low',
      expect.objectContaining({ totalUsdc: expect.closeTo(0.5, 5) }),
    );
  });

  it('caches balance within TTL', async () => {
    await getBankroll();
    await getBankroll();
    await getBankroll();
    expect(mockGetPortfolio).toHaveBeenCalledTimes(1);
  });

  it('refreshes balance after TTL expires', async () => {
    await getBankroll();
    _resetCacheForTests();

    mockGetPortfolio.mockResolvedValue({ balance_usdc: 200 });
    const result = await getBankroll();
    expect(result).toBe(200);
  });

  it('falls back to last known balance on fetch failure', async () => {
    // First call: succeeds, caches 100
    await getBankroll();

    // Expire cache via Date.now mock
    const realDateNow = Date.now;
    Date.now = () => realDateNow() + 20_000;

    try {
      mockGetPortfolio.mockRejectedValue(new Error('Simmer API returned HTTP 503'));
      const result = await getBankroll();
      expect(result).toBe(100);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[bankroll] balance fetch failed — using last known balance',
        expect.objectContaining({ lastKnownBalance: 100 }),
      );
    } finally {
      Date.now = realDateNow;
    }
  });

  it('setBankroll is a no-op', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(setBankroll({} as any, 42)).resolves.toBeUndefined();
  });

  it('deductStake subtracts from cached balance', async () => {
    await getBankroll(); // cache = 100

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deductStake({} as any, 30);

    const after = await getBankroll();
    expect(after).toBe(70);
    expect(mockGetPortfolio).toHaveBeenCalledTimes(1); // still cached
  });

  it('deductStake does not go below zero', async () => {
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 10 });
    await getBankroll(); // cache = 10

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deductStake({} as any, 100);

    const result = await getBankroll();
    expect(result).toBe(0);
  });

  it('deductStake is safe when cache is empty', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(deductStake({} as any, 25)).resolves.toBeUndefined();
  });

  it('creditProceeds adds to cached balance', async () => {
    await getBankroll(); // cache = 100

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await creditProceeds({} as any, 30);

    const after = await getBankroll();
    expect(after).toBe(130);
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[bankroll] proceeds credited',
      expect.objectContaining({ proceedsUsd: 30, cachedBalance: 130 }),
    );
  });

  it('creditProceeds is safe when cache is empty', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(creditProceeds({} as any, 30)).resolves.toBeUndefined();
  });
});

// Note: cold-start throw path tested in bankroll.coldstart.test.ts
