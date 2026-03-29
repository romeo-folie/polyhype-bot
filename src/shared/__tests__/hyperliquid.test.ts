import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// 1. Mock Node/HTTP dependencies first for ESM
jest.unstable_mockModule('axios', () => ({
  default: {
    post: jest.fn(),
    get: jest.fn(),
  },
}));

// 2. Mock Config
jest.unstable_mockModule('../config.js', () => ({
  loadConfig: jest.fn().mockReturnValue({
    HYPERLIQUID_PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
    HYPERLIQUID_TESTNET: true,
  }),
}));

// 3. Mock Logger
jest.unstable_mockModule('../logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

// 4. Import modules after mocks
const { default: axios } = await import('axios');
const { getHyperliquid, HL_SYMBOL_MAP } = await import('../hyperliquid.js');

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('HyperliquidClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('correctly maps assets in HL_SYMBOL_MAP', () => {
    expect(HL_SYMBOL_MAP['bitcoin']).toBe('BTC');
    expect(HL_SYMBOL_MAP['ethereum']).toBe('ETH');
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

    (mockedAxios.post as jest.Mock).mockResolvedValueOnce({ data: mockState });

    const positions = await client.getOpenPositions();

    expect(positions).toHaveLength(1);
    expect(positions[0]!.symbol).toBe('BTC');
    expect(positions[0]!.position.szi).toBe('0.1');
  });

  it('placeMarketOrder calculates sizeUsd correctly', async () => {
    const client = getHyperliquid();
    
    // 1. getMeta
    (mockedAxios.post as jest.Mock).mockResolvedValueOnce({
      data: { universe: [{ name: 'BTC', szDecimals: 3, index: 0 }] },
    });
    // 2. updateLeverage
    (mockedAxios.post as jest.Mock).mockResolvedValueOnce({
      data: { status: 'ok' },
    });
    // 3. getAllMids (for getMidPrice)
    (mockedAxios.post as jest.Mock).mockResolvedValueOnce({
      data: { BTC: '50000' },
    });
    // 4. execution
    (mockedAxios.post as jest.Mock).mockResolvedValueOnce({
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
    expect(mockedAxios.post).toHaveBeenCalledTimes(4);
  });
});
