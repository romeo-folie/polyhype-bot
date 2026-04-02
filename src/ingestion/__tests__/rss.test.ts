import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRssFeeds } from '../rss.js';

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
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue('<xml/>'),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    process.env.RSS_USER_AGENT = originalUserAgent;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).fetch;
  });

  it('uses default headers and allows overrides', async () => {
    process.env.RSS_USER_AGENT = '  ';
    await fetchRssFeeds([
      {
        url: 'https://example.com/rss',
        headers: {
          'user-agent': 'custom-agent',
          'x-test': '1',
        },
      },
    ]);

    const [, requestInit] = fetchMock.mock.calls[0];
    const headers = (requestInit as RequestInit).headers as Record<string, string>;

    expect(headers['user-agent']).toBe('custom-agent');
    expect(headers['x-test']).toBe('1');
    expect(headers.accept).toContain('application/rss+xml');
  });

  it('uses trimmed RSS_USER_AGENT when provided', async () => {
    process.env.RSS_USER_AGENT = '  PGA-Test-Agent  ';
    await fetchRssFeeds([{ url: 'https://example.com/rss' }]);

    const [, requestInit] = fetchMock.mock.calls[0];
    const headers = (requestInit as RequestInit).headers as Record<string, string>;

    expect(headers['user-agent']).toBe('PGA-Test-Agent');
  });
});
