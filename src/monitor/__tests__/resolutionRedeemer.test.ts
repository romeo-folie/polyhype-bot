import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetSimmerPositions = vi.fn<(...args: any[]) => Promise<any>>();
const mockSubmitRedeem = vi.fn<(...args: any[]) => Promise<any>>();
const mockClosePosition = vi.fn<(...args: any[]) => Promise<void>>();
const mockGetOpenPositions = vi.fn<(...args: any[]) => Promise<any[]>>();
const mockRedeemClobOutcome = vi.fn<(...args: any[]) => Promise<any>>();
const mockCreditProceeds = vi.fn<(...args: any[]) => Promise<void>>();
const mockNotifyRedemptionExecuted = vi.fn<(...args: any[]) => Promise<void>>();
const mockRecordPositionOutcome = vi.fn<(...args: any[]) => Promise<void>>();
const mockMarkRecentlyClosed = vi.fn<(...args: any[]) => Promise<void>>();
const mockMarkRecentlyResolved = vi.fn<(...args: any[]) => Promise<void>>();

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

vi.mock('../../shared/positionOutcomeRecorder.js', () => ({
  recordPositionOutcome: mockRecordPositionOutcome.mockResolvedValue(undefined),
  recordRedemptionOutcome: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../shared/closedGuard.js', () => ({
  isRecentlyClosed: vi.fn().mockResolvedValue(false),
  isRecentlyResolved: vi.fn().mockResolvedValue(false),
  markRecentlyClosed: mockMarkRecentlyClosed.mockResolvedValue(undefined),
  markRecentlyResolved: mockMarkRecentlyResolved.mockResolvedValue(undefined),
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
  PUSD_ADDRESS: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
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
    get: vi.fn().mockResolvedValue(null),
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
    expect(mockMarkRecentlyResolved).toHaveBeenCalledWith(mockRedis, 'ol-market-1');
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

  it('old expired Gamma-unresolvable loss closes without notifying', async () => {
    const oldDate = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'old-gamma-loss',
        conditionId: 'cond-old-gamma-loss',
        clobTokenIds: ['token-yes-old-loss', 'token-no-old-loss'],
        direction: 'NO',
        executionVenue: 'clob',
        question: 'Old already-ended market',
        sharesHeld: 10,
        entryPrice: 0.5,
        stakeUsd: 5,
        endDate: oldDate,
      },
    ]);
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as any),
    );
    // On-chain: YES won, so our NO position lost.
    mockCtfContract.payoutDenominator.mockResolvedValue(1n);
    mockCtfContract.payoutNumerators.mockImplementation(async (_: string, index: number) =>
      index === 0 ? 1n : 0n,
    );
    const { fetchClobTokenBalance: mockFetchBalance } = await import('../../shared/clob.js');
    vi.mocked(mockFetchBalance).mockResolvedValueOnce({ ok: true, balance: 10 } as any);
    const { notifyMarketResolved: mockNotifyMarketResolved } = await import('../../execution/telegram.js');

    const results = await redeemResolvedPositions(mockRedis);

    expect(mockClosePosition).toHaveBeenCalledWith(mockRedis, 'old-gamma-loss', 'NO');
    expect(mockRecordPositionOutcome).toHaveBeenCalledWith(
      mockRedis,
      expect.objectContaining({ marketId: 'old-gamma-loss' }),
      expect.objectContaining({ result: 'lost', exitReason: 'expired_unresolvable' }),
    );
    expect(vi.mocked(mockNotifyMarketResolved)).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].error).toBe('expired_unresolvable');
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

  it('no-endDate dust position: on-chain confirms win + real position → auto-redeemed win (not redemption attempt)', async () => {
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
    // On-chain: YES won — balance is dust because Polymarket auto-redeemed already
    mockCtfContract.payoutDenominator.mockResolvedValue(1n);
    mockCtfContract.payoutNumerators.mockImplementation(async (_: string, index: number) =>
      index === 0 ? 1n : 0n,
    );
    const { fetchClobTokenBalance: mockFetchBalance } = await import('../../shared/clob.js');
    vi.mocked(mockFetchBalance).mockResolvedValueOnce({ ok: true, balance: 0.005 } as any);
    const { notifyMarketResolved: mockNotifyMarketResolved } = await import('../../execution/telegram.js');

    const results = await redeemResolvedPositions(mockRedis);

    // Should not attempt redemption — already auto-redeemed
    expect(mockRedeemClobOutcome).not.toHaveBeenCalled();
    expect(mockCreditProceeds).not.toHaveBeenCalled();
    // Should close and record as auto-redeemed win (stakeUsd>0 + sharesHeld>0 → hadRealPosition)
    expect(mockClosePosition).toHaveBeenCalledWith(mockRedis, 'ol-no-date-dust', 'YES');
    expect(mockRecordPositionOutcome).toHaveBeenCalledWith(
      mockRedis,
      expect.objectContaining({ marketId: 'ol-no-date-dust' }),
      expect.objectContaining({ result: 'won', exitReason: 'no_end_date_auto_redeemed_win' }),
    );
    expect(vi.mocked(mockNotifyMarketResolved)).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'won' }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
  });

  it('no-endDate dust position: on-chain confirms win + never filled → records as lost', async () => {
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'ol-no-date-dust-nofill',
        conditionId: 'cond-nd-dust-nf',
        clobTokenIds: ['token-yes-ndnf', 'token-no-ndnf'],
        direction: 'YES',
        executionVenue: 'clob',
        question: 'Bitcoin Up or Down - April 18',
        sharesHeld: 0,
        entryPrice: 0.5,
        stakeUsd: 5,
        endDate: '',
      },
    ]);
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as any),
    );
    mockCtfContract.payoutDenominator.mockResolvedValue(1n);
    mockCtfContract.payoutNumerators.mockImplementation(async (_: string, index: number) =>
      index === 0 ? 1n : 0n,
    );
    const { fetchClobTokenBalance: mockFetchBalance } = await import('../../shared/clob.js');
    vi.mocked(mockFetchBalance).mockResolvedValueOnce({ ok: true, balance: 0.005 } as any);
    const { notifyMarketResolved: mockNotifyMarketResolved } = await import('../../execution/telegram.js');

    const results = await redeemResolvedPositions(mockRedis);

    expect(mockRedeemClobOutcome).not.toHaveBeenCalled();
    expect(mockClosePosition).toHaveBeenCalledWith(mockRedis, 'ol-no-date-dust-nofill', 'YES');
    expect(mockRecordPositionOutcome).toHaveBeenCalledWith(
      mockRedis,
      expect.objectContaining({ marketId: 'ol-no-date-dust-nofill' }),
      expect.objectContaining({ result: 'lost', exitReason: 'no_end_date_dust_closed' }),
    );
    expect(vi.mocked(mockNotifyMarketResolved)).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'lost' }),
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

  it('expired zero-balance position with real ledger shares + on-chain WIN → records auto_redeemed_win', async () => {
    // Simulates Polymarket's auto-redeemer having already paid us out: we held
    // 6.66 NO shares, market resolved NO, Polymarket's backend redeemed them
    // to USDC. By the time our redeemer runs, balance is 0 but on-chain
    // payout confirms NO won.
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'weather-autoredeem',
        conditionId: 'cond-weather-autoredeem',
        clobTokenIds: ['token-yes-w', 'token-no-w'],
        direction: 'NO',
        executionVenue: 'clob',
        question: 'Will the highest temperature in Hong Kong be 29°C on April 22?',
        sharesHeld: 6.66,          // ledger recorded a real fill
        entryPrice: 0.015,
        stakeUsd: 0.10,
        endDate: pastDate,
        sourcedFrom: 'weather:hong kong:2026-04-22:29°C',
      },
    ]);
    // Gamma returns empty (unresolvable for this market type)
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as any),
    );
    // On-chain: NO won (index 1)
    mockCtfContract.payoutDenominator.mockResolvedValue(1n);
    mockCtfContract.payoutNumerators.mockImplementation(async (_: string, index: number) =>
      index === 1 ? 1n : 0n,
    );
    // Balance has been auto-redeemed to 0
    const { fetchClobTokenBalance: mockFetchBalance } = await import('../../shared/clob.js');
    vi.mocked(mockFetchBalance).mockResolvedValueOnce({ ok: true, balance: 0 } as any);

    const { notifyMarketResolved: mockNotifyMarketResolved } = await import('../../execution/telegram.js');

    const results = await redeemResolvedPositions(mockRedis);

    // Must NOT attempt on-chain redemption (no shares to redeem)
    expect(mockRedeemClobOutcome).not.toHaveBeenCalled();
    // Must close the ledger position and notify a WIN with proceeds
    expect(mockClosePosition).toHaveBeenCalledWith(mockRedis, 'weather-autoredeem', 'NO');
    expect(mockCreditProceeds).toHaveBeenCalledWith(mockRedis, 6.66);
    expect(vi.mocked(mockNotifyMarketResolved)).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'won',
        proceedsUsdc: 6.66,
        reason: expect.stringContaining('auto-redeemed'),
      }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
  });

  it('expired zero-balance position with real ledger shares + on-chain LOSS → records resolved_as_loss', async () => {
    // Same balance=0 state, but on-chain says the other side won.
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'weather-lost',
        conditionId: 'cond-weather-lost',
        clobTokenIds: ['token-yes-wl', 'token-no-wl'],
        direction: 'NO',
        executionVenue: 'clob',
        question: 'Will the highest temperature in Shenzhen be 26°C on April 23?',
        sharesHeld: 5.83,
        entryPrice: 0.59,
        stakeUsd: 3.44,
        endDate: pastDate,
        sourcedFrom: 'weather:shenzhen:2026-04-23:26°C',
      },
    ]);
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as any),
    );
    // On-chain: YES won (we held NO, so we lost)
    mockCtfContract.payoutDenominator.mockResolvedValue(1n);
    mockCtfContract.payoutNumerators.mockImplementation(async (_: string, index: number) =>
      index === 0 ? 1n : 0n,
    );
    const { fetchClobTokenBalance: mockFetchBalance } = await import('../../shared/clob.js');
    vi.mocked(mockFetchBalance).mockResolvedValueOnce({ ok: true, balance: 0 } as any);
    const { notifyMarketResolved: mockNotifyMarketResolved } = await import('../../execution/telegram.js');

    const results = await redeemResolvedPositions(mockRedis);

    expect(mockRedeemClobOutcome).not.toHaveBeenCalled();
    expect(mockClosePosition).toHaveBeenCalledWith(mockRedis, 'weather-lost', 'NO');
    expect(vi.mocked(mockNotifyMarketResolved)).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'lost' }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe('resolved_as_loss');
  });

  it('expired zero-balance position with real ledger shares + on-chain NOT YET settled → retries without writing outcome', async () => {
    // Polymarket auto-redeem ran before CTF payout finalized — our on-chain
    // check sees denominator=0. Previously we would have prematurely written
    // a -100% expired_unresolvable loss here, silently dropping a real win.
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'weather-pending',
        conditionId: 'cond-weather-pending',
        clobTokenIds: ['token-yes-wp', 'token-no-wp'],
        direction: 'NO',
        executionVenue: 'clob',
        question: 'Will the highest temperature in Moscow be 12°C on April 22?',
        sharesHeld: 6.74,
        entryPrice: 0.44,
        stakeUsd: 2.97,
        endDate: pastDate,
        sourcedFrom: 'weather:moscow:2026-04-22:12°C',
      },
    ]);
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as any),
    );
    // On-chain: not yet resolved
    mockCtfContract.payoutDenominator.mockResolvedValue(0n);
    const { fetchClobTokenBalance: mockFetchBalance } = await import('../../shared/clob.js');
    vi.mocked(mockFetchBalance).mockResolvedValueOnce({ ok: true, balance: 0 } as any);
    const { notifyMarketResolved: mockNotifyMarketResolved } = await import('../../execution/telegram.js');

    const results = await redeemResolvedPositions(mockRedis);

    // Must NOT write a premature loss outcome
    expect(mockClosePosition).not.toHaveBeenCalled();
    expect(vi.mocked(mockNotifyMarketResolved)).not.toHaveBeenCalled();
    expect(mockRedeemClobOutcome).not.toHaveBeenCalled();
    expect(results).toHaveLength(0);
  });

  it('expired dust position (genuinely never filled) + on-chain WIN → records expired_dust', async () => {
    // Avoids ghost wins: a position whose order was recorded but never
    // actually filled (sharesHeld = 0 exactly) must NOT be counted as a
    // win even when on-chain resolution matches our direction.
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'weather-neverfilled',
        conditionId: 'cond-weather-neverfilled',
        clobTokenIds: ['token-yes-wn', 'token-no-wn'],
        direction: 'NO',
        executionVenue: 'clob',
        question: 'Will the highest temperature in Toronto be 18°C on April 22?',
        sharesHeld: 0,          // nothing ever filled
        entryPrice: 0.74,
        stakeUsd: 4.21,         // recorded at signal time, before fill
        endDate: pastDate,
        sourcedFrom: 'weather:toronto:2026-04-22:18°C',
      },
    ]);
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as any),
    );
    mockCtfContract.payoutDenominator.mockResolvedValue(1n);
    mockCtfContract.payoutNumerators.mockImplementation(async (_: string, index: number) =>
      index === 1 ? 1n : 0n,
    );
    const { fetchClobTokenBalance: mockFetchBalance } = await import('../../shared/clob.js');
    vi.mocked(mockFetchBalance).mockResolvedValueOnce({ ok: true, balance: 0 } as any);
    const { notifyMarketResolved: mockNotifyMarketResolved } = await import('../../execution/telegram.js');

    const results = await redeemResolvedPositions(mockRedis);

    expect(mockClosePosition).toHaveBeenCalledWith(mockRedis, 'weather-neverfilled', 'NO');
    expect(vi.mocked(mockNotifyMarketResolved)).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'lost', reason: 'expired dust position' }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe('expired_dust');
  });

  it('reconciler-healed-to-dust winner + on-chain WIN → auto_redeemed_win (2026-04-24 fix)', async () => {
    // The exact 2026-04-24 incident shape: a real fill that the reconciler
    // subsequently healed down to dust after a maker-exit partial fill.
    // `stakeUsd` is the authoritative "did we have a real position" signal
    // because the reconciler does not touch it; `sharesHeld` is post-heal
    // dust. Previously this routed to `expired_dust` (−100%); the fix routes
    // to `auto_redeemed_win` when on-chain confirms our side won.
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'eth-updown-healed',
        conditionId: 'cond-eth-updown-healed',
        clobTokenIds: ['token-yes-eth', 'token-no-eth'],
        direction: 'YES',
        executionVenue: 'clob',
        question: 'Ethereum Up or Down - April 24, 7:15AM-7:30AM ET',
        sharesHeld: 0.0044,    // healed down from 9.9944
        entryPrice: 0.5,
        stakeUsd: 4.9972,      // real original stake, untouched by reconciler
        endDate: pastDate,
        sourcedFrom: 'oracle-lag:eth:0.129pct:5s',
        reconciliationStatus: 'healed_mismatch:2026-04-24T11:28:28.636Z',
      },
    ]);
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as any),
    );
    // On-chain: YES won (we held YES)
    mockCtfContract.payoutDenominator.mockResolvedValue(1n);
    mockCtfContract.payoutNumerators.mockImplementation(async (_: string, index: number) =>
      index === 0 ? 1n : 0n,
    );
    const { fetchClobTokenBalance: mockFetchBalance } = await import('../../shared/clob.js');
    vi.mocked(mockFetchBalance).mockResolvedValueOnce({ ok: true, balance: 0.0044 } as any);
    const { notifyMarketResolved: mockNotifyMarketResolved } = await import('../../execution/telegram.js');

    const results = await redeemResolvedPositions(mockRedis);

    expect(mockClosePosition).toHaveBeenCalledWith(mockRedis, 'eth-updown-healed', 'YES');
    expect(mockCreditProceeds).toHaveBeenCalledWith(mockRedis, 0.0044);
    expect(vi.mocked(mockNotifyMarketResolved)).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'won', proceedsUsdc: 0.0044 }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
  });

  it('partial-exit-marker position + Gamma RESOLVED + dust: skips resolved_dust_closed write', async () => {
    // Mirror of the !resolved partial_exit test, but exercising the Gamma-
    // resolved code path. Same duplicate-outcome risk: `finalizeClobExit`
    // already recorded a realized outcome at the moment of the partial fill;
    // writing `resolved_dust_closed/−100` here would double-count.
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'resolved-partial',
        conditionId: 'cond-resolved-partial',
        clobTokenIds: ['token-yes-rp', 'token-no-rp'],
        direction: 'YES',
        executionVenue: 'clob',
        question: 'Will BTC close > $70k by April 30?',
        sharesHeld: 0.005,
        entryPrice: 0.5,
        stakeUsd: 4.9972,
        endDate: pastDate,
        sourcedFrom: 'osint',
        reconciliationStatus: 'partial_exit:2026-04-28T10:15:00.000Z',
        pendingSettlement: true,
      },
    ]);
    // Gamma IS able to resolve this one (not an Up/Down binary).
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{ resolved: true, outcomePrices: '["1","0"]' }]),
      } as any),
    );
    const { fetchClobTokenBalance: mockFetchBalance } = await import('../../shared/clob.js');
    vi.mocked(mockFetchBalance).mockResolvedValueOnce({ ok: true, balance: 0.005 } as any);
    const { notifyMarketResolved: mockNotifyMarketResolved } = await import('../../execution/telegram.js');

    const results = await redeemResolvedPositions(mockRedis);

    expect(mockClosePosition).toHaveBeenCalledWith(mockRedis, 'resolved-partial', 'YES');
    expect(mockRedeemClobOutcome).not.toHaveBeenCalled();
    expect(vi.mocked(mockNotifyMarketResolved)).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
  });

  it('partial-exit-marker position skips expired_dust write (prevents duplicate outcome row)', async () => {
    // After a maker-exit partial fill, `finalizeClobExit` already recorded
    // the realized outcome and left a `partial_exit:` marker on the ledger.
    // The redeemer must NOT write a second outcome row at resolution, else
    // we get the 2026-04-24-style double-count (lost/−40 + lost/−100).
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'eth-updown-partial',
        conditionId: 'cond-eth-updown-partial',
        clobTokenIds: ['token-yes-eth2', 'token-no-eth2'],
        direction: 'YES',
        executionVenue: 'clob',
        question: 'Ethereum Up or Down - April 25, 8:00AM-8:15AM ET',
        sharesHeld: 0.0044,
        entryPrice: 0.5,
        stakeUsd: 4.9972,
        endDate: pastDate,
        sourcedFrom: 'oracle-lag:eth:0.140pct:5s',
        reconciliationStatus: 'partial_exit:2026-04-25T08:03:00.000Z',
        pendingSettlement: true,
      },
    ]);
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as any),
    );
    // On-chain: YES won (we held YES) — the most dangerous case for a dup-write
    mockCtfContract.payoutDenominator.mockResolvedValue(1n);
    mockCtfContract.payoutNumerators.mockImplementation(async (_: string, index: number) =>
      index === 0 ? 1n : 0n,
    );
    const { fetchClobTokenBalance: mockFetchBalance } = await import('../../shared/clob.js');
    vi.mocked(mockFetchBalance).mockResolvedValueOnce({ ok: true, balance: 0.0044 } as any);
    const { notifyMarketResolved: mockNotifyMarketResolved } = await import('../../execution/telegram.js');

    const results = await redeemResolvedPositions(mockRedis);

    // Position is closed, but NO new outcome notification is sent (one was
    // already sent by finalizeClobExit's notifyTakeProfitExecuted path).
    expect(mockClosePosition).toHaveBeenCalledWith(mockRedis, 'eth-updown-partial', 'YES');
    expect(vi.mocked(mockNotifyMarketResolved)).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
  });
});
