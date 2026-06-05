import { vi, describe, it, expect, beforeEach } from 'vitest';
import type * as ClobModule from '../clob.js';

const mockCreateAndPostMarketOrder = vi.fn();
const mockCreateAndPostOrder = vi.fn();
const mockGetTickSize = vi.fn();
const mockGetNegRisk = vi.fn();
const mockGetBalanceAllowance = vi.fn();
const mockUpdateBalanceAllowance = vi.fn();
const mockSendTransaction = vi.fn();
const mockWait = vi.fn();
const mockProxy = vi.fn();

// Mock ethers v6
// CTF read mocks for the redemption pre-flight (getCollectionId returns the bytes32
// collectionId; balanceOf returns the wallet's ERC-1155 token balance for that position).
// Default to non-zero so the pre-flight passes; tests override mockCtfBalanceOf to assert
// the balance_is_zero early-exit branch.
const mockCtfBalanceOf = vi.fn().mockResolvedValue(5_000_000n); // 5 shares (6 decimals)
const mockCtfGetCollectionId = vi.fn().mockResolvedValue('0x' + 'cd'.repeat(32));

vi.mock('ethers', () => ({
  Wallet: vi.fn(() => ({
    address: '0xtest',
    sendTransaction: mockSendTransaction,
    // ethers v6 renamed _signTypedData → signTypedData; clob.ts patches _signTypedData
    // back onto the wallet. The mock must expose signTypedData so the patch doesn't throw.
    signTypedData: vi.fn().mockResolvedValue('0xsig'),
    signingKey: {},
  })),
  Contract: vi.fn(() => ({
    proxy: mockProxy,
    balanceOf: mockCtfBalanceOf,
    getCollectionId: mockCtfGetCollectionId,
  })),
  Interface: vi.fn(() => ({
    encodeFunctionData: vi.fn(() => '0xencodeddata'),
  })),
  JsonRpcProvider: vi.fn(() => ({})),
  Network: vi.fn(() => ({})),
  FetchRequest: vi.fn(() => ({ timeout: 0 })),
  getBytes: vi.fn((val) => val),
  solidityPackedKeccak256: vi.fn(() => '0x' + 'ab'.repeat(32)),
}));

vi.mock('@polymarket/clob-client-v2', () => ({
  ClobClient: vi.fn(() => ({
    createAndPostMarketOrder: mockCreateAndPostMarketOrder,
    createAndPostOrder: mockCreateAndPostOrder,
    getTickSize: mockGetTickSize,
    getNegRisk: mockGetNegRisk,
    getBalanceAllowance: mockGetBalanceAllowance,
    updateBalanceAllowance: mockUpdateBalanceAllowance,
    createOrDeriveApiKey: vi
      .fn()
      .mockResolvedValue({ key: 'test', secret: 'test', passphrase: 'test' }),
  })),
  OrderType: { FOK: 'FOK', FAK: 'FAK', GTC: 'GTC' },
  Side: { BUY: 'BUY', SELL: 'SELL' },
  AssetType: { COLLATERAL: 'COLLATERAL' },
  Chain: { POLYGON: 137 },
}));

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({
    CLOB_FALLBACK_ENABLED: true,
    POLYGON_WALLET_PRIVATE_KEY:
      '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    POLYMARKET_SIGNATURE_TYPE: 0,
    POLYMARKET_FUNDER_ADDRESS: undefined,
    CLOB_ORDER_TYPE: 'FAK',
    // Pin a single RPC URL so buildRpcList() makes exactly one attempt — prevents
    // flakiness in CI (Node 20) from the 4-URL public fallback list exhaustion.
    POLYGON_RPC_URL: 'http://mock-rpc.test',
  })),
  CTF_ADDRESS: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
  PUSD_ADDRESS: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
  POLYGON_FALLBACK_RPCS: ['http://mock-rpc.test'],
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

