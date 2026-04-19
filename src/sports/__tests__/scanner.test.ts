import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { scanLiveSportsArb } from '../scanner.js';
import type { LiveGame, SportsLeague } from '../espnFeed.js';
import type { GammaMarket } from '../../mapping/gamma.js';
import type { AppConfig } from '../../shared/config.js';

const baseCfg: Partial<AppConfig> = {
  SPORTS_ARB_ENABLED: true,
  SPORTS_LEAGUES: new Set(['nba']) as Set<'nba' | 'nhl' | 'mlb'>,
  SPORTS_MIN_EDGE: 0.08,
  SPORTS_MAX_STAKE_USD: 5,
  SPORTS_MARKET_LOOKAHEAD_H: 48,
  SPORTS_POLL_INTERVAL_S: 8,
};

function mkCfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...baseCfg, ...overrides } as AppConfig;
}

const fakeRedis = {} as any;

function mkGame(overrides: Partial<LiveGame> = {}): LiveGame {
  return {
    league: 'nba',
    gameId: 'g1',
    homeTeam: 'Los Angeles Lakers',
    awayTeam: 'Golden State Warriors',
    homeAbbrev: 'LAL',
    awayAbbrev: 'GSW',
    homeScore: 110,
    awayScore: 100,
    secondsRemaining: 60,
    period: 4,
    state: 'in',
    ...overrides,
  };
}

function mkMarket(overrides: Partial<GammaMarket> = {}): GammaMarket {
  return {
    id: 'm1',
    question: 'Will the Lakers beat the Warriors tonight?',
    conditionId: 'cond1',
    clobTokenIds: '["tok_yes","tok_no"]',
    outcomePrices: '["0.55","0.45"]',
    outcomes: '["Yes","No"]',
    active: true,
    closed: false,
    volume: '1000',
    liquidity: '500',
    endDate: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
    description: null,
    feesEnabled: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('scanLiveSportsArb', () => {
  it('emits a signal for a matching live NBA market', async () => {
    const { signals, candidates } = await scanLiveSportsArb(fakeRedis, mkCfg(), {
      fetchLive: async () => [mkGame()],
      getMarkets: async () => [mkMarket()],
    });
    expect(candidates).toHaveLength(1);
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.direction).toBe('YES');
    expect(s.stakeUsd).toBe(5);
    expect(s.clobTokenIds).toEqual(['tok_yes', 'tok_no']);
    expect(s.marketId).toBe('m1');
  });

  it('skips PM markets whose endDate is well past the grace window (5h ago)', async () => {
    const expired = mkMarket({
      endDate: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
    });
    const { signals } = await scanLiveSportsArb(fakeRedis, mkCfg(), {
      fetchLive: async () => [mkGame()],
      getMarkets: async () => [expired],
    });
    expect(signals).toHaveLength(0);
  });

  it('still matches a market whose endDate just passed (within 4h grace window)', async () => {
    // Polymarket sets endDate = tip-off time; game runs ~2.5h after that.
    const tippedOff = mkMarket({
      endDate: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    });
    const { signals } = await scanLiveSportsArb(fakeRedis, mkCfg(), {
      fetchLive: async () => [mkGame()],
      getMarkets: async () => [tippedOff],
    });
    expect(signals).toHaveLength(1);
  });

  it('skips O/U prop markets even when both team names appear', async () => {
    const ouMarket = mkMarket({ question: 'Lakers vs. Warriors: O/U 225.5' });
    const { signals } = await scanLiveSportsArb(fakeRedis, mkCfg(), {
      fetchLive: async () => [mkGame()],
      getMarkets: async () => [ouMarket],
    });
    expect(signals).toHaveLength(0);
  });

  it('skips Spread prop markets', async () => {
    const spreadMarket = mkMarket({ question: 'Spread: Warriors (-4.5)' });
    const { signals } = await scanLiveSportsArb(fakeRedis, mkCfg(), {
      fetchLive: async () => [mkGame()],
      getMarkets: async () => [spreadMarket],
    });
    expect(signals).toHaveLength(0);
  });

  it('emits a signal for a live MLB game with a matching market', async () => {
    const mlbGame = mkGame({
      league: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      homeAbbrev: 'NYY',
      awayAbbrev: 'BOS',
      homeScore: 3,
      awayScore: 2,
      period: 7,
      secondsRemaining: 3000,
      halfInning: 'top',
    });
    const mlbMarket = mkMarket({ question: 'Yankees vs. Red Sox' });
    const { signals } = await scanLiveSportsArb(
      fakeRedis,
      mkCfg({ SPORTS_LEAGUES: new Set(['mlb']) as Set<'nba' | 'nhl' | 'mlb'> }),
      {
        fetchLive: async () => [mlbGame],
        getMarkets: async () => [mlbMarket],
      },
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.sourcedFrom).toContain('mlb');
  });

  it('skips when ESPN reports no live games', async () => {
    const { signals, candidates } = await scanLiveSportsArb(fakeRedis, mkCfg(), {
      fetchLive: async () => [],
      getMarkets: async () => [mkMarket()],
    });
    expect(candidates).toHaveLength(0);
    expect(signals).toHaveLength(0);
  });

  it('respects SPORTS_LEAGUES=nba (does not poll NHL)', async () => {
    const fetchLive = vi.fn<[SportsLeague], Promise<LiveGame[]>>(async () => []);
    await scanLiveSportsArb(fakeRedis, mkCfg(), {
      fetchLive,
      getMarkets: async () => [],
    });
    expect(fetchLive).toHaveBeenCalledTimes(1);
    expect(fetchLive).toHaveBeenCalledWith('nba');
  });

  it('respects SPORTS_ARB_ENABLED=false → log-only, no signals', async () => {
    const { signals, candidates } = await scanLiveSportsArb(
      fakeRedis,
      mkCfg({ SPORTS_ARB_ENABLED: false }),
      {
        fetchLive: async () => [mkGame()],
        getMarkets: async () => [mkMarket()],
      },
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(signals).toHaveLength(0);
  });

  it('emits no signal when edge < SPORTS_MIN_EDGE', async () => {
    // Tied game with lots of time left → model ~0.55, set market price ~0.55
    const game = mkGame({ homeScore: 100, awayScore: 100, secondsRemaining: 1200, period: 2 });
    const market = mkMarket({ outcomePrices: '["0.55","0.45"]' });
    const { signals } = await scanLiveSportsArb(fakeRedis, mkCfg(), {
      fetchLive: async () => [game],
      getMarkets: async () => [market],
    });
    expect(signals).toHaveLength(0);
  });
});
