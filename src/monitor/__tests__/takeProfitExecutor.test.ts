import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Position } from '../../execution/positionLedger.js';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    CLOB_ORDER_TYPE: 'FAK',
  })),
}));

vi.mock('../../shared/simmer.js', () => ({
  submitSell: vi.fn(),
  resolveSimmerMarketId: vi.fn(),
  SimmerError: class SimmerError extends Error {
    statusCode: number;
    body: unknown;
    constructor(message: string, statusCode: number, body: unknown) {
      super(message);
      this.name = 'SimmerError';
      this.statusCode = statusCode;
      this.body = body;
    }
  },
}));

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
  getOpenPositions: vi.fn(),
  recordPosition: vi.fn(),
  hasOpenPosition: vi.fn(),
  updatePositionShares: vi.fn(),
  markPositionSynthHedged: vi.fn(),
  markPositionPendingSettlement: vi.fn(),
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

vi.mock('../../shared/hyperliquid.js', () => ({
  getHyperliquid: vi.fn(() => ({
    closePosition: vi.fn().mockResolvedValue({ success: true }),
    getClearinghouseState: vi.fn().mockResolvedValue({}),
    getOpenPositions: vi.fn().mockResolvedValue([]),
  })),
  resolveHlSymbol: vi.fn().mockReturnValue(null),
}));

const { submitSell, resolveSimmerMarketId } = await import('../../shared/simmer.js');
const { submitClobSell, fetchClobTokenBalance } = await import('../../shared/clob.js');
const { closePosition, updatePositionShares } = await import('../../execution/positionLedger.js');
const { notifyTakeProfitExecuted } = await import('../../execution/telegram.js');
const { executeTakeProfit } = await import('../takeProfitExecutor.js');

const mockSell = vi.mocked(submitSell);
const mockResolveSimmerMarketId = vi.mocked(resolveSimmerMarketId);
const mockClobSell = vi.mocked(submitClobSell);
const mockFetchClobTokenBalance = vi.mocked(fetchClobTokenBalance);
const mockClose = vi.mocked(closePosition);
const mockUpdateShares = vi.mocked(updatePositionShares);
const mockNotify = vi.mocked(notifyTakeProfitExecuted);

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
    executionVenue: 'simmer',
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
    mockSell.mockReset();
    mockResolveSimmerMarketId.mockReset();
    mockClobSell.mockReset();
    mockClose.mockReset();
    mockUpdateShares.mockReset();
    mockNotify.mockReset();
    // Default: Simmer resolves to a stable UUID for all tests
    mockResolveSimmerMarketId.mockResolvedValue('simmer-uuid-abc123');
    mockClose.mockResolvedValue(undefined);
    mockUpdateShares.mockResolvedValue(undefined);
    mockNotify.mockResolvedValue(undefined);
  });

  it('executes sell on the same side as entry for YES position', async () => {
    mockSell.mockResolvedValue({ success: true, tx_hash: '0xexit' });

    await executeTakeProfit({
      position: makePosition({ direction: 'YES' }),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    // market_id must be the Simmer UUID (resolved from question), NOT the Polymarket numeric ID
    expect(mockSell).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'yes', market_id: 'simmer-uuid-abc123', action: 'sell' }),
    );
  });

  it('returns success=false when Simmer UUID cannot be resolved', async () => {
    mockResolveSimmerMarketId.mockResolvedValue(null);
    mockSell.mockResolvedValue({ success: false, error: 'Market not found in venue' });

    const result = await executeTakeProfit({
      position: makePosition({ clobTokenIds: [] }), // Remove CLOB tokens to test resolution exit specifically
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Market not found in venue');
    expect(mockSell).toHaveBeenCalledTimes(1); // One attempt with Numeric ID after UUID resolution failed
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('executes sell on the same side as entry for NO position', async () => {
    mockSell.mockResolvedValue({ success: true, tx_hash: '0xexit2' });

    await executeTakeProfit({
      position: makePosition({ direction: 'NO' }),
      currentPrice: 0.35,
      returnPct: 30,
      reason: 'divergence_closed',
      redis: makeRedis(),
    });

    expect(mockSell).toHaveBeenCalledWith(expect.objectContaining({ side: 'no', action: 'sell' }));
  });

  it('uses sharesHeld when available', async () => {
    mockSell.mockResolvedValue({ success: true, tx_hash: '0xexit' });

    await executeTakeProfit({
      position: makePosition({ sharesHeld: 12.5 }),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(mockSell).toHaveBeenCalledWith(expect.objectContaining({ shares: 12.5 }));
  });

  it('falls back to stake/price estimate when sharesHeld is absent', async () => {
    mockSell.mockResolvedValue({ success: true, tx_hash: '0xexit' });
    const pos = makePosition({ sharesHeld: undefined, stakeUsd: 5.0, entryPrice: 0.4 });

    await executeTakeProfit({
      position: pos,
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    // fallback: 5.0 / 0.4 = 12.5
    expect(mockSell).toHaveBeenCalledWith(expect.objectContaining({ shares: 12.5 }));
  });

  it('closes position in ledger on success', async () => {
    mockSell.mockResolvedValue({ success: true, tx_hash: '0xexit' });

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
    mockSell.mockResolvedValue({ success: true, tx_hash: '0xexit' });

    const result = await executeTakeProfit({
      position: makePosition(),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(result.success).toBe(true);
    expect(result.txHash).toBe('0xexit');
    expect(result.returnPct).toBe(25);
  });

  it('returns success=false when trade returns success=false', async () => {
    mockSell.mockResolvedValue({ success: false, error: 'slippage' });

    const result = await executeTakeProfit({
      position: makePosition(),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('slippage');
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('returns success=false and does not close ledger when submitSell throws', async () => {
    mockSell.mockRejectedValue(new Error('timeout'));

    const result = await executeTakeProfit({
      position: makePosition(),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timeout');
    expect(mockClose).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('aborts without calling submitSell when entryPrice=0 and sharesHeld is absent', async () => {
    const result = await executeTakeProfit({
      position: makePosition({ entryPrice: 0, sharesHeld: undefined }),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/terminal_no_balance/);
    expect(mockSell).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
    // Verify terminal flag was set
    expect(mockUpdateShares).toHaveBeenCalledWith(
      expect.anything(),
      'mkt-1',
      'YES',
      0,
      'terminal_no_balance',
    );
  });

  it('aborts without calling submitSell when sharesHeld is 0', async () => {
    const result = await executeTakeProfit({
      position: makePosition({ sharesHeld: 0 }),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid sharesToSell/);
    expect(mockSell).not.toHaveBeenCalled();
  });

  // ── CLOB venue routing ────────────────────────────────────────────────────

  it('routes CLOB-venue position to submitClobSell instead of submitSell', async () => {
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
    expect(mockSell).not.toHaveBeenCalled();
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
});
