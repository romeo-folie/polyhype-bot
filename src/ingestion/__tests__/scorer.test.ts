import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { RssItem } from '../rss.js';

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
  beforeEach(() => {
    mockGenerateContent.mockReset();
    process.env['GEMINI_API_KEY'] = 'test-key';
  });

  it('returns items with urgencyScore and keywords from LLM', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () =>
          JSON.stringify([
            { score: 9, keywords: ['military', 'conflict'] },
            { score: 3, keywords: ['trade'] },
          ]),
      },
    });

    const items = [makeItem('Major military conflict erupts'), makeItem('Trade talks continue')];

    const result = await scoreItems(items);

    expect(result).toHaveLength(2);
    expect(result[0]!.urgencyScore).toBe(9);
    expect(result[0]!.keywords).toEqual(['military', 'conflict']);
    expect(result[1]!.urgencyScore).toBe(3);
    expect(result[1]!.keywords).toEqual(['trade']);
  });

  it('returns empty array for empty input', async () => {
    const result = await scoreItems([]);
    expect(result).toEqual([]);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('assigns default score 1 when LLM call fails', async () => {
    mockGenerateContent.mockRejectedValue(new Error('API error'));
    // Remove OpenAI key so no fallback
    delete process.env['OPENAI_API_KEY'];

    const items = [makeItem('Some headline')];
    const result = await scoreItems(items);

    expect(result).toHaveLength(1);
    expect(result[0]!.urgencyScore).toBe(1);
    expect(result[0]!.keywords).toEqual([]);
  });
});
