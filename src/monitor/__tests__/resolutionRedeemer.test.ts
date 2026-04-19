import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetSimmerPositions = vi.fn<(...args: any[]) => Promise<any>>();
const mockSubmitRedeem = vi.fn<(...args: any[]) => Promise<any>>();
const mockClosePosition = vi.fn<(...args: any[]) => Promise<void>>();
const mockGetOpenPositions = vi.fn<(...args: any[]) => Promise<any[]>>();
const mockRedeemClobOutcome = vi.fn<(...args: any[]) => Promise<any>>();
const mockCreditProceeds = vi.fn<(...args: any[]) => Promise<void>>();
const mockNotifyRedemptionExecuted = vi.fn<(...args: any[]) => Promise<void>>();

// Shared mock for the CTF contract used by checkOnChainResolution
const mockCtfContract = {
  payoutDenominator: vi.fn<() => Promise<bigint>>(),
  payoutNumerators: vi.fn<(conditionId: string, index: number) => Promise<bigint>>(),
};

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, Contract: vi.fn().mockImplementation(() => mockCtfContract) };
});

vi.mock('../../shared/simmer.js', () => ({
  getSimmerPositions: mockGetSimmerPositions,
  submitRedeem: mockSubmitRedeem,
  resolveSimmerMarketId: vi.fn().mockResolvedValue(null), // fallback won't fire in these tests
  SimmerError: class extends Error {
    statusCode = 500;
  },
}));

vi.mock('../../execution/positionLedger.js', () => ({
  closePosition: mockClosePosition,
  getOpenPositions: mockGetOpenPositions,
  getPosition: vi.fn().mockResolvedValue(null), // no ledger entry for Simmer positions in tests
}));

vi.mock('../../shared/outcomeRecorder.js', () => ({
  recordOutcome: vi.fn().mockResolvedValue(undefined),
  inferCategory: vi.fn().mockReturnValue('geopolitical'),
  inferSource: vi.fn().mockReturnValue('osint'),
}));

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    SIMMER_API_KEY: 'test-key',
    OUTCOME_HISTORY_DAYS: 180,
    OUTCOME_MAX_PER_CATEGORY: 500,
  }),
  POLYGON_FALLBACK_RPCS: ['https://mock-rpc.polygon.test'],
  CTF_ADDRESS: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
  USDC_E_ADDRESS: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
}));

vi.mock('../../shared/clob.js', () => ({
  redeemClobOutcome: mockRedeemClobOutcome,
  fetchClobTokenBalance: vi.fn().mockResolvedValue({ ok: true, balance: 100 }),
  getClobClient: vi.fn().mockReturnValue(null),
  getPolygonProvider: vi.fn().mockReturnValue({}),
  resetPolygonProvider: vi.fn(),
}));

vi.mock('../../shared/bankroll.js', () => ({
  creditProceeds: mockCreditProceeds,
}));

