import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockDiscoverUnimportedMarkets = vi.fn();
const mockImportMarket = vi.fn();
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    SIMMER_AUTO_IMPORT_ENABLED: true,
  })),
}));

vi.mock('../../shared/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('../../shared/simmerImport.js', () => ({
  discoverUnimportedMarkets: mockDiscoverUnimportedMarkets,
  importMarket: mockImportMarket,
}));

beforeEach(() => {
  // Reset module registry so each test gets a fresh cron module execution.
  // Without this, the first import() is cached and subsequent tests reuse
  // the same module instance (and the same mock call counts).
  vi.resetModules();
  vi.clearAllMocks();
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

    await import('../../cron/simmerMarketDiscoveryCron.js');
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
