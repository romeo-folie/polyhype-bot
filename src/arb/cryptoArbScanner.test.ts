import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scanCryptoArb } from './cryptoArbScanner.js';
import { loadConfig } from '../shared/config.js';
import { resolveHlSymbol } from '../shared/hyperliquid.js';

// Mock Config
vi.mock('../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    CRYPTO_ARB_ENABLED: true,
    CRYPTO_ARB_MIN_EDGE: 0.05,
    ARB_FEE_RATE: 0.01,
  })),
}));

// Mock Correlator
vi.mock('../spot/marketCorrelator.js', () => ({
  findCorrelatedMarkets: vi.fn().mockResolvedValue([
    {
      marketId: 'mkt-1',
      conditionId: 'cond-1',
      clobTokenIds: ['yes-1', 'no-1'],
      question: 'Will Bitcoin reach $100k?',
      currentYesPrice: 0.5,
      feesEnabled: false,
    },
  ]),
}));

// Mock Consensus
vi.mock('../spot/fastPathConsensus.js', () => ({
  estimateFastConsensus: vi.fn().mockResolvedValue({
    probability: 0.65, // 0.15 edge
    method: 'bs',
  }),
}));

// Mock HL Resolution
vi.mock('../shared/hyperliquid.js', () => ({
  getHyperliquid: vi.fn(),
  resolveHlSymbol: vi.fn((q) => (q.includes('Bitcoin') ? 'BTC' : null)),
}));

// Mock Bankroll
vi.mock('../shared/bankroll.js', () => ({
  getBankroll: vi.fn().mockResolvedValue(1000), // $1000 bankroll
}));

// Mock Telemetry
vi.mock('../shared/telemetry.js', () => ({
  recordCryptoArbGate: vi.fn().mockResolvedValue(undefined),
}));

// Mock Price Feed
vi.mock('../shared/feedSingleton.js', () => ({
  getPriceFeed: vi.fn(() => ({
    getCachedPrice: vi.fn().mockResolvedValue(null),
    getCachedSpread: vi.fn().mockResolvedValue(0),
  })),
}));

// Mock Assets
vi.mock('../shared/assets.js', () => ({
  ASSET_SEARCH_QUERIES: { bitcoin: ['BTC'] },
  BINANCE_SYMBOL_TO_ASSET: { btcusdt: 'bitcoin' },
}));

// Mock Redis
const mockRedis = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  zrange: vi.fn().mockResolvedValue([]),
};

describe('Crypto Arb Scanner (Extended)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should identify hedgable markets for delta-neutral arb', async () => {
    const move = { assetId: 'bitcoin', currentPrice: 65000, detectedAt: '' };
    const results = await scanCryptoArb(move as any, mockRedis as any);

    expect(results).toHaveLength(1);
    expect(results[0].hlSymbol).toBe('BTC');
    expect(resolveHlSymbol).toHaveBeenCalled();
  });

  it('should successfully calculate edge and state correct direction', async () => {
    const move = { assetId: 'bitcoin', currentPrice: 65000, detectedAt: '' };
    const results = await scanCryptoArb(move as any, mockRedis as any);

    const opp = results[0];
    // fairValue(0.65) - currentPrice(0.50) - fee(0.01) = 0.14
    expect(opp.edge).toBeCloseTo(0.14);
    expect(opp.direction).toBe('YES');
  });
});