const {
  submitClobBuy,
  submitClobSell,
  submitClobLimitBuy,
  submitClobLimitSell,
  getClobBalance,
  redeemClobOutcome,
  redactClobSecrets,
  redactConsoleErrorArgs,
} = await import('../clob.js');

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
      () =>
        new Promise(() => {
          /* never resolves */
        }),
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
    // For a SELL: takingAmount = USDC received, makingAmount = YES shares sold.
    // The corrected parser normalises: shares_bought = YES shares, cost = USDC, price = USDC/YES.
    mockCreateAndPostMarketOrder.mockResolvedValue({
      success: true,
      errorMsg: '',
      orderID: 'order-456',
      transactionsHashes: ['0xselltx'],
      status: 'matched',
      takingAmount: '8.0',  // USDC received
      makingAmount: '10',   // YES shares sold
    });

    const result = await submitClobSell({ tokenId: 'tok-yes', shares: 10 });

    expect(result.success).toBe(true);
    expect(result.tx_hash).toBe('0xselltx');
    expect(result.shares_bought).toBeCloseTo(10);   // YES shares sold
    expect(result.cost).toBeCloseTo(8.0);            // USDC proceeds
    expect(result.price).toBeCloseTo(0.8);           // 8 USDC / 10 shares
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
      () =>
        new Promise(() => {
          /* never resolves */
        }),
    );

    const result = await submitClobSell({ tokenId: 'tok-yes', shares: 10 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  }, 35_000);
});

describe('submitClobLimitSell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTickSize.mockResolvedValue('0.01');
    mockGetNegRisk.mockResolvedValue(false);
  });

  it('applies sell-side field normalisation (makingAmount=shares, takingAmount=USDC)', async () => {
    // Maker-exit path: createAndPostOrder with Side.SELL.
    // Same takingAmount/makingAmount inversion as submitClobSell — isSell=true must be passed.
    mockCreateAndPostOrder.mockResolvedValue({
      success: true,
      errorMsg: '',
      orderID: 'order-limit-sell',
      transactionsHashes: ['0xlimittx'],
      status: 'matched',
      takingAmount: '4.20',  // USDC received
      makingAmount: '6.00',  // YES shares sold
    });

    const result = await submitClobLimitSell({
      tokenId: 'tok-yes',
      price: 0.70,
      size: 6,
      tickSize: '0.01',
      negRisk: false,
    });

    expect(result.success).toBe(true);
    expect(result.tx_hash).toBe('0xlimittx');
    expect(result.shares_bought).toBeCloseTo(6.0);   // YES shares sold (makingAmount)
    expect(result.cost).toBeCloseTo(4.20);            // USDC proceeds (takingAmount)
    expect(result.price).toBeCloseTo(0.7);            // 4.20 / 6.00
  });
});

describe('post-only / defer-exec SDK argument mapping', () => {
  // @polymarket/clob-client-v2 createAndPostOrder positional signature:
  //   (userOrder, options, orderType, postOnly, deferExec)
  // The two flags were swapped until 2026-06-05 — every "post-only" order went
  // out as postOnly=false + deferExec=true (maker-rebate audit, finding 1).
  // These tests pin the mapping BY POSITION so an SDK bump or refactor that
  // reorders them fails loudly.
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateAndPostOrder.mockResolvedValue({
      success: true,
      errorMsg: '',
      orderID: 'order-postonly',
      status: 'live',
    });
  });

  it('submitClobLimitBuy maps postOnly:true to SDK arg 4 and deferExec=false to arg 5', async () => {
    const result = await submitClobLimitBuy({
      tokenId: 'tok-yes',
      price: 0.40,
      size: 10,
      tickSize: '0.01',
      negRisk: false,
      orderType: 'GTC',
      postOnly: true,
    });

    expect(result.success).toBe(true);
    expect(mockCreateAndPostOrder).toHaveBeenCalledTimes(1);
    const args = mockCreateAndPostOrder.mock.calls[0]!;
    expect(args[2]).toBe('GTC'); // orderType
    expect(args[3]).toBe(true); // postOnly — was false pre-fix
    expect(args[4]).toBe(false); // deferExec — was true pre-fix
  });

  it('submitClobLimitBuy defaults postOnly to false (and never defers) when omitted', async () => {
    await submitClobLimitBuy({
      tokenId: 'tok-yes',
      price: 0.40,
      size: 10,
      tickSize: '0.01',
      negRisk: false,
    });

    const args = mockCreateAndPostOrder.mock.calls[0]!;
    expect(args[3]).toBe(false); // postOnly default
    expect(args[4]).toBe(false); // deferExec always false
  });

  it('submitClobLimitSell maps postOnly:true to SDK arg 4 and deferExec=false to arg 5', async () => {
    await submitClobLimitSell({
      tokenId: 'tok-yes',
      price: 0.70,
      size: 6,
      tickSize: '0.01',
      negRisk: false,
      orderType: 'GTC',
      postOnly: true,
    });

    expect(mockCreateAndPostOrder).toHaveBeenCalledTimes(1);
    const args = mockCreateAndPostOrder.mock.calls[0]!;
    expect(args[3]).toBe(true); // postOnly
    expect(args[4]).toBe(false); // deferExec
  });
});

