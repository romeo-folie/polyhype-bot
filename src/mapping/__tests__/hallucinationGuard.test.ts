import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findCorrelatedMarkets } from '../../spot/marketCorrelator.js';
import { findCandidateMarkets } from '../entityExtractor.js';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../gamma.js', () => ({
  searchEvents: vi.fn(),
  parseOutcomePrices: vi.fn().mockImplementation((p) => (Array.isArray(p) ? p : JSON.parse(p))),
  parseClobTokenIds: vi.fn().mockImplementation((t) => (Array.isArray(t) ? t : JSON.parse(t))),
}));

vi.mock('openai', () => ({
  default: vi.fn(),
  OpenAI: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: 'positive' } }],
        }),
      },
    },
  })),
}));

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({
      generateContent: vi.fn().mockResolvedValue({
        response: { text: () => 'positive' },
      }),
    }),
  })),
}));

vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn().mockReturnValue({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  }),
}));

const { searchEvents } = await import('../gamma.js');
const mockSearchEvents = vi.mocked(searchEvents);

describe('Hallucination Guard Regression Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = 'test';
    process.env.GEMINI_API_KEY = 'test';
  });

  describe('marketCorrelator Strict Filtering', () => {
    it('skips unrelated markets returned by Gamma trending fallback (e.g. Bittensor -> Macron)', async () => {
      // Mock Gamma returning Macron for a Bittensor query
      mockSearchEvents.mockResolvedValue([
        {
          id: 'evt-macron',
          title: 'Macron Presidency',
          slug: 'macron',
          active: true,
          closed: false,
          markets: [
            {
              id: 'mkt-macron',
              question: 'Will Macron be out by June?',
              conditionId: 'cond-1',
              outcomes: ['Yes', 'No'],
              active: true,
              closed: false,
              liquidity: '10000',
              volume: '50000',
              outcomePrices: '["0.5", "0.5"]',
              clobTokenIds: '["yes", "no"]',
              endDate: '2026-06-30',
              description: 'French election market',
            },
          ],
        },
      ]);

      const results = await findCorrelatedMarkets({
        assetId: 'bittensor',
        currentPrice: 500,
        referencePrice: 480,
        changePercent: 4.1,
        windowMinutes: 5,
        detectedAt: new Date().toISOString(),
      });

      // Macron should be filtered because it doesn't mention 'bittensor' or 'TAO'
      expect(results).toHaveLength(0);
    });

    it('keeps relevant markets that mention the asset', async () => {
      mockSearchEvents.mockResolvedValue([
        {
          id: 'evt-tao',
          title: 'Bittensor Node Growth',
          slug: 'tao-growth',
          active: true,
          closed: false,
          markets: [
            {
              id: 'mkt-tao',
              question: 'Will there be 100k Bittensor nodes by year end?',
              conditionId: 'cond-2',
              outcomes: ['Yes', 'No'],
              active: true,
              closed: false,
              liquidity: '10000',
              volume: '50000',
              outcomePrices: '["0.5", "0.5"]',
              clobTokenIds: '["yes", "no"]',
              endDate: '2026-12-31',
              description: 'TAO node market',
            },
          ],
        },
      ]);

      const results = await findCorrelatedMarkets({
        assetId: 'bittensor',
        currentPrice: 500,
        referencePrice: 480,
        changePercent: 4.1,
        windowMinutes: 5,
        detectedAt: new Date().toISOString(),
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.marketId).toBe('mkt-tao');
    });
  });

  describe('entityExtractor Strict Filtering', () => {
    it('filters out garbage search results for OSINT signals', async () => {
      mockSearchEvents.mockResolvedValue([
        {
          id: 'evt-random',
          title: 'Trending Market About Something Else',
          slug: 'random-trending',
          active: true,
          closed: false,
          markets: [
            {
              id: 'mkt-random',
              question: 'Will something completely unrelated happen?',
              conditionId: 'cond-3',
              outcomes: ['Yes', 'No'],
              active: true,
              closed: false,
              liquidity: '10000',
              volume: '50000',
              outcomePrices: '["0.5", "0.5"]',
              clobTokenIds: '["yes", "no"]',
              endDate: '2026-12-31',
              description: 'Unrelated market',
            },
          ],
        },
      ]);

      const results = await findCandidateMarkets({
        title: 'Bittensor launches new subnet',
        url: 'https://test.com',
        source: 'test',
        publishedAt: new Date(),
        keywords: ['bittensor', 'subnet'],
        urgencyScore: 9,
        categoryId: 'crypto',
        categoryLabel: 'Crypto',
        entityContext: 'bittensor',
        sentiment: 'NEUTRAL',
      });

      expect(results).toHaveLength(0);
    });

    it('rejects sports/weather markets in any category (Universal Guard)', async () => {
      // Mock Gamma returning a sports market when query for 'crypto' news
      mockSearchEvents.mockResolvedValue([
        {
          id: 'evt-olympics',
          title: 'Paris Olympics 2024',
          slug: 'paris-olympics',
          active: true,
          closed: false,
          markets: [
            {
              id: 'mkt-olympics',
              question: 'Will Paris Olympics win award for best event?',
              conditionId: 'cond-olympics',
              outcomes: ['Yes', 'No'],
              active: true,
              closed: false,
              liquidity: '10000',
              volume: '50000',
              outcomePrices: '["0.5", "0.5"]',
              clobTokenIds: '["yes", "no"]',
              endDate: '2026-12-31',
              description: 'Sports market',
            },
          ],
        },
      ]);

      const results = await findCandidateMarkets({
        title: 'Bitcoin price hits new ATH',
        url: 'https://test.com',
        source: 'test',
        publishedAt: new Date(),
        keywords: ['bitcoin', 'crypto'],
        urgencyScore: 9,
        categoryId: 'crypto', // Non-geopolitical
        categoryLabel: 'Crypto',
        entityContext: 'bitcoin',
        sentiment: 'YES',
      });

      // Olympics market contains 'win', which is on the universal blocklist
      expect(results).toHaveLength(0);
    });
  });
});
