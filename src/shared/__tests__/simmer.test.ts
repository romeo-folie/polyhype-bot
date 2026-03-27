import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockFetch = jest.fn() as any;

jest.unstable_mockModule('../config.js', () => ({
  loadConfig: jest.fn(() => ({
    SIMMER_API_KEY: 'test',
  })),
}));

beforeEach(() => {
  mockFetch.mockReset();
  // @ts-expect-error override global fetch for tests
  global.fetch = mockFetch;
});

describe('getSimmerPositions', () => {
  it('infers side when missing and defaults redeemable=false', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ([
        {
          market_id: 'm1',
          question: 'Will X happen?',
          shares_yes: 10,
          shares_no: 0,
          current_price: 0.4,
        },
      ]),
    });

    const { getSimmerPositions } = await import('../simmer.js');
    const positions = await getSimmerPositions({ status: 'active', venue: 'polymarket' });

    expect(positions).toHaveLength(1);
    expect(positions[0]).toEqual(expect.objectContaining({
      market_id: 'm1',
      side: 'yes',
      redeemable: false,
      shares: 10,
      value_usdc: 4,
    }));
  });
});
