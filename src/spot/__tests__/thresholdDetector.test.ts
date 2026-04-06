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
};

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue(mockConfig),
}));

const mockRedis = {
  get: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
  set: vi.fn<() => Promise<'OK'>>().mockResolvedValue('OK'),
  zrangebyscore: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
  zrange: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
};

vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn().mockReturnValue(mockRedis),
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
    // Both exceed threshold
    mockRedis.zrangebyscore
      .mockResolvedValueOnce([`${refTs}:65000`]) // bitcoin ref
      .mockResolvedValueOnce([`${refTs}:3000`]); // ethereum ref

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
});
