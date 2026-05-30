import { describe, it, expect, beforeEach, vi } from 'vitest';
import type * as EthersModule from 'ethers';

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
  get loadConfig() {
    return mockLoadConfig;
  },
  PUSD_ADDRESS: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
  POLYGON_FALLBACK_RPCS: ['https://polygon-rpc.com'],
}));

// Mock ethers — Contract.balanceOf controls on-chain return value
const mockBalanceOf = vi.fn<() => Promise<bigint>>().mockResolvedValue(0n);
vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof EthersModule>();
  return {
    ...actual,
    Contract: vi.fn().mockImplementation(() => ({
      balanceOf: mockBalanceOf,
    })),
    Wallet: vi.fn().mockImplementation(() => ({ address: '0xTestWallet' })),
  };
});

const {
  getBankroll,
  setBankroll,
  deductStake,
  creditProceeds,
  _resetCacheForTests,
  getOnChainUsdcBalance,
} = await import('../bankroll.js');

describe('bankroll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCacheForTests();
    // Default: wallet key not set → on-chain returns 0
    mockLoadConfig.mockReturnValue({
      POLYGON_WALLET_PRIVATE_KEY: undefined,
      POLYGON_RPC_URL: undefined,
    });
    mockBalanceOf.mockResolvedValue(0n);
  });

  it('returns 0 when no wallet key configured', async () => {
    const result = await getBankroll();
    expect(result).toBe(0);
  });

  it('returns on-chain balance when wallet key is set', async () => {
    mockLoadConfig.mockReturnValue({
      POLYGON_WALLET_PRIVATE_KEY: 'test-key',
      POLYGON_RPC_URL: 'https://polygon-rpc.com',
    });
    mockBalanceOf.mockResolvedValue(40_000_000n); // 40 USDC.e (6 decimals)
    const result = await getBankroll();
    expect(result).toBe(40);
  });

  it('logs on-chain balance', async () => {
    mockLoadConfig.mockReturnValue({
      POLYGON_WALLET_PRIVATE_KEY: 'test-key',
      POLYGON_RPC_URL: 'https://polygon-rpc.com',
    });
    mockBalanceOf.mockResolvedValue(40_000_000n);
    await getBankroll();
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[bankroll] on-chain balance',
      expect.objectContaining({ onChainUsdc: 40 }),
    );
  });

  it('accepts optional redis parameter for backward compat', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getBankroll({} as any);
    expect(result).toBe(0);
  });

  it('logs error when total balance is zero', async () => {
    const result = await getBankroll();
    expect(result).toBe(0);
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[bankroll] total balance is zero or negative — all trades will be skipped',
      expect.objectContaining({ totalUsdc: 0 }),
    );
  });

  it('logs warning when total balance is suspiciously low', async () => {
    mockLoadConfig.mockReturnValue({
      POLYGON_WALLET_PRIVATE_KEY: 'test-key',
      POLYGON_RPC_URL: 'https://polygon-rpc.com',
    });
    mockBalanceOf.mockResolvedValue(500_000n); // 0.5 USDC
    const result = await getBankroll();
    expect(result).toBeCloseTo(0.5);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[bankroll] total balance is suspiciously low',
      expect.objectContaining({ totalUsdc: expect.closeTo(0.5, 5) }),
    );
  });

  it('caches balance within TTL', async () => {
    mockLoadConfig.mockReturnValue({
      POLYGON_WALLET_PRIVATE_KEY: 'test-key',
      POLYGON_RPC_URL: 'https://polygon-rpc.com',
    });
    mockBalanceOf.mockResolvedValue(100_000_000n); // 100 USDC
    await getBankroll();
    await getBankroll();
    await getBankroll();
    // Contract mock should only be called once due to caching
    expect(mockBalanceOf).toHaveBeenCalledTimes(1);
  });

  it('refreshes balance after TTL expires', async () => {
    mockLoadConfig.mockReturnValue({
      POLYGON_WALLET_PRIVATE_KEY: 'test-key',
      POLYGON_RPC_URL: 'https://polygon-rpc.com',
    });
    mockBalanceOf.mockResolvedValue(100_000_000n); // 100 USDC
    await getBankroll();
    _resetCacheForTests();

    mockBalanceOf.mockResolvedValue(220_000_000n); // 220 USDC
    const result = await getBankroll();
    expect(result).toBe(220);
  });

  it('returns 0 gracefully when all RPCs fail (on-chain degraded)', async () => {
    // When all RPCs fail, getOnChainUsdcBalance returns 0 gracefully (never throws).
    // getBankroll then caches 0 and returns 0 — no last-known-balance fallback needed
    // since the degraded state is a valid (zero) balance, not an error.
    mockLoadConfig.mockReturnValue({
      POLYGON_WALLET_PRIVATE_KEY: 'test-key',
      POLYGON_RPC_URL: 'https://polygon-rpc.com',
    });
    mockBalanceOf.mockRejectedValue(new Error('RPC error'));
    const result = await getBankroll();
    expect(result).toBe(0);
  });

  it('returns 0 when all RPCs fail (on-chain degraded to 0)', async () => {
    mockLoadConfig.mockReturnValue({
      POLYGON_WALLET_PRIVATE_KEY: 'test-key',
      POLYGON_RPC_URL: 'https://polygon-rpc.com',
    });
    // All RPC attempts fail — getOnChainUsdcBalance returns 0
    mockBalanceOf.mockRejectedValue(new Error('RPC timeout'));
    const result = await getBankroll();
    expect(result).toBe(0);
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
    mockLoadConfig.mockReturnValue({
      POLYGON_WALLET_PRIVATE_KEY: 'test-key',
      POLYGON_RPC_URL: 'https://polygon-rpc.com',
    });
    mockBalanceOf.mockResolvedValue(100_000_000n); // 100 USDC
    await getBankroll(); // cache = 100

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deductStake({} as any, 30);

    const after = await getBankroll();
    expect(after).toBe(70);
    expect(mockBalanceOf).toHaveBeenCalledTimes(1); // still cached
  });

  it('deductStake does not go below zero', async () => {
    mockLoadConfig.mockReturnValue({
      POLYGON_WALLET_PRIVATE_KEY: 'test-key',
      POLYGON_RPC_URL: 'https://polygon-rpc.com',
    });
    mockBalanceOf.mockResolvedValue(10_000_000n); // 10 USDC
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
    mockLoadConfig.mockReturnValue({
      POLYGON_WALLET_PRIVATE_KEY: 'test-key',
      POLYGON_RPC_URL: 'https://polygon-rpc.com',
    });
    mockBalanceOf.mockResolvedValue(100_000_000n); // 100 USDC
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
    mockLoadConfig.mockReturnValue({
      POLYGON_WALLET_PRIVATE_KEY: undefined,
      POLYGON_RPC_URL: undefined,
    });
    const balance = await getOnChainUsdcBalance();
    expect(balance).toBe(0);
  });

  it('returns human-unit USDC.e balance when wallet key is set', async () => {
    mockLoadConfig.mockReturnValue({
      POLYGON_WALLET_PRIVATE_KEY: 'test-key',
      POLYGON_RPC_URL: 'https://polygon-rpc.com',
    });
    mockBalanceOf.mockResolvedValue(59_580_000n); // $59.58
    const balance = await getOnChainUsdcBalance();
    expect(balance).toBeCloseTo(59.58, 5);
  });

  it('returns 0 when all RPCs fail', async () => {
    mockLoadConfig.mockReturnValue({
      POLYGON_WALLET_PRIVATE_KEY: 'test-key',
      POLYGON_RPC_URL: 'https://polygon-rpc.com',
    });
    mockBalanceOf.mockRejectedValue(new Error('connection refused'));
    const balance = await getOnChainUsdcBalance();
    expect(balance).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[bankroll] all RPCs failed for on-chain pUSD balance — returning 0',
    );
  });

  it('uses POLYMARKET_FUNDER_ADDRESS for sigType=1 (POLY_PROXY) instead of signer wallet', async () => {
    // POLY_PROXY accounts hold collateral in the funder/proxy address, not the signer wallet.
    mockLoadConfig.mockReturnValue({
      POLYGON_WALLET_PRIVATE_KEY: 'test-key',
      POLYGON_RPC_URL: 'https://polygon-rpc.com',
      POLYMARKET_SIGNATURE_TYPE: 1,
      POLYMARKET_FUNDER_ADDRESS: '0xFunderProxy',
    });
    mockBalanceOf.mockResolvedValue(5_200_000n); // $5.20

    const { Contract } = await import('ethers');
    const balance = await getOnChainUsdcBalance();

    expect(balance).toBeCloseTo(5.2, 5);
    // balanceOf must be called with the funder address, not the signer wallet address
    expect(Contract).toHaveBeenCalled();
    const contractInstance = vi.mocked(Contract).mock.results[0]!.value as {
      balanceOf: typeof mockBalanceOf;
    };
    expect(contractInstance.balanceOf).toHaveBeenCalledWith('0xFunderProxy');
  });
});

// Note: cold-start throw path tested in bankroll.coldstart.test.ts
