import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockConfig = {
  SPOT_MOVE_THRESHOLD: 3,
  SPOT_LOOKBACK_MINUTES: 5,
  SPOT_COOLDOWN_MINUTES: 30,
  SESSION_THRESHOLD_ENABLED: false,
  SESSION_MULTIPLIERS: '1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.3,1.3,1.3,1.3,1.3,1.5,1.5,1.5,1.5,1.2,1.2,1.2,1.2,0.8,0.8,0.8',
  SPOT_TRIGGER_MODE: 'pct' as 'pct' | 'zscore' | 'both',
  SPOT_ZSCORE_THRESHOLD: 2.5,
  SPOT_ZSCORE_LOOKBACK_MIN: 60,
};

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue(mockConfig),
}));

const mockRedis = {
  get: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
  set: vi.fn<() => Promise<'OK'>>().mockResolvedValue('OK'),
  zrangebyscore: vi.fn<(key: string) => Promise<string[]>>().mockResolvedValue([]),
  zrange: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
};

vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn().mockReturnValue(mockRedis),
}));

const enqueueWriteMock = vi.fn();
vi.mock('../../db/writeQueue.js', () => ({
  enqueueWrite: enqueueWriteMock,
}));

const { detectMoves } = await import('../thresholdDetector.js');

beforeEach(() => {
  mockRedis.get.mockReset().mockResolvedValue(null);
  mockRedis.set.mockReset().mockResolvedValue('OK');
  mockRedis.zrangebyscore.mockReset().mockResolvedValue([]);
  mockRedis.zrange.mockReset().mockResolvedValue([]);
  enqueueWriteMock.mockReset();
});

