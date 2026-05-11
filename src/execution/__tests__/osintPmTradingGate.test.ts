import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScoredItem } from '../../ingestion/scorer.js';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn(),
  acquireLock: vi.fn().mockResolvedValue('lock-token'),
  releaseLock: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../shared/bankroll.js', () => ({
  getBankroll: vi.fn().mockResolvedValue(100),
}));

vi.mock('../../monitor/signalReeval.js', () => ({
  reEvaluatePositions: vi.fn().mockResolvedValue({ exited: 0, held: 0, errors: 0 }),
}));

vi.mock('../../ingestion/osintStore.js', () => ({
  persistOsintItems: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../mapping/index.js', () => ({
  runMapping: vi.fn().mockResolvedValue([]),
  mapNewsToFutures: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(),
}));

// No signals to execute — this test is only about which mappers are called.
vi.mock('../executor.js', () => ({
  executeAndRecordSignal: vi.fn(),
}));

vi.mock('../telegram.js', () => ({
  notifyTradeError: vi.fn(),
}));

import { processScoredItems } from '../index.js';
import { runMapping, mapNewsToFutures } from '../../mapping/index.js';
import { loadConfig } from '../../shared/config.js';

function makeConfig(osintPmEnabled: boolean) {
  return { OSINT_PM_TRADING_ENABLED: osintPmEnabled } as ReturnType<typeof loadConfig>;
}

function makeScoredItem(title: string): ScoredItem {
  return {
    title,
    url: 'https://example.com',
    publishedAt: new Date(),
    source: 'test',
    urgencyScore: 9,
    keywords: ['BTC'],
    categoryId: 'crypto-futures',
    categoryLabel: 'Crypto / Futures',
    entityContext: 'cryptocurrency',
    sentiment: 'NEUTRAL',
  };
}

describe('OSINT_PM_TRADING_ENABLED gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips runMapping when flag is false', async () => {
    vi.mocked(loadConfig).mockReturnValue(makeConfig(false));
    const redis = {} as ReturnType<typeof import('../../shared/redis.js').getRedis>;

    await processScoredItems([makeScoredItem('BTC pumping hard')], redis);

    expect(runMapping).not.toHaveBeenCalled();
    expect(mapNewsToFutures).toHaveBeenCalledOnce();
  });

  it('calls runMapping when flag is true', async () => {
    vi.mocked(loadConfig).mockReturnValue(makeConfig(true));
    const redis = {} as ReturnType<typeof import('../../shared/redis.js').getRedis>;

    await processScoredItems([makeScoredItem('BTC pumping hard')], redis);

    expect(runMapping).toHaveBeenCalledOnce();
    expect(mapNewsToFutures).toHaveBeenCalledOnce();
  });

  it('always calls mapNewsToFutures regardless of flag', async () => {
    for (const flag of [false, true]) {
      vi.clearAllMocks();
      vi.mocked(loadConfig).mockReturnValue(makeConfig(flag));
      const redis = {} as ReturnType<typeof import('../../shared/redis.js').getRedis>;

      await processScoredItems([makeScoredItem('ETH news')], redis);

      expect(mapNewsToFutures).toHaveBeenCalledOnce();
    }
  });
});
