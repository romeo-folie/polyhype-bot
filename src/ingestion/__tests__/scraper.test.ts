import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGet = jest.fn<(...args: any[]) => any>();

jest.unstable_mockModule('axios', () => ({
  default: { get: mockGet },
  get: mockGet,
}));

jest.unstable_mockModule('../../shared/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
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
        url: '',           // no URL — skipped
        title: 'Empty URL article',
        language: 'English',
      },
      {
        url: 'https://example.com/no-title',
        title: '',         // no title — skipped
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
    jest.restoreAllMocks();
  });

  it('returns deduplicated English articles from multiple GDELT themes', async () => {
    mockGet.mockResolvedValue(MOCK_RESPONSE);

    const items = await scrapeHeadlines();

    // Only 2 unique English articles with non-empty url+title
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe('Iran launches ballistic missiles at Israeli targets');
    expect(items[1]?.title).toBe('Conflict escalates in Gaza Strip');
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
    expect(items[0]?.source).toMatch(/^GDELT/);
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

  it('continues when one GDELT theme fails, returns results from others', async () => {
    // First call fails, remaining 3 succeed with 1 article each (same URL → deduped to 1)
    mockGet
      .mockRejectedValueOnce(new Error('GDELT timeout'))
      .mockResolvedValue({
        data: {
          articles: [
            {
              url: 'https://example.com/theme-article',
              title: 'Conflict event',
              seendate: '20260319T080000Z',
              language: 'English',
            },
          ],
        },
      });

    const items = await scrapeHeadlines();
    expect(items).toHaveLength(1);
  });

  it('returns empty array when all GDELT themes fail', async () => {
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
