import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock logger
jest.unstable_mockModule('../../shared/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { recordPosition, getOpenPositions, closePosition, hasOpenPosition } =
  await import('../positionLedger.js');

import type { Position } from '../positionLedger.js';

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
    sourcedFrom: 'Test headline',
    openedAt: new Date('2026-03-18T12:00:00Z').toISOString(),
    txHash: '0xabc',
    ...overrides,
  };
}

function makeRedis() {
  const store: Record<string, Record<string, string>> = {};
  const zsets: Record<string, Array<[number, string]>> = {};

  return {
    hset: jest.fn(async (key: string, fields: Record<string, string>) => {
      store[key] = { ...(store[key] ?? {}), ...fields };
      return 1;
    }),
    expire: jest.fn(async () => 1),
    zadd: jest.fn(async (key: string, score: number, member: string) => {
      if (!zsets[key]) zsets[key] = [];
      zsets[key]!.push([score, member]);
      return 1;
    }),
    zrange: jest.fn(async (key: string) => {
      return (zsets[key] ?? []).map(([, member]) => member);
    }),
    zrem: jest.fn(async (key: string, member: string) => {
      if (zsets[key]) {
        zsets[key] = zsets[key]!.filter(([, m]) => m !== member);
      }
      return 1;
    }),
    hgetall: jest.fn(async (key: string) => store[key] ?? null),
    del: jest.fn(async (key: string) => {
      delete store[key];
      return 1;
    }),
    exists: jest.fn(async (key: string) => (store[key] ? 1 : 0)),
    _store: store,
    _zsets: zsets,
  };
}

describe('recordPosition', () => {
  it('stores position and adds to index', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordPosition(redis as any, makePosition());

    expect(redis.hset).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(redis.zadd).toHaveBeenCalledTimes(1);
  });

  it('serialises clobTokenIds as JSON', async () => {
    const redis = makeRedis();
    const pos = makePosition({ clobTokenIds: ['tok-a', 'tok-b'] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordPosition(redis as any, pos);

    const call = redis.hset.mock.calls[0] as [string, Record<string, string>];
    const fields = call[1];
    expect(fields['clobTokenIds']).toBe('["tok-a","tok-b"]');
  });
});

describe('getOpenPositions', () => {
  it('returns empty array when no positions stored', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const positions = await getOpenPositions(redis as any);
    expect(positions).toEqual([]);
  });

  it('returns stored positions with correct types', async () => {
    const redis = makeRedis();
    const pos = makePosition();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordPosition(redis as any, pos);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const positions = await getOpenPositions(redis as any);

    expect(positions).toHaveLength(1);
    expect(positions[0]!.marketId).toBe('mkt-1');
    expect(positions[0]!.entryPrice).toBeCloseTo(0.4);
    expect(positions[0]!.clobTokenIds).toEqual(['tok-yes', 'tok-no']);
    expect(positions[0]!.txHash).toBe('0xabc');
  });
});

describe('hasOpenPosition', () => {
  it('returns false when no position exists', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await hasOpenPosition(redis as any, 'mkt-1', 'YES');
    expect(result).toBe(false);
  });

  it('returns true after recording a position', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordPosition(redis as any, makePosition());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await hasOpenPosition(redis as any, 'mkt-1', 'YES');
    expect(result).toBe(true);
  });
});

describe('closePosition', () => {
  it('removes position and index entry', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordPosition(redis as any, makePosition());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await closePosition(redis as any, 'mkt-1', 'YES');

    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.zrem).toHaveBeenCalledTimes(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const positions = await getOpenPositions(redis as any);
    expect(positions).toHaveLength(0);
  });
});
