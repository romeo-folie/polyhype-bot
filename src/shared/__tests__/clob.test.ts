import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreateAndPostMarketOrder = jest.fn<(...args: any[]) => Promise<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetTickSize = jest.fn<(...args: any[]) => Promise<string>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetNegRisk = jest.fn<(...args: any[]) => Promise<boolean>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetBalanceAllowance = jest.fn<(...args: any[]) => Promise<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockUpdateBalanceAllowance = jest.fn<(...args: any[]) => Promise<any>>();

const mockClobClient = {
  createAndPostMarketOrder: mockCreateAndPostMarketOrder,
  getTickSize: mockGetTickSize,
  getNegRisk: mockGetNegRisk,
  getBalanceAllowance: mockGetBalanceAllowance,
  updateBalanceAllowance: mockUpdateBalanceAllowance,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createOrDeriveApiKey: jest.fn<() => Promise<any>>().mockResolvedValue({ apiKey: 'test', secret: 'test', passphrase: 'test' }),
};

jest.unstable_mockModule('@polymarket/clob-client', () => ({
  ClobClient: jest.fn(() => mockClobClient),
  OrderType: { FOK: 'FOK', FAK: 'FAK' },
  Side: { BUY: 'BUY', SELL: 'SELL' },
  AssetType: { COLLATERAL: 'COLLATERAL' },
}));

jest.unstable_mockModule('@ethersproject/wallet', () => ({
  Wallet: jest.fn(() => ({ address: '0xtest' })),
}));

jest.unstable_mockModule('../config.js', () => ({
  loadConfig: jest.fn(() => ({
    CLOB_FALLBACK_ENABLED: true,
    POLYGON_WALLET_PRIVATE_KEY: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    POLYMARKET_SIGNATURE_TYPE: 0,
    POLYMARKET_FUNDER_ADDRESS: undefined,
    CLOB_ORDER_TYPE: 'FAK',
  })),
}));

jest.unstable_mockModule('../logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockRedisGet = jest.fn<() => Promise<string | null>>().mockResolvedValue(null);
const mockRedisSet = jest.fn<() => Promise<string>>().mockResolvedValue('OK');
const mockRedisDel = jest.fn<() => Promise<number>>().mockResolvedValue(1);

jest.unstable_mockModule('../redis.js', () => ({
  getRedis: jest.fn(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
  })),
}));

const { submitClobBuy, submitClobSell, getClobBalance } = await import('../clob.js');

describe('submitClobBuy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    jest.clearAllMocks();
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
    jest.clearAllMocks();
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