vi.mock('../../execution/telegram.js', () => ({
  notifyRedemptionExecuted: mockNotifyRedemptionExecuted,
  notifyManualRedemptionRequired: vi.fn().mockResolvedValue(undefined),
  notifyMarketResolved: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { redeemResolvedPositions } = await import('../resolutionRedeemer.js');

describe('redeemResolvedPositions', () => {
  const mockRedis = {
    exists: vi.fn().mockResolvedValue(0),
    hgetall: vi.fn().mockResolvedValue({}),
    hset: vi.fn().mockResolvedValue('OK'),
    expire: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    sadd: vi.fn().mockResolvedValue(1),
    sismember: vi.fn().mockResolvedValue(0),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSimmerPositions.mockResolvedValue([]);
    mockGetOpenPositions.mockResolvedValue([]);
    // Mock global fetch for Gamma API check
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{ resolved: true, outcomePrices: '["1","0"]' }]),
      } as any),
    );
  });

  it('redeems resolved positions from Simmer', async () => {
    mockGetSimmerPositions.mockResolvedValue([
      {
        market_id: 'm1',
        side: 'yes',
        redeemable: true,
        question: 'Q1',
        value_usdc: 10,
      },
    ]);
    mockSubmitRedeem.mockResolvedValue({ success: true, tx_hash: '0xhash1' });

    const results = await redeemResolvedPositions(mockRedis);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(mockSubmitRedeem).toHaveBeenCalledWith({ market_id: 'm1', side: 'yes' });
    expect(mockClosePosition).toHaveBeenCalledWith(mockRedis, 'm1', 'YES');
    expect(mockCreditProceeds).toHaveBeenCalledWith(mockRedis, 10);
    expect(mockNotifyRedemptionExecuted).toHaveBeenCalled();
  });

  it('handles CLOB positions independently', async () => {
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'clob1',
        conditionId: 'cond1',
        clobTokenIds: ['token-yes-1', 'token-no-1'],
        direction: 'YES',
        executionVenue: 'clob',
        question: 'QC1',
        sharesHeld: 100,
        entryPrice: 0.5,
      },
    ]);
    mockRedeemClobOutcome.mockResolvedValue({ success: true, tx_hash: '0xclobhash' });

    const results = await redeemResolvedPositions(mockRedis);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(mockRedeemClobOutcome).toHaveBeenCalledWith({
      conditionId: 'cond1',
      direction: 'YES',
    });
    expect(mockClosePosition).toHaveBeenCalledWith(mockRedis, 'clob1', 'YES');
    expect(mockNotifyRedemptionExecuted).toHaveBeenCalled();
  });

  it('handles mixed AMM and CLOB positions', async () => {
    mockGetSimmerPositions.mockResolvedValue([
      { market_id: 'amm1', side: 'no', redeemable: true, value_usdc: 5 },
    ]);
    mockSubmitRedeem.mockResolvedValue({ success: true });

    mockGetOpenPositions.mockResolvedValue([
      { marketId: 'clob1', conditionId: 'cond1', clobTokenIds: ['token-yes-1', 'token-no-1'], direction: 'YES', executionVenue: 'clob' },
    ]);
    mockRedeemClobOutcome.mockResolvedValue({ success: true });

    const results = await redeemResolvedPositions(mockRedis);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('expired Gamma-unresolvable position: on-chain confirms win → redeems, credits, notifies', async () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'ol-market-1',
        conditionId: 'cond-ol-1',
        clobTokenIds: ['token-yes-ol', 'token-no-ol'],
        direction: 'YES',
        executionVenue: 'clob',
        question: 'Bitcoin Up or Down - April 17, 1:00PM-1:15PM ET',
        sharesHeld: 10,
        entryPrice: 0.5,
        stakeUsd: 5,
        endDate: pastDate,
      },
    ]);
    // Gamma returns empty — can't resolve Up/Down binary
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as any),
    );
    // On-chain: condition settled, YES won
    mockCtfContract.payoutDenominator.mockResolvedValue(1n);
    mockCtfContract.payoutNumerators.mockImplementation(async (_: string, index: number) =>
      index === 0 ? 1n : 0n,
    );
    mockRedeemClobOutcome.mockResolvedValue({ success: true, tx_hash: '0xabc' });

    const results = await redeemResolvedPositions(mockRedis);

    expect(mockRedeemClobOutcome).toHaveBeenCalledWith({ conditionId: 'cond-ol-1', direction: 'YES' });
    expect(mockCreditProceeds).toHaveBeenCalledWith(mockRedis, 10);
    expect(mockNotifyRedemptionExecuted).toHaveBeenCalledWith(
      expect.objectContaining({ marketId: 'ol-market-1', side: 'yes', valueUsdc: 10 }),
    );
    expect(mockClosePosition).toHaveBeenCalledWith(mockRedis, 'ol-market-1', 'YES');
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
  });

  it('expired Gamma-unresolvable position: on-chain not yet settled → skips, retries next cycle', async () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'ol-market-2',
        conditionId: 'cond-ol-2',
        clobTokenIds: ['token-yes-ol2', 'token-no-ol2'],
        direction: 'DOWN',
        executionVenue: 'clob',
        question: 'Bitcoin Up or Down - April 17, 1:15PM-1:30PM ET',
        sharesHeld: 10,
        entryPrice: 0.5,
        stakeUsd: 5,
        endDate: pastDate,
      },
    ]);
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as any),
    );
    // On-chain: payoutDenominator = 0 → not yet settled
    mockCtfContract.payoutDenominator.mockResolvedValue(0n);

    const { notifyMarketResolved: mockNotifyMarketResolved } = await import('../../execution/telegram.js');

    const results = await redeemResolvedPositions(mockRedis);

    // Should not attempt redemption, not close, not notify — just skip until settled
    expect(mockRedeemClobOutcome).not.toHaveBeenCalled();
    expect(mockCreditProceeds).not.toHaveBeenCalled();
    expect(mockNotifyRedemptionExecuted).not.toHaveBeenCalled();
    expect(mockClosePosition).not.toHaveBeenCalled();
    expect(vi.mocked(mockNotifyMarketResolved)).not.toHaveBeenCalled();
    expect(results).toHaveLength(0);
  });

  it('expired Gamma-unresolvable position: on-chain confirms win but redemption RPC fails → retry next cycle', async () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'ol-market-3',
        conditionId: 'cond-ol-3',
        clobTokenIds: ['token-yes-ol3', 'token-no-ol3'],
        direction: 'YES',
        executionVenue: 'clob',
        question: 'Bitcoin Up or Down - April 17, 1:30PM-1:45PM ET',
        sharesHeld: 10,
        entryPrice: 0.5,
        stakeUsd: 5,
        endDate: pastDate,
      },
    ]);
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as any),
    );
    // On-chain: YES won
    mockCtfContract.payoutDenominator.mockResolvedValue(1n);
    mockCtfContract.payoutNumerators.mockImplementation(async (_: string, index: number) =>
      index === 0 ? 1n : 0n,
    );
    mockRedeemClobOutcome.mockResolvedValue({ success: false, error: 'RPC timeout' });

    const results = await redeemResolvedPositions(mockRedis);

    expect(mockRedeemClobOutcome).toHaveBeenCalledWith({ conditionId: 'cond-ol-3', direction: 'YES' });
    expect(mockCreditProceeds).not.toHaveBeenCalled();
    expect(mockNotifyRedemptionExecuted).not.toHaveBeenCalled();
    expect(mockClosePosition).not.toHaveBeenCalled();
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe('redemption_rpc_error');
  });

  it('closes CLOB position resolved as loss without redeeming', async () => {
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'clob-loss1',
        conditionId: 'cond-loss1',
        clobTokenIds: ['token-yes-loss', 'token-no-loss'],
        direction: 'YES',
        executionVenue: 'clob',
        question: 'Will Spurs beat Nuggets?',
        sharesHeld: 50,
        entryPrice: 0.6,
      },
    ]);
    // Gamma API returns resolved with outcome NO — our YES position lost
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{ resolved: true, outcomePrices: '["0","1"]' }]),
      } as any),
    );

    const results = await redeemResolvedPositions(mockRedis);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe('resolved_as_loss');
    expect(mockClosePosition).toHaveBeenCalledWith(mockRedis, 'clob-loss1', 'YES');
    expect(mockRedeemClobOutcome).not.toHaveBeenCalled();
  });
});
