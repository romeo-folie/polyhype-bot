import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
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
    SIZE_UP_ELIGIBLE_SOURCES: 'weather',
    EXECUTION_MODE: 'taker',
    TAKER_MIN_EDGE: 0,
    TAIL_TAKER_BLOCK: false,
    TAIL_PRICE_THRESHOLD: 0.2,
    TAIL_TAKER_OVERRIDE_EDGE: 0.2,
    TAKER_MIN_EDGE_CATEGORIES: {},
    CLOB_FALLBACK_ENABLED: false,
    SIMMER_VENUE_ENABLED: true,
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
  getMarketContext: vi
    .fn()
    .mockResolvedValue({
      market: { status: 'open' },
      position: { has_position: false },
      discipline: { warning_level: 'none' },
    }),
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
const { hasOpenPosition } = await import('../positionLedger.js');

describe('Delta Hedging Integration', () => {
  const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    exists: vi.fn(),
  } as unknown as Redis;

  beforeEach(async () => {
    vi.clearAllMocks();
    // clearAllMocks resets call records but not implementations. Explicitly restore the
    // defaults that guard tests override so they don't bleed into later tests.
    (hasOpenPosition as Mock).mockResolvedValue(false);
    const { getHyperliquid } = await import('../../shared/hyperliquid.js');
    (getHyperliquid as Mock)().getOpenPositions.mockResolvedValue([]);
  });

  it('triggers a 1:1 delta hedge on HL after a successful PM buy', async () => {
    const signal = {
      marketId: 'pm-123',
      question: 'Will Bitcoin reach $100k?',
      direction: 'YES' as const,
      stakeUsd: 10,
      outcomePrice: 0.5,
      edgeMagnitude: 0.2,
      sourcedFrom: 'oracle-lag:btc:1.5pct:300s',
      isFutures: false,
    };

    mockPlaceMarketOrder.mockResolvedValue({ success: true, txHash: '0x-hedge-tx' });

    const result = await executeSignal(signal as any, mockRedis);

    expect(result.skipped).toBe(false);
    expect(result.executionVenue).toBe('simmer');

    // The delta hedge is fire-and-forget (void triggerDeltaHedge), so give it a tick to resolve
    await new Promise((r) => setTimeout(r, 50));

    // Verify HL hedge was triggered
    expect(mockPlaceMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'BTC',
        isBuy: false, // SHORT
        sizeUsd: 10, // 1:1 stake
        leverage: 1,
      }),
    );

    // Verify Redis link was set
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('hedge:link:pm-123'),
      'BTC',
      'EX',
      expect.any(Number),
    );
  });

  it('skips when an opposite-side position is already open (YES signal, NO held)', async () => {
    (hasOpenPosition as Mock).mockImplementation((_redis, _marketId, direction) =>
      Promise.resolve(direction === 'NO'),
    );

    const result = await executeSignal(
      {
        marketId: 'pm-456',
        question: 'Will Girona FC win?',
        direction: 'YES' as const,
        stakeUsd: 10,
        outcomePrice: 0.5,
        edgeMagnitude: 0.2,
        sourcedFrom: 'copytrade:0xwallet',
        isFutures: false,
      } as any,
      mockRedis,
    );

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('position_already_open');
  });

  it('skips when an opposite-side position is already open (UP signal, NO held)', async () => {
    (hasOpenPosition as Mock).mockImplementation((_redis, _marketId, direction) =>
      Promise.resolve(direction === 'NO'),
    );

    const result = await executeSignal(
      {
        marketId: 'crypto-updown-btc',
        question: 'Will BTC be UP at expiry?',
        direction: 'UP' as const,
        stakeUsd: 10,
        outcomePrice: 0.5,
        edgeMagnitude: 0.2,
        sourcedFrom: 'copytrade:0xwallet',
        isFutures: false,
      } as any,
      mockRedis,
    );

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('position_already_open');
  });

  it('skips hedge when an HL position for the same symbol already exists (same direction)', async () => {
    const { getHyperliquid } = await import('../../shared/hyperliquid.js');
    // Use mockResolvedValue (not Once) so both the margin check and the guard receive the BTC position
    (getHyperliquid as Mock)().getOpenPositions.mockResolvedValue([
      { symbol: 'BTC', position: { szi: '0.01', entryPx: '60000', leverage: { type: 'cross', value: 1 }, unrealizedPnl: '0', marginUsed: '10', coin: 'BTC' } },
    ]);

    const signal = {
      marketId: 'pm-btc-2',
      question: 'Will Bitcoin exceed $70k?',
      direction: 'YES' as const,
      stakeUsd: 10,
      outcomePrice: 0.5,
      edgeMagnitude: 0.2,
      sourcedFrom: 'oracle-lag:btc:1.5pct:300s',
      isFutures: false,
    };

    mockPlaceMarketOrder.mockResolvedValue({ success: true, txHash: '0x-hedge-tx-2' });
    await executeSignal(signal as any, mockRedis);
    await new Promise((r) => setTimeout(r, 50));

    expect(mockPlaceMarketOrder).not.toHaveBeenCalled();
  });

  it('skips hedge when an HL position for the same symbol already exists (opposite direction — prevents flip)', async () => {
    const { getHyperliquid } = await import('../../shared/hyperliquid.js');
    (getHyperliquid as Mock)().getOpenPositions.mockResolvedValue([
      { symbol: 'BTC', position: { szi: '-0.01', entryPx: '60000', leverage: { type: 'cross', value: 1 }, unrealizedPnl: '0', marginUsed: '10', coin: 'BTC' } },
    ]);

    const signal = {
      marketId: 'pm-btc-3',
      question: 'Will Bitcoin price drop below $50k?',
      direction: 'NO' as const,
      stakeUsd: 10,
      outcomePrice: 0.5,
      edgeMagnitude: 0.2,
      sourcedFrom: 'oracle-lag:btc:1.5pct:300s',
      isFutures: false,
    };

    mockPlaceMarketOrder.mockResolvedValue({ success: true, txHash: '0x-hedge-tx-3' });
    await executeSignal(signal as any, mockRedis);
    await new Promise((r) => setTimeout(r, 50));

    expect(mockPlaceMarketOrder).not.toHaveBeenCalled();
  });

  it('does NOT skip hedge when HL has a zero-size stale entry for the symbol', async () => {
    const { getHyperliquid } = await import('../../shared/hyperliquid.js');
    // szi='0' — recently-closed position the API hasn't cleared yet; should not block the hedge
    (getHyperliquid as Mock)().getOpenPositions.mockResolvedValue([
      { symbol: 'BTC', position: { szi: '0', entryPx: '0', leverage: { type: 'cross', value: 1 }, unrealizedPnl: '0', marginUsed: '0', coin: 'BTC' } },
    ]);

    const signal = {
      marketId: 'pm-btc-stale',
      question: 'Will Bitcoin be above $80k?',
      direction: 'YES' as const,
      stakeUsd: 10,
      outcomePrice: 0.5,
      edgeMagnitude: 0.2,
      sourcedFrom: 'oracle-lag:btc:1.5pct:300s',
      isFutures: false,
    };

    mockPlaceMarketOrder.mockResolvedValue({ success: true, txHash: '0x-hedge-stale' });
    await executeSignal(signal as any, mockRedis);
    await new Promise((r) => setTimeout(r, 50));

    expect(mockPlaceMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'BTC', isBuy: false, sizeUsd: 10 }),
    );
  });

  it('skips hedge for non-price-target questions even from eligible sources', async () => {
    // Regulatory/adoption markets mention BTC but PM payout doesn't track spot price
    const signal = {
      marketId: 'pm-btc-etf',
      question: 'Will the US approve a Bitcoin ETF?',
      direction: 'YES' as const,
      stakeUsd: 10,
      outcomePrice: 0.5,
      edgeMagnitude: 0.2,
      sourcedFrom: 'oracle-lag:btc:1.5pct:300s',
      isFutures: false,
    };

    mockPlaceMarketOrder.mockResolvedValue({ success: true, txHash: '0x-hedge-etf' });
    await executeSignal(signal as any, mockRedis);
    await new Promise((r) => setTimeout(r, 50));

    expect(mockPlaceMarketOrder).not.toHaveBeenCalled();
  });

  it('opens hedge for price-target questions from any source (source gate removed)', async () => {
    // The regex+resolveHlSymbol combination is the gate — any scanner can produce a hedgeable trade
    const signal = {
      marketId: 'pm-copytrade-btc',
      question: 'Will Bitcoin be above $100,000 by year end?',
      direction: 'YES' as const,
      stakeUsd: 10,
      outcomePrice: 0.5,
      edgeMagnitude: 0.2,
      sourcedFrom: 'copytrade:0xwallet',
      isFutures: false,
    };

    mockPlaceMarketOrder.mockResolvedValue({ success: true, txHash: '0x-hedge-copytrade' });
    await executeSignal(signal as any, mockRedis);
    await new Promise((r) => setTimeout(r, 50));

    expect(mockPlaceMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'BTC', isBuy: false, sizeUsd: 10 }),
    );
  });

  it('opens LONG hedge for bearish-framed question with YES direction', async () => {
    // "Will ETH be below $2000?" + YES: trader profits if ETH drops → short PM exposure → offset with LONG
    const signal = {
      marketId: 'pm-eth-below',
      question: 'Will Ethereum be below $2000 by end of month?',
      direction: 'YES' as const,
      stakeUsd: 10,
      outcomePrice: 0.5,
      edgeMagnitude: 0.2,
      sourcedFrom: 'oracle-lag:eth:2pct:300s',
      isFutures: false,
    };

    mockPlaceMarketOrder.mockResolvedValue({ success: true, txHash: '0x-hedge-eth-below' });
    await executeSignal(signal as any, mockRedis);
    await new Promise((r) => setTimeout(r, 50));

    expect(mockPlaceMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'ETH', isBuy: true, sizeUsd: 10 }),
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
