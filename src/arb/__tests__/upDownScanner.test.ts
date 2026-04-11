import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scanUpDownArb } from '../cryptoArbScanner.js';
import { loadConfig } from '../../shared/config.js';

vi.mock('../../shared/config.js');
vi.mock('../../shared/bankroll.js', () => ({
  getBankroll: () => Promise.resolve(1000),
}));
vi.mock('../confluenceScorer.js');
vi.mock('../../mapping/gamma.js');
vi.mock('../../shared/feedSingleton.js');
vi.mock('../../shared/hyperliquid.js', () => ({
  resolveHlSymbol: () => 'BTC',
}));

import { scoreConfluence } from '../confluenceScorer.js';
import { listRecentCryptoEvents, parseClobTokenIds, parseOutcomePrices, parseOutcomes } from '../../mapping/gamma.js';
import { getPriceFeed } from '../../shared/feedSingleton.js';

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  zrange: vi.fn().mockResolvedValue([]),
  del: vi.fn(),
};

const mockFeed = {
  getCachedPrice: vi.fn().mockResolvedValue(null),
  getCachedSpread: vi.fn().mockResolvedValue(0),
  watch: vi.fn(),
};

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    UPDOWN_ENABLED: true,
    UPDOWN_MIN_EDGE: 0.08,
    CRYPTO_ARB_ENABLED: true,
    CRYPTO_ARB_MIN_EDGE: 0.08,
    ARB_FEE_RATE: 0.02,
    MAX_BET_FRACTION: 0.1,
    CRYPTO_ARB_MAX_STAKE_FRACTION: 0.05,
    CONFLUENCE_GATE_ENABLED: true,
    CRYPTO_ARB_MIN_CONFLUENCE_SCORE: 2,
    CRYPTO_ARB_DEDUP_TTL_S: 300,
    ...overrides,
  };
}

const baseMove = {
  assetId: 'bitcoin',
  currentPrice: 65000,
  referencePrice: 64000,
  changePercent: 1.5,
  windowMinutes: 0,
  detectedAt: new Date().toISOString(),
};

const mockUpDownEvent = {
  id: 'e1',
  title: 'Bitcoin Up or Down',
  slug: 'btc-up-down',
  active: true,
  closed: false,
  markets: [
    {
      id: 'm1',
      question: 'Will Bitcoin go up in the next 5 minutes?',
      conditionId: 'c1',
      clobTokenIds: ['token-up', 'token-down'],
      outcomePrices: ['0.48', '0.52'],
      outcomes: ['Up', 'Down'],
      active: true,
      closed: false,
      volume: '100000',
      liquidity: '5000',
      endDate: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min from now
      description: null,
      feesEnabled: true,
    },
  ],
};

