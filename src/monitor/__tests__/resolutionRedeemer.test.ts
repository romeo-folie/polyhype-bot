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
    REDEEMER_DUST_THRESHOLD_USDC: 0.25,
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
    const { fetchClobTokenBalance: mockFetchBalance } = await import('../../shared/clob.js');
    vi.mocked(mockFetchBalance).mockResolvedValueOnce({ ok: true, balance: 10 } as any);

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

  it('expired Gamma-unresolvable position: redemption succeeds but proceeds unknown → logs error and retries', async () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'ol-market-4',
        conditionId: 'cond-ol-4',
        clobTokenIds: ['token-yes-ol4', 'token-no-ol4'],
        direction: 'YES',
        executionVenue: 'clob',
        question: 'Bitcoin Up or Down - April 17, 1:45PM-2:00PM ET',
        sharesHeld: null,
        entryPrice: 0,   // invalid — entryPriceSafe = false
        stakeUsd: 5,
        endDate: pastDate,
      },
    ]);
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as any),
    );
    mockCtfContract.payoutDenominator.mockResolvedValue(1n);
    mockCtfContract.payoutNumerators.mockImplementation(async (_: string, index: number) =>
      index === 0 ? 1n : 0n,
    );
    mockRedeemClobOutcome.mockResolvedValue({ success: true, tx_hash: '0xdef' });
    // NaN balance: typeof NaN === 'number' (passes refreshTokenBalance), but
    // Number.isFinite(NaN) is false so proceeds computation falls through to null.
    // NaN also slips past the dust gate (NaN <= 0.01 is false), so we reach the
    // proceeds-unknown guard rather than the earlier dust-close path.
    const { fetchClobTokenBalance: mockFetchBalance } = await import('../../shared/clob.js');
    vi.mocked(mockFetchBalance).mockResolvedValueOnce({ ok: true, balance: NaN } as any);

    const results = await redeemResolvedPositions(mockRedis);

    expect(mockCreditProceeds).not.toHaveBeenCalled();
    expect(mockClosePosition).not.toHaveBeenCalled();
    expect(mockNotifyRedemptionExecuted).not.toHaveBeenCalled();
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe('redemption_proceeds_unknown');
  });

  it('no-endDate position: on-chain confirms loss → closes without redemption', async () => {
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'ol-no-date-1',
        conditionId: 'cond-nd-1',
        clobTokenIds: ['token-yes-nd1', 'token-no-nd1'],
        direction: 'YES',
        executionVenue: 'clob',
        question: 'Bitcoin Up or Down - April 17, 1:00PM-1:15PM ET',
        sharesHeld: 10,
        entryPrice: 0.5,
        stakeUsd: 5,
        endDate: '', // missing — simulates pre-endDate-fix entries
      },
    ]);
    // Gamma returns empty
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as any),
    );
    // On-chain: condition settled, NO won (index 1) — our YES position lost
    mockCtfContract.payoutDenominator.mockResolvedValue(1n);
    mockCtfContract.payoutNumerators.mockImplementation(async (_: string, index: number) =>
      index === 1 ? 1n : 0n,
    );
    const { notifyMarketResolved: mockNotifyMarketResolved } = await import('../../execution/telegram.js');

    const results = await redeemResolvedPositions(mockRedis);

    expect(mockRedeemClobOutcome).not.toHaveBeenCalled();
    expect(mockCreditProceeds).not.toHaveBeenCalled();
    expect(mockClosePosition).toHaveBeenCalledWith(mockRedis, 'ol-no-date-1', 'YES');
    expect(vi.mocked(mockNotifyMarketResolved)).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'lost', reason: 'on-chain settled (no endDate stored)' }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe('no_end_date_on_chain_resolved');
  });

  it('no-endDate position: on-chain confirms win → redeems, credits, notifies', async () => {
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'ol-no-date-2',
        conditionId: 'cond-nd-2',
        clobTokenIds: ['token-yes-nd2', 'token-no-nd2'],
        direction: 'YES',
        executionVenue: 'clob',
        question: 'Bitcoin Up or Down - April 17, 1:15PM-1:30PM ET',
        sharesHeld: 10,
        entryPrice: 0.5,
        stakeUsd: 5,
        endDate: '',
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
    mockRedeemClobOutcome.mockResolvedValue({ success: true, tx_hash: '0xnd2' });
    const { fetchClobTokenBalance: mockFetchBalance } = await import('../../shared/clob.js');
    vi.mocked(mockFetchBalance).mockResolvedValueOnce({ ok: true, balance: 10 } as any);

    const results = await redeemResolvedPositions(mockRedis);

    expect(mockRedeemClobOutcome).toHaveBeenCalledWith({ conditionId: 'cond-nd-2', direction: 'YES' });
    expect(mockCreditProceeds).toHaveBeenCalledWith(mockRedis, 10);
    expect(mockNotifyRedemptionExecuted).toHaveBeenCalledWith(
      expect.objectContaining({ marketId: 'ol-no-date-2', side: 'yes', valueUsdc: 10 }),
    );
    expect(mockClosePosition).toHaveBeenCalledWith(mockRedis, 'ol-no-date-2', 'YES');
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
  });

  it('no-endDate dust position: on-chain confirms win → closes without redemption, records won', async () => {
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'ol-no-date-dust',
        conditionId: 'cond-nd-dust',
        clobTokenIds: ['token-yes-ndd', 'token-no-ndd'],
        direction: 'YES',
        executionVenue: 'clob',
        question: 'Bitcoin Up or Down - April 17',
        sharesHeld: 0.05,
        entryPrice: 0.5,
        stakeUsd: 5,
        endDate: '',
      },
    ]);
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as any),
    );
    // On-chain: YES won — but balance is dust (≤0.01 threshold triggers skipped_dust)
    mockCtfContract.payoutDenominator.mockResolvedValue(1n);
    mockCtfContract.payoutNumerators.mockImplementation(async (_: string, index: number) =>
      index === 0 ? 1n : 0n,
    );
    const { fetchClobTokenBalance: mockFetchBalance } = await import('../../shared/clob.js');
    vi.mocked(mockFetchBalance).mockResolvedValueOnce({ ok: true, balance: 0.005 } as any);
    const { notifyMarketResolved: mockNotifyMarketResolved } = await import('../../execution/telegram.js');

    const results = await redeemResolvedPositions(mockRedis);

    // Should not attempt redemption — dust
    expect(mockRedeemClobOutcome).not.toHaveBeenCalled();
    expect(mockCreditProceeds).not.toHaveBeenCalled();
    // But should close and record as won
    expect(mockClosePosition).toHaveBeenCalledWith(mockRedis, 'ol-no-date-dust', 'YES');
    expect(vi.mocked(mockNotifyMarketResolved)).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'won' }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].error).toBe('no_end_date_dust_closed');
  });

  it('no-endDate position: on-chain not yet settled → skips and retries next cycle', async () => {
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'ol-no-date-3',
        conditionId: 'cond-nd-3',
        clobTokenIds: ['token-yes-nd3', 'token-no-nd3'],
        direction: 'YES',
        executionVenue: 'clob',
        question: 'Spurs vs Nuggets - April 4',
        sharesHeld: 5,
        entryPrice: 0.6,
        stakeUsd: 3,
        endDate: '',
      },
    ]);
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as any),
    );
    // payoutDenominator = 0 → not yet settled
    mockCtfContract.payoutDenominator.mockResolvedValue(0n);

    const results = await redeemResolvedPositions(mockRedis);

    expect(mockRedeemClobOutcome).not.toHaveBeenCalled();
    expect(mockCreditProceeds).not.toHaveBeenCalled();
    expect(mockClosePosition).not.toHaveBeenCalled();
    expect(results).toHaveLength(0);
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
