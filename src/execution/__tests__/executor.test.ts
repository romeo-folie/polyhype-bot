import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { TradeSignal } from '../../mapping/index.js';

jest.unstable_mockModule('../../shared/simmer.js', () => ({
  submitTrade: jest.fn(),
  resolveSimmerMarketId: jest.fn(),
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
  submitClobBuy: jest.fn(),
}));

jest.unstable_mockModule('../positionLedger.js', () => ({
  hasOpenPosition: jest.fn(),
}));

jest.unstable_mockModule('../../shared/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { submitTrade, resolveSimmerMarketId } = await import('../../shared/simmer.js');
const { submitClobBuy } = await import('../../shared/clob.js');
const { hasOpenPosition } = await import('../positionLedger.js');
const { executeSignal, executeSignals } = await import('../executor.js');

const mockSubmit = submitTrade as jest.MockedFunction<typeof submitTrade>;
const mockResolve = resolveSimmerMarketId as jest.MockedFunction<typeof resolveSimmerMarketId>;
const mockSubmitClob = submitClobBuy as jest.MockedFunction<typeof submitClobBuy>;
const mockHasPosition = hasOpenPosition as jest.MockedFunction<typeof hasOpenPosition>;

function makeSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    marketId: 'mkt-test',
    conditionId: 'cond-test',
    clobTokenIds: ['tok-yes', 'tok-no'],
    question: 'Will X happen?',
    direction: 'YES',
    stakeUsd: 5.0,
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
    mockResolve.mockReset();
    mockSubmitClob.mockReset();
    mockHasPosition.mockReset();

    // Default: available in Simmer, Simmer succeeds, no open position
    mockResolve.mockResolvedValue('simmer-uuid-123');
    mockSubmit.mockResolvedValue({ success: true, tx_hash: '0xabc' });
    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xclob' });
    mockHasPosition.mockResolvedValue(false);
  });

  it('skips when already holding position in same market+direction', async () => {
    mockHasPosition.mockResolvedValue(true);
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('position_already_open');
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('skips when stake is below floor', async () => {
    const redis = makeRedis();
    const signal = makeSignal({ stakeUsd: 0.001 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(signal, redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('stake_below_floor');
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('skips when idempotency key already exists', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue('1');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('already_executed');
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('executes via Simmer when market is available there', async () => {
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.executionVenue).toBe('simmer');
    expect(result.tradeResult?.success).toBe(true);
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ market_id: 'simmer-uuid-123', side: 'yes', amount: 5.0 }),
    );
    expect(mockSubmitClob).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it('falls back to CLOB when market is not in Simmer catalogue', async () => {
    const redis = makeRedis();
    mockResolve.mockResolvedValue(null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.skipped).toBe(false);
    expect(result.executionVenue).toBe('clob');
    expect(result.tradeResult?.success).toBe(true);
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockSubmitClob).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-yes', amountUsd: 5.0 }),
    );
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it('falls back to CLOB when Simmer says market not found', async () => {
    const redis = makeRedis();
    mockSubmit.mockResolvedValue({ success: false, error: 'Market not found' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.executionVenue).toBe('clob');
    expect(result.tradeResult?.success).toBe(true);
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockSubmitClob).toHaveBeenCalledTimes(1);
  });

  it('returns an error when CLOB fallback fails', async () => {
    const redis = makeRedis();
    mockResolve.mockResolvedValue(null);
    mockSubmitClob.mockResolvedValue({ success: false, error: 'insufficient balance' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.executionVenue).toBe('clob');
    expect(result.error).toContain('insufficient balance');
    expect(result.tradeResult?.success).toBe(false);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('does not fallback to CLOB on non-market Simmer errors', async () => {
    const redis = makeRedis();
    mockSubmit.mockRejectedValue(new Error('network timeout'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeSignal(makeSignal(), redis as any);

    expect(result.executionVenue).toBe('simmer');
    expect(result.error).toContain('network timeout');
    expect(mockSubmitClob).not.toHaveBeenCalled();
  });

  it('uses NO token id when direction is NO during CLOB fallback', async () => {
    const redis = makeRedis();
    mockResolve.mockResolvedValue(null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeSignal(makeSignal({ direction: 'NO' }), redis as any);

    expect(mockSubmitClob).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-no' }),
    );
  });
});

describe('executeSignals', () => {
  beforeEach(() => {
    mockSubmit.mockReset();
    mockResolve.mockReset();
    mockSubmitClob.mockReset();
    mockHasPosition.mockReset();

    mockResolve.mockResolvedValue('simmer-uuid-123');
    mockSubmit.mockResolvedValue({ success: true, tx_hash: '0xabc' });
    mockSubmitClob.mockResolvedValue({ success: true, tx_hash: '0xclob' });
    mockHasPosition.mockResolvedValue(false);
  });

  it('processes all signals and returns results', async () => {
    const redis = makeRedis();

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
