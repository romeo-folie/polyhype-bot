import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { z } from 'zod';
import type * as configModule from '../../shared/config.js';
import type * as hyperliquidModule from '../../shared/hyperliquid.js';
import { mapNewsToFutures } from '../index.js';
import type { ScoredItem } from '../../ingestion/scorer.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../db/writeQueue.js', () => ({ enqueueWrite: vi.fn().mockResolvedValue(undefined) }));

// Test config foundation from the REAL Zod schema defaults (see
// hlMomentumScanner.test.ts for rationale — mocks can never drift from config.ts).
const { envSchema } = await vi.importActual<typeof configModule>('../../shared/config.js');
function schemaDefaults(schema: z.AnyZodObject): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const parsed = field.safeParse(undefined);
    if (parsed.success && parsed.data !== undefined) defaults[key] = parsed.data;
  }
  return defaults;
}

const baseConfig = {
  ...schemaDefaults(envSchema),
  FUTURES_ENABLED: true,
  FUTURES_URGENCY_THRESHOLD: 6,
  // Keep the path deterministic: no confluence/vol-sizing dependencies.
  FUTURES_CONFLUENCE_GATE_ENABLED: false,
  FUTURES_VOL_SIZING_ENABLED: false,
  FUTURES_MAX_PER_TRADE_USD: 10,
  MAX_BET_FRACTION: 0.05,
};

const mockLoadConfig = vi.fn(() => ({ ...baseConfig }));
vi.mock('../../shared/config.js', () => ({ loadConfig: () => mockLoadConfig() }));

const mockEstimateSentiment = vi.fn();
vi.mock('../consensusCalculator.js', () => ({
  estimateConsensusProbability: vi.fn(),
  estimateSentiment: (...args: unknown[]) => mockEstimateSentiment(...args),
}));

const mockRedis = { exists: vi.fn().mockResolvedValue(0) };
vi.mock('../../shared/redis.js', () => ({ getRedis: () => mockRedis }));

vi.mock('../../shared/hyperliquid.js', async () => {
  const actual = await vi.importActual<typeof hyperliquidModule>('../../shared/hyperliquid.js');
  return {
    ...actual,
    getHyperliquid: () => ({
      getClearinghouseState: vi.fn().mockResolvedValue({
        marginSummary: { accountValue: '100' },
        assetPositions: [],
      }),
    }),
  };
});

vi.mock('../../arb/confluenceScorer.js', () => ({ scoreConfluence: vi.fn() }));
vi.mock('../../arb/indicators.js', () => ({ computeATR: vi.fn().mockResolvedValue(null) }));

// Heavy PM-mapping deps pulled in by mapping/index.ts — inert for this test.
vi.mock('../entityExtractor.js', () => ({ findCandidateMarkets: vi.fn() }));
vi.mock('../relevanceGate.js', () => ({ scoreMarketRelevance: vi.fn() }));
vi.mock('../divergenceCalculator.js', () => ({
  computeDivergence: vi.fn(),
  checkTimeToResolution: vi.fn(),
}));
vi.mock('../../shared/priceCache.js', () => ({
  resolveYesPrice: vi.fn(),
  resolveNoPrice: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<ScoredItem> = {}): ScoredItem {
  return {
    title: 'Bitcoin surges on ETF inflows',
    url: 'https://example.com/article',
    publishedAt: new Date(),
    source: 'rss',
    urgencyScore: 8,
    keywords: ['bitcoin'],
    categoryId: 'crypto',
    categoryLabel: 'Crypto',
    entityContext: '',
    sentiment: 'YES',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue({ ...baseConfig });
  mockEstimateSentiment.mockResolvedValue('LONG');
  mockRedis.exists.mockResolvedValue(0);
});

// ---------------------------------------------------------------------------
// NEWS_FUTURES_ENABLED gate
// ---------------------------------------------------------------------------

describe('mapNewsToFutures — NEWS_FUTURES_ENABLED gate', () => {
  it('returns the futures signal when NEWS_FUTURES_ENABLED=true (default)', async () => {
    const signals = await mapNewsToFutures([makeItem()], 100);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      marketId: 'BTC',
      direction: 'LONG',
      isFutures: true,
      source: 'futures',
    });
  });

  it('shadow-logs instead of emitting when NEWS_FUTURES_ENABLED=false', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, NEWS_FUTURES_ENABLED: false });
    const { enqueueWrite } = await import('../../db/writeQueue.js');

    const signals = await mapNewsToFutures([makeItem()], 100);

    expect(signals).toHaveLength(0);
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        kind: 'news_futures_signal',
        source: 'futures',
        symbol: 'BTC',
        direction: 'LONG',
        wouldBlock: true,
        metricValue: 8,
        payload: expect.objectContaining({
          urgencyScore: 8,
          stakeUsd: expect.any(Number),
          title: 'Bitcoin surges on ETF inflows',
        }),
      }),
    );
  });

  it('still applies upstream gates before shadow-logging (neutral sentiment writes nothing)', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, NEWS_FUTURES_ENABLED: false });
    mockEstimateSentiment.mockResolvedValue('NEUTRAL');
    const { enqueueWrite } = await import('../../db/writeQueue.js');

    const signals = await mapNewsToFutures([makeItem()], 100);

    expect(signals).toHaveLength(0);
    expect(enqueueWrite).not.toHaveBeenCalled();
  });
});
