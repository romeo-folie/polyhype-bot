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

// Default: no wallet key → on-chain check skipped, returns 0
const mockLoadConfig = vi.fn(() => ({
  POLYGON_WALLET_PRIVATE_KEY: undefined as string | undefined,
  POLYGON_RPC_URL: undefined as string | undefined,
}));

vi.mock('../config.js', () => ({
  get loadConfig() { return mockLoadConfig; },
  USDC_E_ADDRESS: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
}));

// Mock ethers — Contract.balanceOf controls on-chain return value
const mockBalanceOf = vi.fn<() => Promise<bigint>>().mockResolvedValue(0n);
vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>();
  return {
    ...actual,
    Contract: vi.fn().mockImplementation(() => ({
      balanceOf: mockBalanceOf,
    })),
    Wallet: vi.fn().mockImplementation(() => ({ address: '0xTestWallet' })),
  };
});

const { getBankroll, setBankroll, deductStake, creditProceeds, _resetCacheForTests, getOnChainUsdcBalance } =
  await import('../bankroll.js');

describe('bankroll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCacheForTests();
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 100 });
    // Default: wallet key not set → on-chain returns 0
    mockLoadConfig.mockReturnValue({ POLYGON_WALLET_PRIVATE_KEY: undefined, POLYGON_RPC_URL: undefined });
    mockBalanceOf.mockResolvedValue(0n);
  });

  it('returns Simmer balance only when no wallet key configured', async () => {
    const result = await getBankroll();
    expect(result).toBe(100);
    expect(mockGetPortfolio).toHaveBeenCalledTimes(1);
  });

  it('returns Simmer + on-chain balance combined when wallet key is set', async () => {
    mockLoadConfig.mockReturnValue({ POLYGON_WALLET_PRIVATE_KEY: 'test-key', POLYGON_RPC_URL: 'https://polygon-rpc.com' });
    mockBalanceOf.mockResolvedValue(40_000_000n); // 40 USDC.e (6 decimals)
    const result = await getBankroll();
    expect(result).toBe(140);
  });

  it('logs combined balance with all three components', async () => {
    mockLoadConfig.mockReturnValue({ POLYGON_WALLET_PRIVATE_KEY: 'test-key', POLYGON_RPC_URL: 'https://polygon-rpc.com' });
    mockBalanceOf.mockResolvedValue(40_000_000n);
    await getBankroll();
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[bankroll] combined balance',
      expect.objectContaining({ simmerUsdc: 100, onChainUsdc: 40, totalUsdc: 140 }),
    );
  });

  it('accepts optional redis parameter for backward compat', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getBankroll({} as any);
    expect(result).toBe(100);
  });

  it('logs error when total balance is zero', async () => {
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 0 });
    const result = await getBankroll();
    expect(result).toBe(0);
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[bankroll] total balance is zero or negative — all trades will be skipped',
      expect.objectContaining({ totalUsdc: 0 }),
    );
  });

  it('logs warning when total balance is suspiciously low', async () => {
    mockGetPortfolio.mockResolvedValue({ balance_usdc: 0.5 });
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
  });

  it('refreshes balance after TTL expires', async () => {
    await getBankroll();
    _resetCacheForTests();

    mockGetPortfolio.mockResolvedValue({ balance_usdc: 200 });
    mockLoadConfig.mockReturnValue({ POLYGON_WALLET_PRIVATE_KEY: 'test-key', POLYGON_RPC_URL: 'https://polygon-rpc.com' });
    mockBalanceOf.mockResolvedValue(20_000_000n); // 20 USDC.e
    const result = await getBankroll();
    expect(result).toBe(220);
  });

  it('falls back to last known balance when Simmer fails', async () => {
    await getBankroll(); // cache = 100

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

  it('degrades to Simmer-only when on-chain RPC fails', async () => {
    mockLoadConfig.mockReturnValue({ POLYGON_WALLET_PRIVATE_KEY: 'test-key', POLYGON_RPC_URL: 'https://polygon-rpc.com' });
    // All RPC attempts fail — getOnChainUsdcBalance returns 0
    mockBalanceOf.mockRejectedValue(new Error('RPC timeout'));
    const result = await getBankroll();
    expect(result).toBe(100); // Simmer only
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[bankroll]'),
      expect.any(Object),
    );
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

describe('getOnChainUsdcBalance', () => {
  it('returns 0 immediately when POLYGON_WALLET_PRIVATE_KEY is not set', async () => {
    mockLoadConfig.mockReturnValue({ POLYGON_WALLET_PRIVATE_KEY: undefined, POLYGON_RPC_URL: undefined });
    const balance = await getOnChainUsdcBalance();
    expect(balance).toBe(0);
  });

  it('returns human-unit USDC.e balance when wallet key is set', async () => {
    mockLoadConfig.mockReturnValue({ POLYGON_WALLET_PRIVATE_KEY: 'test-key', POLYGON_RPC_URL: 'https://polygon-rpc.com' });
    mockBalanceOf.mockResolvedValue(59_580_000n); // $59.58
    const balance = await getOnChainUsdcBalance();
    expect(balance).toBeCloseTo(59.58, 5);
  });

  it('returns 0 when all RPCs fail', async () => {
    mockLoadConfig.mockReturnValue({ POLYGON_WALLET_PRIVATE_KEY: 'test-key', POLYGON_RPC_URL: 'https://polygon-rpc.com' });
    mockBalanceOf.mockRejectedValue(new Error('connection refused'));
    const balance = await getOnChainUsdcBalance();
    expect(balance).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[bankroll] all RPCs failed for on-chain USDC.e balance — returning 0',
    );
  });
});

// Note: cold-start throw path tested in bankroll.coldstart.test.ts