describe('redactClobSecrets', () => {
  it('scrubs L2 auth header values from a serialized axios config', () => {
    const leaked =
      '[CLOB Client] request error {"status":425,"config":{"headers":{"Accept":"*/*",' +
      '"POLY_ADDRESS":"0x3e945beEE937eC4D3eB79C0B2710a467BCABC382",' +
      '"POLY_SIGNATURE":"VaTCKF9I-ogyxvsz3oHcXHRwHcFQVrIuN7Nhx_cz8cg=",' +
      '"POLY_TIMESTAMP":"1779831633",' +
      '"POLY_API_KEY":"36724185-4022-567e-e78c-f01b6e831290",' +
      '"POLY_PASSPHRASE":"eb4fd6b420626ed508cf1f2fde4b8b06019781b5b9d83736ef911010f7b2a0ba"}}}';

    const redacted = redactClobSecrets(leaked);

    expect(redacted).not.toContain('VaTCKF9I');
    expect(redacted).not.toContain('36724185-4022');
    expect(redacted).not.toContain('eb4fd6b420626ed');
    expect(redacted).not.toContain('0x3e945beEE937');
    expect(redacted).toContain('"POLY_SIGNATURE":"REDACTED"');
    expect(redacted).toContain('"POLY_API_KEY":"REDACTED"');
    expect(redacted).toContain('"POLY_PASSPHRASE":"REDACTED"');
    // Non-secret fields survive.
    expect(redacted).toContain('"POLY_TIMESTAMP":"1779831633"');
    expect(redacted).toContain('"status":425');
  });

  it('scrubs the escaped order signature and owner (api key) in SDK-context strings', () => {
    // The request body is a JSON-encoded string INSIDE the serialized config,
    // so its quotes arrive escaped: \"signature\":\"0x...\". signature/owner
    // are generic names — scrubbed only with includeGenericFields=true (the
    // console patch sets it for "[CLOB Client]…" calls).
    const leaked =
      '{"config":{"data":"{\\"order\\":{\\"maker\\":\\"0x2474\\",' +
      '\\"signature\\":\\"0xa909e09d409a7d1cbbed5b30b4b938bbcdb3786e\\"},' +
      '\\"owner\\":\\"36724185-4022-567e-e78c-f01b6e831290\\",\\"orderType\\":\\"GTC\\"}"}}';

    const redacted = redactClobSecrets(leaked, true);

    expect(redacted).not.toContain('0xa909e09d');
    expect(redacted).not.toContain('36724185-4022');
    expect(redacted).toContain('\\"signature\\":\\"REDACTED\\"');
    expect(redacted).toContain('\\"owner\\":\\"REDACTED\\"');
    expect(redacted).toContain('\\"orderType\\":\\"GTC\\"');
  });

  it('leaves generic signature/owner fields intact outside SDK context (no over-redaction)', () => {
    // Non-SDK structured logging legitimately uses these field names.
    const appLog = '{"event":"transfer","owner":"alice","signature":"valid"}';
    expect(redactClobSecrets(appLog)).toBe(appLog);
    // POLY_* headers are unambiguous credentials — scrubbed regardless of context.
    const mixed = '{"owner":"alice","POLY_API_KEY":"36724185-4022"}';
    const redacted = redactClobSecrets(mixed);
    expect(redacted).toContain('"owner":"alice"');
    expect(redacted).toContain('"POLY_API_KEY":"REDACTED"');
  });

  it('leaves strings without credential fields untouched', () => {
    const clean = '[CLOB Client] request error {"error":"service not ready","status":425}';
    expect(redactClobSecrets(clean, true)).toBe(clean);
  });
});

