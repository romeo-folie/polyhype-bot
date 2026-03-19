import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { TradeSignal } from '../../mapping/index.js';

// Mock the simmer module
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

// Mock logger
jest.unstable_mockModule('../../shared/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { submitTrade } = await import('../../shared/simmer.js');
const { executeSignal, executeSignals } = await import('../executor.js');

const mockSubmit = submitTrade as jest.MockedFunction<typeof submitTrade>;

function makeSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    marketId: 'mkt-test',
    conditionId: 'cond-test',
    clobTokenIds: ['tok-yes', 'tok-no'],
    question: 'Will X happen?',
    direction: 'YES',
    stakeUsd: 5.00,
    edgeMagnitude: 0.2,
    consensusProbability: 0.7,
    outcomePrice: 0.5,
    halfKellyFraction: 0.1,
    sourcedFrom: 'Breaking news headline',
    reasoning: 'Strong signal',
    ...overrides,
  };
}

function makeRedis() {
  return {
    get: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
    set: jest.fn<() => Promise<'OK'>>().mockResolvedValue('OK'),
  };
}

describe('executeSignal', () => {
  beforeEach(() => {
    mockSubmit.mockReset();
  });

  it('skips when stake is below floor', async () => {
    const redis = makeRedis();
    const signal = makeSignal({ stakeUsd: 0.001 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(signal, redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('stake_below_floor');
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('skips when idempotency key already exists', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue('1'); // already executed

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('already_executed');
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('submits trade and sets idempotency key on success', async () => {
    const redis = makeRedis();
    mockSubmit.mockResolvedValue({ success: true, tx_hash: '0xabc' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.tradeResult?.success).toBe(true);
    expect(result.tradeResult?.tx_hash).toBe('0xabc');
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        market_id: 'mkt-test',
        side: 'yes',
        amount: 5.00,
      }),
    );
  });

  it('does NOT set idempotency key when trade returns success=false', async () => {
    const redis = makeRedis();
    mockSubmit.mockResolvedValue({ success: false, error: 'insufficient funds' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.tradeResult?.success).toBe(false);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('captures error when submitTrade throws', async () => {
    const redis = makeRedis();
    mockSubmit.mockRejectedValue(new Error('network timeout'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.error).toContain('network timeout');
    expect(result.tradeResult).toBeUndefined();
  });

  it('passes correct direction for NO trades', async () => {
    const redis = makeRedis();
    mockSubmit.mockResolvedValue({ success: true, tx_hash: '0xdef' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeSignal(makeSignal({ direction: 'NO' }), redis as any);

    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'no' }),
    );
  });
});

describe('executeSignals', () => {
  beforeEach(() => {
    mockSubmit.mockReset();
  });

  it('processes all signals and returns results', async () => {
    const redis = makeRedis();
    mockSubmit.mockResolvedValue({ success: true, tx_hash: '0xabc' });

    const signals = [makeSignal({ marketId: 'a' }), makeSignal({ marketId: 'b' })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await executeSignals(signals, redis as any);

    expect(results).toHaveLength(2);
    expect(mockSubmit).toHaveBeenCalledTimes(2);
  });

  it('returns empty array for empty input', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await executeSignals([], redis as any);
    expect(results).toHaveLength(0);
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});
