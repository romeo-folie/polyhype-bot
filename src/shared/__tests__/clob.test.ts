import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockCreateAndPostMarketOrder = vi.fn();
const mockGetTickSize = vi.fn();
const mockGetNegRisk = vi.fn();
const mockGetBalanceAllowance = vi.fn();
const mockUpdateBalanceAllowance = vi.fn();
const mockSendTransaction = vi.fn();
const mockWait = vi.fn();
const mockExecTransaction = vi.fn();
const mockNonce = vi.fn();
const mockGetTransactionHash = vi.fn();

// Mock ethers v6
vi.mock('ethers', () => ({
  Wallet: vi.fn(() => ({
    address: '0xtest',
    sendTransaction: mockSendTransaction,
    signingKey: {
      sign: () => ({
        r: '0x' + '0'.repeat(64),
        s: '0x' + '0'.repeat(64),
        v: 27,
      }),
    },
  })),
  Contract: vi.fn(() => ({
    execTransaction: mockExecTransaction,
    nonce: mockNonce,
    getTransactionHash: mockGetTransactionHash,
  })),
  Interface: vi.fn(() => ({
    encodeFunctionData: vi.fn(() => '0xencodeddata'),
  })),
  JsonRpcProvider: vi.fn(() => ({})),
  getBytes: vi.fn((val) => val),
}));

vi.mock('@polymarket/clob-client', () => ({
  ClobClient: vi.fn(() => ({
    createAndPostMarketOrder: mockCreateAndPostMarketOrder,
    getTickSize: mockGetTickSize,
    getNegRisk: mockGetNegRisk,
    getBalanceAllowance: mockGetBalanceAllowance,
    updateBalanceAllowance: mockUpdateBalanceAllowance,
    createOrDeriveApiKey: vi.fn().mockResolvedValue({ apiKey: 'test', secret: 'test', passphrase: 'test' }),
  })),
  OrderType: { FOK: 'FOK', FAK: 'FAK' },
  Side: { BUY: 'BUY', SELL: 'SELL' },
  AssetType: { COLLATERAL: 'COLLATERAL' },
}));

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({
    CLOB_FALLBACK_ENABLED: true,
    POLYGON_WALLET_PRIVATE_KEY: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    POLYMARKET_SIGNATURE_TYPE: 0,
    POLYMARKET_FUNDER_ADDRESS: undefined,
    CLOB_ORDER_TYPE: 'FAK',
  })),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../redis.js', () => ({
  getRedis: vi.fn(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  })),
}));

const { submitClobBuy, submitClobSell, getClobBalance, redeemClobOutcome } = await import('../clob.js');

