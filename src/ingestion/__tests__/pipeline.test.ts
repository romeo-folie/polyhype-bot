/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * End-to-end pipeline integration tests.
 * Mocks all external I/O (RSS, scraper, Redis, scorer, mapper, executor, telegram).
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockFetchRss = jest.fn<(...args: any[]) => any>();
const mockScrape = jest.fn<(...args: any[]) => any>();
const mockFilterSeen = jest.fn<(...args: any[]) => any>();
const mockScoreItems = jest.fn<(...args: any[]) => any>();
const mockRunMapping = jest.fn<(...args: any[]) => any>();
const mockExecuteSignals = jest.fn<(...args: any[]) => any>();
const mockPersistPosition = jest.fn<(...args: any[]) => any>();
const mockNotifyTradeExecuted = jest.fn<(...args: any[]) => any>();
const mockNotifyExecutionError = jest.fn<(...args: any[]) => any>();
const mockGetRedis = jest.fn<(...args: any[]) => any>();

jest.unstable_mockModule('../rss.js', () => ({ fetchRssFeeds: mockFetchRss }));
jest.unstable_mockModule('../scraper.js', () => ({ scrapeHeadlines: mockScrape }));
jest.unstable_mockModule('../dedup.js', () => ({ filterSeen: mockFilterSeen }));
jest.unstable_mockModule('../scorer.js', () => ({ scoreItems: mockScoreItems }));
jest.unstable_mockModule('../../mapping/index.js', () => ({ runMapping: mockRunMapping }));
jest.unstable_mockModule('../../execution/executor.js', () => ({
  executeSignals: mockExecuteSignals,
}));
jest.unstable_mockModule('../../execution/positionLedger.js', () => ({
  persistPosition: mockPersistPosition,
}));
jest.unstable_mockModule('../../shared/telegram.js', () => ({
  notifyTradeExecuted: mockNotifyTradeExecuted,
  notifyExecutionError: mockNotifyExecutionError,
}));
jest.unstable_mockModule('../../shared/redis.js', () => ({ getRedis: mockGetRedis }));
jest.unstable_mockModule('../../shared/config.js', () => ({
  loadConfig: jest.fn().mockReturnValue({
    URGENCY_THRESHOLD: 8,
    DIVERGENCE_THRESHOLD: 0.1,
    MAX_BET_FRACTION: 0.1,
  }),
}));

const { runPipeline } = await import('../index.js');

const BASE_SIGNAL = {
  marketId: 'mkt-1',
  conditionId: 'cond-1',
  clobTokenIds: [],
  question: 'Will X happen?',
  direction: 'YES' as const,
  stakeUsd: 10,
  edgeMagnitude: 0.2,
  consensusProbability: 0.7,
  outcomePrice: 0.5,
  halfKellyFraction: 0.1,
  sourcedFrom: 'Test',
  reasoning: 'reason',
};

const HIGH_URGENCY_ITEM = {
  title: 'Crisis headline',
  url: 'https://example.com/1',
  publishedAt: new Date(),
  source: 'Test',
  urgencyScore: 9,
  keywords: ['conflict'],
};

function resetMocks() {
  mockFetchRss.mockReset();
  mockScrape.mockReset();
  mockFilterSeen.mockReset();
  mockScoreItems.mockReset();
  mockRunMapping.mockReset();
  mockExecuteSignals.mockReset();
  mockPersistPosition.mockReset();
  mockNotifyTradeExecuted.mockReset();
  mockNotifyExecutionError.mockReset();

  mockFetchRss.mockResolvedValue([HIGH_URGENCY_ITEM]);
  mockScrape.mockResolvedValue([]);
  mockFilterSeen.mockResolvedValue([HIGH_URGENCY_ITEM]);
  mockScoreItems.mockResolvedValue([HIGH_URGENCY_ITEM]);
  mockPersistPosition.mockResolvedValue(undefined);
}

describe('runPipeline', () => {
  beforeEach(resetMocks);

  it('persists position and notifies on success with txHash', async () => {
    mockRunMapping.mockResolvedValue([BASE_SIGNAL]);
    mockExecuteSignals.mockResolvedValue([
      { success: true, txHash: '0xabc', signal: BASE_SIGNAL },
    ]);

    await runPipeline(100);

    expect(mockPersistPosition).toHaveBeenCalledWith(BASE_SIGNAL, '0xabc');
    expect(mockNotifyTradeExecuted).toHaveBeenCalledTimes(1);
    expect(mockNotifyExecutionError).not.toHaveBeenCalled();
  });

  it('still notifies (no persist) on success WITHOUT txHash', async () => {
    // HIGH finding: success=true but no tx_hash must not silently drop the result
    mockRunMapping.mockResolvedValue([BASE_SIGNAL]);
    mockExecuteSignals.mockResolvedValue([
      { success: true, signal: BASE_SIGNAL }, // txHash omitted
    ]);

    await runPipeline(100);

    expect(mockPersistPosition).not.toHaveBeenCalled();
    // Must still fire the trade-executed notification
    expect(mockNotifyTradeExecuted).toHaveBeenCalledTimes(1);
    expect(mockNotifyExecutionError).not.toHaveBeenCalled();
  });

  it('notifies error and does not persist on failure', async () => {
    mockRunMapping.mockResolvedValue([BASE_SIGNAL]);
    mockExecuteSignals.mockResolvedValue([
      { success: false, error: 'Simmer rejected', signal: BASE_SIGNAL },
    ]);

    await runPipeline(100);

    expect(mockPersistPosition).not.toHaveBeenCalled();
    expect(mockNotifyExecutionError).toHaveBeenCalledTimes(1);
    expect(mockNotifyTradeExecuted).not.toHaveBeenCalled();
  });

  it('exits early when no high-urgency items', async () => {
    mockScoreItems.mockResolvedValue([{ ...HIGH_URGENCY_ITEM, urgencyScore: 3 }]);

    await runPipeline(100);

    expect(mockRunMapping).not.toHaveBeenCalled();
    expect(mockExecuteSignals).not.toHaveBeenCalled();
  });

  it('exits early when mapping produces no signals', async () => {
    mockRunMapping.mockResolvedValue([]);

    await runPipeline(100);

    expect(mockExecuteSignals).not.toHaveBeenCalled();
  });
});
