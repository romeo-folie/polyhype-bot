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

// Each test file gets a fresh module — lastKnownBalance starts as null.
const { getBankroll, setBankroll, deductStake, creditProceeds } = await import('../bankroll.js');

describe('bankroll', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

  it('falls back to last known balance on Simmer API failure', async () => {
    // First call succeeds — caches balance
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 200 });
    await getBankroll();

    // Second call fails — should return cached value
    mockGetPortfolio.mockRejectedValue(new Error('Simmer API returned HTTP 503'));
    const result = await getBankroll();
    expect(result).toBe(200);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[bankroll] Simmer API failed — using last known balance',
      expect.objectContaining({ lastKnownBalance: 200 }),
    );
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

// Note: the cold-start throw path (lastKnownBalance === null + API failure → throws)
// is tested in bankroll.coldstart.test.ts, which gets a fresh module instance.
describe('bankroll — error fallback with cached balance', () => {
  it('falls back to prior cached balance when Simmer fails mid-run', async () => {
    mockGetPortfolio.mockReset();
    mockGetPortfolio.mockRejectedValue(new Error('Simmer API returned HTTP 503'));

    // lastKnownBalance was populated by earlier tests in this file —
    // verify that the fallback path returns the cached value.
    const result = await getBankroll();
    expect(typeof result).toBe('number');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[bankroll] Simmer API failed — using last known balance',
      expect.any(Object),
    );
  });
});
