import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { computeCalibration, getCalibrationStats, applyCalibrationCorrection } =
  await import('../calibration.js');

type OutcomeData = Record<string, string>;

function makeRedis(outcomes: OutcomeData[] = []) {
  const ids = outcomes.map((_, i) => `id-${i.toString()}`);
  const hashStore = new Map<string, Record<string, string>>();
  for (let i = 0; i < outcomes.length; i++) {
    hashStore.set(`outcome:id-${i.toString()}`, { ...outcomes[i], id: `id-${i.toString()}` });
  }

  let cachedCalibration: string | null = null;

  // Pipeline mock — collects hgetall commands and executes them against hashStore.
  const pipelineCommands: string[] = [];
  const pipelineMock = {
    hgetall: vi.fn<any>((key: string) => {
      pipelineCommands.push(key);
      return pipelineMock; // chainable
    }),
    exec: vi.fn<any>(async () => pipelineCommands.map((key) => [null, hashStore.get(key) ?? {}])),
  };

  return {
    zrange: vi.fn<any>(async () => ids),
    hgetall: vi.fn<any>(async (key: string) => hashStore.get(key) ?? {}),
    pipeline: vi.fn<any>(() => {
      pipelineCommands.length = 0; // reset for each pipeline() call
      return pipelineMock;
    }),
    set: vi.fn<any>(async (_k: string, v: string) => {
      cachedCalibration = v;
      return 'OK';
    }),
    get: vi.fn<any>(async (key: string) => {
      if (key.startsWith('calibration:')) return cachedCalibration;
      return null;
    }),
    _cachedCalibration: () => cachedCalibration,
  };
}

function makeOutcomeData(overrides: Partial<OutcomeData> = {}): OutcomeData {
  return {
    result: 'won',
    returnPct: '10',
    consensusProbability: '0.7',
    ...overrides,
  };
}

describe('computeCalibration', () => {
  it('computes correct win rate and avg return', async () => {
    const outcomes = [
      makeOutcomeData({ result: 'won', returnPct: '20', consensusProbability: '0.7' }),
      makeOutcomeData({ result: 'won', returnPct: '10', consensusProbability: '0.7' }),
      makeOutcomeData({ result: 'lost', returnPct: '-15', consensusProbability: '0.7' }),
      makeOutcomeData({ result: 'won', returnPct: '5', consensusProbability: '0.7' }),
    ];
    const redis = makeRedis(outcomes);

    const stats = await computeCalibration(redis as any, 'geopolitical');

    expect(stats).not.toBeNull();
    expect(stats!.sampleSize).toBe(4);
    expect(stats!.winRate).toBeCloseTo(0.75); // 3/4
    expect(stats!.avgReturn).toBeCloseTo(5); // (20+10-15+5)/4
  });

  it('assigns outcomes to correct buckets', async () => {
    const outcomes = [
      makeOutcomeData({ consensusProbability: '0.55', result: 'won' }), // 0.50-0.60
      makeOutcomeData({ consensusProbability: '0.65', result: 'lost' }), // 0.60-0.70
      makeOutcomeData({ consensusProbability: '0.75', result: 'won' }), // 0.70-0.80
      makeOutcomeData({ consensusProbability: '0.85', result: 'won' }), // 0.80-0.90
      makeOutcomeData({ consensusProbability: '0.95', result: 'lost' }), // 0.90-1.00
    ];
    const redis = makeRedis(outcomes);

    const stats = await computeCalibration(redis as any, 'geopolitical');

    const bucket50 = stats!.buckets.find((b) => b.range === '0.50-0.60');
    const bucket60 = stats!.buckets.find((b) => b.range === '0.60-0.70');
    const bucket70 = stats!.buckets.find((b) => b.range === '0.70-0.80');
    expect(bucket50!.count).toBe(1);
    expect(bucket50!.actualWinRate).toBe(1); // 1 win / 1 total
    expect(bucket60!.count).toBe(1);
    expect(bucket60!.actualWinRate).toBe(0); // 0 win / 1 total
    expect(bucket70!.count).toBe(1);
    expect(bucket70!.actualWinRate).toBe(1);
  });

  it('clamps edgeCorrectionFactor at floor 0.5', async () => {
    // All losses with high stated probability → very low correction
    const outcomes = Array.from({ length: 25 }, () =>
      makeOutcomeData({ result: 'lost', consensusProbability: '0.9', returnPct: '-50' }),
    );
    const redis = makeRedis(outcomes);

    const stats = await computeCalibration(redis as any, 'geopolitical');

    expect(stats!.edgeCorrectionFactor).toBe(0.5);
  });

  it('clamps edgeCorrectionFactor at ceiling 1.5', async () => {
    // All wins with low stated probability → very high correction
    const outcomes = Array.from({ length: 25 }, () =>
      makeOutcomeData({ result: 'won', consensusProbability: '0.5', returnPct: '50' }),
    );
    const redis = makeRedis(outcomes);

    const stats = await computeCalibration(redis as any, 'geopolitical');

    // 1.0 / 0.5 = 2.0, clamped to 1.5
    expect(stats!.edgeCorrectionFactor).toBe(1.5);
  });

  it('applies correction in both directions', async () => {
    // Overconfident model: 0.8 stated, 0.6 actual → factor < 1
    const overconfident = Array.from({ length: 30 }, (_, i) =>
      makeOutcomeData({
        result: i < 18 ? 'won' : 'lost', // 60% win rate
        consensusProbability: '0.8',
        returnPct: i < 18 ? '10' : '-20',
      }),
    );
    const redis1 = makeRedis(overconfident);
    const stats1 = await computeCalibration(redis1 as any, 'macro');
    expect(stats1!.edgeCorrectionFactor).toBeLessThan(1.0);

    // Underconfident model: 0.55 stated, 0.8 actual → factor > 1
    const underconfident = Array.from({ length: 30 }, (_, i) =>
      makeOutcomeData({
        result: i < 24 ? 'won' : 'lost', // 80% win rate
        consensusProbability: '0.55',
        returnPct: i < 24 ? '10' : '-20',
      }),
    );
    const redis2 = makeRedis(underconfident);
    const stats2 = await computeCalibration(redis2 as any, 'macro');
    expect(stats2!.edgeCorrectionFactor).toBeGreaterThan(1.0);
  });

  it('returns null when sampleSize < minSamples', async () => {
    const outcomes = [makeOutcomeData(), makeOutcomeData()];
    const redis = makeRedis(outcomes);

    const stats = await computeCalibration(redis as any, 'geopolitical', 20);

    expect(stats).toBeNull();
  });

  it('returns null for empty category', async () => {
    const redis = makeRedis([]);
    redis.zrange.mockResolvedValue([]);

    const stats = await computeCalibration(redis as any, 'nonexistent');

    expect(stats).toBeNull();
  });
});

