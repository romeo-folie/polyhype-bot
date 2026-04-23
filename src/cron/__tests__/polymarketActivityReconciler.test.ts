import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks -- must come before dynamic import
// ---------------------------------------------------------------------------

const mockSqlTag = vi.fn<(...args: unknown[]) => Promise<unknown>>();
// postgres-style tagged template mock: first call is SELECT, subsequent writes
// return empty.
const makeSqlFn = (): typeof mockSqlTag => {
  const fn = vi.fn((...args: unknown[]) => mockSqlTag(...args));
  return fn as unknown as typeof mockSqlTag;
};
const mockSql = makeSqlFn();

vi.mock('../../db/client.js', () => ({
  getSql: () => mockSql,
  closeSql: vi.fn(),
}));

const mockFetch = vi.fn<(url: string, t: number) => Promise<Response>>();
vi.mock('../../mapping/gamma.js', () => ({
  fetchWithTimeout: mockFetch,
}));

const mockRecordOutcome = vi.fn<(...args: unknown[]) => Promise<void>>();
vi.mock('../../shared/positionOutcomeRecorder.js', () => ({
  recordPositionOutcome: mockRecordOutcome,
}));

const mockNotifyMarketResolved = vi
  .fn<(...args: unknown[]) => Promise<void>>()
  .mockResolvedValue(undefined);
vi.mock('../../execution/telegram.js', () => ({
  notifyMarketResolved: mockNotifyMarketResolved,
}));

