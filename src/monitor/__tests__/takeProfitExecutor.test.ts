import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Position } from '../../execution/positionLedger.js';

jest.unstable_mockModule('../../shared/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.unstable_mockModule('../../shared/simmer.js', () => ({
  submitTrade: jest.fn(),
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

const { submitTrade } = await import('../../shared/simmer.js');
const { closePosition } = await import('../../execution/positionLedger.js');
const { notifyTakeProfitExecuted } = await import('../../execution/telegram.js');
const { executeTakeProfit } = await import('../takeProfitExecutor.js');

const mockSubmit = submitTrade as jest.MockedFunction<typeof submitTrade>;
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
    consensusProbability: 0.7,
    edgeMagnitude: 0.3,
    sourcedFrom: 'headline',
    openedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRedis() {
  return {} as Parameters<typeof executeTakeProfit>[0]['redis'];
}

describe('executeTakeProfit', () => {
  beforeEach(() => {
    mockSubmit.mockReset();
    mockClose.mockReset();
    mockNotify.mockReset();
    mockClose.mockResolvedValue(undefined);
    mockNotify.mockResolvedValue(undefined);
  });

  it('executes sell with inverted direction for YES position', async () => {
    mockSubmit.mockResolvedValue({ success: true, tx_hash: '0xexit' });

    await executeTakeProfit({
      position: makePosition({ direction: 'YES' }),
      currentPrice: 0.65,
      returnPct: 25,
      reason: 'take_profit_threshold',
      redis: makeRedis(),
    });

    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'NO', market_id: 'mkt-1' }),
    );
  });

  it('executes sell with inverted direction for NO position', async () => {
    mockSubmit.mockResolvedValue({ success: true, tx_hash: '0xexit2' });

    await executeTakeProfit({
      position: makePosition({ direction: 'NO' }),
      currentPrice: 0.35,
      returnPct: 30,
      reason: 'divergence_closed',
      redis: makeRedis(),
    });

    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'YES' }),
    );
  });

  it('closes position in ledger on success', async () => {
    mockSubmit.mockResolvedValue({ success: true, tx_hash: '0xexit' });

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
    mockSubmit.mockResolvedValue({ success: true, tx_hash: '0xexit' });

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
    mockSubmit.mockResolvedValue({ success: false, error: 'slippage' });

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

  it('returns success=false and does not close ledger when submitTrade throws', async () => {
    mockSubmit.mockRejectedValue(new Error('timeout'));

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
});
