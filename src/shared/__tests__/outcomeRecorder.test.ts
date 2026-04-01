import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({
    OUTCOME_HISTORY_DAYS: 180,
    OUTCOME_MAX_PER_CATEGORY: 3,
    CONTEXT_INJECTION_LIMIT: 5,
    CONTEXT_INJECTION_ENABLED: true,
  })),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { recordOutcome, getRecentOutcomes, inferCategory } = await import('../outcomeRecorder.js');
const { logger } = await import('../logger.js');

function makeOutcome(overrides: Record<string, unknown> = {}) {
  return {
    source: 'osint' as const,
    category: 'geopolitical',
    question: 'Will X happen?',
    direction: 'YES' as const,
    consensusProbability: 0.7,
    divergence: 0.15,
    result: 'won' as const,
    returnPct: 12.5,
    holdingHours: 48,
    executionVenue: 'simmer',
    ...overrides,
  };
}

function makeRedis() {
  const store = new Map<string, Record<string, string>>();
  const sortedSets = new Map<string, { score: number; member: string }[]>();

  return {
    hset: vi.fn<any>(async (key: string, fields: Record<string, string>) => {
      store.set(key, { ...fields });
      return Object.keys(fields).length;
    }),
    hgetall: vi.fn<any>(async (key: string) => {
      return store.get(key) ?? {};
    }),
    expire: vi.fn<any>(async () => 1),
    zadd: vi.fn<any>(async (key: string, score: number, member: string) => {
      if (!sortedSets.has(key)) sortedSets.set(key, []);
      sortedSets.get(key)!.push({ score, member });
      return 1;
    }),
    zcard: vi.fn<any>(async (key: string) => {
      return sortedSets.get(key)?.length ?? 0;
    }),
    zpopmin: vi.fn<any>(async (key: string, count: number) => {
      const set = sortedSets.get(key);
      if (!set) return [];
      set.sort((a, b) => a.score - b.score);
      const removed = set.splice(0, count);
      return removed.flatMap((r) => [r.member, String(r.score)]);
    }),
    zrevrange: vi.fn<any>(async (key: string, start: number, stop: number) => {
      const set = sortedSets.get(key);
      if (!set) return [];
      set.sort((a, b) => b.score - a.score);
      return set.slice(start, stop + 1).map((r) => r.member);
    }),
    _store: store,
    _sortedSets: sortedSets,
  };
}

describe('recordOutcome', () => {
  it('writes hash and sorted sets', async () => {
    const redis = makeRedis();
    await recordOutcome(redis as any, makeOutcome());

    expect(redis.hset).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledTimes(1);
    // outcomes:all, outcomes:geopolitical, outcomes:source:osint
    expect(redis.zadd).toHaveBeenCalledTimes(3);
  });

  it('prunes when ZCARD exceeds max per category', async () => {
    const redis = makeRedis();
    // Pre-populate 3 items (max is 3)
    redis._sortedSets.set('outcomes:geopolitical', [
      { score: 1, member: 'old-1' },
      { score: 2, member: 'old-2' },
      { score: 3, member: 'old-3' },
    ]);
    redis.zcard.mockResolvedValue(4); // after adding new one

    await recordOutcome(redis as any, makeOutcome());

    expect(redis.zpopmin).toHaveBeenCalledWith('outcomes:geopolitical', 1);
  });

  it('never throws on Redis error', async () => {
    const redis = makeRedis();
    redis.hset.mockRejectedValue(new Error('Redis down'));

    // Should not throw
    await recordOutcome(redis as any, makeOutcome());

    expect((logger.warn as any)).toHaveBeenCalledWith(
      expect.stringContaining('failed to record outcome'),
      expect.any(Object),
    );
  });
});

