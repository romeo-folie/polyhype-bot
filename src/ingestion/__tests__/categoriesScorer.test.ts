import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RssItem } from '../rss.js';
import { CATEGORIES } from '../categories/index.js';

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    OPENAI_API_KEY: 'test-openai-key',
    GEMINI_API_KEY: 'test-gemini-key',
    OPENAI_MODEL: 'gpt-4o-mini',
    GEMINI_MODEL: 'gemini-2.5-flash',
    LLM_PROVIDER: 'gemini',
    URGENCY_THRESHOLD: 8,
    SCORER_CACHE_TTL_S: 3600,
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGenerateContent = vi.fn<(...args: any[]) => any>();
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({
      generateContent: mockGenerateContent,
    }),
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockChatCreate = vi.fn<(...args: any[]) => any>();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockChatCreate,
      },
    },
  })),
}));

const { scoreItems } = await import('../scorer.js');

function makeItems(headlines: string[]): RssItem[] {
  return headlines.map((title, index) => ({
    title,
    url: `https://example.com/${index}-${title.toLowerCase().replace(/\s+/g, '-')}`,
    publishedAt: new Date('2026-03-01T00:00:00Z'),
    source: 'Test Source',
  }));
}

const HEADLINES: Record<string, [string, string, string]> = {
  geopolitical: [
    'US launches airstrikes on Iranian nuclear facility',
    'Diplomatic talks between US and North Korea scheduled for next month',
    'UN envoy issues routine statement on ceasefire monitoring',
  ],
  macro: [
    'Federal Reserve cuts rates by 50bps in emergency meeting',
    'ECB signals possible policy shift ahead of summer meeting',
    'Fed governor gives speech on long-run inflation expectations',
  ],
  'crypto-regulatory': [
    'SEC approves spot Ethereum ETF for three major asset managers',
    'UK regulator opens consultation on crypto exchange capital rules',
    'CFTC issues guidance on crypto derivatives reporting requirements',
  ],
  'crypto-futures': [
    'Major crypto exchange suffers $200M exploit — withdrawals halted',
    'Ethereum Pectra upgrade activates on mainnet, network congestion spikes',
    'Coinbase lists new token in routine monthly review',
  ],
  'ai-tech': [
    'OpenAI releases GPT-5 with claimed PhD-level reasoning across all domains',
    'NVIDIA launches new AI accelerator lineup for data centers',
    'HuggingFace adds new model card template to its platform',
  ],
  'us-politics': [
    'Senate passes bipartisan AI regulation bill 67-33',
    'House committee advances bipartisan tech oversight proposal',
    'Democratic senator calls for investigation into tech company practices',
  ],
  sports: [
    'Star quarterback ruled out for championship game with torn ACL',
    'Trade deadline looms as contending team eyes All-Star acquisition',
    'Team announces new assistant coach hiring for next season',
  ],
};

const SCORES: Record<string, number[]> = {
  geopolitical: [9, 8, 2],
  macro: [9, 8, 3],
  'crypto-regulatory': [9, 8, 2],
  'crypto-futures': [9, 7, 2],
  'ai-tech': [9, 7, 2],
  'us-politics': [9, 7, 2],
  sports: [9, 7, 2],
};

describe('category scorer prompts', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockChatCreate.mockReset();
  });

  for (const category of CATEGORIES) {
    it(`scores ${category.id} headlines with ${category.scoreThreshold}+ threshold`, async () => {
      const headlines = HEADLINES[category.id];
      const scores = SCORES[category.id];
      if (!headlines || !scores) {
        throw new Error(`Missing test fixtures for ${category.id}`);
      }

      mockGenerateContent.mockResolvedValue({
        response: {
          text: () =>
            JSON.stringify({
              results: [
                { score: scores[0], keywords: ['alpha'] },
                { score: scores[1], keywords: ['beta'] },
                { score: scores[2], keywords: ['gamma'] },
              ],
            }),
        },
      });

      const items = makeItems(headlines);
      const result = await scoreItems(items, {
        systemPrompt: category.scorerPrompt,
        categoryId: category.id,
        categoryLabel: category.label,
        entityContext: category.entityContext,
      });

      expect(result).toHaveLength(3);
      expect(result[0]!.urgencyScore).toBe(scores[0]);
      expect(result[1]!.urgencyScore).toBe(scores[1]);
      expect(result[2]!.urgencyScore).toBe(scores[2]);

      expect(result[0]!.categoryId).toBe(category.id);
      expect(result[0]!.categoryLabel).toBe(category.label);
      expect(result[0]!.entityContext).toBe(category.entityContext);

      const call = mockGenerateContent.mock.calls[0]?.[0];
      expect(call?.systemInstruction?.parts?.[0]?.text).toBe(category.scorerPrompt);
      const userPrompt = call?.contents?.[0]?.parts?.[0]?.text ?? '';
      expect(userPrompt).toContain(`1. ${headlines[0]}`);
      expect(userPrompt).toContain(`2. ${headlines[1]}`);
      expect(userPrompt).toContain(`3. ${headlines[2]}`);
    });
  }
});
