import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { RssItem } from '../rss.js';

const mockSet = jest.fn<(...args: unknown[]) => Promise<string | null>>();

const { filterSeen } = await import('../dedup.js');

function makeItem(overrides: Partial<RssItem> = {}): RssItem {
  return {
    title: 'Test headline',
    url: 'https://example.com/article',
    publishedAt: new Date('2026-01-01'),
    source: 'Test Source',
    ...overrides,
  };
}

describe('filterSeen', () => {
  const fakeRedis = { set: mockSet } as never;

  beforeEach(() => {
    mockSet.mockReset();
  });

  it('returns only items not previously seen in Redis', async () => {
    // First item is new (SET NX returns 'OK'), second is a duplicate (returns null)
    mockSet.mockResolvedValueOnce('OK');
    mockSet.mockResolvedValueOnce(null);

    const items = [
      makeItem({ url: 'https://example.com/new-article' }),
      makeItem({ url: 'https://example.com/old-article' }),
    ];

    const result = await filterSeen(items, fakeRedis);

    expect(result).toHaveLength(1);
    expect(result[0]!.url).toBe('https://example.com/new-article');
  });

  it('marks new items as seen with SET NX and 24h TTL', async () => {
    mockSet.mockResolvedValue('OK');

    const items = [makeItem({ url: 'https://example.com/article-1' })];
    await filterSeen(items, fakeRedis);

    expect(mockSet).toHaveBeenCalledTimes(1);
    const call = mockSet.mock.calls[0]!;
    expect(call[0]).toMatch(/^dedup:/);
    expect(call[1]).toBe('1');
    expect(call[2]).toBe('EX');
    expect(call[3]).toBe(86_400);
    expect(call[4]).toBe('NX');
  });

  it('returns empty array when given empty input', async () => {
    const result = await filterSeen([], fakeRedis);
    expect(result).toEqual([]);
    expect(mockSet).not.toHaveBeenCalled();
  });
});