describe('getCalibrationStats', () => {
  it('reads cached stats from Redis', async () => {
    const redis = makeRedis([makeOutcomeData()]);
    // Compute first to populate cache
    await computeCalibration(redis as any, 'geopolitical');

    const stats = await getCalibrationStats(redis as any, 'geopolitical');

    expect(stats).not.toBeNull();
    expect(stats!.category).toBe('geopolitical');
  });

  it('returns null when no cached stats exist', async () => {
    const redis = makeRedis([]);
    redis.get.mockResolvedValue(null);

    const stats = await getCalibrationStats(redis as any, 'nonexistent');

    expect(stats).toBeNull();
  });
});

describe('applyCalibrationCorrection', () => {
  it('returns edge unchanged when stats is null', () => {
    expect(applyCalibrationCorrection(0.15, null, 20)).toBe(0.15);
  });

  it('returns edge unchanged when sampleSize < threshold', () => {
    const stats = {
      category: 'geo',
      updatedAt: '',
      sampleSize: 10,
      winRate: 0.5,
      avgReturn: 0,
      edgeCorrectionFactor: 0.8,
      buckets: [],
    };
    expect(applyCalibrationCorrection(0.15, stats, 20)).toBe(0.15);
  });

  it('applies correction factor when stats are valid', () => {
    const stats = {
      category: 'geo',
      updatedAt: '',
      sampleSize: 30,
      winRate: 0.5,
      avgReturn: 0,
      edgeCorrectionFactor: 0.8,
      buckets: [],
    };
    expect(applyCalibrationCorrection(0.15, stats, 20)).toBeCloseTo(0.12);
  });

  it('applies upward correction (factor > 1)', () => {
    const stats = {
      category: 'geo',
      updatedAt: '',
      sampleSize: 30,
      winRate: 0.8,
      avgReturn: 10,
      edgeCorrectionFactor: 1.3,
      buckets: [],
    };
    expect(applyCalibrationCorrection(0.1, stats, 20)).toBeCloseTo(0.13);
  });
});
