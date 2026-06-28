import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Position } from '../../execution/positionLedger.js';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockLoadConfig = vi.fn(() => ({
  CLOB_ORDER_TYPE: 'FAK',
  WEATHER_EXIT_BLOCKED_ENABLED: false,
  RECONCILE_MIN_HEAL_SHARES: 1,
} as Record<string, unknown>));
vi.mock('../../shared/config.js', () => ({ loadConfig: mockLoadConfig }));

vi.mock('../../db/writeQueue.js', () => ({ enqueueWrite: vi.fn() }));

vi.mock('../../shared/clob.js', () => ({
  submitClobSell: vi.fn(),
  submitClobBuy: vi.fn(),
  getClobBalance: vi.fn(),
  fetchClobTokenBalance: vi.fn().mockResolvedValue({ ok: true, balance: 5.0 }),
  parseBalanceFromClobError: vi.fn().mockReturnValue(null),
  CLOB_MIN_ORDER_USD: 1.0,
}));

vi.mock('../../execution/positionLedger.js', () => ({
  closePosition: vi.fn(),
  getPosition: vi.fn().mockResolvedValue(null),
  getOpenPositions: vi.fn(),
  recordPosition: vi.fn(),
  hasOpenPosition: vi.fn(),
  updatePositionShares: vi.fn(),
  markPositionSynthHedged: vi.fn(),
  markPositionPendingSettlement: vi.fn(),
  markPositionExitBlocked: vi.fn(),
  // Real-ish implementation so the executor's weather discriminator works.
  isWeatherSourced: (s?: string | null) =>
    (s?.startsWith('weather:') || s?.startsWith('weather-oracle:') || s?.startsWith('reconciled:weather')) ?? false,
}));

vi.mock('../../execution/telegram.js', () => ({
  notifyTakeProfitExecuted: vi.fn(),
  notifyTradeExecuted: vi.fn(),
  notifyTradeError: vi.fn(),
}));

vi.mock('../../shared/bankroll.js', () => ({
  creditProceeds: vi.fn<any>().mockResolvedValue(100),
}));

vi.mock('../../shared/outcomeRecorder.js', () => ({
  recordOutcome: vi.fn().mockResolvedValue(undefined),
  inferCategory: vi.fn().mockReturnValue('geopolitical'),
  inferSource: vi.fn().mockReturnValue('osint'),
}));

vi.mock('../../shared/positionOutcomeRecorder.js', () => ({
  recordPositionOutcome: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../shared/hyperliquid.js', () => ({
  getHyperliquid: vi.fn(() => ({
    closePosition: vi.fn().mockResolvedValue({ success: true }),
    getClearinghouseState: vi.fn().mockResolvedValue({}),
    getOpenPositions: vi.fn().mockResolvedValue([]),
  })),
  resolveHlSymbol: vi.fn().mockReturnValue(null),
}));

const { submitClobSell, fetchClobTokenBalance } = await import('../../shared/clob.js');
const { closePosition, updatePositionShares, markPositionPendingSettlement, markPositionExitBlocked } = await import('../../execution/positionLedger.js');
const { enqueueWrite } = await import('../../db/writeQueue.js');
const { notifyTakeProfitExecuted } = await import('../../execution/telegram.js');
const { recordPositionOutcome } = await import('../../shared/positionOutcomeRecorder.js');
const { executeTakeProfit, resolveMakerExitPrice } = await import('../takeProfitExecutor.js');