describe('submitClobBuy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTickSize.mockResolvedValue('0.01');
    mockGetNegRisk.mockResolvedValue(false);
    mockGetBalanceAllowance.mockResolvedValue({ balance: '1000000000', allowance: '1000000000' });
    mockUpdateBalanceAllowance.mockResolvedValue(undefined);
  });

  it('returns success on a successful order', async () => {
    mockCreateAndPostMarketOrder.mockResolvedValue({
      success: true,
      errorMsg: '',
      orderID: 'order-123',
      transactionsHashes: ['0xtxhash'],
      status: 'matched',
      takingAmount: '10.5',
      makingAmount: '5',
    });

    const result = await submitClobBuy({ tokenId: 'tok-yes', amountUsd: 5 });

    expect(result.success).toBe(true);
    expect(result.tx_hash).toBe('0xtxhash');
    expect(result.shares_bought).toBeCloseTo(10.5);
  });

  it('returns error when order has success=false', async () => {
    mockCreateAndPostMarketOrder.mockResolvedValue({
      success: false,
      errorMsg: 'insufficient balance',
      orderID: '',
      transactionsHashes: [],
      status: 'failed',
      takingAmount: '0',
      makingAmount: '0',
    });

    const result = await submitClobBuy({ tokenId: 'tok-yes', amountUsd: 5 });

    expect(result.success).toBe(false);
    expect(result.error).toBe('insufficient balance');
  });

  it('returns error on timeout', async () => {
    mockCreateAndPostMarketOrder.mockImplementation(
      () => new Promise(() => { /* never resolves */ }),
    );

    const result = await submitClobBuy({ tokenId: 'tok-yes', amountUsd: 5 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  }, 35_000);

  it('rejects when balance is insufficient', async () => {
    mockGetBalanceAllowance.mockResolvedValue({ balance: '2000000', allowance: '0' });

    const result = await submitClobBuy({ tokenId: 'tok-yes', amountUsd: 5 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient CLOB balance');
    expect(mockCreateAndPostMarketOrder).not.toHaveBeenCalled();
  });
});

describe('submitClobSell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTickSize.mockResolvedValue('0.01');
    mockGetNegRisk.mockResolvedValue(false);
  });

  it('returns success on a successful sell', async () => {
    mockCreateAndPostMarketOrder.mockResolvedValue({
      success: true,
      errorMsg: '',
      orderID: 'order-456',
      transactionsHashes: ['0xselltx'],
      status: 'matched',
      takingAmount: '8.0',
      makingAmount: '10',
    });

    const result = await submitClobSell({ tokenId: 'tok-yes', shares: 10 });

    expect(result.success).toBe(true);
    expect(result.tx_hash).toBe('0xselltx');
    expect(result.shares_bought).toBeCloseTo(8.0);
  });

  it('returns error when sell order fails', async () => {
    mockCreateAndPostMarketOrder.mockResolvedValue({
      success: false,
      errorMsg: 'no liquidity',
      orderID: '',
      transactionsHashes: [],
      status: 'failed',
      takingAmount: '0',
      makingAmount: '0',
    });

    const result = await submitClobSell({ tokenId: 'tok-yes', shares: 10 });

    expect(result.success).toBe(false);
    expect(result.error).toBe('no liquidity');
  });

  it('returns error on timeout', async () => {
    mockCreateAndPostMarketOrder.mockImplementation(
      () => new Promise(() => { /* never resolves */ }),
    );

    const result = await submitClobSell({ tokenId: 'tok-yes', shares: 10 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  }, 35_000);
});

describe('getClobBalance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateBalanceAllowance.mockResolvedValue(undefined);
  });

  it('returns balance and allowance separately', async () => {
    mockGetBalanceAllowance.mockResolvedValue({ balance: '100500000', allowance: '50250000' });

    const result = await getClobBalance();

    expect(result).toEqual({ balance: 100.5, allowance: 50.25 });
  });

  it('returns null on error', async () => {
    mockGetBalanceAllowance.mockImplementation(() => Promise.reject(new Error('network error')));

    const result = await getClobBalance();

    expect(result).toBeNull();
  });
});

describe('redeemClobOutcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWait.mockResolvedValue({ hash: '0xredeemhash' });
    mockSendTransaction.mockResolvedValue({ wait: mockWait });
    mockExecTransaction.mockResolvedValue({ wait: mockWait });
    mockNonce.mockResolvedValue(42);
    mockGetTransactionHash.mockResolvedValue('0xsafetxhash');
  });

  it('executes via EOA when sigType=0', async () => {
    const result = await redeemClobOutcome({ conditionId: 'cond-123', direction: 'YES' });

    expect(result.success).toBe(true);
    expect(result.tx_hash).toBe('0xredeemhash');
    expect(mockSendTransaction).toHaveBeenCalled();
  });

  it('executes via Safe Proxy when sigType=1', async () => {
    const { loadConfig } = await import('../config.js');
    (loadConfig as any).mockReturnValue({
      POLYGON_WALLET_PRIVATE_KEY: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      POLYMARKET_SIGNATURE_TYPE: 1,
      POLYMARKET_FUNDER_ADDRESS: '0xproxyaddress',
      CLOB_FALLBACK_ENABLED: true,
    });

    const result = await redeemClobOutcome({ conditionId: 'cond-123', direction: 'NO' });

    expect(result.success).toBe(true);
    expect(result.tx_hash).toBe('0xredeemhash');
    expect(mockExecTransaction).toHaveBeenCalled();
  });
});
