import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockFetch = vi.fn() as any;

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({
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
      json: async () => [
        {
          market_id: 'm1',
          question: 'Will X happen?',
          shares_yes: 10,
          shares_no: 0,
          current_price: 0.4,
        },
      ],
    });

    const { getSimmerPositions } = await import('../simmer.js');
    const positions = await getSimmerPositions({ status: 'active', venue: 'polymarket' });

    expect(positions).toHaveLength(1);
    expect(positions[0]).toEqual(
      expect.objectContaining({
        market_id: 'm1',
        side: 'yes',
        redeemable: false,
        shares: 10,
        value_usdc: 4,
      }),
    );
  });

  it('does not override shares when both yes/no are present and side is known', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          market_id: 'm2',
          side: 'yes',
          shares_yes: 5,
          shares_no: 12,
          current_price: 0.25,
          redeemable: true,
        },
      ],
    });

    const { getSimmerPositions } = await import('../simmer.js');
    const positions = await getSimmerPositions({ status: 'active', venue: 'polymarket' });

    expect(positions).toHaveLength(1);
    expect(positions[0]).toEqual(
      expect.objectContaining({
        market_id: 'm2',
        side: 'yes',
        shares: 5,
        value_usdc: 1.25,
      }),
    );
  });
});

describe('setAgentAutoRedeem', () => {
  it('sends PATCH request with auto_redeem_enabled=true', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });

    const { setAgentAutoRedeem } = await import('../simmer.js');
    await setAgentAutoRedeem(true);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.simmer.markets/api/sdk/agents/me/settings',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer test',
        }),
        body: JSON.stringify({ auto_redeem_enabled: true }),
      }),
    );
  });

  it('sends PATCH request with auto_redeem_enabled=false', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });

    const { setAgentAutoRedeem } = await import('../simmer.js');
    await setAgentAutoRedeem(false);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.simmer.markets/api/sdk/agents/me/settings',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ auto_redeem_enabled: false }),
      }),
    );
  });

  it('throws SimmerError on HTTP 4xx/5xx', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Forbidden' }),
    });

    const { setAgentAutoRedeem } = await import('../simmer.js');
    await expect(setAgentAutoRedeem(true)).rejects.toThrow(
      'Simmer agent settings API returned HTTP 403',
    );
  });
});