const mockLoadConfig = vi.fn(() => ({
  PM_RECONCILER_ENABLED: true,
  PM_RECONCILER_LIMIT: 500,
  POLYMARKET_FUNDER_ADDRESS: '0x2474251E6F057d57d045853Bf94fB15DBd50Ec29',
  POLYGON_WALLET_PRIVATE_KEY: '',
}));
vi.mock('../../shared/config.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn(),
  closeRedis: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { pickBestMatch, reconcileRedeem, runPmActivityReconciler, fetchRedeems } =
  await import('../polymarketActivityReconciler.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockRedis {
  exists: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

function makeRedis(overrides: Partial<MockRedis> = {}): MockRedis {
  return {
    exists: vi.fn().mockResolvedValue(0),
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makeRedeem(overrides: Record<string, unknown> = {}) {
  return {
    proxyWallet: '0x2474251e6f057d57d045853bf94fb15dbd50ec29',
    timestamp: 1776923726,
    conditionId: '0xcond_weather_hk_30',
    type: 'REDEEM' as const,
    size: 5.82,
    usdcSize: 6.57,
    transactionHash: '0xtx1',
    title: 'Will the highest temperature in Hong Kong be 30°C on April 22?',
    slug: 'hong-kong-30c-april-22',
    eventSlug: 'highest-temperature-in-hong-kong-on-april-22-2026',
    ...overrides,
  };
}

function makePositionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '1001',
    marketId: '2029699',
    direction: 'NO',
    openedAt: '2026-04-21T18:34:57Z',
    closedAt: '2026-04-21T18:36:19Z',
    entryPrice: 0.5699,
    stakeUsd: 3.32,
    sharesHeld: 5.82,
    executionId: 'exec-hk-30',
    modeConfigured: 'hybrid',
    sourcedFrom: 'weather:hong kong:2026-04-22:30°C',
    question: 'Will the highest temperature in Hong Kong be 30°C on April 22?',
    pendingSettlement: true,
    reconciliationStatus: null,
    conditionId: '0xcond_weather_hk_30',
    executionVenue: 'clob',
    consensusProbability: 0.05,
    entryExecutionPath: 'maker_fill',
    entryOrderType: 'GTC',
    fallbackReason: null,
    edgeClass: null,
    decisionSpreadBps: null,
    makerPriceImprovementBps: null,
    makerPriceImprovementUsd: null,
    priceZone: null,
    entryAtr: null,
    entryAtrPct: null,
    synthHedged: false,
    ...overrides,
  };
}

// Helper to script the SQL tagged-template calls in order. `mockSql` is the
// tagged-template mock itself; each call corresponds to a SQL statement in the
// code under test. Here we drive the sequence explicitly per test case.
function scriptSqlCalls(calls: unknown[][]): void {
  mockSqlTag.mockReset();
  for (const ret of calls) {
    mockSqlTag.mockResolvedValueOnce(ret);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pickBestMatch', () => {
  it('returns the single row when only one position exists', () => {
    const p = makePositionRow();
    expect(pickBestMatch([p], { size: 5.82, usdcSize: 6.57 })).toBe(p);
  });

  it('returns null for empty positions', () => {
    expect(pickBestMatch([], { size: 5.82, usdcSize: 6.57 })).toBeNull();
  });

  it('prefers a pending_settlement=true row over an already-closed row', () => {
    const a = makePositionRow({ id: 'a', direction: 'YES', sharesHeld: 10, pendingSettlement: false });
    const b = makePositionRow({ id: 'b', direction: 'NO', sharesHeld: 5.82, pendingSettlement: true });
    expect(pickBestMatch([a, b], { size: 5.82, usdcSize: 6.57 })?.id).toBe('b');
  });

  it('picks by shares_held proximity when multiple pending rows exist', () => {
    const a = makePositionRow({ id: 'a', sharesHeld: 1.0, pendingSettlement: true });
    const b = makePositionRow({ id: 'b', sharesHeld: 5.8, pendingSettlement: true });
    const c = makePositionRow({ id: 'c', sharesHeld: 9.9, pendingSettlement: true });
    expect(pickBestMatch([a, b, c], { size: 5.82, usdcSize: 6.57 })?.id).toBe('b');
  });
});

describe('fetchRedeems', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('filters to REDEEM type and drops malformed entries', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          makeRedeem(),
          { type: 'TRADE', conditionId: 'x', transactionHash: 'y', timestamp: 1, size: 1, usdcSize: 1 },
          // malformed: missing transactionHash
          { type: 'REDEEM', conditionId: 'z', timestamp: 1, size: 1, usdcSize: 1 },
        ]),
    } as Response);
    const out = await fetchRedeems('0xwallet');
    expect(out).toHaveLength(1);
    expect(out[0]!.conditionId).toBe('0xcond_weather_hk_30');
  });

  it('throws on non-2xx', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'err' } as Response);
    await expect(fetchRedeems('0xwallet')).rejects.toThrow(/pm-reconciler fetch/);
  });
});