describe('getRecentOutcomes', () => {
  it('returns outcomes in reverse-chronological order', async () => {
    const redis = makeRedis();

    // Manually set up sorted set with explicit timestamps to ensure ordering
    const ids = ['id-old', 'id-mid', 'id-new'];
    redis._sortedSets.set('outcomes:geopolitical', [
      { score: 1000, member: 'id-old' },
      { score: 2000, member: 'id-mid' },
      { score: 3000, member: 'id-new' },
    ]);
    redis._store.set('outcome:id-old', {
      id: 'id-old', closedAt: '2026-01-01T00:00:00Z', source: 'osint',
      category: 'geopolitical', question: 'Q1', direction: 'YES',
      consensusProbability: '0.7', divergence: '0.1', result: 'won',
      returnPct: '10', holdingHours: '5', executionVenue: 'simmer',
    });
    redis._store.set('outcome:id-mid', {
      id: 'id-mid', closedAt: '2026-01-02T00:00:00Z', source: 'osint',
      category: 'geopolitical', question: 'Q2', direction: 'YES',
      consensusProbability: '0.7', divergence: '0.1', result: 'won',
      returnPct: '20', holdingHours: '5', executionVenue: 'simmer',
    });
    redis._store.set('outcome:id-new', {
      id: 'id-new', closedAt: '2026-01-03T00:00:00Z', source: 'osint',
      category: 'geopolitical', question: 'Q3', direction: 'YES',
      consensusProbability: '0.7', divergence: '0.1', result: 'won',
      returnPct: '30', holdingHours: '5', executionVenue: 'simmer',
    });

    const outcomes = await getRecentOutcomes(redis as any, 'geopolitical', 5);

    // Most recent first (reverse chronological)
    expect(outcomes.length).toBe(3);
    expect(outcomes[0].question).toBe('Q3');
    expect(outcomes[1].question).toBe('Q2');
    expect(outcomes[2].question).toBe('Q1');
  });

  it('returns empty array when Redis is unavailable', async () => {
    const redis = makeRedis();
    redis.zrevrange.mockRejectedValue(new Error('connection refused'));

    const outcomes = await getRecentOutcomes(redis as any, 'geopolitical');

    expect(outcomes).toEqual([]);
  });

  it('skips malformed records', async () => {
    const redis = makeRedis();
    redis.zrevrange.mockResolvedValue(['good-id', 'bad-id']);
    redis.hgetall
      .mockResolvedValueOnce({
        id: 'good-id',
        closedAt: '2026-01-01T00:00:00Z',
        source: 'osint',
        category: 'geopolitical',
        question: 'Good question',
        direction: 'YES',
        consensusProbability: '0.7',
        divergence: '0.1',
        result: 'won',
        returnPct: '10',
        holdingHours: '5',
        executionVenue: 'simmer',
      })
      .mockResolvedValueOnce({}); // malformed — no id

    const outcomes = await getRecentOutcomes(redis as any, 'geopolitical');

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].id).toBe('good-id');
  });
});

describe('inferCategory', () => {
  it('detects crypto keywords', () => {
    expect(inferCategory('Bitcoin ETF approved by SEC')).toBe('crypto-regulatory');
    expect(inferCategory('ETH price surges')).toBe('crypto-regulatory');
    expect(inferCategory('Solana network upgrade')).toBe('crypto-regulatory');
  });

  it('detects macro keywords', () => {
    expect(inferCategory('Fed raises rate to 5.5%')).toBe('macro');
    expect(inferCategory('GDP growth exceeds expectations')).toBe('macro');
    expect(inferCategory('Inflation data released')).toBe('macro');
  });

  it('detects US politics keywords', () => {
    expect(inferCategory('Trump announces candidacy')).toBe('us-politics');
    expect(inferCategory('Senate passes new bill')).toBe('us-politics');
    expect(inferCategory('Election results are in')).toBe('us-politics');
  });

  it('detects AI/tech keywords', () => {
    expect(inferCategory('OpenAI releases GPT-5')).toBe('ai-tech');
    expect(inferCategory('NVIDIA announces new GPU')).toBe('ai-tech');
  });

  it('defaults to geopolitical', () => {
    expect(inferCategory('Unknown topic signal')).toBe('geopolitical');
    expect(inferCategory('War breaks out in region')).toBe('geopolitical');
  });
});
