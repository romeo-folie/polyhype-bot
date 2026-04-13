import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import type { ConstraintEdge } from '../types.js';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { saveConstraint, loadAllConstraints, evictExpiredConstraints } = await import(
  '../constraintGraph.js'
);

function makeEdge(overrides: Partial<ConstraintEdge> = {}): ConstraintEdge {
  return {
    id: 'edge-1',
    type: 'implication',
    marketIdA: 'mkt-a',
    marketIdB: 'mkt-b',
    questionA: 'Market A',
    questionB: 'Market B',
    reasoning: 'A implies B',
    discoveredAt: Math.floor(Date.now() / 1000),
    endDateA: null,
    endDateB: null,
    ...overrides,
  };
}

function makePipelineMock() {
  const calls: [string, ...unknown[]][] = [];
  const pipeline = {
    set: (...args: unknown[]) => { calls.push(['set', ...args]); return pipeline; },
    sadd: (...args: unknown[]) => { calls.push(['sadd', ...args]); return pipeline; },
    expire: (...args: unknown[]) => { calls.push(['expire', ...args]); return pipeline; },
    del: (...args: unknown[]) => { calls.push(['del', ...args]); return pipeline; },
    srem: (...args: unknown[]) => { calls.push(['srem', ...args]); return pipeline; },
    exec: vi.fn().mockResolvedValue([]),
  };
  return { pipeline, calls };
}

function makeRedis(overrides: Partial<Redis> = {}): Redis {
  const { pipeline } = makePipelineMock();
  return {
    pipeline: vi.fn(() => pipeline),
    smembers: vi.fn().mockResolvedValue([]),
    mget: vi.fn().mockResolvedValue([]),
    srem: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as unknown as Redis;
}

describe('constraintGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('saveConstraint', () => {
    it('writes edge JSON and updates index sets via pipeline', async () => {
      const { pipeline, calls } = makePipelineMock();
      const redis = { pipeline: vi.fn(() => pipeline) } as unknown as Redis;

      const edge = makeEdge();
      await saveConstraint(redis, edge, 604800);

      expect(redis.pipeline).toHaveBeenCalled();
      expect(pipeline.exec).toHaveBeenCalled();

      // Verify key operations.
      const ops = calls.map(([op]) => op);
      expect(ops).toContain('set');
      expect(ops).toContain('sadd');
      expect(ops).toContain('expire');
    });
  });

  describe('loadAllConstraints', () => {
    it('returns parsed edges from Redis', async () => {
      const edge = makeEdge();
      const redis = makeRedis({
        smembers: vi.fn().mockResolvedValue(['edge-1']),
        mget: vi.fn().mockResolvedValue([JSON.stringify(edge)]),
      } as Partial<Redis>);

      const edges = await loadAllConstraints(redis);
      expect(edges.length).toBe(1);
      expect(edges[0]!.id).toBe('edge-1');
    });

    it('skips null values and cleans orphaned IDs from index', async () => {
      const edge = makeEdge();
      const sremMock = vi.fn().mockResolvedValue(1);
      const redis = makeRedis({
        smembers: vi.fn().mockResolvedValue(['edge-1', 'edge-2']),
        mget: vi.fn().mockResolvedValue([JSON.stringify(edge), null]),
        srem: sremMock,
      } as Partial<Redis>);

      const edges = await loadAllConstraints(redis);
      expect(edges.length).toBe(1);
      expect(sremMock).toHaveBeenCalledWith('correlation:graph:all_edge_ids', 'edge-2');
    });

    it('returns empty array when no edges exist', async () => {
      const redis = makeRedis();
      const edges = await loadAllConstraints(redis);
      expect(edges.length).toBe(0);
    });

    it('skips malformed JSON and cleans orphaned IDs', async () => {
      const sremMock = vi.fn().mockResolvedValue(1);
      const redis = makeRedis({
        smembers: vi.fn().mockResolvedValue(['edge-1']),
        mget: vi.fn().mockResolvedValue(['not valid json']),
        srem: sremMock,
      } as Partial<Redis>);

      const edges = await loadAllConstraints(redis);
      expect(edges.length).toBe(0);
      expect(sremMock).toHaveBeenCalledWith('correlation:graph:all_edge_ids', 'edge-1');
    });
  });

  describe('evictExpiredConstraints', () => {
    it('removes edges where endDateA is in the past', async () => {
      const pastDate = new Date(Date.now() - 86400_000).toISOString();
      const edge = makeEdge({ endDateA: pastDate, endDateB: null });

      const { pipeline } = makePipelineMock();
      const redis = makeRedis({
        smembers: vi.fn().mockResolvedValue(['edge-1']),
        mget: vi.fn().mockResolvedValue([JSON.stringify(edge)]),
        pipeline: vi.fn(() => pipeline),
      } as unknown as Partial<Redis>);

      const count = await evictExpiredConstraints(redis);
      expect(count).toBe(1);
      expect(pipeline.exec).toHaveBeenCalled();
    });

    it('does not evict edges where both endDates are in the future', async () => {
      const futureDate = new Date(Date.now() + 86400_000).toISOString();
      const edge = makeEdge({ endDateA: futureDate, endDateB: futureDate });

      const { pipeline } = makePipelineMock();
      const redis = makeRedis({
        smembers: vi.fn().mockResolvedValue(['edge-1']),
        mget: vi.fn().mockResolvedValue([JSON.stringify(edge)]),
        pipeline: vi.fn(() => pipeline),
      } as unknown as Partial<Redis>);

      const count = await evictExpiredConstraints(redis);
      expect(count).toBe(0);
    });

    it('does not evict edges where endDates are null (no expiry)', async () => {
      const edge = makeEdge({ endDateA: null, endDateB: null });

      const { pipeline } = makePipelineMock();
      const redis = makeRedis({
        smembers: vi.fn().mockResolvedValue(['edge-1']),
        mget: vi.fn().mockResolvedValue([JSON.stringify(edge)]),
        pipeline: vi.fn(() => pipeline),
      } as unknown as Partial<Redis>);

      const count = await evictExpiredConstraints(redis);
      expect(count).toBe(0);
    });
  });
});