describe('scanUpDownArb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (loadConfig as any).mockReturnValue(makeConfig());
    (getPriceFeed as any).mockReturnValue(mockFeed);
    (parseClobTokenIds as any).mockImplementation((ids: string[]) => ids);
    (parseOutcomePrices as any).mockImplementation((prices: string[]) => prices);
    (parseOutcomes as any).mockImplementation((outcomes: string[]) => outcomes);
    mockRedis.get.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue('OK');
  });

  it('returns opportunities when confluence is strong (score >= 2)', async () => {
    (scoreConfluence as any).mockResolvedValue({
      direction: 'UP',
      score: 3,
      signals: { rsi: 'oversold', macd: 'bullish_cross', stochastic: 'oversold_cross' },
    });
    (listRecentCryptoEvents as any).mockResolvedValue([mockUpDownEvent]);

    const opps = await scanUpDownArb(baseMove, mockRedis as any);

    expect(opps.length).toBe(1);
    expect(opps[0].direction).toBe('UP');
    expect(opps[0].marketId).toBe('m1');
    expect(opps[0].feesEnabled).toBe(true);
    expect(opps[0].tokenId).toBe('token-up');
  });

  it('skips when UPDOWN_ENABLED=false', async () => {
    (loadConfig as any).mockReturnValue(makeConfig({ UPDOWN_ENABLED: false }));

    const opps = await scanUpDownArb(baseMove, mockRedis as any);
    expect(opps.length).toBe(0);
  });

  it('skips when confluence direction is NEUTRAL', async () => {
    (scoreConfluence as any).mockResolvedValue({
      direction: 'NEUTRAL',
      score: 0,
      signals: {},
    });
    (listRecentCryptoEvents as any).mockResolvedValue([mockUpDownEvent]);

    const opps = await scanUpDownArb(baseMove, mockRedis as any);
    expect(opps.length).toBe(0);
  });

  it('maps DOWN confluence to DOWN direction (token[1])', async () => {
    (scoreConfluence as any).mockResolvedValue({
      direction: 'DOWN',
      score: 3,
      signals: { rsi: 'overbought', macd: 'bearish_cross', stochastic: 'overbought_cross' },
    });
    // Adjust prices: DOWN token (1-upPrice) is cheap = 0.48, fair value will be 0.65
    const event = structuredClone(mockUpDownEvent);
    event.markets[0].outcomePrices = ['0.52', '0.48'];
    (listRecentCryptoEvents as any).mockResolvedValue([event]);

    const opps = await scanUpDownArb(baseMove, mockRedis as any);

    expect(opps.length).toBe(1);
    expect(opps[0].direction).toBe('DOWN');
    expect(opps[0].tokenId).toBe('token-down');
  });

  it('stores fairValuePrice as true P(YES) so the monitor does not exit DOWN positions instantly', async () => {
    // Regression: scanner used to store fairValuePrice as "fair value of our
    // token" (e.g. 0.65 for a DOWN bet = P(DOWN wins)). Worker then wired it
    // into signal.consensusProbability, which the evaluator always reads as
    // P(YES). For DOWN positions the else branch fired `currentYesPrice <=
    // consensusProbability` → 0.52 <= 0.65 → instant divergence_closed exit.
    // Fix: P(YES) = 1 - fairValueOurSide for DOWN, = fairValueOurSide for UP.
    (scoreConfluence as any).mockResolvedValue({
      direction: 'DOWN',
      score: 3, // confluenceScoreToFairValue(3) = 0.65
      signals: { rsi: 'overbought', macd: 'bearish_cross', stochastic: 'overbought_cross' },
    });
    const event = structuredClone(mockUpDownEvent);
    event.markets[0].outcomePrices = ['0.52', '0.48'];
    (listRecentCryptoEvents as any).mockResolvedValue([event]);

    const opps = await scanUpDownArb(baseMove, mockRedis as any);

    expect(opps.length).toBe(1);
    expect(opps[0].direction).toBe('DOWN');
    // DOWN bet, fair=0.65 for the DOWN token → P(YES=UP wins) = 0.35
    expect(opps[0].fairValuePrice).toBeCloseTo(0.35, 5);
    // Invariant: for DOWN, currentYesPrice (= 0.52) > fairValuePrice (= 0.35),
    // so evaluator's `currentYesPrice <= consensus` check is FALSE → hold.
    const currentYesPrice = 0.52;
    expect(currentYesPrice <= opps[0].fairValuePrice).toBe(false);
  });

  it('stores fairValuePrice as fair value directly for UP direction', async () => {
    (scoreConfluence as any).mockResolvedValue({
      direction: 'UP',
      score: 3, // confluenceScoreToFairValue(3) = 0.65
      signals: { rsi: 'oversold', macd: 'bullish_cross', stochastic: 'oversold_cross' },
    });
    // UP cheap at 0.48
    const event = structuredClone(mockUpDownEvent);
    event.markets[0].outcomePrices = ['0.48', '0.52'];
    (listRecentCryptoEvents as any).mockResolvedValue([event]);

    const opps = await scanUpDownArb(baseMove, mockRedis as any);

    expect(opps.length).toBe(1);
    expect(opps[0].direction).toBe('UP');
    // UP = YES-side, so P(YES) = fair value directly
    expect(opps[0].fairValuePrice).toBeCloseTo(0.65, 5);
  });

  it('respects min edge gate', async () => {
    (scoreConfluence as any).mockResolvedValue({
      direction: 'UP',
      score: 2, // fairValue = 0.58
      signals: { rsi: 'oversold', macd: 'bullish_cross' },
    });
    // UP price at 0.55 → edge = |0.58 - 0.55| - 0.02 = 0.01, below 0.08 min
    const event = structuredClone(mockUpDownEvent);
    event.markets[0].outcomePrices = ['0.55', '0.45'];
    (listRecentCryptoEvents as any).mockResolvedValue([event]);

    const opps = await scanUpDownArb(baseMove, mockRedis as any);
    expect(opps.length).toBe(0);
  });

  it('respects dedup', async () => {
    (scoreConfluence as any).mockResolvedValue({
      direction: 'UP',
      score: 3,
      signals: { rsi: 'oversold', macd: 'bullish_cross', stochastic: 'oversold_cross' },
    });
    (listRecentCryptoEvents as any).mockResolvedValue([mockUpDownEvent]);
    // Simulate dedup key already set (worker writes arb:crypto: prefix)
    mockRedis.get.mockImplementation((key: string) => {
      if (key.startsWith('arb:crypto:')) return Promise.resolve('1');
      return Promise.resolve(null);
    });

    const opps = await scanUpDownArb(baseMove, mockRedis as any);
    expect(opps.length).toBe(0);
  });

  it('normalizes reversed outcome ordering (Down, Up)', async () => {
    (scoreConfluence as any).mockResolvedValue({
      direction: 'UP',
      score: 3,
      signals: { rsi: 'oversold', macd: 'bullish_cross', stochastic: 'oversold_cross' },
    });
    // Gamma returns outcomes in reversed order: [Down, Up]
    const event = structuredClone(mockUpDownEvent);
    event.markets[0].outcomes = ['Down', 'Up'];
    event.markets[0].outcomePrices = ['0.52', '0.48']; // Down price first, Up price second
    event.markets[0].clobTokenIds = ['token-down', 'token-up']; // Down token first, Up token second
    (listRecentCryptoEvents as any).mockResolvedValue([event]);

    const opps = await scanUpDownArb(baseMove, mockRedis as any);

    expect(opps.length).toBe(1);
    expect(opps[0].direction).toBe('UP');
    // Should pick the UP token despite it being at index 1 in the raw data
    expect(opps[0].tokenId).toBe('token-up');
  });

  it('skips non-bitcoin moves', async () => {
    (scoreConfluence as any).mockResolvedValue({
      direction: 'UP',
      score: 3,
      signals: {},
    });

    const opps = await scanUpDownArb(
      { ...baseMove, assetId: 'ethereum' },
      mockRedis as any,
    );
    expect(opps.length).toBe(0);
  });
});
