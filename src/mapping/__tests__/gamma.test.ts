import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { parseYesPrice, parseOutcomePrices } from '../gamma.js';

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

const mockFetch = jest.fn<typeof fetch>();

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
