import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRssFeeds } from '../rss.js';
import { loadConfig } from '../../shared/config.js';

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('rss-parser', () => ({
  default: class Parser {
    async parseString() {
      return {
        title: 'Mock Feed',
        items: [
          {
            title: 'Headline',
            link: 'https://example.com/item',
            isoDate: '2020-01-01T00:00:00Z',
          },
        ],
      };
    }
  },
}));

describe('fetchRssFeeds', () => {
  const originalUserAgent = process.env.RSS_USER_AGENT;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.mocked(loadConfig).mockReturnValue({
      RSS_FEED_URLS: 'https://rss.nytimes.com/World.xml',
      RSS_USER_AGENT: 'Mozilla/5.0 ...',
    } as any);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue('<xml/>'),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).fetch;
  });

  it('uses default headers and allows overrides', async () => {
    process.env.RSS_USER_AGENT = '  ';
    await fetchRssFeeds([
      {
        url: 'https://example.com/rss',
        headers: {
          'User-Agent': 'custom-agent',
          'x-test': '1',
        },
      },
    ]);

    const [, requestInit] = fetchMock.mock.calls[0];
    const headers = (requestInit as RequestInit).headers as Record<string, string>;

    expect(headers['User-Agent']).toBe('custom-agent');
    expect(headers['x-test']).toBe('1');
    expect(headers.Accept).toContain('application/rss+xml');
  });

  it('uses RSS_USER_AGENT from config when provided', async () => {
    vi.mocked(loadConfig).mockReturnValue({
      RSS_FEED_URLS: 'https://rss.nytimes.com/World.xml',
      RSS_USER_AGENT: 'PGA-Test-Agent',
    } as any);
    await fetchRssFeeds([{ url: 'https://example.com/rss' }]);

    const [, requestInit] = fetchMock.mock.calls[0];
    const headers = (requestInit as RequestInit).headers as Record<string, string>;

    expect(headers['User-Agent']).toBe('PGA-Test-Agent');
  });
});