const mockClobSell = vi.mocked(submitClobSell);
const mockFetchClobTokenBalance = vi.mocked(fetchClobTokenBalance);
const mockClose = vi.mocked(closePosition);
const mockUpdateShares = vi.mocked(updatePositionShares);
const mockMarkPending = vi.mocked(markPositionPendingSettlement);
const mockMarkExitBlocked = vi.mocked(markPositionExitBlocked);
const mockNotify = vi.mocked(notifyTakeProfitExecuted);
const mockRecordOutcome = vi.mocked(recordPositionOutcome);

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    marketId: 'mkt-1',
    conditionId: 'cond-1',
    clobTokenIds: ['tok-yes', 'tok-no'],
    question: 'Will X happen?',
    direction: 'YES',
    entryPrice: 0.4,
    stakeUsd: 5.0,
    sharesHeld: 12.5,
    consensusProbability: 0.7,
    edgeMagnitude: 0.3,
    sourcedFrom: 'headline',
    openedAt: new Date().toISOString(),
    executionVenue: 'clob',
    ...overrides,
  };
}

function makeRedis() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  } as unknown as Parameters<typeof executeTakeProfit>[0]['redis'];
}

describe('executeTakeProfit', () => {
  beforeEach(() => {
    mockClobSell.mockReset();
    mockClose.mockReset();
    mockUpdateShares.mockReset();
    mockMarkPending.mockReset();
    mockMarkExitBlocked.mockReset();
    mockNotify.mockReset();
    mockRecordOutcome.mockReset();
    mockClose.mockResolvedValue(undefined);
    mockUpdateShares.mockResolvedValue(undefined);
    mockMarkPending.mockResolvedValue(undefined);
    mockMarkExitBlocked.mockResolvedValue(undefined);
    mockNotify.mockResolvedValue(undefined);
    mockRecordOutcome.mockResolvedValue(undefined);
    mockLoadConfig.mockReturnValue({
      CLOB_ORDER_TYPE: 'FAK',
      WEATHER_EXIT_BLOCKED_ENABLED: false,
      RECONCILE_MIN_HEAL_SHARES: 1,
    });
    // Default CLOB setup
    mockFetchClobTokenBalance.mockResolvedValue({ ok: true, balance: 12.5 });
    mockClobSell.mockResolvedValue({ success: true, tx_hash: '0xexit' });
  });

  it('executes CLOB sell on the same side as entry for YES position', async () => {
    await executeTakeProfit({
      position: makePosition({ direction: 'YES' }),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(mockClobSell).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-yes', orderType: 'FAK' }),
    );
  });

  it('executes CLOB sell on the same side as entry for NO position', async () => {
    await executeTakeProfit({
      position: makePosition({ direction: 'NO' }),
      currentPrice: 0.35,
      returnPct: 30,
      reason: 'divergence_closed',
      redis: makeRedis(),
    });

    expect(mockClobSell).toHaveBeenCalledWith(expect.objectContaining({ tokenId: 'tok-no' }));
  });

  it('uses sharesHeld when available', async () => {
    await executeTakeProfit({
      position: makePosition({ sharesHeld: 12.5 }),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(mockClobSell).toHaveBeenCalledWith(expect.objectContaining({ shares: 12.5 }));
  });

  it('falls back to stake/price estimate when sharesHeld is absent', async () => {
    mockFetchClobTokenBalance.mockResolvedValue({ ok: true, balance: 12.5 });
    const pos = makePosition({ sharesHeld: undefined, stakeUsd: 5.0, entryPrice: 0.4 });

    await executeTakeProfit({
      position: pos,
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    // fallback: 5.0 / 0.4 = 12.5
    expect(mockClobSell).toHaveBeenCalledWith(expect.objectContaining({ shares: 12.5 }));
  });

  it('closes position in ledger on success', async () => {
    await executeTakeProfit({
      position: makePosition(),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(mockClose).toHaveBeenCalledWith(
      expect.objectContaining({ get: expect.any(Function) }),
      'mkt-1',
      'YES',
    );
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('returns success=true with txHash on success', async () => {
    const result = await executeTakeProfit({
      position: makePosition(),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(result.success).toBe(true);
    expect(result.txHash).toBe('0xexit');
    expect(result.returnPct).toBeDefined();
  });

  it('returns success=false when CLOB sell returns success=false', async () => {
    mockClobSell.mockResolvedValue({ success: false, error: 'CLOB order rejected' });

    const result = await executeTakeProfit({
      position: makePosition(),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('CLOB order rejected');
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('aborts without calling submitClobSell when entryPrice=0 and sharesHeld is absent', async () => {
    const result = await executeTakeProfit({
      position: makePosition({ entryPrice: 0, sharesHeld: undefined }),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/terminal_no_balance/);
    expect(mockClobSell).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
    expect(mockUpdateShares).toHaveBeenCalledWith(
      expect.anything(),
      'mkt-1',
      'YES',
      0,
      'terminal_no_balance',
    );
  });

  it('aborts without calling submitClobSell when sharesHeld is 0', async () => {
    const result = await executeTakeProfit({
      position: makePosition({ sharesHeld: 0 }),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid sharesToSell/);
    expect(mockClobSell).not.toHaveBeenCalled();
  });

  // ── CLOB venue routing ────────────────────────────────────────────────────

  it('routes CLOB-venue position to submitClobSell with correct token', async () => {
    mockFetchClobTokenBalance.mockResolvedValue({ ok: true, balance: 15.0 });
    mockClobSell.mockResolvedValue({ success: true, tx_hash: '0xclobexit' });

    const result = await executeTakeProfit({
      position: makePosition({ executionVenue: 'clob', direction: 'YES' }),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(result.success).toBe(true);
    expect(result.txHash).toBe('0xclobexit');
    expect(mockClobSell).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-yes', shares: 12.5, orderType: 'FAK' }),
    );
    expect(mockClose).toHaveBeenCalledWith(
      expect.objectContaining({ get: expect.any(Function) }),
      'mkt-1',
      'YES',
    );
  });

  it('routes CLOB-venue NO position to correct token ID', async () => {
    mockClobSell.mockResolvedValue({ success: true, tx_hash: '0xclobexit2' });

    await executeTakeProfit({
      position: makePosition({ executionVenue: 'clob', direction: 'NO' }),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(mockClobSell).toHaveBeenCalledWith(expect.objectContaining({ tokenId: 'tok-no' }));
  });

  it('returns error when CLOB-venue position has no token ID', async () => {
    const result = await executeTakeProfit({
      position: makePosition({ executionVenue: 'clob', clobTokenIds: [] }),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('missing token ID');
    expect(mockClobSell).not.toHaveBeenCalled();
  });

  it('returns success=false when CLOB sell fails', async () => {
    mockClobSell.mockResolvedValue({ success: false, error: 'CLOB order rejected' });

    const result = await executeTakeProfit({
      position: makePosition({ executionVenue: 'clob' }),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('CLOB order rejected');
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('caps CLOB sell at actual on-chain balance when it is less than Redis-tracked shares', async () => {
    // On-chain balance is 2.5 but ledger says 3.0 — sell should use 2.5
    mockFetchClobTokenBalance.mockResolvedValue({ ok: true, balance: 2.5 });
    mockClobSell.mockResolvedValue({ success: true, tx_hash: '0xcapped' });

    const result = await executeTakeProfit({
      position: makePosition({ executionVenue: 'clob', sharesHeld: 3.0, direction: 'YES' }),
      currentPrice: 0.65,
      returnPct: 20,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(result.success).toBe(true);
    expect(mockClobSell).toHaveBeenCalledWith(expect.objectContaining({ shares: 2.5 }));
  });

  // ── Realized returnPct recording (2026-04-24 incident fix) ───────────────

  it('records realized returnPct from venue fill price, not the trigger returnPct', async () => {
    // Mirrors the 2026-04-24 ETH Up-or-Down incident: trigger reports −40%
    // (stale WS cache said $0.30), sell actually fills at $0.80 (venue
    // reports `price`). realized = (10 × 0.8 − 5) / 5 = +60%.
    mockFetchClobTokenBalance.mockResolvedValue({ ok: true, balance: 10 });
    mockClobSell.mockResolvedValue({
      success: true,
      tx_hash: '0xluckyfill',
      shares_bought: 10,
      price: 0.8,
      cost: 8.0,
    });

    const result = await executeTakeProfit({
      position: makePosition({
        executionVenue: 'clob',
        direction: 'YES',
        stakeUsd: 5.0,
        sharesHeld: 10,
        entryPrice: 0.5,
      }),
      currentPrice: 0.3, // stale quote — what triggered the signal
      returnPct: -40,
      reason: 'oracle_lag_stop_loss',
      redis: makeRedis(),
    });

    expect(result.success).toBe(true);
    expect(result.returnPct).toBeCloseTo(60, 2);
    expect(mockRecordOutcome).toHaveBeenCalledTimes(1);
    const outcomeCall = mockRecordOutcome.mock.calls[0];
    const outcomeArgs = outcomeCall?.[2] as { result: string; returnPct: number };
    expect(outcomeArgs.result).toBe('won');
    expect(outcomeArgs.returnPct).toBeCloseTo(60, 2);
    // Notify should reflect realized, not trigger
    const notifyCall = mockNotify.mock.calls[0]?.[0] as { returnPct: number };
    expect(notifyCall.returnPct).toBeCloseTo(60, 2);
  });

  it('falls back to trigger returnPct when the venue does not report a fill price', async () => {
    // Taker path today: `submitClobSell` returns shares_bought but SDK didn't
    // populate `price` or `cost`. Without a venue-reported fill price we
    // cannot confidently compute realized P&L from `currentPrice` (which
    // may be the stale quote), so we keep the trigger returnPct and warn.
    mockFetchClobTokenBalance.mockResolvedValue({ ok: true, balance: 10 });
    mockClobSell.mockResolvedValue({
      success: true,
      tx_hash: '0xnoprice',
      shares_bought: 10,
    });

    await executeTakeProfit({
      position: makePosition({
        executionVenue: 'clob',
        direction: 'YES',
        stakeUsd: 5.0,
        sharesHeld: 10,
        entryPrice: 0.5,
      }),
      currentPrice: 0.3,
      returnPct: -40,
      reason: 'oracle_lag_stop_loss',
      redis: makeRedis(),
    });

    expect(mockRecordOutcome).toHaveBeenCalledTimes(1);
    const outcomeArgs = mockRecordOutcome.mock.calls[0]?.[2] as { returnPct: number; result: string };
    expect(outcomeArgs.returnPct).toBeCloseTo(-40, 2);
    expect(outcomeArgs.result).toBe('lost');
  });

  it('derives fill price from cost/shares_bought when `price` is absent', async () => {
    // Some SDK paths populate `cost` (USDC) and `shares_bought` but not
    // `price` directly. `deriveClobFillPrice` fills the gap.
    mockFetchClobTokenBalance.mockResolvedValue({ ok: true, balance: 10 });
    mockClobSell.mockResolvedValue({
      success: true,
      tx_hash: '0xcostonly',
      shares_bought: 10,
      cost: 7.7,
    });

    await executeTakeProfit({
      position: makePosition({
        executionVenue: 'clob',
        direction: 'YES',
        stakeUsd: 5.0,
        sharesHeld: 10,
        entryPrice: 0.5,
      }),
      currentPrice: 0.3,
      returnPct: -40,
      reason: 'oracle_lag_stop_loss',
      redis: makeRedis(),
    });

    // proceeds = 10 × (7.7 / 10) = 7.7 → realized = (7.7 − 5) / 5 = +54%
    const outcomeArgs = mockRecordOutcome.mock.calls[0]?.[2] as { returnPct: number };
    expect(outcomeArgs.returnPct).toBeCloseTo(54, 2);
  });

  it('falls back to trigger returnPct when stakeUsd is missing', async () => {
    mockFetchClobTokenBalance.mockResolvedValue({ ok: true, balance: 10 });
    mockClobSell.mockResolvedValue({
      success: true,
      tx_hash: '0xnostake',
      shares_bought: 10,
      price: 0.5,
    });

    await executeTakeProfit({
      position: makePosition({
        executionVenue: 'clob',
        direction: 'YES',
        stakeUsd: undefined as unknown as number,
        sharesHeld: 10,
      }),
      currentPrice: 0.5,
      returnPct: 12.5,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(mockRecordOutcome).toHaveBeenCalledTimes(1);
    const outcomeArgs = mockRecordOutcome.mock.calls[0]?.[2] as { returnPct: number };
    expect(outcomeArgs.returnPct).toBeCloseTo(12.5, 2);
  });

  // ── Partial-fill ledger update (2026-04-24 incident fix) ─────────────────

  it('on partial CLOB fill (no sweep), falls through to normal close path', async () => {
    // Baseline: RESIDUAL_SWEEP_ENABLED off in the default config mock so the
    // sweep branch never fires. Position closes cleanly with realized return.
    mockFetchClobTokenBalance.mockResolvedValue({ ok: true, balance: 10 });
    mockClobSell.mockResolvedValue({
      success: true,
      tx_hash: '0xpartial',
      shares_bought: 9.99,
    });

    await executeTakeProfit({
      position: makePosition({
        executionVenue: 'clob',
        direction: 'YES',
        stakeUsd: 5.0,
        sharesHeld: 10,
        entryPrice: 0.5,
      }),
      currentPrice: 0.8,
      returnPct: 60,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(mockClose).toHaveBeenCalledWith(
      expect.any(Object),
      'mkt-1',
      'YES',
    );
  });

  it('sweep-enabled partial fill leaves residual: updates sharesHeld + partial_exit marker BEFORE pendingSettlement', async () => {
    // Force the sweep path: primary fill is 9.99 of 10, sweep finds 0.01
    // residual worth <$0.01 → below RESIDUAL_SWEEP_MIN_NOTIONAL_USD → sweep
    // bails with residualRemainsOnVenue=true and additionalSharesSold=0.
    // finalizeClobExit must then: (1) update sharesHeld to residual with a
    // `partial_exit:<ts>` marker, (2) mark pendingSettlement. Order matters
    // — the marker is what lets the redeemer suppress the dup-outcome row,
    // so it must land BEFORE pendingSettlement (otherwise any racing
    // reconciler-then-redeemer cycle in between could write -100%).
    const { loadConfig } = await import('../../shared/config.js');
    const mockCfg = vi.mocked(loadConfig);
    mockCfg.mockReturnValue({
      CLOB_ORDER_TYPE: 'FAK',
      RESIDUAL_SWEEP_ENABLED: true,
      RESIDUAL_SWEEP_MAX_ATTEMPTS: 1,
      RESIDUAL_SWEEP_MIN_NOTIONAL_USD: 1.0,
    } as any);

    // First call: entry-side balance check → full position. Second call:
    // sweep's fetchClobTokenBalance → tiny residual below min notional.
    mockFetchClobTokenBalance
      .mockResolvedValueOnce({ ok: true, balance: 10 })
      .mockResolvedValueOnce({ ok: true, balance: 0.01 });
    mockClobSell.mockResolvedValue({
      success: true,
      tx_hash: '0xpartialsweep',
      shares_bought: 9.99,
      price: 0.8,
    });

    const callOrder: string[] = [];
    mockUpdateShares.mockImplementation(async () => {
      callOrder.push('updatePositionShares');
    });
    mockMarkPending.mockImplementation(async () => {
      callOrder.push('markPositionPendingSettlement');
    });

    await executeTakeProfit({
      position: makePosition({
        executionVenue: 'clob',
        direction: 'YES',
        stakeUsd: 5.0,
        sharesHeld: 10,
        entryPrice: 0.5,
      }),
      currentPrice: 0.8,
      returnPct: 60,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    // updatePositionShares(redis, marketId, direction, residualShares, 'partial_exit:<ts>')
    expect(mockUpdateShares).toHaveBeenCalledTimes(1);
    const updateCall = mockUpdateShares.mock.calls[0];
    expect(updateCall?.[1]).toBe('mkt-1');
    expect(updateCall?.[2]).toBe('YES');
    expect(updateCall?.[3]).toBeCloseTo(0.01, 6); // residual = 10 − 9.99
    expect(updateCall?.[4]).toMatch(/^partial_exit:/);

    expect(mockMarkPending).toHaveBeenCalledWith(expect.any(Object), 'mkt-1', 'YES');

    // The marker must land BEFORE the pending flag so no reconciler window
    // can slip in between.
    expect(callOrder).toEqual([
      'updatePositionShares',
      'markPositionPendingSettlement',
    ]);

    // And the realized outcome must be recorded with realized returnPct.
    const outcomeArgs = mockRecordOutcome.mock.calls[0]?.[2] as { result: string; returnPct: number };
    expect(outcomeArgs.result).toBe('won');
    expect(outcomeArgs.returnPct).toBeCloseTo(((9.99 * 0.8) - 5.0) / 5.0 * 100, 2);
  });

  // ── Weather exit-blocked (sub-min-notional) ──────────────────────────────────

  const weatherPos = (overrides: Partial<Position> = {}) =>
    makePosition({
      direction: 'NO',
      sourcedFrom: 'weather:miami:2026-06-27:90-91°F',
      ...overrides,
    });

  it('weather full position below min notional → exit-blocked, NOT pendingSettlement (flag on)', async () => {
    mockLoadConfig.mockReturnValue({
      CLOB_ORDER_TYPE: 'FAK',
      WEATHER_EXIT_BLOCKED_ENABLED: true,
      RECONCILE_MIN_HEAL_SHARES: 1,
    });
    // 5.882351 sh × 0.13 = $0.7647 < $1 → pre-sync min-notional, shares ≥ 1 → exit-blocked.
    const result = await executeTakeProfit({
      position: weatherPos({ sharesHeld: 5.882351, entryPrice: 0.65 }),
      currentPrice: 0.13,
      returnPct: -80,
      reason: 'weather_drift',
      redis: makeRedis(),
    });

    expect(mockMarkExitBlocked).toHaveBeenCalledWith(expect.any(Object), 'mkt-1', 'NO', 'min_notional');
    expect(mockMarkPending).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain('exit_blocked_min_notional');
    // Shadow row records the blocked exit (wouldBlock=true per repo convention).
    expect(vi.mocked(enqueueWrite)).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ kind: 'weather_exit_blocked', wouldBlock: true }),
    );
  });

  it('weather full position below min notional → pendingSettlement when flag OFF (default)', async () => {
    // Flag defaults false → legacy behaviour preserved.
    const result = await executeTakeProfit({
      position: weatherPos({ sharesHeld: 5.882351, entryPrice: 0.65 }),
      currentPrice: 0.13,
      returnPct: -80,
      reason: 'weather_drift',
      redis: makeRedis(),
    });

    expect(mockMarkPending).toHaveBeenCalledWith(expect.any(Object), 'mkt-1', 'NO');
    expect(mockMarkExitBlocked).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('weather DUST below min notional → still pendingSettlement, not exit-blocked (flag on)', async () => {
    mockLoadConfig.mockReturnValue({
      CLOB_ORDER_TYPE: 'FAK',
      WEATHER_EXIT_BLOCKED_ENABLED: true,
      RECONCILE_MIN_HEAL_SHARES: 1,
    });
    // 0.008707 sh < RECONCILE_MIN_HEAL_SHARES → genuine dust → pendingSettlement.
    await executeTakeProfit({
      position: weatherPos({ sharesHeld: 0.008707, entryPrice: 0.55 }),
      currentPrice: 0.5,
      returnPct: -10,
      reason: 'weather_drift',
      redis: makeRedis(),
    });

    expect(mockMarkPending).toHaveBeenCalledWith(expect.any(Object), 'mkt-1', 'NO');
    expect(mockMarkExitBlocked).not.toHaveBeenCalled();
  });

  it('NON-weather full position below min notional → pendingSettlement even with flag on', async () => {
    mockLoadConfig.mockReturnValue({
      CLOB_ORDER_TYPE: 'FAK',
      WEATHER_EXIT_BLOCKED_ENABLED: true,
      RECONCILE_MIN_HEAL_SHARES: 1,
    });
    await executeTakeProfit({
      position: makePosition({ sourcedFrom: 'headline', sharesHeld: 5, entryPrice: 0.5 }),
      currentPrice: 0.13,
      returnPct: -70,
      reason: 'take_profit',
      redis: makeRedis(),
    });

    expect(mockMarkPending).toHaveBeenCalledWith(expect.any(Object), 'mkt-1', 'YES');
    expect(mockMarkExitBlocked).not.toHaveBeenCalled();
  });

  it('weather post-sync notional below min (on-chain balance shrank) → exit-blocked (flag on)', async () => {
    mockLoadConfig.mockReturnValue({
      CLOB_ORDER_TYPE: 'FAK',
      WEATHER_EXIT_BLOCKED_ENABLED: true,
      RECONCILE_MIN_HEAL_SHARES: 1,
    });
    // pre-sync 5.882351 × 0.30 = $1.76 ≥ $1 (passes), but on-chain balance is 2 sh →
    // safeShares 2 × 0.30 = $0.60 < $1 → post-sync min-notional, 2 sh ≥ 1 → exit-blocked.
    mockFetchClobTokenBalance.mockResolvedValue({ ok: true, balance: 2 });
    const result = await executeTakeProfit({
      position: weatherPos({ sharesHeld: 5.882351, entryPrice: 0.65 }),
      currentPrice: 0.3,
      returnPct: -54,
      reason: 'weather_drift',
      redis: makeRedis(),
    });

    expect(mockMarkExitBlocked).toHaveBeenCalledWith(expect.any(Object), 'mkt-1', 'NO', 'min_notional');
    expect(mockMarkPending).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
});

describe('resolveMakerExitPrice', () => {
  it('rests below the REAL best ask on a multi-level raw-REST-order book', () => {
    // REST books are best-at-the-END: asks[0] is the WORST ask. Pre-fix this
    // book priced a maker exit at 0.99 − edge = 0.98 instead of off the real
    // 0.51 touch — a resting sell nothing would ever lift.
    const book = {
      bids: [
        { price: '0.01', size: '5' },
        { price: '0.49', size: '100' }, // real best bid — LAST
      ],
      asks: [
        { price: '0.99', size: '5' },
        { price: '0.51', size: '100' }, // real best ask — LAST
      ],
      tick_size: '0.01',
    };

    // 100bps below the REAL ask: 0.51 − 0.01 = 0.50 (= real bid + tick).
    expect(resolveMakerExitPrice(book, 100)).toBeCloseTo(0.50);
  });

  it('clamps the post-only floor to the REAL best bid, not the bottom-of-book bid', () => {
    // Real touch 0.49/0.50. An 8% edge targets 0.42 — below the bid — so the
    // clamp must lift it to REAL bid + tick (0.50), not to 0.01 + tick.
    const book = {
      bids: [
        { price: '0.01', size: '5' },
        { price: '0.49', size: '100' },
      ],
      asks: [
        { price: '0.99', size: '5' },
        { price: '0.50', size: '100' },
      ],
      tick_size: '0.01',
    };

    expect(resolveMakerExitPrice(book, 800)).toBeCloseTo(0.50);
  });
});
