import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    HYPERLIQUID_PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
    HYPERLIQUID_TESTNET: true,
    HL_DRY_RUN: false,
    FUTURES_IOC_SLIPPAGE: 0.002,
    HL_MOMENTUM_POST_ONLY_WAIT_MS: 1000,
  }),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

const { default: axios } = await import('axios');
const { getHyperliquid, resetHyperliquid, HL_SYMBOL_MAP } = await import('../hyperliquid.js');

const mockedAxiosPost = vi.mocked(axios.post);

describe('HyperliquidClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHyperliquid();
  });

  it('correctly maps assets in HL_SYMBOL_MAP', () => {
    expect(HL_SYMBOL_MAP.bitcoin).toBe('BTC');
    expect(HL_SYMBOL_MAP.ethereum).toBe('ETH');
  });

  it('getOpenPositions structures data correctly', async () => {
    const client = getHyperliquid();
    const mockState = {
      assetPositions: [
        {
          position: {
            coin: 'BTC',
            szi: '0.1',
            entryPx: '50000',
            leverage: { type: 'cross', value: 5 },
            unrealizedPnl: '100',
            marginUsed: '1000',
          },
        },
      ],
    };

    mockedAxiosPost.mockResolvedValueOnce({ data: mockState });

    const positions = await client.getOpenPositions();

    expect(positions).toHaveLength(1);
    expect(positions[0]!.symbol).toBe('BTC');
    expect(positions[0]!.position.szi).toBe('0.1');
  });

  it('placeMarketOrder calculates sizeUsd correctly', async () => {
    const client = getHyperliquid();

    // 1. getMeta
    mockedAxiosPost.mockResolvedValueOnce({
      data: { universe: [{ name: 'BTC', szDecimals: 3, index: 0 }] },
    });
    // 2. updateLeverage
    mockedAxiosPost.mockResolvedValueOnce({ data: { status: 'ok' } });
    // 3. getAllMids (for getMidPrice)
    mockedAxiosPost.mockResolvedValueOnce({ data: { BTC: '50000' } });
    // 4. execution
    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ filled: { oid: 12345 } }] } },
      },
    });

    const result = await client.placeMarketOrder({
      symbol: 'BTC',
      isBuy: true,
      sizeUsd: 100,
      leverage: 5,
    });

    expect(result.success).toBe(true);
    expect(mockedAxiosPost).toHaveBeenCalledTimes(4);
  });

  it('placeMarketOrder returns error when midPrice is zero', async () => {
    const client = getHyperliquid();

    // getMeta
    mockedAxiosPost.mockResolvedValueOnce({
      data: { universe: [{ name: 'BTC', szDecimals: 3, index: 0 }] },
    });
    // updateLeverage
    mockedAxiosPost.mockResolvedValueOnce({ data: { status: 'ok' } });
    // getMidPrice returns 0
    mockedAxiosPost.mockResolvedValueOnce({ data: { BTC: '0' } });

    const result = await client.placeMarketOrder({
      symbol: 'BTC',
      isBuy: true,
      sizeUsd: 100,
      leverage: 5,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid value/);
  });

  it('placeMarketOrder retries once on nonce-too-low rejection and succeeds', async () => {
    const client = getHyperliquid();

    // First attempt: meta + leverage + mids + nonce rejection (4 calls)
    mockedAxiosPost.mockResolvedValueOnce({ data: { universe: [{ name: 'BTC', szDecimals: 3, index: 0 }] } });
    mockedAxiosPost.mockResolvedValueOnce({ data: { status: 'ok' } }); // updateLeverage
    mockedAxiosPost.mockResolvedValueOnce({ data: { BTC: '50000' } }); // getMidPrice
    mockedAxiosPost.mockResolvedValueOnce({
      data: { status: 'err', response: 'Invalid nonce: nonce too low 1000 < 9999' },
    });

    // Retry: meta + mids are cached; only updateLeverage + exchange are re-called (2 calls)
    mockedAxiosPost.mockResolvedValueOnce({ data: { status: 'ok' } }); // updateLeverage (retry)
    mockedAxiosPost.mockResolvedValueOnce({
      data: { status: 'ok', response: { data: { statuses: [{ filled: { oid: 99999 } }] } } },
    });

    const result = await client.placeMarketOrder({
      symbol: 'BTC',
      isBuy: true,
      sizeUsd: 100,
      leverage: 5,
    });

    expect(result.success).toBe(true);
    expect(result.txHash).toBe('99999');
    expect(mockedAxiosPost).toHaveBeenCalledTimes(6);
  });

  it('placePatientLimitOrder submits a post-only order and returns a filled result', async () => {
    const client = getHyperliquid();

    mockedAxiosPost.mockResolvedValueOnce({
      data: { universe: [{ name: 'BTC', szDecimals: 3, index: 0 }] },
    });
    mockedAxiosPost.mockResolvedValueOnce({ data: { status: 'ok' } }); // updateLeverage
    mockedAxiosPost.mockResolvedValueOnce({
      data: { coin: 'BTC', levels: [[{ px: '50000', sz: '1' }], [{ px: '50010', sz: '1' }]] },
    }); // getL2Book
    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ filled: { oid: 777, avgPx: '50000' } }] } },
      },
    });

    const result = await client.placePatientLimitOrder({
      symbol: 'BTC',
      isBuy: true,
      sizeUsd: 100,
      leverage: 5,
    });

    expect(result.success).toBe(true);
    expect(result.txHash).toBe('777');
    expect(result.price).toBe(50000);
    expect(mockedAxiosPost).toHaveBeenCalledTimes(4);
    const exchangeCall = mockedAxiosPost.mock.calls[3];
    expect(exchangeCall?.[1]).toMatchObject({
      action: {
        orders: [
          {
            t: { limit: { tif: 'Alo' } },
          },
        ],
      },
    });
  });

  it('placeMarketOrder does not retry a second time on repeated nonce error', async () => {
    const client = getHyperliquid();

    const nonceError = { data: { status: 'err', response: 'Invalid nonce: nonce too low 1000 < 9999' } };

    // First attempt: meta + leverage + mids + nonce rejection (4 calls)
    mockedAxiosPost.mockResolvedValueOnce({ data: { universe: [{ name: 'BTC', szDecimals: 3, index: 0 }] } });
    mockedAxiosPost.mockResolvedValueOnce({ data: { status: 'ok' } }); // updateLeverage
    mockedAxiosPost.mockResolvedValueOnce({ data: { BTC: '50000' } }); // getMidPrice
    mockedAxiosPost.mockResolvedValueOnce(nonceError);

    // Retry: meta + mids cached; updateLeverage + exchange (2 calls) — nonce error again, no third attempt
    mockedAxiosPost.mockResolvedValueOnce({ data: { status: 'ok' } }); // updateLeverage (retry)
    mockedAxiosPost.mockResolvedValueOnce(nonceError);

    const result = await client.placeMarketOrder({
      symbol: 'BTC',
      isBuy: true,
      sizeUsd: 100,
      leverage: 5,
    });

    expect(result.success).toBe(false);
    expect(mockedAxiosPost).toHaveBeenCalledTimes(6); // exactly 2 attempts, no third
  });
});
