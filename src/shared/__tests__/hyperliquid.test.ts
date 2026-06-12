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

describe('HyperliquidClient — maker order methods (post-only entries)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHyperliquid();
  });

  it('getBestBidAsk parses the l2 book touch', async () => {
    const client = getHyperliquid();
    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        levels: [
          [{ px: '49990', sz: '1', n: 2 }, { px: '49980', sz: '3', n: 1 }],
          [{ px: '50010', sz: '2', n: 1 }, { px: '50020', sz: '1', n: 1 }],
        ],
      },
    });
    const book = await client.getBestBidAsk('BTC');
    expect(book).toEqual({ bestBid: 49990, bestAsk: 50010 });
  });

  it('getBestBidAsk returns null on an empty side', async () => {
    const client = getHyperliquid();
    mockedAxiosPost.mockResolvedValueOnce({ data: { levels: [[], [{ px: '50010' }]] } });
    expect(await client.getBestBidAsk('BTC')).toBeNull();
  });

  it('placeRestingOrder posts an ALO order at the limit price', async () => {
    const client = getHyperliquid();
    // 1. getMeta
    mockedAxiosPost.mockResolvedValueOnce({
      data: { universe: [{ name: 'BTC', szDecimals: 3, index: 0 }] },
    });
    // 2. updateLeverage
    mockedAxiosPost.mockResolvedValueOnce({ data: { status: 'ok' } });
    // 3. exchange → resting
    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ resting: { oid: 777 } }] } },
      },
    });

    const result = await client.placeRestingOrder({
      symbol: 'BTC',
      isBuy: true,
      sizeUsd: 100,
      leverage: 5,
      limitPrice: 49990,
    });

    expect(result.success).toBe(true);
    expect(result.oid).toBe(777);
    expect(result.price).toBe(49990);

    // The exchange call (3rd) must carry tif Alo at the requested price.
    const exchangeCall = mockedAxiosPost.mock.calls[2]!;
    const payload = exchangeCall[1] as {
      action: { orders: { p: string; t: { limit: { tif: string } } }[] };
    };
    expect(payload.action.orders[0]!.t.limit.tif).toBe('Alo');
    expect(payload.action.orders[0]!.p).toBe('49990');
  });

  it('placeRestingOrder surfaces the ALO would-cross rejection as an error string', async () => {
    const client = getHyperliquid();
    mockedAxiosPost.mockResolvedValueOnce({
      data: { universe: [{ name: 'BTC', szDecimals: 3, index: 0 }] },
    });
    mockedAxiosPost.mockResolvedValueOnce({ data: { status: 'ok' } });
    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        status: 'ok',
        response: {
          type: 'order',
          data: { statuses: [{ error: 'Post only order would have immediately matched, bbo was 49990' }] },
        },
      },
    });

    const result = await client.placeRestingOrder({
      symbol: 'BTC', isBuy: true, sizeUsd: 100, leverage: 5, limitPrice: 50_011,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/immediately matched/);
  });

  it('getOrderStatus maps fill state and computes filledSz', async () => {
    const client = getHyperliquid();
    mockedAxiosPost.mockResolvedValueOnce({
      data: { status: 'order', order: { status: 'open', order: { origSz: '10', sz: '4' } } },
    });
    const status = await client.getOrderStatus(777);
    expect(status.status).toBe('open');
    expect(status.origSz).toBe(10);
    expect(status.remainingSz).toBe(4);
    expect(status.filledSz).toBe(6);
  });

  it('getOrderStatus returns unknown for unknownOid', async () => {
    const client = getHyperliquid();
    mockedAxiosPost.mockResolvedValueOnce({ data: { status: 'unknownOid' } });
    const status = await client.getOrderStatus(123);
    expect(status.status).toBe('unknown');
  });

  it('cancelOrder succeeds on a clean cancel', async () => {
    const client = getHyperliquid();
    mockedAxiosPost.mockResolvedValueOnce({
      data: { universe: [{ name: 'BTC', szDecimals: 3, index: 0 }] },
    });
    mockedAxiosPost.mockResolvedValueOnce({
      data: { status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } },
    });
    const result = await client.cancelOrder('BTC', 777);
    expect(result.success).toBe(true);
  });

  it('cancelOrder reports failure when the order is already gone', async () => {
    const client = getHyperliquid();
    mockedAxiosPost.mockResolvedValueOnce({
      data: { universe: [{ name: 'BTC', szDecimals: 3, index: 0 }] },
    });
    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        status: 'ok',
        response: { type: 'cancel', data: { statuses: [{ error: 'Order was never placed, already canceled, or filled.' }] } },
      },
    });
    const result = await client.cancelOrder('BTC', 777);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already canceled/);
  });
});
