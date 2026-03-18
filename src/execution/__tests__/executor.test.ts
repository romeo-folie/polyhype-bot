import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { TradeSignal } from '../../mapping/index.js';

// Mock the Simmer module
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSubmitTrade = jest.fn<(...args: any[]) => any>();
jest.unstable_mockModule('../../shared/simmer.js', () => ({
  submitTrade: mockSubmitTrade,
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

const { executeSignal, executeSignals } = await import('../executor.js');
const { SimmerError } = await import('../../shared/simmer.js');

function makeSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    marketId: 'mkt-1',
    conditionId: 'cond-1',
    clobTokenIds: ['tok-yes', 'tok-no'],
    question: 'Will X happen?',
    direction: 'YES',
    stakeUsd: 10,
    edgeMagnitude: 0.2,
    consensusProbability: 0.7,
    outcomePrice: 0.5,
    halfKellyFraction: 0.1,
    sourcedFrom: 'Test headline',
    reasoning: 'Test reason',
    ...overrides,
  };
}

describe('executeSignal', () => {
  beforeEach(() => {
    mockSubmitTrade.mockReset();
  });

  it('returns success with txHash on successful trade', async () => {
    mockSubmitTrade.mockResolvedValue({ success: true, tx_hash: '0xabc123' });

    const result = await executeSignal(makeSignal());

    expect(result.success).toBe(true);
    expect(result.txHash).toBe('0xabc123');
    expect(result.signal.marketId).toBe('mkt-1');
    expect(mockSubmitTrade).toHaveBeenCalledTimes(1);
  });

  it('returns failure when Simmer returns success=false', async () => {
    mockSubmitTrade.mockResolvedValue({ success: false, error: 'Insufficient balance' });

    const result = await executeSignal(makeSignal());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Insufficient balance');
    expect(mockSubmitTrade).toHaveBeenCalledTimes(1);
  });

  it('retries once on timeout then returns failure', async () => {
    const timeoutErr = new Error('timeout');
    timeoutErr.name = 'TimeoutError';
    mockSubmitTrade
      .mockRejectedValueOnce(timeoutErr)
      .mockRejectedValueOnce(timeoutErr);

    const result = await executeSignal(makeSignal());

    expect(result.success).toBe(false);
    expect(mockSubmitTrade).toHaveBeenCalledTimes(2);
  });

  it('retries once on timeout and succeeds on second attempt', async () => {
    const timeoutErr = new Error('timeout');
    timeoutErr.name = 'TimeoutError';
    mockSubmitTrade
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce({ success: true, tx_hash: '0xretry' });

    const result = await executeSignal(makeSignal());

    expect(result.success).toBe(true);
    expect(result.txHash).toBe('0xretry');
    expect(mockSubmitTrade).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 401 auth error', async () => {
    const authErr = new (SimmerError as new (m: string, s: number, b: unknown) => Error)(
      'Unauthorized', 401, { error: 'invalid key' }
    );
    mockSubmitTrade.mockRejectedValue(authErr);

    const result = await executeSignal(makeSignal());

    expect(result.success).toBe(false);
    expect(mockSubmitTrade).toHaveBeenCalledTimes(1);
  });
});

describe('executeSignals', () => {
  beforeEach(() => {
    mockSubmitTrade.mockReset();
  });

  it('returns results for all signals', async () => {
    mockSubmitTrade
      .mockResolvedValueOnce({ success: true, tx_hash: '0x1' })
      .mockResolvedValueOnce({ success: false, error: 'rejected' });

    const signals = [makeSignal({ marketId: 'mkt-1' }), makeSignal({ marketId: 'mkt-2' })];
    const results = await executeSignals(signals);

    expect(results).toHaveLength(2);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
  });
});
