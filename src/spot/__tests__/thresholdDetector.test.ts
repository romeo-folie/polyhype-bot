import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../shared/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../shared/config.js', () => ({
  loadConfig: jest.fn().mockReturnValue({
    SPOT_MOVE_THRESHOLD: 3,
    SPOT_LOOKBACK_MINUTES: 5,
    SPOT_COOLDOWN_MINUTES: 30,
  }),
}));

const mockRedis = {
  get: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
  set: jest.fn<() => Promise<'OK'>>().mockResolvedValue('OK'),
  zrangebyscore: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
  zrange: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
};

jest.unstable_mockModule('../../shared/redis.js', () => ({
  getRedis: jest.fn().mockReturnValue(mockRedis),
}));

const { detectMoves } = await import('../thresholdDetector.js');

beforeEach(() => {
  mockRedis.get.mockReset().mockResolvedValue(null);
  mockRedis.set.mockReset().mockResolvedValue('OK');
  mockRedis.zrangebyscore.mockReset().mockResolvedValue([]);
  mockRedis.zrange.mockReset().mockResolvedValue([]);
});

describe('detectMoves', () => {
  it('detects a move exceeding the threshold', async () => {
    const now = Date.now();
    const refTs = now - 310_000; // ~5 min ago
    mockRedis.zrangebyscore.mockResolvedValue([`${refTs}:65000`]);

    const moves = await detectMoves([
      { assetId: 'bitcoin', price: 67000, timestamp: now },
    ]);

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

    const moves = await detectMoves([
      { assetId: 'bitcoin', price: 66660, timestamp: now },
    ]);

    expect(moves).toHaveLength(0);
  });

  it('skips assets with no reference price', async () => {
    mockRedis.zrangebyscore.mockResolvedValue([]);
    mockRedis.zrange.mockResolvedValue([]);

    const moves = await detectMoves([
      { assetId: 'bitcoin', price: 67000, timestamp: Date.now() },
    ]);

    expect(moves).toHaveLength(0);
  });

  it('respects cooldown — suppresses re-trigger in same direction', async () => {
    const now = Date.now();
    const refTs = now - 310_000;
    mockRedis.zrangebyscore.mockResolvedValue([`${refTs}:65000`]);

    // First call: triggers
    const moves1 = await detectMoves([
      { assetId: 'bitcoin', price: 67000, timestamp: now },
    ]);
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

    await detectMoves([
      { assetId: 'bitcoin', price: 67000, timestamp: now },
    ]);

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

    const moves = await detectMoves([
      { assetId: 'bitcoin', price: 67000, timestamp: now },
    ]);

    expect(moves).toHaveLength(1);
    expect(moves[0]!.changePercent).toBeLessThan(0);
    expect(mockRedis.set).toHaveBeenCalledWith(
      'spot:cooldown:bitcoin:down',
      '1',
      'EX',
      1800,
    );
  });

  it('handles multiple assets in one batch', async () => {
    const now = Date.now();
    const refTs = now - 310_000;
    // Both exceed threshold
    mockRedis.zrangebyscore
      .mockResolvedValueOnce([`${refTs}:65000`])  // bitcoin ref
      .mockResolvedValueOnce([`${refTs}:3000`]);   // ethereum ref

    const moves = await detectMoves([
      { assetId: 'bitcoin', price: 67000, timestamp: now },
      { assetId: 'ethereum', price: 3120, timestamp: now },
    ]);

    expect(moves).toHaveLength(2);
  });
});
