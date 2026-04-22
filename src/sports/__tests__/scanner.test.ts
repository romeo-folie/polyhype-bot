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
  SPORTS_LIVE_MATCH_TOLERANCE_H: 6,
  SPORTS_POLL_INTERVAL_S: 8,
  SPORTS_MLB_MIN_INNING: 6,
  SPORTS_MAKER_PREMIUM_PCT: 0.02,
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
    scheduledStart: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    ...overrides,
  };
}

/** PM's endDate for a live MLB game = scheduledStart + 168h (7d resolution buffer). */
function mlbEndDate(scheduledStartMs: number): string {
  return new Date(scheduledStartMs + 168 * 3600 * 1000).toISOString();
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
    // Default endDate aligns with mkGame's scheduledStart (NBA convention:
    // endDate == tipoff). MLB tests must override to scheduledStart + 168h.
    endDate: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
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

  it('skips PM markets whose endDate is outside the live-match tolerance window', async () => {
    // Game scheduledStart = now - 2h (default); NBA expected endDate = scheduledStart + 0 = now - 2h.
    // A market whose endDate is now - 10h is 8h away from expected → outside ±6h tolerance.
    const mismatched = mkMarket({
      endDate: new Date(Date.now() - 10 * 3600 * 1000).toISOString(),
    });
    const { signals } = await scanLiveSportsArb(fakeRedis, mkCfg(), {
      fetchLive: async () => [mkGame()],
      getMarkets: async () => [mismatched],
    });
    expect(signals).toHaveLength(0);
  });

  it('matches a market whose endDate is within the live-match tolerance', async () => {
    // endDate 1h from expected — well within ±6h tolerance.
    const close = mkMarket({
      endDate: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
    });
    const { signals } = await scanLiveSportsArb(fakeRedis, mkCfg(), {
      fetchLive: async () => [mkGame()],
      getMarkets: async () => [close],
    });
    expect(signals).toHaveLength(1);
  });

  it('rejects a same-teams market for a future/next-day game (cross-day series bug)', async () => {
    // Simulates the 2026-04-22 White Sox/Diamondbacks incident: a live MLB
    // game matched to the next day's market because nicknames overlap.
    const liveGameStart = Date.now() - 2 * 3600 * 1000; // live game started 2h ago
    const nextDayMarketEnd = liveGameStart + 24 * 3600 * 1000 + 168 * 3600 * 1000; // tomorrow's game + 168h MLB offset
    const mlbGame = mkGame({
      league: 'mlb',
      homeTeam: 'Arizona Diamondbacks',
      awayTeam: 'Chicago White Sox',
      homeAbbrev: 'ARI',
      awayAbbrev: 'CHW',
      homeScore: 5,
      awayScore: 11,
      period: 7,
      halfInning: 'top',
      scheduledStart: new Date(liveGameStart).toISOString(),
    });
    const nextDayMarket = mkMarket({
      question: 'Chicago White Sox vs. Arizona Diamondbacks',
      endDate: new Date(nextDayMarketEnd).toISOString(),
    });
    const { signals, candidates } = await scanLiveSportsArb(
      fakeRedis,
      mkCfg({ SPORTS_LEAGUES: new Set(['mlb']) as Set<'nba' | 'nhl' | 'mlb'> }),
      {
        fetchLive: async () => [mlbGame],
        getMarkets: async () => [nextDayMarket],
      },
    );
    expect(candidates).toHaveLength(0);
    expect(signals).toHaveLength(0);
  });

  it('picks the closest-endDate market when multiple same-teams markets are in horizon', async () => {
    // Two MLB markets for the same matchup — today's game (should match) and
    // tomorrow's game (should not). Scanner must pick today's.
    const liveGameStart = Date.now() - 2 * 3600 * 1000;
    const todayEnd = liveGameStart + 168 * 3600 * 1000;
    const tomorrowEnd = liveGameStart + 24 * 3600 * 1000 + 168 * 3600 * 1000;
    const mlbGame = mkGame({
      league: 'mlb',
      homeTeam: 'Arizona Diamondbacks',
      awayTeam: 'Chicago White Sox',
      homeAbbrev: 'ARI',
      awayAbbrev: 'CHW',
      homeScore: 5,
      awayScore: 11,
      period: 7,
      halfInning: 'top',
      scheduledStart: new Date(liveGameStart).toISOString(),
    });
    const todayMarket = mkMarket({
      id: 'today',
      question: 'Chicago White Sox vs. Arizona Diamondbacks',
      endDate: new Date(todayEnd).toISOString(),
      outcomePrices: '["0.30","0.70"]',
    });
    const tomorrowMarket = mkMarket({
      id: 'tomorrow',
      question: 'Chicago White Sox vs. Arizona Diamondbacks',
      endDate: new Date(tomorrowEnd).toISOString(),
      outcomePrices: '["0.50","0.50"]',
    });
    const { signals } = await scanLiveSportsArb(
      fakeRedis,
      mkCfg({ SPORTS_LEAGUES: new Set(['mlb']) as Set<'nba' | 'nhl' | 'mlb'> }),
      {
        fetchLive: async () => [mlbGame],
        getMarkets: async () => [tomorrowMarket, todayMarket],
      },
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.marketId).toBe('today');
  });

  it('skips O/U prop markets even when both team names appear', async () => {
    const ouMarket = mkMarket({ question: 'Lakers vs. Warriors: O/U 225.5' });
    const { signals } = await scanLiveSportsArb(fakeRedis, mkCfg(), {
      fetchLive: async () => [mkGame()],
      getMarkets: async () => [ouMarket],
    });
    expect(signals).toHaveLength(0);
  });

  it('skips first-inning run prop markets', async () => {
    const inningMarket = mkMarket({
      question: 'Will there be a run scored in the first inning?: Lakers vs. Warriors',
    });
    const { signals } = await scanLiveSportsArb(fakeRedis, mkCfg(), {
      fetchLive: async () => [mkGame()],
      getMarkets: async () => [inningMarket],
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
    const mlbMarket = mkMarket({
      question: 'Yankees vs. Red Sox',
      endDate: mlbEndDate(new Date(mlbGame.scheduledStart).getTime()),
    });
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

  it('skips MLB games in early innings (below SPORTS_MLB_MIN_INNING)', async () => {
    const earlyGame = mkGame({
      league: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      homeAbbrev: 'NYY',
      awayAbbrev: 'BOS',
      homeScore: 3,
      awayScore: 0,
      period: 3, // inning 3 < min inning 6
      secondsRemaining: 3000,
      halfInning: 'top',
    });
    const mlbMarket = mkMarket({
      question: 'Yankees vs. Red Sox',
      outcomePrices: '["0.30","0.70"]',
      endDate: mlbEndDate(new Date(earlyGame.scheduledStart).getTime()),
    });
    const { signals, candidates } = await scanLiveSportsArb(
      fakeRedis,
      mkCfg({ SPORTS_LEAGUES: new Set(['mlb']) as Set<'nba' | 'nhl' | 'mlb'>, SPORTS_MLB_MIN_INNING: 6 }),
      {
        fetchLive: async () => [earlyGame],
        getMarkets: async () => [mlbMarket],
      },
    );
    expect(candidates).toHaveLength(0);
    expect(signals).toHaveLength(0);
  });

  it('allows MLB games at or above SPORTS_MLB_MIN_INNING', async () => {
    const lateGame = mkGame({
      league: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      homeAbbrev: 'NYY',
      awayAbbrev: 'BOS',
      homeScore: 3,
      awayScore: 0,
      period: 7, // inning 7 >= min inning 6
      secondsRemaining: 1500,
      halfInning: 'top',
    });
    const mlbMarket = mkMarket({
      question: 'Yankees vs. Red Sox',
      outcomePrices: '["0.30","0.70"]',
      endDate: mlbEndDate(new Date(lateGame.scheduledStart).getTime()),
    });
    const { signals } = await scanLiveSportsArb(
      fakeRedis,
      mkCfg({ SPORTS_LEAGUES: new Set(['mlb']) as Set<'nba' | 'nhl' | 'mlb'>, SPORTS_MLB_MIN_INNING: 6 }),
      {
        fetchLive: async () => [lateGame],
        getMarkets: async () => [mlbMarket],
      },
    );
    expect(signals).toHaveLength(1);
  });

  it('does not apply the inning gate to NBA games', async () => {
    // period=2 (2nd quarter) for NBA should still be eligible
    const earlyNba = mkGame({ period: 2, homeScore: 110, awayScore: 90, secondsRemaining: 600 });
    const { signals } = await scanLiveSportsArb(fakeRedis, mkCfg(), {
      fetchLive: async () => [earlyNba],
      getMarkets: async () => [mkMarket()],
    });
    expect(signals).toHaveLength(1);
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
