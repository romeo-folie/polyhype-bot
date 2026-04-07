import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const fakeRedis = { expire: vi.fn().mockResolvedValue(1) };
vi.mock('../../shared/redis.js', () => ({
  getRedis: () => fakeRedis,
  acquireLock: vi.fn().mockResolvedValue('token-123'),
  releaseLock: vi.fn().mockResolvedValue(true),
  closeRedis: vi.fn().mockResolvedValue(undefined),
}));

const executeSignalMock = vi.fn().mockResolvedValue({ skipped: false });
vi.mock('../../execution/executor.js', () => ({
  executeSignal: executeSignalMock,
}));

const scanMock = vi.fn();
vi.mock('../scanner.js', () => ({
  scanLiveSportsArb: scanMock,
}));

// Drive the config; simplest is to mock loadConfig directly.
const cfg: any = {
  SPORTS_ARB_ENABLED: true,
  SPORTS_LEAGUES: new Set(['nba']),
  SPORTS_POLL_INTERVAL_S: 8,
  SPORTS_MIN_EDGE: 0.08,
  SPORTS_MAX_STAKE_USD: 5,
  SPORTS_MARKET_LOOKAHEAD_H: 48,
};
vi.mock('../../shared/config.js', () => ({
  loadConfig: () => cfg,
}));

const { sportsPollerTick } = await import('../poller.js');

beforeEach(() => {
  vi.clearAllMocks();
  cfg.SPORTS_ARB_ENABLED = true;
});

describe('sportsPollerTick', () => {
  it('executes emitted signals through executeSignal', async () => {
    scanMock.mockResolvedValueOnce({
      candidates: [],
      signals: [{ marketId: 'm1', direction: 'YES', stakeUsd: 5 }],
    });
    await sportsPollerTick();
    expect(executeSignalMock).toHaveBeenCalledTimes(1);
  });

  it('no-ops when scanner returns no signals', async () => {
    scanMock.mockResolvedValueOnce({ candidates: [], signals: [] });
    await sportsPollerTick();
    expect(executeSignalMock).not.toHaveBeenCalled();
  });

  it('skips execution when SPORTS_ARB_ENABLED=false (log-only)', async () => {
    cfg.SPORTS_ARB_ENABLED = false;
    scanMock.mockResolvedValueOnce({ candidates: [], signals: [] });
    await sportsPollerTick();
    expect(scanMock).toHaveBeenCalledTimes(1);
    expect(executeSignalMock).not.toHaveBeenCalled();
  });

  it('swallows executeSignal failures without throwing', async () => {
    scanMock.mockResolvedValueOnce({
      candidates: [],
      signals: [{ marketId: 'm1' }, { marketId: 'm2' }],
    });
    executeSignalMock.mockRejectedValueOnce(new Error('boom'));
    executeSignalMock.mockResolvedValueOnce({ skipped: false });
    await expect(sportsPollerTick()).resolves.toBeUndefined();
    expect(executeSignalMock).toHaveBeenCalledTimes(2);
  });
});
