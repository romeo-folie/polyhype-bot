import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { parseYesPrice, parseOutcomePrices, parseClobTokenIds } from '../gamma.js';

// ─── parseOutcomePrices unit tests ────────────────────────────────────────────

describe('parseOutcomePrices', () => {
  it('passes through a pre-parsed string array unchanged', () => {
    expect(parseOutcomePrices(['0.72', '0.28'])).toEqual(['0.72', '0.28']);
  });

  it('parses a JSON-encoded string (Gamma v2 wire format)', () => {
    expect(parseOutcomePrices('["0.72","0.28"]')).toEqual(['0.72', '0.28']);
  });

  it('throws for invalid JSON string', () => {
    expect(() => parseOutcomePrices('not-json')).toThrow('Cannot parse outcomePrices');
  });

  it('throws for JSON that is not an array', () => {
    expect(() => parseOutcomePrices('{"price":0.5}')).toThrow('Cannot parse outcomePrices');
  });
});

// ─── parseClobTokenIds unit tests ───────────────────────────────────────────

describe('parseClobTokenIds', () => {
  it('passes through pre-parsed token id array unchanged', () => {
    expect(parseClobTokenIds(['tok-yes', 'tok-no'])).toEqual(['tok-yes', 'tok-no']);
  });

  it('parses JSON-encoded token id array from Gamma wire format', () => {
    const raw = '["36135303630970774358991758965953725374791089628290212294816140371870983436829","100818499003359884559774352671825765184103958625070066814408985574716007147193"]';
    const parsed = parseClobTokenIds(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatch(/^\d+$/);
    expect(parsed[1]).toMatch(/^\d+$/);
  });

  it('throws for invalid JSON string', () => {
    expect(() => parseClobTokenIds('not-json')).toThrow('Cannot parse clobTokenIds');
  });

  it('throws for JSON that is not an array', () => {
    expect(() => parseClobTokenIds('{"token":"x"}')).toThrow('Cannot parse clobTokenIds');
  });
});

// ─── parseYesPrice unit tests (pure function, no mocks needed) ────────────────

describe('parseYesPrice', () => {
  it('parses a valid pre-parsed outcomePrices array', () => {
    expect(parseYesPrice(['0.72', '0.28'])).toBeCloseTo(0.72);
  });

  it('parses a JSON-encoded outcomePrices string (Gamma v2 wire format)', () => {
    expect(parseYesPrice('["0.72","0.28"]')).toBeCloseTo(0.72);
  });

  it('handles single-element array', () => {
    expect(parseYesPrice(['0.55'])).toBeCloseTo(0.55);
  });

  it('throws for empty array', () => {
    expect(() => parseYesPrice([])).toThrow('outcomePrices is empty');
  });

  it('throws for non-numeric value', () => {
    expect(() => parseYesPrice(['abc', '0.28'])).toThrow('Cannot parse YES price');
  });
});

// ─── searchEvents (network call) ─────────────────────────────────────────────

const mockFetch = vi.fn<typeof fetch>();

// Replace global fetch with mock
(global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;

afterEach(() => {
  mockFetch.mockReset();
});

const { searchEvents, getMarket } = await import('../gamma.js');

function makeGammaEvent(overrides: Partial<{
  id: string;
  title: string;
  active: boolean;
  closed: boolean;
}> = {}) {
  return {
    id: overrides.id ?? 'evt-1',
    title: overrides.title ?? 'Will conflict escalate?',
    slug: 'will-conflict-escalate',
    active: overrides.active ?? true,
    closed: overrides.closed ?? false,
    markets: [
      {
        id: 'mkt-1',
        question: 'Will conflict escalate?',
        conditionId: 'cond-1',
        clobTokenIds: ['tok-yes', 'tok-no'],
        outcomePrices: ['0.65', '0.35'],
        outcomes: ['Yes', 'No'],
        active: true,
        closed: false,
        volume: '5000',
        liquidity: '1200',
        endDate: '2026-06-01T00:00:00Z',
        description: 'Resolves YES if armed conflict escalates.',
      },
    ],
  };
}

describe('searchEvents', () => {
  it('returns parsed events on 200 response', async () => {
    const events = [makeGammaEvent()];
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => events,
    } as Response);

    const result = await searchEvents({ query: 'conflict' });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('evt-1');
    expect(result[0]!.markets).toHaveLength(1);
  });

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({}),
    } as Response);

    await expect(searchEvents({ query: 'test' })).rejects.toThrow('Gamma API error: 500');
  });

  it('returns empty array when API returns empty array', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);

    const result = await searchEvents({ query: 'nothing' });
    expect(result).toEqual([]);
  });

  it('sends activeOnly params when activeOnly=true', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);

    await searchEvents({ query: 'test', activeOnly: true });

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('active=true');
    expect(calledUrl).toContain('closed=false');
  });
});

describe('getMarket', () => {
  it('returns a single market on 200 response', async () => {
    const market = makeGammaEvent().markets[0]!;
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => market,
    } as Response);

    const result = await getMarket('mkt-1');
    expect(result.id).toBe('mkt-1');
  });

  it('throws on 404', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({}),
    } as Response);

    await expect(getMarket('bad-id')).rejects.toThrow('Gamma API error: 404');
  });
});

// ─── getActiveMarkets pagination tests ───────────────────────────────────────

const { getActiveMarkets } = await import('../gamma.js');

function makeMarket(id: string) {
  return {
    id,
    question: `Market ${id}`,
    conditionId: `cond-${id}`,
    clobTokenIds: ['tok-yes', 'tok-no'],
    outcomePrices: ['0.55', '0.45'],
    outcomes: ['Yes', 'No'],
    active: true,
    closed: false,
    volume: '1000',
    liquidity: '500',
    endDate: null,
    description: null,
  };
}

describe('getActiveMarkets', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns all markets from a single page when count < pageSize', async () => {
    const page = [makeMarket('1'), makeMarket('2'), makeMarket('3')];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => page,
    } as Response);

    const result = await getActiveMarkets(500, 500);
    expect(result).toHaveLength(3);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fetches multiple pages when first page is full', async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => makeMarket(`p1-${i}`));
    const page2 = Array.from({ length: 300 }, (_, i) => makeMarket(`p2-${i}`));

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => page1 } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => page2 } as Response);

    const result = await getActiveMarkets(1000, 500);
    expect(result).toHaveLength(800);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('stops at maxTotal even if more pages are available', async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => makeMarket(`p1-${i}`));
    const page2 = Array.from({ length: 500 }, (_, i) => makeMarket(`p2-${i}`));

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => page1 } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => page2 } as Response);

    const result = await getActiveMarkets(700, 500);
    // First page: 500, second page: capped at 200 (700 - 500)
    // But mock returns 500 for page2 — result should be capped at 700
    expect(result.length).toBeLessThanOrEqual(700);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('includes order=liquidityNum and ascending=false in query params', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeMarket('1')],
    } as Response);

    await getActiveMarkets(10, 10);
    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('order=liquidityNum');
    expect(calledUrl).toContain('ascending=false');
  });

  it('includes offset in subsequent page requests', async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => makeMarket(`p1-${i}`));
    const page2 = [makeMarket('last')];

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => page1 } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => page2 } as Response);

    await getActiveMarkets(1000, 500);

    const secondCallUrl = mockFetch.mock.calls[1]?.[0] as string;
    expect(secondCallUrl).toContain('offset=500');
  });

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response);

    await expect(getActiveMarkets()).rejects.toThrow('Gamma markets error: 503');
  });

  it('returns empty array when API returns empty array on first page', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as Response);

    const result = await getActiveMarkets();
    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
