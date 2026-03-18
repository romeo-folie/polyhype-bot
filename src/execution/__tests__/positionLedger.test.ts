/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { TradeSignal } from '../../mapping/index.js';

// Mock Redis
const mockSetex = jest.fn<(...args: any[]) => any>();
const mockGet = jest.fn<(...args: any[]) => any>();
const mockDel = jest.fn<(...args: any[]) => any>();
const mockSadd = jest.fn<(...args: any[]) => any>();
const mockSrem = jest.fn<(...args: any[]) => any>();
const mockSmembers = jest.fn<(...args: any[]) => any>();
const mockExpire = jest.fn<(...args: any[]) => any>();

jest.unstable_mockModule('../../shared/redis.js', () => ({
  getRedis: () => ({
    setex: mockSetex,
    get: mockGet,
    del: mockDel,
    sadd: mockSadd,
    srem: mockSrem,
    smembers: mockSmembers,
    expire: mockExpire,
  }),
}));

const { persistPosition, getPosition, getAllPositions, removePosition } =
  await import('../positionLedger.js');

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

describe('persistPosition', () => {
  beforeEach(() => {
    mockSetex.mockReset();
    mockSadd.mockReset();
    mockExpire.mockReset();
    mockSetex.mockResolvedValue('OK');
    mockSadd.mockResolvedValue(1);
    mockExpire.mockResolvedValue(1);
  });

  it('calls setex with 7-day TTL', async () => {
    await persistPosition(makeSignal(), '0xabc');

    expect(mockSetex).toHaveBeenCalledTimes(1);
    const [key, ttl, value] = mockSetex.mock.calls[0] as [string, number, string];
    expect(key).toBe('position:mkt-1');
    expect(ttl).toBe(7 * 24 * 60 * 60);
    const parsed = JSON.parse(value) as { txHash: string; direction: string };
    expect(parsed.txHash).toBe('0xabc');
    expect(parsed.direction).toBe('YES');
  });

  it('adds marketId to the index set', async () => {
    await persistPosition(makeSignal(), '0xabc');
    expect(mockSadd).toHaveBeenCalledWith('position:index', 'mkt-1');
  });
});

describe('getPosition', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('returns parsed position when key exists', async () => {
    const pos = { marketId: 'mkt-1', direction: 'YES', stakeUsd: 10 };
    mockGet.mockResolvedValue(JSON.stringify(pos));

    const result = await getPosition('mkt-1');
    expect(result?.marketId).toBe('mkt-1');
  });

  it('returns null when key does not exist', async () => {
    mockGet.mockResolvedValue(null);
    const result = await getPosition('mkt-missing');
    expect(result).toBeNull();
  });
});

describe('getAllPositions', () => {
  beforeEach(() => {
    mockSmembers.mockReset();
    mockGet.mockReset();
    mockSrem.mockReset();
    mockSrem.mockResolvedValue(1);
  });

  it('returns all active positions', async () => {
    mockSmembers.mockResolvedValue(['mkt-1', 'mkt-2']);
    const pos1 = { marketId: 'mkt-1', direction: 'YES', stakeUsd: 10 };
    const pos2 = { marketId: 'mkt-2', direction: 'NO', stakeUsd: 5 };
    mockGet
      .mockResolvedValueOnce(JSON.stringify(pos1))
      .mockResolvedValueOnce(JSON.stringify(pos2));

    const results = await getAllPositions();
    expect(results).toHaveLength(2);
  });

  it('removes expired positions from the index', async () => {
    mockSmembers.mockResolvedValue(['mkt-expired']);
    mockGet.mockResolvedValue(null); // expired — key not found

    const results = await getAllPositions();
    expect(results).toHaveLength(0);
    expect(mockSrem).toHaveBeenCalledWith('position:index', 'mkt-expired');
  });
});

describe('removePosition', () => {
  beforeEach(() => {
    mockDel.mockReset();
    mockSrem.mockReset();
    mockDel.mockResolvedValue(1);
    mockSrem.mockResolvedValue(1);
  });

  it('deletes the position key and removes from index', async () => {
    await removePosition('mkt-1');
    expect(mockDel).toHaveBeenCalledWith('position:mkt-1');
    expect(mockSrem).toHaveBeenCalledWith('position:index', 'mkt-1');
  });
});
