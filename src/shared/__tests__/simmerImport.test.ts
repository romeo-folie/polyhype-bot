import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockFetch = vi.fn();

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({
    SIMMER_API_KEY: 'test-key',
  })),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

beforeEach(() => {
  mockFetch.mockReset();
  // @ts-expect-error override global fetch for tests
  global.fetch = mockFetch;
});

describe('importMarket', () => {
  it('returns success when market imported successfully', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        market_id: 'simmer-uuid-123',
      }),
    });

    const { importMarket } = await import('../simmerImport.js');
    const result = await importMarket('https://polymarket.com/event/test-market');

    expect(result.success).toBe(true);
    expect(result.marketId).toBe('simmer-uuid-123');
    expect(result.alreadyImported).toBeUndefined();
  });

  it('handles 409 already-imported as success', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        error: 'Market already imported',
      }),
    });

    const { importMarket } = await import('../simmerImport.js');
    const result = await importMarket('https://polymarket.com/event/existing-market');

    expect(result.success).toBe(true);
    expect(result.alreadyImported).toBe(true);
  });

  it('handles 402 payment required as error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({
        success: false,
        error: 'Payment required',
      }),
    });

    const { importMarket } = await import('../simmerImport.js');
    const result = await importMarket('https://polymarket.com/event/test-market');

    expect(result.success).toBe(false);
    expect(result.error).toBe('x402_payment_required');
  });

  it('handles network failure gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const { importMarket } = await import('../simmerImport.js');
    const result = await importMarket('https://polymarket.com/event/test-market');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network error');
  });

  it('handles non-200 HTTP responses', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        error: 'Internal server error',
      }),
    });

    const { importMarket } = await import('../simmerImport.js');
    const result = await importMarket('https://polymarket.com/event/test-market');

    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 500');
  });
});

describe('discoverUnimportedMarkets', () => {
  it('returns discovered markets array', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        markets: [
          {
            polymarket_url: 'https://polymarket.com/event/market-1',
            question: 'Will X happen?',
            volume_usd: 10000,
            liquidity_usd: 5000,
          },
          {
            polymarket_url: 'https://polymarket.com/event/market-2',
            question: 'Will Y happen?',
            volume_usd: 8000,
            liquidity_usd: 3000,
          },
        ],
      }),
    });

    const { discoverUnimportedMarkets } = await import('../simmerImport.js');
    const markets = await discoverUnimportedMarkets({ limit: 10 });

    expect(markets).toHaveLength(2);
    expect(markets[0]?.polymarket_url).toBe('https://polymarket.com/event/market-1');
    expect(markets[1]?.question).toBe('Will Y happen?');
  });

  it('handles bare array response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          polymarket_url: 'https://polymarket.com/event/market-1',
          question: 'Will X happen?',
        },
      ],
    });

    const { discoverUnimportedMarkets } = await import('../simmerImport.js');
    const markets = await discoverUnimportedMarkets();

    expect(markets).toHaveLength(1);
  });

  it('returns empty array on HTTP error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Server error' }),
    });

    const { discoverUnimportedMarkets } = await import('../simmerImport.js');
    const markets = await discoverUnimportedMarkets();

    expect(markets).toEqual([]);
  });

  it('returns empty array on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const { discoverUnimportedMarkets } = await import('../simmerImport.js');
    const markets = await discoverUnimportedMarkets();

    expect(markets).toEqual([]);
  });
});
