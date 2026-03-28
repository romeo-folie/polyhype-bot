import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { RssItem } from '../rss.js';

// Mock loadConfig so scorer tests don't need REDIS_URL / SIMMER_* env vars
jest.unstable_mockModule('../../shared/config.js', () => ({
  loadConfig: jest.fn(() => ({
    OPENAI_MODEL: 'gpt-4o-mini',
    GEMINI_MODEL: 'gemini-2.5-flash',
    LLM_PROVIDER: 'gemini', // default: try Gemini first, fall back to OpenAI
    URGENCY_THRESHOLD: 8,
  })),
}));

// Mock the Google Generative AI module
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGenerateContent = jest.fn<(...args: any[]) => any>();
jest.unstable_mockModule('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({
      generateContent: mockGenerateContent,
    }),
  })),
}));

// Mock the OpenAI module
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockChatCreate = jest.fn<(...args: any[]) => any>();
jest.unstable_mockModule('openai', () => ({
  default: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockChatCreate,
      },
    },
  })),
}));

const { scoreItems } = await import('../scorer.js');

function makeItem(title: string): RssItem {
  return {
    title,
    url: `https://example.com/${title.toLowerCase().replace(/\s+/g, '-')}`,
    publishedAt: new Date('2026-01-01'),
    source: 'Test Source',
  };
}

describe('scoreItems', () => {
  const meta = {
    systemPrompt: 'Custom system prompt for testing',
    categoryId: 'test',
    categoryLabel: 'Test Category',
    entityContext: 'test entities',
  };

  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockChatCreate.mockReset();
    process.env['GEMINI_API_KEY'] = 'test-gemini-key';
    process.env['OPENAI_API_KEY'] = 'test-openai-key';
  });

  afterEach(() => {
    delete process.env['GEMINI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
  });

  it('returns items with urgencyScore and keywords from LLM', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () =>
          JSON.stringify({
            results: [
              { score: 9, keywords: ['military', 'conflict'], sentiment: 'YES' },
              { score: 3, keywords: ['trade'], sentiment: 'NEUTRAL' },
            ],
          }),
      },
    });

    const items = [makeItem('Major military conflict erupts'), makeItem('Trade talks continue')];

    const result = await scoreItems(items, meta);

    expect(result).toHaveLength(2);
    expect(result[0]!.urgencyScore).toBe(9);
    expect(result[0]!.keywords).toEqual(['military', 'conflict']);
    expect(result[0]!.sentiment).toBe('YES');
    expect(result[0]!.categoryId).toBe('test');
    expect(result[0]!.categoryLabel).toBe('Test Category');
    expect(result[0]!.entityContext).toBe('test entities');
    expect(result[1]!.urgencyScore).toBe(3);
    expect(result[1]!.keywords).toEqual(['trade']);
    expect(result[1]!.sentiment).toBe('NEUTRAL');
  });

  it('returns empty array for empty input', async () => {
    const result = await scoreItems([], meta);
    expect(result).toEqual([]);
    expect(mockGenerateContent).not.toHaveBeenCalled();
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('assigns default score 1 when LLM call fails', async () => {
    mockGenerateContent.mockRejectedValue(new Error('API error'));
    delete process.env['OPENAI_API_KEY'];

    const items = [makeItem('Some headline')];
    const result = await scoreItems(items, meta);

    expect(result).toHaveLength(1);
    expect(result[0]!.urgencyScore).toBe(1);
    expect(result[0]!.keywords).toEqual([]);
    expect(result[0]!.sentiment).toBe('NEUTRAL');
  });

  it('falls back to OpenAI when Gemini fails', async () => {
    // Gemini rejects (e.g. quota exceeded or network error)
    mockGenerateContent.mockRejectedValue(new Error('Gemini quota exceeded'));

    // OpenAI succeeds
    mockChatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              results: [{ score: 8, keywords: ['sanctions', 'russia'] }],
            }),
          },
        },
      ],
    });

    const items = [makeItem('New sanctions imposed on Russia')];
    const result = await scoreItems(items, meta);

    expect(result).toHaveLength(1);
    expect(result[0]!.urgencyScore).toBe(8);
    expect(result[0]!.keywords).toEqual(['sanctions', 'russia']);

    // Gemini was attempted first
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    // OpenAI was used as fallback
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
  });

  it('uses the provided system prompt', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () =>
          JSON.stringify({
            results: [{ score: 5, keywords: ['test'] }],
          }),
      },
    });

    const items = [makeItem('Test headline')];
    await scoreItems(items, meta);

    const call = mockGenerateContent.mock.calls[0]?.[0];
    expect(call?.systemInstruction?.parts?.[0]?.text).toBe(meta.systemPrompt);
  });
});
