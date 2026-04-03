import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGet = vi.fn<(...args: any[]) => any>();

vi.mock('axios', () => ({
  default: { get: mockGet },
  get: mockGet,
}));

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { scrapeHeadlines } = await import('../scraper.js');

const ARTICLE_1 = {
  url: 'https://example.com/article-1',
  title: 'Iran launches ballistic missiles at Israeli targets',
  seendate: '20260319T080000Z',
  language: 'English',
};

const ARTICLE_2 = {
  url: 'https://example.com/article-2',
  title: 'Conflict escalates in Gaza Strip',
  seendate: '20260319T075000Z',
  language: 'English',
};

const MOCK_RESPONSE = {
  data: {
    articles: [
      ARTICLE_1,
      ARTICLE_2,
      { ...ARTICLE_1 }, // duplicate — same URL, should be deduped
      {
        url: 'https://example.com/french',
        title: 'Conflit en Méditerranée',
        seendate: '20260319T074000Z',
        language: 'French', // non-English — filtered out
      },
      {
        url: '',
        title: 'Empty URL article',
        language: 'English',
      },
      {
        url: 'https://example.com/no-title',
        title: '',
        language: 'English',
      },
    ],
  },
};

describe('scrapeHeadlines (GDELT)', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns deduplicated English articles from combined GDELT query', async () => {
    mockGet.mockResolvedValue(MOCK_RESPONSE);

    const items = await scrapeHeadlines();

    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe('Iran launches ballistic missiles at Israeli targets');
    expect(items[1]?.title).toBe('Conflict escalates in Gaza Strip');
    expect(mockGet).toHaveBeenCalledTimes(1);

    const url = String(mockGet.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('theme%3ACRISISLEX_CRISISLEXREC');
    expect(url).toContain('theme%3AWB_2243_CONFLICT_AND_VIOLENCE');
    expect(url).toContain('theme%3ATERROR');
    expect(url).toContain('theme%3APROTEST');
  });

  it('parses GDELT date format correctly', async () => {
    mockGet.mockResolvedValue({
      data: {
        articles: [
          {
            url: 'https://example.com/dated',
            title: 'Breaking event',
            seendate: '20260319T083045Z',
            language: 'English',
          },
        ],
      },
    });

    const items = await scrapeHeadlines();
    expect(items).toHaveLength(1);
    expect(items[0]?.publishedAt).toEqual(new Date('2026-03-19T08:30:45Z'));
    expect(items[0]?.source).toBe('GDELT Combined');
  });

  it('falls back to current time when seendate is absent', async () => {
    const before = new Date();
    mockGet.mockResolvedValue({
      data: {
        articles: [
          {
            url: 'https://example.com/nodated',
            title: 'No date article',
            language: 'English',
          },
        ],
      },
    });

    const items = await scrapeHeadlines();
    const after = new Date();
    expect(items).toHaveLength(1);
    expect(items[0]?.publishedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(items[0]?.publishedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('retries once on 429 and succeeds', async () => {
    const rateLimitError = { response: { status: 429 } };

    mockGet.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce({
      data: {
        articles: [
          {
            url: 'https://example.com/retry-ok',
            title: 'Retry success article',
            seendate: '20260319T080000Z',
            language: 'English',
          },
        ],
      },
    });

    const items = await scrapeHeadlines();
    expect(items).toHaveLength(1);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('returns empty array when combined query fails', async () => {
    mockGet.mockRejectedValue(new Error('network error'));

    const items = await scrapeHeadlines();
    expect(items).toHaveLength(0);
  });

  it('handles empty articles array from GDELT', async () => {
    mockGet.mockResolvedValue({ data: { articles: [] } });

    const items = await scrapeHeadlines();
    expect(items).toHaveLength(0);
  });

  it('handles missing articles field in GDELT response', async () => {
    mockGet.mockResolvedValue({ data: {} });

    const items = await scrapeHeadlines();
    expect(items).toHaveLength(0);
  });
});