describe('redactConsoleErrorArgs (console.error patch wiring)', () => {
  it('scrubs signature/owner when any arg carries the [CLOB Client prefix', () => {
    const args = redactConsoleErrorArgs([
      '[CLOB Client] request error',
      '{"config":{"data":"{\\"signature\\":\\"0xdeadbeef\\",\\"owner\\":\\"api-key-uuid\\"}"}}',
    ]);

    expect(args[0]).toBe('[CLOB Client] request error');
    expect(args[1]).not.toContain('0xdeadbeef');
    expect(args[1]).not.toContain('api-key-uuid');
    expect(args[1]).toContain('\\"signature\\":\\"REDACTED\\"');
    expect(args[1]).toContain('\\"owner\\":\\"REDACTED\\"');
  });

  it('does NOT scrub generic signature/owner fields in non-SDK calls (over-redaction guard)', () => {
    const appLog = '{"event":"transfer","owner":"alice","signature":"valid"}';
    const args = redactConsoleErrorArgs(['app error', appLog]);

    expect(args[1]).toBe(appLog);
  });

  it('scrubs POLY_* headers even in non-SDK calls and passes non-string args through', () => {
    const err = new Error('boom');
    const args = redactConsoleErrorArgs([
      'some wrapper log',
      '{"headers":{"POLY_PASSPHRASE":"secret-passphrase"}}',
      err,
    ]);

    expect(args[1]).toContain('"POLY_PASSPHRASE":"REDACTED"');
    expect(args[2]).toBe(err); // identity — Error objects untouched
  });
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
    mockProxy.mockResolvedValue({ wait: mockWait });
    // Reset pre-flight mocks to passing defaults (clearAllMocks preserves implementations
    // but tests below override with mockResolvedValueOnce, so reset to be explicit).
    mockCtfBalanceOf.mockResolvedValue(5_000_000n);
    mockCtfGetCollectionId.mockResolvedValue('0x' + 'cd'.repeat(32));
  });

  it('executes via EOA when sigType=0', async () => {
    const result = await redeemClobOutcome({ conditionId: 'cond-123', direction: 'YES' });

    expect(result.success).toBe(true);
    expect(result.tx_hash).toBe('0xredeemhash');
    expect(mockSendTransaction).toHaveBeenCalled();
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it('returns "balance is 0" error and submits no transaction when wallet holds no CTF tokens', async () => {
    // Both indexSets [1, 2] return zero balance — the wallet has no winning tokens to redeem.
    // This is the regression bug PR #357 targets: redeemPositions is a no-op (not a revert)
    // for zero-balance redemptions, so without this pre-flight the V2 relayer always reports
    // success and the redeemer credits phantom proceeds + fires spurious notifications.
    //
    // Error string MUST contain the substring "balance is 0" so the redeemer's
    // post-CLOB-failure handler triggers markFallbackStale (6h dedup) instead of
    // retrying every cycle.
    mockCtfBalanceOf.mockResolvedValue(0n);

    const result = await redeemClobOutcome({ conditionId: 'cond-empty', direction: 'YES' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('balance is 0');
    expect(mockSendTransaction).not.toHaveBeenCalled();
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it('returns MAGIC_PROXY_MANUAL_REDEEM_REQUIRED when sigType=1 with no creds (skips pre-flight)', async () => {
    const { loadConfig } = await import('../config.js');
    vi.mocked(loadConfig).mockReturnValue({
      POLYGON_WALLET_PRIVATE_KEY:
        '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      POLYMARKET_SIGNATURE_TYPE: 1,
      POLYMARKET_FUNDER_ADDRESS: '0xproxyaddress',
      CLOB_FALLBACK_ENABLED: true,
      POLYGON_RPC_URL: 'http://mock-rpc.test',
    });

    const result = await redeemClobOutcome({ conditionId: 'cond-123', direction: 'NO' });

    // sigType=1 (Magic Proxy) cannot auto-redeem — must be done manually on polymarket.com
    expect(result.success).toBe(false);
    expect(result.error).toBe('MAGIC_PROXY_MANUAL_REDEEM_REQUIRED');
    // Credential gate runs BEFORE the pre-flight balance check, so no on-chain reads either.
    expect(mockCtfGetCollectionId).not.toHaveBeenCalled();
    expect(mockCtfBalanceOf).not.toHaveBeenCalled();
    expect(mockProxy).not.toHaveBeenCalled();
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });
});

describe('parseBalanceFromClobError', () => {
  let parseBalanceFromClobError: typeof ClobModule.parseBalanceFromClobError;

  beforeEach(async () => {
    ({ parseBalanceFromClobError } = await import('../clob.js'));
  });

  it('extracts balance from CLOB error message', () => {
    const error =
      'not enough balance / allowance: the balance is not enough -> balance: 3266460, order amount: 3280000';
    expect(parseBalanceFromClobError(error)).toBeCloseTo(3.26646, 5);
  });

  it('handles HTML-encoded arrow in error', () => {
    const error =
      'not enough balance / allowance: the balance is not enough &gt; balance: 2916310, order amount: 2920000';
    expect(parseBalanceFromClobError(error)).toBeCloseTo(2.91631, 5);
  });

  it('returns null for unrelated error messages', () => {
    expect(parseBalanceFromClobError('CLOB order rejected')).toBeNull();
    expect(parseBalanceFromClobError('')).toBeNull();
  });

  it('returns null for non-numeric balance', () => {
    expect(parseBalanceFromClobError('balance: abc, order amount: 100')).toBeNull();
  });
});
