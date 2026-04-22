/**
 * ESPN public scoreboard client (NBA, NHL, MLB).
 *
 * Uses the no-auth public endpoints:
 *   https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard
 *   https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard
 *   https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard
 *
 * Returns a flat list of live-game snapshots. Pre-game and final games are
 * filtered out — the scanner only acts on `STATUS_IN_PROGRESS`.
 */

import { logger } from '../shared/logger.js';

export type SportsLeague = 'nba' | 'nhl' | 'mlb';

export interface LiveGame {
  league: SportsLeague;
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  homeAbbrev: string;
  awayAbbrev: string;
  homeScore: number;
  awayScore: number;
  /** Seconds remaining in regulation / current game (best-effort from clock). */
  secondsRemaining: number;
  /** Period number (1,2,3, or 4+ for OT/extra innings). */
  period: number;
  /** Raw ESPN status state for debugging. */
  state: string;
  /** Scheduled game start (ISO 8601) — used to disambiguate series games in the scanner. */
  scheduledStart: string;
  /** MLB only: which half of the inning is being played. */
  halfInning?: 'top' | 'bottom';
}

const ESPN_ENDPOINTS: Record<SportsLeague, string> = {
  nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
  nhl: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard',
  mlb: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
};

/** Regulation length in seconds per league (MLB uses inning-based proxy). */
const REGULATION_SECONDS: Record<'nba' | 'nhl', number> = {
  nba: 48 * 60,
  nhl: 60 * 60,
};

/** Per-period length in seconds (NBA/NHL only). */
const PERIOD_SECONDS: Record<'nba' | 'nhl', number> = {
  nba: 12 * 60,
  nhl: 20 * 60,
};

/** Parse a "MM:SS" clock string to seconds. Returns 0 on failure. */
export function parseClock(clock: string | undefined | null): number {
  if (!clock || typeof clock !== 'string') return 0;
  const m = /^(\d+):(\d{2})(?:\.\d+)?$/.exec(clock.trim());
  if (!m) return 0;
  return parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10);
}

/**
 * Extract live games from an ESPN scoreboard JSON response.
 * Pure function so we can unit-test it without hitting the network.
 */
export function extractLiveGames(
  league: SportsLeague,
  json: Record<string, unknown>,
): LiveGame[] {
  const events = Array.isArray(json.events) ? (json.events as Record<string, unknown>[]) : [];
  const out: LiveGame[] = [];
  for (const ev of events) {
    try {
      const gameId = String(ev.id ?? '');
      if (!gameId) continue;

      const competitions = Array.isArray(ev.competitions)
        ? (ev.competitions as Record<string, unknown>[])
        : [];
      const comp = competitions[0];
      if (!comp) continue;

      // ESPN publishes the scheduled start on the event and/or competition.
      // Prefer the competition-level date, fall back to the event-level.
      const scheduledStart = (comp.date ?? ev.date) as string | undefined;
      if (!scheduledStart || typeof scheduledStart !== 'string') continue;

      const status = (comp.status ?? ev.status) as Record<string, unknown> | undefined;
      const statusType = status?.type as Record<string, unknown> | undefined;
      const stateRaw = (statusType?.state ?? '') as string;
      // Only consider in-progress games.
      if (stateRaw !== 'in') continue;

      const competitors = Array.isArray(comp.competitors)
        ? (comp.competitors as Record<string, unknown>[])
        : [];
      if (competitors.length !== 2) continue;

      const findSide = (side: 'home' | 'away') =>
        competitors.find((c) => c.homeAway === side);
      const home = findSide('home');
      const away = findSide('away');
      if (!home || !away) continue;

      const pickTeamName = (c: Record<string, unknown>) => {
        const t = c.team as Record<string, unknown> | undefined;
        return (t?.displayName as string) ?? (t?.name as string) ?? '';
      };
      const pickTeamAbbrev = (c: Record<string, unknown>) => {
        const t = c.team as Record<string, unknown> | undefined;
        return (t?.abbreviation as string) ?? '';
      };
      const pickScore = (c: Record<string, unknown>) => {
        const raw = c.score;
        const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
        return Number.isFinite(n) ? n : 0;
      };

      const period = typeof status?.period === 'number' ? status.period : 1;

      let secondsRemaining: number;
      let halfInning: 'top' | 'bottom' | undefined;

      if (league === 'mlb') {
        // Baseball has no clock. Derive game-progress proxy from inning.
        const shortDetail = (statusType?.shortDetail as string | undefined) ?? '';
        const isTop = /^top/i.test(shortDetail.trim());
        const isBot = /^bot/i.test(shortDetail.trim());
        halfInning = isTop ? 'top' : isBot ? 'bottom' : 'top';
        // Remaining innings including current half so secondsRemaining stays > 0
        // for every live state (bottom 9th = 0.5, not 0). Use 25 min/inning.
        const inningsLeft = Math.max(9 - period, 0) + (halfInning === 'top' ? 1 : 0.5);
        secondsRemaining = inningsLeft * 1500;
      } else {
        const clockRaw = status?.clock;
        const clockDisplay =
          (status?.displayClock as string | undefined) ??
          (typeof clockRaw === 'number'
            ? `${Math.floor(clockRaw / 60)}:${String(Math.floor(clockRaw % 60)).padStart(2, '0')}`
            : undefined);
        const periodSecondsLeft = parseClock(clockDisplay);

        // In OT — treat as "very little time left".
        if (period > (league === 'nba' ? 4 : 3)) {
          secondsRemaining = Math.max(periodSecondsLeft, 1);
        } else {
          const ps = PERIOD_SECONDS[league];
          const rs = REGULATION_SECONDS[league];
          const completedPeriods = Math.max(period - 1, 0);
          const totalElapsed = completedPeriods * ps + (ps - periodSecondsLeft);
          secondsRemaining = Math.max(rs - totalElapsed, 0);
        }
      }

      out.push({
        league,
        gameId,
        homeTeam: pickTeamName(home),
        awayTeam: pickTeamName(away),
        homeAbbrev: pickTeamAbbrev(home),
        awayAbbrev: pickTeamAbbrev(away),
        homeScore: pickScore(home),
        awayScore: pickScore(away),
        secondsRemaining,
        period,
        state: stateRaw,
        scheduledStart,
        ...(halfInning !== undefined && { halfInning }),
      });
    } catch (err) {
      logger.debug('[espnFeed] skipping malformed event', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/**
 * Fetch the live scoreboard for one league. Network-bound; returns [] on failure.
 */
export async function fetchLiveGames(league: SportsLeague): Promise<LiveGame[]> {
  const url = ESPN_ENDPOINTS[league];
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      logger.warn('[espnFeed] non-OK response', { league, status: res.status });
      return [];
    }
    const json = (await res.json()) as Record<string, unknown>;
    return extractLiveGames(league, json);
  } catch (err) {
    logger.warn('[espnFeed] fetch failed', {
      league,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
