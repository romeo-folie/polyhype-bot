import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock logger
vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
    executionVenue: 'simmer',
    ...overrides,
  };
}

function makeRedis() {
  const store: Record<string, Record<string, string>> = {};
  const zsets: Record<string, Array<[number, string]>> = {};

  return {
    hset: vi.fn(async (key: string, fields: Record<string, string>) => {
      store[key] = { ...(store[key] ?? {}), ...fields };
      return 1;
    }),
    expire: vi.fn(async () => 1),
    zadd: vi.fn(async (key: string, score: number, member: string) => {
      if (!zsets[key]) zsets[key] = [];
      zsets[key]!.push([score, member]);
      return 1;
    }),
    zrange: vi.fn(async (key: string) => {
      return (zsets[key] ?? []).map(([, member]) => member);
    }),
    zrem: vi.fn(async (key: string, member: string) => {
      if (zsets[key]) {
        zsets[key] = zsets[key]!.filter(([, m]) => m !== member);
      }
      return 1;
    }),
    hgetall: vi.fn(async (key: string) => store[key] ?? null),
    del: vi.fn(async (key: string) => {
      delete store[key];
      return 1;
    }),
    exists: vi.fn(async (key: string) => (store[key] ? 1 : 0)),
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
    expect(redis.expire).toHaveBeenCalledTimes(0);
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

describe('executionVenue', () => {
  it('persists and deserialises executionVenue round-trip (simmer)', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordPosition(redis as any, makePosition({ executionVenue: 'simmer' }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const positions = await getOpenPositions(redis as any);
    expect(positions[0]!.executionVenue).toBe('simmer');
  });

  it('persists and deserialises executionVenue round-trip (clob)', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordPosition(redis as any, makePosition({ executionVenue: 'clob' }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const positions = await getOpenPositions(redis as any);
    expect(positions[0]!.executionVenue).toBe('clob');
  });

  it('defaults to simmer for legacy positions without executionVenue', async () => {
    const redis = makeRedis();
    // Simulate a legacy position that was stored without executionVenue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordPosition(redis as any, makePosition({ executionVenue: 'simmer' }));

    // Manually remove the executionVenue field from the stored hash
    const key = Object.keys(redis._store)[0]!;
    delete redis._store[key]!['executionVenue'];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const positions = await getOpenPositions(redis as any);
    expect(positions[0]!.executionVenue).toBe('simmer');
  });

  it('persists execution path metadata and decision benchmarks', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordPosition(redis as any, makePosition({
      executionVenue: 'clob',
      modeConfigured: 'hybrid',
      entryExecutionPath: 'clob_fallback',
      entryOrderType: 'taker',
      decisionBestBid: 0.49,
      decisionBestAsk: 0.51,
      decisionMidPrice: 0.5,
      decisionSpreadBps: 400,
      counterfactualImmediateTakerPrice: 0.51,
      counterfactualImmediateTakerShares: 9.8039215686,
      counterfactualImmediateTakerCostUsd: 5,
      makerPriceImprovementBps: 392.1568627451,
      makerPriceImprovementUsd: 0.2,
      fallbackReason: 'simmer_market_missing',
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const positions = await getOpenPositions(redis as any);

    expect(positions[0]!.modeConfigured).toBe('hybrid');
    expect(positions[0]!.entryExecutionPath).toBe('clob_fallback');
    expect(positions[0]!.entryOrderType).toBe('taker');
    expect(positions[0]!.decisionBestBid).toBe(0.49);
    expect(positions[0]!.decisionBestAsk).toBe(0.51);
    expect(positions[0]!.decisionMidPrice).toBe(0.5);
    expect(positions[0]!.decisionSpreadBps).toBe(400);
    expect(positions[0]!.counterfactualImmediateTakerPrice).toBe(0.51);
    expect(positions[0]!.counterfactualImmediateTakerShares).toBeCloseTo(9.8039215686, 6);
    expect(positions[0]!.counterfactualImmediateTakerCostUsd).toBe(5);
    expect(positions[0]!.makerPriceImprovementBps).toBeCloseTo(392.1568627451, 6);
    expect(positions[0]!.makerPriceImprovementUsd).toBe(0.2);
    expect(positions[0]!.fallbackReason).toBe('simmer_market_missing');
  });
});