describe('detectMoves', () => {
  it('detects a move exceeding the threshold', async () => {
    const now = Date.now();
    const refTs = now - 310_000; // ~5 min ago
    mockRedis.zrangebyscore.mockResolvedValue([`${refTs}:65000`]);

    const moves = await detectMoves([{ assetId: 'bitcoin', price: 67000, timestamp: now }]);

    expect(moves).toHaveLength(1);
    expect(moves[0]!.assetId).toBe('bitcoin');
    expect(moves[0]!.changePercent).toBeCloseTo(3.077, 1);
    expect(moves[0]!.currentPrice).toBe(67000);
    expect(moves[0]!.referencePrice).toBe(65000);
    expect(moves[0]!.windowMinutes).toBe(5);
  });

  it('ignores moves below the threshold', async () => {
    const now = Date.now();
    const refTs = now - 310_000;
    // 1% move — below 3% threshold
    mockRedis.zrangebyscore.mockResolvedValue([`${refTs}:66000`]);

    const moves = await detectMoves([{ assetId: 'bitcoin', price: 66660, timestamp: now }]);

    expect(moves).toHaveLength(0);
  });

  it('skips assets with no reference price', async () => {
    mockRedis.zrangebyscore.mockResolvedValue([]);
    mockRedis.zrange.mockResolvedValue([]);

    const moves = await detectMoves([{ assetId: 'bitcoin', price: 67000, timestamp: Date.now() }]);

    expect(moves).toHaveLength(0);
  });

  it('respects cooldown — suppresses re-trigger in same direction', async () => {
    const now = Date.now();
    const refTs = now - 310_000;
    mockRedis.zrangebyscore.mockResolvedValue([`${refTs}:65000`]);

    // First call: triggers
    const moves1 = await detectMoves([{ assetId: 'bitcoin', price: 67000, timestamp: now }]);
    expect(moves1).toHaveLength(1);

    // Simulate cooldown active
    mockRedis.get.mockResolvedValue('1');

    const moves2 = await detectMoves([
      { assetId: 'bitcoin', price: 67500, timestamp: now + 60_000 },
    ]);
    expect(moves2).toHaveLength(0);
  });

  it('sets cooldown after detecting a move', async () => {
    const now = Date.now();
    const refTs = now - 310_000;
    mockRedis.zrangebyscore.mockResolvedValue([`${refTs}:65000`]);

    await detectMoves([{ assetId: 'bitcoin', price: 67000, timestamp: now }]);

    expect(mockRedis.set).toHaveBeenCalledWith(
      'spot:cooldown:bitcoin:up',
      '1',
      'EX',
      1800, // 30 min
    );
  });

  it('detects downward moves', async () => {
    const now = Date.now();
    const refTs = now - 310_000;
    mockRedis.zrangebyscore.mockResolvedValue([`${refTs}:70000`]);

    const moves = await detectMoves([{ assetId: 'bitcoin', price: 67000, timestamp: now }]);

    expect(moves).toHaveLength(1);
    expect(moves[0]!.changePercent).toBeLessThan(0);
    expect(mockRedis.set).toHaveBeenCalledWith('spot:cooldown:bitcoin:down', '1', 'EX', 1800);
  });

  it('handles multiple assets in one batch', async () => {
    const now = Date.now();
    const refTs = now - 310_000;
    // Route by key — pct path uses spot:prices:*, shadow zscore uses spot:klines:*
    mockRedis.zrangebyscore.mockImplementation(async (key: string) => {
      if (key === 'spot:prices:bitcoin') return [`${refTs}:65000`];
      if (key === 'spot:prices:ethereum') return [`${refTs}:3000`];
      return [];
    });

    const moves = await detectMoves([
      { assetId: 'bitcoin', price: 67000, timestamp: now },
      { assetId: 'ethereum', price: 3120, timestamp: now },
    ]);

    expect(moves).toHaveLength(2);
  });

  it('applies session multiplier when enabled — widens threshold', async () => {
    // Enable session threshold and set all multipliers to 2.0
    mockConfig.SESSION_THRESHOLD_ENABLED = true;
    mockConfig.SESSION_MULTIPLIERS = Array(24).fill('2.0').join(',');

    const now = Date.now();
    const refTs = now - 310_000;
    // 3.08% move — above base 3% threshold but below 6% (3% * 2.0)
    mockRedis.zrangebyscore.mockResolvedValue([`${refTs}:65000`]);

    const moves = await detectMoves([{ assetId: 'bitcoin', price: 67000, timestamp: now }]);
    expect(moves).toHaveLength(0); // blocked by widened threshold

    // Reset
    mockConfig.SESSION_THRESHOLD_ENABLED = false;
    mockConfig.SESSION_MULTIPLIERS = '1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.3,1.3,1.3,1.3,1.3,1.5,1.5,1.5,1.5,1.2,1.2,1.2,1.2,0.8,0.8,0.8';
  });

  it('zscore mode: triggers on a large spike against a flat baseline', async () => {
    mockConfig.SPOT_TRIGGER_MODE = 'zscore';
    const now = Date.now();
    // 84 perfectly flat closes, then one explosive bar at the end.
    // Returns over 5-bar window are all 0 except the last 5 which carry the jump,
    // producing a strong z-score on the latest return.
    const klines: string[] = [];
    for (let i = 0; i < 84; i++) {
      klines.push(JSON.stringify({ t: now - (85 - i) * 60_000, c: 100 }));
    }
    klines.push(JSON.stringify({ t: now - 60_000, c: 110 }));
    mockRedis.zrangebyscore.mockImplementation(async (key: string) => {
      if (key === 'spot:prices:bitcoin') return [`${now - 310_000}:100`];
      if (key === 'spot:klines:btcusdt:1m') return klines;
      return [];
    });

    const moves = await detectMoves([{ assetId: 'bitcoin', price: 110, timestamp: now }]);
    expect(moves).toHaveLength(1);
    expect(moves[0]!.assetId).toBe('bitcoin');
    mockConfig.SPOT_TRIGGER_MODE = 'pct';
  });

  it('zscore mode: does not trigger on a flat market', async () => {
    mockConfig.SPOT_TRIGGER_MODE = 'zscore';
    const now = Date.now();
    const klines: string[] = [];
    for (let i = 0; i < 80; i++) {
      klines.push(
        JSON.stringify({ t: now - (80 - i) * 60_000, c: 100 + (i % 2 === 0 ? 0.001 : -0.001) }),
      );
    }
    mockRedis.zrangebyscore.mockImplementation(async (key: string) => {
      if (key === 'spot:prices:bitcoin') return [`${now - 310_000}:100`];
      if (key === 'spot:klines:btcusdt:1m') return klines;
      return [];
    });

    const moves = await detectMoves([{ assetId: 'bitcoin', price: 100.05, timestamp: now }]);
    expect(moves).toHaveLength(0);
    mockConfig.SPOT_TRIGGER_MODE = 'pct';
  });

  it('both mode: requires pct AND zscore agreement', async () => {
    mockConfig.SPOT_TRIGGER_MODE = 'both';
    const now = Date.now();
    // Flat klines → zscore won't fire even though pct does
    const klines: string[] = [];
    for (let i = 0; i < 80; i++) {
      klines.push(JSON.stringify({ t: now - (80 - i) * 60_000, c: 100 }));
    }
    mockRedis.zrangebyscore.mockImplementation(async (key: string) => {
      if (key === 'spot:prices:bitcoin') return [`${now - 310_000}:65000`];
      if (key === 'spot:klines:btcusdt:1m') return klines;
      return [];
    });

    const moves = await detectMoves([{ assetId: 'bitcoin', price: 67000, timestamp: now }]);
    expect(moves).toHaveLength(0);
    mockConfig.SPOT_TRIGGER_MODE = 'pct';
  });

  it('session multiplier < 1 narrows threshold — lets smaller moves through', async () => {
    // Set all multipliers to 0.5 — threshold becomes 1.5%
    mockConfig.SESSION_THRESHOLD_ENABLED = true;
    mockConfig.SESSION_MULTIPLIERS = Array(24).fill('0.5').join(',');

    const now = Date.now();
    const refTs = now - 310_000;
    // 2% move — below base 3% but above 1.5% (3% * 0.5)
    mockRedis.zrangebyscore.mockResolvedValue([`${refTs}:65000`]);

    const moves = await detectMoves([{ assetId: 'bitcoin', price: 66300, timestamp: now }]);
    expect(moves).toHaveLength(1);

    // Reset
    mockConfig.SESSION_THRESHOLD_ENABLED = false;
    mockConfig.SESSION_MULTIPLIERS = '1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.3,1.3,1.3,1.3,1.3,1.5,1.5,1.5,1.5,1.2,1.2,1.2,1.2,0.8,0.8,0.8';
  });

  it('session_threshold shadow row written when multiplier blocks a trigger', async () => {
    mockConfig.SESSION_THRESHOLD_ENABLED = true;
    mockConfig.SESSION_MULTIPLIERS = Array(24).fill('2.0').join(',');

    const now = Date.now();
    const refTs = now - 310_000;
    // 3.08% move — above base 3% but below adjusted 6%
    mockRedis.zrangebyscore.mockResolvedValue([`${refTs}:65000`]);

    await detectMoves([{ assetId: 'bitcoin', price: 67000, timestamp: now }]);

    const sessionCall = enqueueWriteMock.mock.calls.find(
      ([table, row]) => table === 'shadow_observations' && row?.kind === 'session_threshold',
    );
    expect(sessionCall).toBeDefined();
    const row = sessionCall![1];
    expect(row.symbol).toBe('bitcoin');
    expect(row.wouldBlock).toBe(true);
    expect(row.payload.outcome).toBe('multiplier_blocked_trigger');
    expect(row.payload.pctTriggeredBase).toBe(true);
    expect(row.payload.pctTriggeredAdjusted).toBe(false);

    mockConfig.SESSION_THRESHOLD_ENABLED = false;
    mockConfig.SESSION_MULTIPLIERS = '1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.3,1.3,1.3,1.3,1.3,1.5,1.5,1.5,1.5,1.2,1.2,1.2,1.2,0.8,0.8,0.8';
  });

  it('session_threshold shadow row written when multiplier enables a trigger', async () => {
    mockConfig.SESSION_THRESHOLD_ENABLED = true;
    mockConfig.SESSION_MULTIPLIERS = Array(24).fill('0.5').join(',');

    const now = Date.now();
    const refTs = now - 310_000;
    // 2% move — below base 3% but above adjusted 1.5%
    mockRedis.zrangebyscore.mockResolvedValue([`${refTs}:65000`]);

    await detectMoves([{ assetId: 'bitcoin', price: 66300, timestamp: now }]);

    const sessionCall = enqueueWriteMock.mock.calls.find(
      ([table, row]) => table === 'shadow_observations' && row?.kind === 'session_threshold',
    );
    expect(sessionCall).toBeDefined();
    const row = sessionCall![1];
    expect(row.wouldBlock).toBe(false);
    expect(row.payload.outcome).toBe('multiplier_enabled_trigger');
    expect(row.payload.pctTriggeredBase).toBe(false);
    expect(row.payload.pctTriggeredAdjusted).toBe(true);

    mockConfig.SESSION_THRESHOLD_ENABLED = false;
    mockConfig.SESSION_MULTIPLIERS = '1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.3,1.3,1.3,1.3,1.3,1.5,1.5,1.5,1.5,1.2,1.2,1.2,1.2,0.8,0.8,0.8';
  });

  it('session_threshold shadow row NOT written when multiplier does not flip outcome', async () => {
    mockConfig.SESSION_THRESHOLD_ENABLED = true;
    mockConfig.SESSION_MULTIPLIERS = Array(24).fill('1.5').join(',');

    const now = Date.now();
    const refTs = now - 310_000;
    // 1% move — below both base 3% and adjusted 4.5%
    mockRedis.zrangebyscore.mockResolvedValue([`${refTs}:66000`]);

    await detectMoves([{ assetId: 'bitcoin', price: 66660, timestamp: now }]);

    const sessionCall = enqueueWriteMock.mock.calls.find(
      ([table, row]) => table === 'shadow_observations' && row?.kind === 'session_threshold',
    );
    expect(sessionCall).toBeUndefined();

    mockConfig.SESSION_THRESHOLD_ENABLED = false;
    mockConfig.SESSION_MULTIPLIERS = '1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.3,1.3,1.3,1.3,1.3,1.5,1.5,1.5,1.5,1.2,1.2,1.2,1.2,0.8,0.8,0.8';
  });
});
