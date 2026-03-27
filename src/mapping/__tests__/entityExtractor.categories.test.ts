import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CATEGORIES } from '../../ingestion/categories/index.js';

jest.unstable_mockModule('../../shared/config.js', () => ({
  loadConfig: jest.fn(() => ({
    OPENAI_MODEL: 'gpt-4o-mini',
    GEMINI_MODEL: 'gemini-2.5-flash',
    LLM_PROVIDER: 'openai',
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockChatCreate = jest.fn<(...args: any[]) => any>();

jest.unstable_mockModule('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockChatCreate,
      },
    },
  })),
}));

const { extractEntities } = await import('../entityExtractor.js');

const ENTITY_FIXTURES: Record<string, { headline: string; entities: string[] }> = {
  geopolitical: {
    headline: 'US launches airstrikes on Iranian nuclear facility',
    entities: ['United States', 'Iran', 'airstrikes'],
  },
  macro: {
    headline: 'Federal Reserve cuts rates by 50bps in emergency meeting',
    entities: ['Federal Reserve', 'rate cut', 'emergency meeting'],
  },
  'crypto-regulatory': {
    headline: 'SEC approves spot Ethereum ETF for three major asset managers',
    entities: ['SEC', 'Ethereum', 'ETF'],
  },
  'ai-tech': {
    headline: 'OpenAI releases GPT-5 with claimed PhD-level reasoning across all domains',
    entities: ['OpenAI', 'GPT-5', 'model release'],
  },
  'us-politics': {
    headline: 'Senate passes bipartisan AI regulation bill 67-33',
    entities: ['Senate', 'AI regulation', 'bill'],
  },
};

describe('entity extraction per category', () => {
  beforeEach(() => {
    mockChatCreate.mockReset();
    process.env['OPENAI_API_KEY'] = 'test-openai-key';
  });

  afterEach(() => {
    delete process.env['OPENAI_API_KEY'];
  });

  for (const category of CATEGORIES) {
    it(`extracts entities with ${category.id} context`, async () => {
      const fixture = ENTITY_FIXTURES[category.id];
      if (!fixture) {
        throw new Error(`Missing entity fixture for ${category.id}`);
      }

      mockChatCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({ entities: fixture.entities }),
            },
          },
        ],
      });

      const result = await extractEntities(fixture.headline, category.entityContext);
      expect(result).toEqual(fixture.entities);

      const call = mockChatCreate.mock.calls[0]?.[0];
      const systemMessage = call?.messages?.[0]?.content ?? '';
      const userMessage = call?.messages?.[1]?.content ?? '';
      expect(systemMessage).toContain(category.entityContext);
      expect(userMessage).toBe(fixture.headline);
    });
  }
});
