import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';

// Mock Config
vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    FUTURES_ENABLED: true,
    FUTURES_GLOBAL_MAX_MARGIN_USD: 50,
    CALIBRATION_ENABLED: false,
    CALIBRATION_MIN_SAMPLES: 20,
    MIN_BET_USD: 5,
    FUTURES_MAX_PER_TRADE_USD: 10,
    FUTURES_DEFAULT_LEVERAGE: 5,
  }),
}));

// Mock Logger
vi.mock('../../shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock Position Ledger
vi.mock('../positionLedger.js', () => ({
  hasOpenPosition: vi.fn().mockResolvedValue(false),
  recordPosition: vi.fn(),
}));

// Mock Simmer
vi.mock('../../shared/simmer.js', () => ({
  submitTrade: vi.fn().mockResolvedValue({ success: true, tx_hash: '0xabc' }),
  resolveSimmerMarketId: vi.fn().mockResolvedValue('simmer-abc'),
  getMarketContext: vi.fn().mockResolvedValue({ market: { status: 'open' }, position: { has_position: false }, discipline: { warning_level: 'none' } }),
}));

// Mock Hyperliquid Client
const mockPlaceMarketOrder = vi.fn();
vi.mock('../../shared/hyperliquid.js', () => ({
  getHyperliquid: vi.fn().mockReturnValue({
    getOpenPositions: vi.fn().mockResolvedValue([]),
    placeMarketOrder: mockPlaceMarketOrder,
  }),
  // resolveHlSymbol replaces the old HL_SYMBOL_MAP inline loop
  resolveHlSymbol: vi.fn().mockImplementation((text: string) => {
    const lower = text.toLowerCase();
    if (lower.includes('bitcoin')) return 'BTC';
    if (lower.includes('ethereum')) return 'ETH';
    return undefined;
  }),
}));

const { executeSignal } = await import('../executor.js');

describe('Delta Hedging Integration', () => {
  const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    exists: vi.fn(),
  } as unknown as Redis;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('triggers a 1:1 delta hedge on HL after a successful PM buy', async () => {
    const signal = {
      marketId: 'pm-123',
      question: 'Will Bitcoin reach $100k?',
      direction: 'YES' as const,
      stakeUsd: 10,
      outcomePrice: 0.5,
      edgeMagnitude: 0.2,
      sourcedFrom: 'OSINT',
      isFutures: false,
    };

    mockPlaceMarketOrder.mockResolvedValue({ success: true, txHash: '0x-hedge-tx' });

    const result = await executeSignal(signal as any, mockRedis);

    expect(result.skipped).toBe(false);
    expect(result.executionVenue).toBe('simmer');

    // Verify HL hedge was triggered (awaited synchronously — no timeout needed)
    expect(mockPlaceMarketOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BTC',
      isBuy: false, // SHORT
      sizeUsd: 10,  // 1:1 stake
      leverage: 1, 
    }));

    // Verify Redis link was set
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('hedge:link:pm-123'),
      'BTC',
      'EX',
      expect.any(Number)
    );
  });

  it('does NOT trigger hedge for non-correlated markets', async () => {
    const signal = {
      marketId: 'pm-politics',
      question: 'Will the US election happen in 2024?',
      direction: 'YES' as const,
      stakeUsd: 10,
      outcomePrice: 0.5,
      edgeMagnitude: 0.2,
      sourcedFrom: 'Election Poll',
      isFutures: false,
    };

    await executeSignal(signal as any, mockRedis);

    expect(mockPlaceMarketOrder).not.toHaveBeenCalled();
  });
});