describe('reconcileRedeem', () => {
  beforeEach(() => {
    mockSqlTag.mockReset();
    mockRecordOutcome.mockReset();
    mockRecordOutcome.mockResolvedValue(undefined);
    mockNotifyMarketResolved.mockReset();
    mockNotifyMarketResolved.mockResolvedValue(undefined);
  });

  it('skips when transactionHash is already in dedup set', async () => {
    const redis = makeRedis({ exists: vi.fn().mockResolvedValue(1) });
    const summary = {
      redeemsFetched: 0, alreadyProcessed: 0, outcomesInserted: 0,
      outcomesFlipped: 0, positionsCleared: 0, synthInsertsSkipped: 0, errors: 0,
    };
    await reconcileRedeem(redis as never, makeRedeem(), summary);
    expect(summary.alreadyProcessed).toBe(1);
    expect(mockSqlTag).not.toHaveBeenCalled();
  });

  it('records closedAt at redeem.timestamp (not Date.now) so backfill preserves hold times', async () => {
    scriptSqlCalls([
      [{ market_id: '2029699' }],              // market_catalog: conditionId → marketId
      [makePositionRow()],
      [],
      { count: 1 },
    ]);
    const redis = makeRedis();
    const summary = {
      redeemsFetched: 0, alreadyProcessed: 0, outcomesInserted: 0,
      outcomesFlipped: 0, positionsCleared: 0, synthInsertsSkipped: 0, errors: 0,
    };
    await reconcileRedeem(redis as never, makeRedeem({ timestamp: 1776923780 }), summary);
    const call = mockRecordOutcome.mock.calls[0]!;
    const opts = call[2] as { closedAtMs: number };
    expect(opts.closedAtMs).toBe(1776923780 * 1000);
  });

  it('preserves position.executionVenue on outcome write (simmer stays simmer, not forced to clob)', async () => {
    scriptSqlCalls([
      [{ market_id: '2029699' }],              // market_catalog: conditionId → marketId
      [makePositionRow({ executionVenue: 'simmer' })],
      [],
      { count: 1 },
    ]);
    const redis = makeRedis();
    const summary = {
      redeemsFetched: 0, alreadyProcessed: 0, outcomesInserted: 0,
      outcomesFlipped: 0, positionsCleared: 0, synthInsertsSkipped: 0, errors: 0,
    };
    await reconcileRedeem(redis as never, makeRedeem(), summary);
    const call = mockRecordOutcome.mock.calls[0]!;
    const opts = call[2] as { executionVenueOverride: string };
    expect(opts.executionVenueOverride).toBe('simmer');
  });

  it('inserts a new won outcome when no prior outcome exists and position is matched', async () => {
    scriptSqlCalls([
      [{ market_id: '2029699' }],              // market_catalog: conditionId → marketId
      [makePositionRow()],            // positions lookup
      [],                              // outcomes lookup (empty)
      { count: 1 },                    // positions update (clear pending_settlement)
    ]);
    const redis = makeRedis();
    const summary = {
      redeemsFetched: 0, alreadyProcessed: 0, outcomesInserted: 0,
      outcomesFlipped: 0, positionsCleared: 0, synthInsertsSkipped: 0, errors: 0,
    };
    await reconcileRedeem(redis as never, makeRedeem(), summary);

    expect(summary.outcomesInserted).toBe(1);
    expect(summary.positionsCleared).toBe(1);
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      redis,
      expect.objectContaining({
        marketId: '2029699',
        direction: 'NO',
        sourcedFrom: 'weather:hong kong:2026-04-22:30°C',
      }),
      expect.objectContaining({
        result: 'won',
        exitReason: 'auto_redeemed_win_pm_reconciler',
      }),
    );
    // return_pct = (6.57 - 3.32) / 3.32 * 100 ≈ 97.9
    const call = mockRecordOutcome.mock.calls[0]!;
    const opts = call[2] as { returnPct: number };
    expect(opts.returnPct).toBeCloseTo(97.9, 1);
    expect(mockNotifyMarketResolved).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'won', proceedsUsdc: 6.57 }),
    );
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('pm-reconciler:processed:0xtx1'),
      '1',
      'EX',
      expect.any(Number),
    );
  });

  it('flips an existing stop_loss outcome when PM shows a winning redeem', async () => {
    scriptSqlCalls([
      [{ market_id: '2029699' }],              // market_catalog: conditionId → marketId
      [makePositionRow()],
      [{ outcome_id: 'o1', result: 'lost', return_pct: -6.12, exit_reason: 'stop_loss', closed_at: new Date() }],
      { count: 1 },  // UPDATE outcomes
      { count: 1 },  // UPDATE positions
    ]);
    const redis = makeRedis();
    const summary = {
      redeemsFetched: 0, alreadyProcessed: 0, outcomesInserted: 0,
      outcomesFlipped: 0, positionsCleared: 0, synthInsertsSkipped: 0, errors: 0,
    };
    await reconcileRedeem(redis as never, makeRedeem(), summary);

    expect(summary.outcomesFlipped).toBe(1);
    expect(summary.positionsCleared).toBe(1);
    expect(summary.outcomesInserted).toBe(0);
    // recordPositionOutcome is NOT called — flips bypass the writer path
    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockNotifyMarketResolved).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'won', proceedsUsdc: 6.57 }),
    );
  });

  it('leaves already-won outcomes alone', async () => {
    scriptSqlCalls([
      [{ market_id: '2029699' }],              // market_catalog: conditionId → marketId
      [makePositionRow()],
      [{ outcome_id: 'o1', result: 'won', return_pct: 5.0, exit_reason: 'trailing_stop', closed_at: new Date() }],
    ]);
    const redis = makeRedis();
    const summary = {
      redeemsFetched: 0, alreadyProcessed: 0, outcomesInserted: 0,
      outcomesFlipped: 0, positionsCleared: 0, synthInsertsSkipped: 0, errors: 0,
    };
    await reconcileRedeem(redis as never, makeRedeem(), summary);

    expect(summary.outcomesInserted).toBe(0);
    expect(summary.outcomesFlipped).toBe(0);
    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalled(); // still stamps dedup
  });

  it('inserts a loss outcome when redeem paid $0 and no prior outcome exists', async () => {
    scriptSqlCalls([
      [{ market_id: '2029699' }],              // market_catalog: conditionId → marketId
      [makePositionRow()],
      [],
      { count: 1 },
    ]);
    const redis = makeRedis();
    const summary = {
      redeemsFetched: 0, alreadyProcessed: 0, outcomesInserted: 0,
      outcomesFlipped: 0, positionsCleared: 0, synthInsertsSkipped: 0, errors: 0,
    };
    await reconcileRedeem(redis as never, makeRedeem({ usdcSize: 0 }), summary);

    expect(summary.outcomesInserted).toBe(1);
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      redis,
      expect.anything(),
      expect.objectContaining({
        result: 'lost',
        exitReason: 'auto_redeemed_loss_pm_reconciler',
      }),
    );
    // No Telegram notification on loss — only on wins
    expect(mockNotifyMarketResolved).not.toHaveBeenCalled();
  });

  it('leaves an existing lost outcome alone when PM also shows $0 redeem', async () => {
    // Position is still pending_settlement=true and has an existing 'lost' row.
    // Reconciler must: NOT rewrite exit_reason, NOT write an outcome, BUT
    // clear the stale pending_settlement flag (the redeem is definitive
    // on-chain resolution, even at usdc=0).
    scriptSqlCalls([
      [{ market_id: '2029699' }],              // market_catalog: conditionId → marketId
      [makePositionRow()],                     // positions by marketId (pendingSettlement=true by default)
      [{ outcome_id: 'o1', result: 'lost', return_pct: -100, exit_reason: 'expired_unresolvable', closed_at: new Date() }],
      { count: 1 },                            // clearPositionPendingSettlement UPDATE
    ]);
    const redis = makeRedis();
    const summary = {
      redeemsFetched: 0, alreadyProcessed: 0, outcomesInserted: 0,
      outcomesFlipped: 0, positionsCleared: 0, synthInsertsSkipped: 0, errors: 0,
    };
    await reconcileRedeem(redis as never, makeRedeem({ usdcSize: 0 }), summary);

    expect(summary.outcomesInserted).toBe(0);
    expect(summary.outcomesFlipped).toBe(0);
    // NEW behavior: positionsCleared increments even though we didn't touch the outcome row
    expect(summary.positionsCleared).toBe(1);
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  it('does NOT clear pending_settlement when it was already false on existing-lost', async () => {
    // Same as above but positions row has pending_settlement=false already.
    // No UPDATE fires; positionsCleared stays 0.
    scriptSqlCalls([
      [{ market_id: '2029699' }],
      [makePositionRow({ pendingSettlement: false })],
      [{ outcome_id: 'o1', result: 'lost', return_pct: -100, exit_reason: 'expired_unresolvable', closed_at: new Date() }],
      // Note: no { count: 1 } since we don't expect the UPDATE SQL to fire
    ]);
    const redis = makeRedis();
    const summary = {
      redeemsFetched: 0, alreadyProcessed: 0, outcomesInserted: 0,
      outcomesFlipped: 0, positionsCleared: 0, synthInsertsSkipped: 0, errors: 0,
    };
    await reconcileRedeem(redis as never, makeRedeem({ usdcSize: 0 }), summary);

    expect(summary.positionsCleared).toBe(0);
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  it('skips synthetic insert when no position row matches the condition_id', async () => {
    scriptSqlCalls([
      [],  // market_catalog fallback → no marketIds
      [],  // question-fallback lookup → no positions either
    ]);
    const redis = makeRedis();
    const summary = {
      redeemsFetched: 0, alreadyProcessed: 0, outcomesInserted: 0,
      outcomesFlipped: 0, positionsCleared: 0, synthInsertsSkipped: 0, errors: 0,
    };
    await reconcileRedeem(redis as never, makeRedeem(), summary);

    expect(summary.synthInsertsSkipped).toBe(1);
    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalled();
  });

  it('question-fallback recovers a position when market_catalog has no mapping', async () => {
    // First SQL (market_catalog IIFE) returns empty → marketIds=[] → positions empty.
    // Second SQL (question-fallback queryPositionsByQuestion) returns a position.
    // Third SQL (outcomes lookup) returns empty.
    // Fourth SQL (positions update) confirms clear.
    scriptSqlCalls([
      [],                                   // market_catalog → no marketIds
      [makePositionRow()],                  // question-fallback → found
      [],                                   // outcomes lookup
      { count: 1 },                         // positions update
    ]);
    const redis = makeRedis();
    const summary = {
      redeemsFetched: 0, alreadyProcessed: 0, outcomesInserted: 0,
      outcomesFlipped: 0, positionsCleared: 0, synthInsertsSkipped: 0, errors: 0,
    };
    await reconcileRedeem(redis as never, makeRedeem(), summary);

    expect(summary.outcomesInserted).toBe(1);
    expect(summary.synthInsertsSkipped).toBe(0);
    expect(mockRecordOutcome).toHaveBeenCalled();
  });
});

describe('runPmActivityReconciler', () => {
  beforeEach(() => {
    mockSqlTag.mockReset();
    mockFetch.mockReset();
    mockRecordOutcome.mockReset();
    mockRecordOutcome.mockResolvedValue(undefined);
    mockNotifyMarketResolved.mockReset();
    mockNotifyMarketResolved.mockResolvedValue(undefined);
    mockLoadConfig.mockReset();
    mockLoadConfig.mockReturnValue({
      PM_RECONCILER_ENABLED: true,
      PM_RECONCILER_LIMIT: 500,
      POLYMARKET_FUNDER_ADDRESS: '0x2474251E6F057d57d045853Bf94fB15DBd50Ec29',
      POLYGON_WALLET_PRIVATE_KEY: '',
    });
  });

  it('returns early when disabled', async () => {
    mockLoadConfig.mockReturnValue({
      PM_RECONCILER_ENABLED: false,
      PM_RECONCILER_LIMIT: 500,
      POLYMARKET_FUNDER_ADDRESS: '0x2474251E6F057d57d045853Bf94fB15DBd50Ec29',
      POLYGON_WALLET_PRIVATE_KEY: '',
    });
    const redis = makeRedis();
    const out = await runPmActivityReconciler(redis as never);
    expect(out.redeemsFetched).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns early when wallet cannot be resolved', async () => {
    mockLoadConfig.mockReturnValue({
      PM_RECONCILER_ENABLED: true,
      PM_RECONCILER_LIMIT: 500,
      POLYMARKET_FUNDER_ADDRESS: '',
      POLYGON_WALLET_PRIVATE_KEY: '',
    });
    const redis = makeRedis();
    const out = await runPmActivityReconciler(redis as never);
    expect(out.redeemsFetched).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('processes multiple redeems and aggregates the summary', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          makeRedeem({ transactionHash: '0xtx1', conditionId: '0xcond_a' }),
          makeRedeem({ transactionHash: '0xtx2', conditionId: '0xcond_b', usdcSize: 0, size: 10 }),
        ]),
    } as Response);
    // Cycle scripts need: buildConditionToMarketsMap (1 call with BOTH condition_id + market_id per conditionId)
    // + per-redeem (positions + outcomes + update) × N.
    scriptSqlCalls([
      [
        { condition_id: '0xcond_a', market_id: 'mkt-a' },
        { condition_id: '0xcond_b', market_id: 'mkt-b' },
      ],  // market_catalog map build
      [makePositionRow({ conditionId: '0xcond_a' })],  // positions A
      [],                                                // outcomes A
      { count: 1 },                                      // positions update A
      [makePositionRow({ conditionId: '0xcond_b' })],  // positions B
      [],                                                // outcomes B
      { count: 1 },                                      // positions update B
    ]);
    const redis = makeRedis();
    const out = await runPmActivityReconciler(redis as never);

    expect(out.redeemsFetched).toBe(2);
    expect(out.outcomesInserted).toBe(2);
    expect(out.positionsCleared).toBe(2);
    expect(mockRecordOutcome).toHaveBeenCalledTimes(2);
  });

  it('checkpoint filters out redeems at-or-before the stored timestamp', async () => {
    // Three fetched redeems with timestamps 100, 200, 300.
    // Stored checkpoint = 200 → only ts=300 should be processed.
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          makeRedeem({ transactionHash: '0xa', conditionId: '0xa', timestamp: 100 }),
          makeRedeem({ transactionHash: '0xb', conditionId: '0xb', timestamp: 200 }),
          makeRedeem({ transactionHash: '0xc', conditionId: '0xc', timestamp: 300 }),
        ]),
    } as Response);
    scriptSqlCalls([
      [{ condition_id: '0xc', market_id: 'mkt-c' }],  // map build — only 0xc survives the checkpoint filter
      [makePositionRow({ conditionId: '0xc' })],
      [],
      { count: 1 },
    ]);
    const redis = makeRedis({
      get: vi.fn().mockResolvedValue('200'),
    });
    const out = await runPmActivityReconciler(redis as never);

    expect(out.redeemsFetched).toBe(3);
    expect(out.outcomesInserted).toBe(1);
    expect(mockRecordOutcome).toHaveBeenCalledTimes(1);
    // Advance checkpoint to 300 (max processed)
    expect(redis.set).toHaveBeenCalledWith(
      'pm-reconciler:last-ts',
      '300',
    );
  });

  it('does NOT advance the checkpoint when any redeem reconcile throws', async () => {
    // Three redeems in the toProcess window; the middle one's SQL throws.
    // Checkpoint should NOT advance — next cycle must retry the whole window.
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          makeRedeem({ transactionHash: '0xa', conditionId: '0xa', timestamp: 110 }),
          makeRedeem({ transactionHash: '0xb', conditionId: '0xb', timestamp: 120 }),
          makeRedeem({ transactionHash: '0xc', conditionId: '0xc', timestamp: 130 }),
        ]),
    } as Response);
    mockSqlTag.mockReset();
    mockSqlTag
      // map build (single call up front for the whole cycle)
      .mockResolvedValueOnce([
        { condition_id: '0xa', market_id: 'mkt-a' },
        { condition_id: '0xb', market_id: 'mkt-b' },
        { condition_id: '0xc', market_id: 'mkt-c' },
      ])
      // redeem A (success)
      .mockResolvedValueOnce([makePositionRow({ conditionId: '0xa' })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ count: 1 })
      // redeem B (positions lookup throws)
      .mockRejectedValueOnce(new Error('simulated db failure on B'))
      // redeem C (success)
      .mockResolvedValueOnce([makePositionRow({ conditionId: '0xc' })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ count: 1 });
    const redis = makeRedis({ get: vi.fn().mockResolvedValue('100') });
    const out = await runPmActivityReconciler(redis as never);

    expect(out.errors).toBe(1);
    expect(out.outcomesInserted).toBe(2);
    const checkpointSet = (redis.set.mock.calls as unknown[][]).find(
      (args) => args[0] === 'pm-reconciler:last-ts',
    );
    expect(checkpointSet).toBeUndefined();
  });

  it('flip path updates closed_at and holding_hours on the outcome row', async () => {
    // Redeem at ts=1776923780 (2026-04-21T18:36:20Z); position opened 2026-04-21T18:34:57Z.
    // Expected holding_hours = (1776923780*1000 - 2026-04-21T18:34:57Z) / 3.6e6 ≈ 0.0228
    const openedAt = '2026-04-21T18:34:57Z';
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([makeRedeem({ timestamp: 1776923780 })]),
    } as Response);
    let capturedFlipArgs: unknown[] | null = null;
    mockSqlTag.mockReset();
    mockSqlTag
      // map build
      .mockImplementationOnce(() =>
        Promise.resolve([{ condition_id: '0xcond_weather_hk_30', market_id: 'mkt-hk' }]),
      )
      // positions by marketIds
      .mockImplementationOnce(() => Promise.resolve([makePositionRow({ openedAt })]))
      // outcomes lookup
      .mockImplementationOnce(() =>
        Promise.resolve([
          { outcome_id: 'o1', result: 'lost', return_pct: -6.12, exit_reason: 'stop_loss', closed_at: new Date() },
        ]),
      )
      // UPDATE outcomes — capture template args
      .mockImplementationOnce((...args: unknown[]) => {
        capturedFlipArgs = args;
        return Promise.resolve({ count: 1 });
      })
      .mockImplementationOnce(() => Promise.resolve({ count: 1 })); // UPDATE positions
    const redis = makeRedis({ get: vi.fn().mockResolvedValue('0') });
    const out = await runPmActivityReconciler(redis as never);

    expect(out.outcomesFlipped).toBe(1);
    expect(capturedFlipArgs).not.toBeNull();
    // The UPDATE interpolates closedAt (ISO string) and holdingHours (number)
    // somewhere in its tagged-template values. Verify both are present.
    const serialized = JSON.stringify(capturedFlipArgs);
    // redeem.timestamp 1776923780 = 2026-04-23T05:56:20Z; must appear in UPDATE
    expect(serialized).toContain('2026-04-23T05:56:20.000Z');
    // holding_hours ≈ 35.36 (redeem_ts - opened_at over 3.6e6 ms)
    const expectedHours =
      (1776923780 * 1000 - new Date(openedAt).getTime()) / 3_600_000;
    expect(serialized).toContain(expectedHours.toString().slice(0, 5));
  });

  it('first-ever run (no checkpoint) processes the full fetched window', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          makeRedeem({ transactionHash: '0xa', conditionId: '0xa', timestamp: 100 }),
          makeRedeem({ transactionHash: '0xb', conditionId: '0xb', timestamp: 200 }),
        ]),
    } as Response);
    scriptSqlCalls([
      [
        { condition_id: '0xa', market_id: 'mkt-a' },
        { condition_id: '0xb', market_id: 'mkt-b' },
      ],  // map build
      [makePositionRow({ conditionId: '0xa' })],
      [],
      { count: 1 },
      [makePositionRow({ conditionId: '0xb' })],
      [],
      { count: 1 },
    ]);
    const redis = makeRedis({ get: vi.fn().mockResolvedValue(null) });
    const out = await runPmActivityReconciler(redis as never);
    expect(out.redeemsFetched).toBe(2);
    expect(out.outcomesInserted).toBe(2);
  });
});
