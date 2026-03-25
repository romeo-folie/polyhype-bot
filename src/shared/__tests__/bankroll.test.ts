import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockGetPortfolio = jest.fn<() => Promise<{ balance_usdc: number }>>();
const mockGetClobBalance = jest.fn<() => Promise<number | null>>();

jest.unstable_mockModule('../simmer.js', () => ({
  getPortfolio: mockGetPortfolio,
}));

jest.unstable_mockModule('../clob.js', () => ({
  getClobBalance: mockGetClobBalance,
  submitClobBuy: jest.fn(),
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
    _resetCacheForTests();
    // Default: Simmer 100, CLOB 50 → combined 150
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 100 });
    mockGetClobBalance.mockResolvedValue(50);
  });

  it('returns combined Simmer + CLOB balance', async () => {
    const result = await getBankroll();
    expect(result).toBe(150);
    expect(mockGetPortfolio).toHaveBeenCalledTimes(1);
    expect(mockGetClobBalance).toHaveBeenCalledTimes(1);
  });

  it('logs combined balance breakdown', async () => {
    await getBankroll();
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[bankroll] combined live balance',
      expect.objectContaining({ simmerUsdc: 100, clobUsdc: 50, totalUsdc: 150 }),
    );
  });

  it('treats null CLOB balance as 0 (CLOB unavailable / key not configured)', async () => {
    mockGetClobBalance.mockResolvedValue(null);
    const result = await getBankroll();
    expect(result).toBe(100); // Simmer only
  });

  it('accepts optional redis parameter for backward compat', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getBankroll({} as any);
    expect(result).toBe(150);
  });

  it('logs error when combined total is zero', async () => {
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 0 });
    mockGetClobBalance.mockResolvedValue(0);
    const result = await getBankroll();
    expect(result).toBe(0);
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[bankroll] total balance is zero or negative — all trades will be skipped',
      expect.objectContaining({ totalUsdc: 0 }),
    );
  });

  it('logs warning when combined total is suspiciously low', async () => {
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 0.3 });
    mockGetClobBalance.mockResolvedValue(0.2);
    const result = await getBankroll();
    expect(result).toBeCloseTo(0.5);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[bankroll] total balance is suspiciously low',
      expect.objectContaining({ totalUsdc: expect.closeTo(0.5, 5) }),
    );
  });

  it('caches combined balance within TTL', async () => {
    await getBankroll();
    await getBankroll();
    await getBankroll();
    expect(mockGetPortfolio).toHaveBeenCalledTimes(1);
    expect(mockGetClobBalance).toHaveBeenCalledTimes(1);
  });

  it('refreshes balance after TTL expires', async () => {
    await getBankroll();
    _resetCacheForTests();

    mockGetPortfolio.mockResolvedValue({ balance_usdc: 200 });
    mockGetClobBalance.mockResolvedValue(75);
    const result = await getBankroll();
    expect(result).toBe(275);
  });

  it('falls back to last known combined balance on fetch failure', async () => {
    // First call: succeeds, caches 150
    await getBankroll();

    // Expire cache via Date.now mock
    const realDateNow = Date.now;
    Date.now = () => realDateNow() + 20_000;

    try {
      mockGetPortfolio.mockRejectedValue(new Error('Simmer API returned HTTP 503'));
      const result = await getBankroll();
      expect(result).toBe(150);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[bankroll] balance fetch failed — using last known balance',
        expect.objectContaining({ lastKnownBalance: 150 }),
      );
    } finally {
      Date.now = realDateNow;
    }
  });

  it('setBankroll is a no-op', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(setBankroll({} as any, 42)).resolves.toBeUndefined();
  });

  it('deductStake subtracts from cached combined balance', async () => {
    await getBankroll(); // cache = 150

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deductStake({} as any, 30);

    const after = await getBankroll();
    expect(after).toBe(120);
    expect(mockGetPortfolio).toHaveBeenCalledTimes(1); // still cached
  });

  it('deductStake does not go below zero', async () => {
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 10 });
    mockGetClobBalance.mockResolvedValue(5);
    await getBankroll(); // cache = 15

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deductStake({} as any, 100);

    const result = await getBankroll();
    expect(result).toBe(0);
  });

  it('deductStake is safe when cache is empty', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(deductStake({} as any, 25)).resolves.toBeUndefined();
  });

  it('creditProceeds is a no-op returning void', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(creditProceeds({} as any, 30)).resolves.toBeUndefined();
  });
});

// Note: cold-start throw path tested in bankroll.coldstart.test.ts
