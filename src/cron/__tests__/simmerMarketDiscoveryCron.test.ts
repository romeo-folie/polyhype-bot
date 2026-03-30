import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockDiscoverUnimportedMarkets = jest.fn();
const mockImportMarket = jest.fn();
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
};

jest.unstable_mockModule('../../shared/config.js', () => ({
  loadConfig: jest.fn(() => ({
    SIMMER_AUTO_IMPORT_ENABLED: true,
  })),
}));

jest.unstable_mockModule('../../shared/logger.js', () => ({
  logger: mockLogger,
}));

jest.unstable_mockModule('../../shared/simmerImport.js', () => ({
  discoverUnimportedMarkets: mockDiscoverUnimportedMarkets,
  importMarket: mockImportMarket,
}));

beforeEach(() => {
  mockDiscoverUnimportedMarkets.mockReset();
  mockImportMarket.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
});

describe('simmerMarketDiscoveryCron', () => {
  it('discovers markets and imports up to 20', async () => {
    const discovered = Array.from({ length: 25 }, (_, i) => ({
      polymarket_url: `https://polymarket.com/event/market-${i}`,
      question: `Market ${i}`,
    }));

    mockDiscoverUnimportedMarkets.mockResolvedValue(discovered);
    mockImportMarket.mockResolvedValue({ success: true, marketId: 'test-id' });

    // Dynamically import to use mocked modules
    await import('../../cron/simmerMarketDiscoveryCron.js');

    // Wait for async operations
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mockDiscoverUnimportedMarkets).toHaveBeenCalledWith({ limit: 50 });
    // Should only import first 20 (MAX_IMPORTS_PER_RUN)
    expect(mockImportMarket).toHaveBeenCalledTimes(20);
  });

  it('skips markets without polymarket_url', async () => {
    mockDiscoverUnimportedMarkets.mockResolvedValue([
      { polymarket_url: 'https://polymarket.com/event/market-1', question: 'Market 1' },
      { question: 'Market 2' }, // missing URL
      { polymarket_url: 'https://polymarket.com/event/market-3', question: 'Market 3' },
    ]);

    mockImportMarket.mockResolvedValue({ success: true, marketId: 'test-id' });

    await import('../../cron/simmerMarketDiscoveryCron.js');
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Should import only 2 markets (skip the one without URL)
    expect(mockImportMarket).toHaveBeenCalledTimes(2);
  });

  it('handles already-imported markets correctly', async () => {
    mockDiscoverUnimportedMarkets.mockResolvedValue([
      { polymarket_url: 'https://polymarket.com/event/market-1', question: 'Market 1' },
      { polymarket_url: 'https://polymarket.com/event/market-2', question: 'Market 2' },
    ]);

    mockImportMarket
      .mockResolvedValueOnce({ success: true, marketId: 'id-1' })
      .mockResolvedValueOnce({ success: true, alreadyImported: true });

    await import('../../cron/simmerMarketDiscoveryCron.js');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mockImportMarket).toHaveBeenCalledTimes(2);
  });

  it('handles import failures gracefully', async () => {
    mockDiscoverUnimportedMarkets.mockResolvedValue([
      { polymarket_url: 'https://polymarket.com/event/market-1', question: 'Market 1' },
      { polymarket_url: 'https://polymarket.com/event/market-2', question: 'Market 2' },
    ]);

    mockImportMarket
      .mockResolvedValueOnce({ success: false, error: 'API error' })
      .mockResolvedValueOnce({ success: true, marketId: 'id-2' });

    await import('../../cron/simmerMarketDiscoveryCron.js');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mockImportMarket).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('exits early when no markets discovered', async () => {
    mockDiscoverUnimportedMarkets.mockResolvedValue([]);

    await import('../../cron/simmerMarketDiscoveryCron.js');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mockImportMarket).not.toHaveBeenCalled();
  });
});
