import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { Redis } from 'ioredis';

// Mock Config
jest.unstable_mockModule('../../shared/config.js', () => ({
  loadConfig: jest.fn().mockReturnValue({
    FUTURES_ENABLED: true,
    FUTURES_GLOBAL_MAX_MARGIN_USD: 50,
  }),
}));

// Mock Logger
jest.unstable_mockModule('../../shared/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

// Mock Position Ledger
jest.unstable_mockModule('../positionLedger.js', () => ({
  hasOpenPosition: jest.fn().mockResolvedValue(false),
  recordPosition: jest.fn(),
}));

// Mock Simmer
jest.unstable_mockModule('../../shared/simmer.js', () => ({
  submitTrade: jest.fn().mockResolvedValue({ success: true, tx_hash: '0xabc' }),
  resolveSimmerMarketId: jest.fn().mockResolvedValue('simmer-abc'),
  getMarketContext: jest.fn().mockResolvedValue({ market: { status: 'open' }, position: { has_position: false }, discipline: { warning_level: 'none' } }),
}));

// Mock Hyperliquid Client
const mockPlaceMarketOrder = jest.fn();
jest.unstable_mockModule('../../shared/hyperliquid.js', () => ({
  getHyperliquid: jest.fn().mockReturnValue({
    placeMarketOrder: mockPlaceMarketOrder,
  }),
  HL_SYMBOL_MAP: {
    bitcoin: 'BTC',
    ethereum: 'ETH',
  },
}));

const { executeSignal } = await import('../executor.js');

describe('Delta Hedging Integration', () => {
  const mockRedis = {
    get: jest.fn(),
    set: jest.fn(),
    exists: jest.fn(),
  } as unknown as Redis;

  beforeEach(() => {
    jest.clearAllMocks();
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

    // Give the async triggerDeltaHedge (voided) a moment to execute
    await new Promise(r => setTimeout(r, 100));

    // Verify HL hedge was triggered
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
    await new Promise(r => setTimeout(r, 100));

    expect(mockPlaceMarketOrder).not.toHaveBeenCalled();
  });
});
