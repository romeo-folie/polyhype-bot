import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Position } from '../../execution/positionLedger.js';

jest.unstable_mockModule('../../shared/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.unstable_mockModule('../../shared/simmer.js', () => ({
  submitSell: jest.fn(),
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

jest.unstable_mockModule('../../shared/clob.js', () => ({
  submitClobSell: jest.fn(),
  submitClobBuy: jest.fn(),
  getClobBalance: jest.fn(),
}));

jest.unstable_mockModule('../../execution/positionLedger.js', () => ({
  closePosition: jest.fn(),
  getOpenPositions: jest.fn(),
  recordPosition: jest.fn(),
  hasOpenPosition: jest.fn(),
}));

jest.unstable_mockModule('../../execution/telegram.js', () => ({
  notifyTakeProfitExecuted: jest.fn(),
  notifyTradeExecuted: jest.fn(),
  notifyTradeError: jest.fn(),
}));

jest.unstable_mockModule('../../shared/bankroll.js', () => ({
  creditProceeds: jest.fn<() => Promise<number>>().mockResolvedValue(100),
}));

const { submitSell } = await import('../../shared/simmer.js');
const { submitClobSell } = await import('../../shared/clob.js');
const { closePosition } = await import('../../execution/positionLedger.js');
const { notifyTakeProfitExecuted } = await import('../../execution/telegram.js');
const { executeTakeProfit } = await import('../takeProfitExecutor.js');

const mockSell = submitSell as jest.MockedFunction<typeof submitSell>;
const mockClobSell = submitClobSell as jest.MockedFunction<typeof submitClobSell>;
const mockClose = closePosition as jest.MockedFunction<typeof closePosition>;
const mockNotify = notifyTakeProfitExecuted as jest.MockedFunction<typeof notifyTakeProfitExecuted>;

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
  return {} as Parameters<typeof executeTakeProfit>[0]['redis'];
}

describe('executeTakeProfit', () => {
  beforeEach(() => {
    mockSell.mockReset();
    mockClobSell.mockReset();
    mockClose.mockReset();
    mockNotify.mockReset();
    mockClose.mockResolvedValue(undefined);
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

    expect(mockSell).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'yes', market_id: 'mkt-1', action: 'sell' }),
    );
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

    expect(mockSell).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'no', action: 'sell' }),
    );
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

    expect(mockSell).toHaveBeenCalledWith(
      expect.objectContaining({ shares: 12.5 }),
    );
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
    expect(mockSell).toHaveBeenCalledWith(
      expect.objectContaining({ shares: 12.5 }),
    );
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

    expect(mockClose).toHaveBeenCalledWith(makeRedis(), 'mkt-1', 'YES');
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
    expect(result.error).toMatch(/invalid sharesToSell/);
    expect(mockSell).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
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
    expect(mockClose).toHaveBeenCalledWith(makeRedis(), 'mkt-1', 'YES');
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

    expect(mockClobSell).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-no' }),
    );
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
});
