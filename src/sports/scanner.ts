/**
 * Sports in-play arbitrage scanner.
 *
 * Matches live NBA/NHL/MLB games from ESPN against cached Polymarket markets,
 * computes a model win-probability, compares against the PM YES price, and
 * emits `TradeSignal`s when the drift exceeds `SPORTS_MIN_EDGE`.
 */

import { logger } from '../shared/logger.js';
import { loadConfig, type AppConfig } from '../shared/config.js';
import { getCachedMarkets, type CachedMarket } from '../shared/watchlist.js';
import { parseClobTokenIds, parseOutcomePrices } from '../mapping/gamma.js';
import { fetchLiveGames, type LiveGame, type SportsLeague } from './espnFeed.js';
import { nbaWinProb, nhlWinProb, mlbWinProb } from './winProb.js';
import type { TradeSignal } from '../mapping/index.js';
import type { Redis } from 'ioredis';

/**
 * Polymarket's sports-market endDate convention is per-league: NBA/NHL set it
 * to tipoff; MLB sets it to first pitch + 168h (7-day resolution buffer).
 * Empirically verified against the live watchlist cache on 2026-04-22.
 */
const PM_ENDDATE_OFFSET_H: Record<SportsLeague, number> = {
  nba: 0,
  nhl: 0,
  mlb: 168,
};

export interface SportsArbCandidate {
  game: LiveGame;
  market: CachedMarket;
  modelHomeProb: number;
  yesPrice: number;
  /**
   * True if the PM "YES" token resolves on the home team winning.
   * Heuristic: question mentions home team first among the two team names.
   */
  yesIsHome: boolean;
  edge: number;
  direction: 'YES' | 'NO';
}

/**
 * Normalise a team name for substring matching: lowercase, strip punctuation,
 * collapse whitespace.
 */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pick the last word of a team's display name as a best-effort nickname
 * ("Los Angeles Lakers" → "lakers"). Falls back to full normalised name.
 */
function nickname(team: string): string {
  const n = norm(team);
  const parts = n.split(' ');
  return parts.length > 0 ? parts[parts.length - 1]! : n;
}

/** Skip over/under, spread, first-half, and first-inning prop markets — win-prob doesn't apply to them. */
function isMoneylineMarket(question: string): boolean {
  return !/\bO\/U\b|Spread:|\b1H\b|\binning\b/i.test(question);
}

/**
 * Return true when the market question mentions both teams from the given game.
 * Uses team nickname matching against the normalised question text.
 */
export function marketMatchesGame(market: CachedMarket, game: LiveGame): boolean {
  const q = norm(market.question ?? '');
  if (!q) return false;
  const home = nickname(game.homeTeam);
  const away = nickname(game.awayTeam);
  if (!home || !away) return false;
  return q.includes(home) && q.includes(away);
}

/**
 * Decide whether the YES outcome represents the home team winning.
 * Heuristic: whichever team appears first in the question is treated as YES.
 */
function yesIsHomeTeam(market: CachedMarket, game: LiveGame): boolean {
  const q = norm(market.question ?? '');
  const home = nickname(game.homeTeam);
  const away = nickname(game.awayTeam);
  const homeIdx = home ? q.indexOf(home) : -1;
  const awayIdx = away ? q.indexOf(away) : -1;
  if (homeIdx === -1) return false;
  if (awayIdx === -1) return true;
  return homeIdx < awayIdx;
}

/** Compute model home-win probability for a live game. */
export function modelHomeWinProb(game: LiveGame): number {
  const scoreDiff = game.homeScore - game.awayScore;
  if (game.league === 'nba') {
    return nbaWinProb({ scoreDiff, secondsRemaining: game.secondsRemaining });
  }
  if (game.league === 'mlb') {
    return mlbWinProb({ scoreDiff, inning: game.period, isTop: game.halfInning !== 'bottom' });
  }
  // NHL — empty-net detection would need play-by-play; skip for now.
  return nhlWinProb({ scoreDiff, secondsRemaining: game.secondsRemaining, period: game.period });
}

interface ScanDeps {
  /** Override ESPN fetch in tests. */
  fetchLive?: (league: SportsLeague) => Promise<LiveGame[]>;
  /** Override watchlist cache in tests. */
  getMarkets?: (redis: Redis) => Promise<CachedMarket[]>;
}

/**
 * Scan once: fetch live games for enabled leagues, match against cached PM
 * markets, and return any candidates whose edge exceeds `SPORTS_MIN_EDGE`.
 *
 * Returns `{ candidates, signals }` — signals are ready for `executeAndRecordSignal()`.
 * Does NOT execute; the caller (poller) hands signals to the executor.
 */
export async function scanLiveSportsArb(
  redis: Redis,
  cfgIn?: AppConfig,
  deps: ScanDeps = {},
): Promise<{ candidates: SportsArbCandidate[]; signals: TradeSignal[] }> {
  const cfg = cfgIn ?? loadConfig();
  const fetchLive = deps.fetchLive ?? fetchLiveGames;
  const getMarkets = deps.getMarkets ?? getCachedMarkets;

  const leagues = [...cfg.SPORTS_LEAGUES] as SportsLeague[];
  if (leagues.length === 0) {
    return { candidates: [], signals: [] };
  }

  const games: LiveGame[] = [];
  for (const league of leagues) {
    const live = await fetchLive(league);
    games.push(...live);
  }
  if (games.length === 0) {
    logger.debug('[sports-arb] no live games', { leagues });
    return { candidates: [], signals: [] };
  }

  const markets = await getMarkets(redis);
  const toleranceMs = cfg.SPORTS_LIVE_MATCH_TOLERANCE_H * 3600 * 1000;

  const candidates: SportsArbCandidate[] = [];
  let matchedAny = false;
  for (const game of games) {
    const scheduledStartMs = new Date(game.scheduledStart).getTime();
    if (!Number.isFinite(scheduledStartMs)) {
      logger.debug('[sports-arb] skipping live game with unparseable scheduledStart', {
        gameId: game.gameId,
        scheduledStart: game.scheduledStart,
      });
      continue;
    }
    const expectedEndMs =
      scheduledStartMs + PM_ENDDATE_OFFSET_H[game.league] * 3600 * 1000;

    // Require the market's endDate to fall within ±SPORTS_LIVE_MATCH_TOLERANCE_H
    // of the league-specific expected endDate for this live game. This
    // disambiguates back-to-back-day series where the same two teams appear on
    // consecutive days — nickname matching alone can't tell them apart.
    let bestMarket: CachedMarket | null = null;
    let bestDelta = Infinity;

    for (const market of markets) {
      if (!market.endDate) continue;
      const endMs = new Date(market.endDate).getTime();
      if (!Number.isFinite(endMs)) continue;
      const delta = Math.abs(endMs - expectedEndMs);
      if (delta > toleranceMs) continue;

      if (!isMoneylineMarket(market.question ?? '')) continue; // skip O/U, spread, 1H props
      if (!marketMatchesGame(market, game)) continue;

      if (delta < bestDelta) {
        bestDelta = delta;
        bestMarket = market;
      }
    }

    if (!bestMarket) continue;
    matchedAny = true;

    // Skip early MLB innings — too much variance for reliable prediction.
    // A multi-run lead in innings 1-5 reverses frequently, causing the model
    // to fire a signal that gets stop-lossed before the edge can materialise.
    if (game.league === 'mlb' && game.period < cfg.SPORTS_MLB_MIN_INNING) {
      logger.debug('[sports-arb] skipping early-inning MLB game', {
        gameId: game.gameId,
        inning: game.period,
        minInning: cfg.SPORTS_MLB_MIN_INNING,
      });
      continue;
    }

    const market = bestMarket;
    let yesPrice: number;
    try {
      const prices = parseOutcomePrices(market.outcomePrices);
      const yes = parseFloat(prices[0] ?? '');
      if (!Number.isFinite(yes)) continue;
      yesPrice = yes;
    } catch {
      continue;
    }

    const modelHomeProb = modelHomeWinProb(game);
    const yesIsHome = yesIsHomeTeam(market, game);
    const modelYesProb = yesIsHome ? modelHomeProb : 1 - modelHomeProb;
    const rawEdge = modelYesProb - yesPrice;
    const edge = Math.abs(rawEdge);
    const direction: 'YES' | 'NO' = rawEdge > 0 ? 'YES' : 'NO';

    logger.info('[sports-arb] divergence', {
      league: game.league,
      gameId: game.gameId,
      marketId: market.id,
      question: market.question,
      modelYesProb: modelYesProb.toFixed(3),
      yesPrice: yesPrice.toFixed(3),
      edge: edge.toFixed(3),
      direction,
    });

    // Publish the live model probability to Redis so the monitor can update
    // divergence-close comparisons in real time. Written for every matched game
    // (not just those passing the edge floor) so open positions continue to get
    // updated model probs even after the edge narrows below MIN_EDGE.
    await redis
      .set(`sports:live_prob:${market.id}`, modelYesProb.toFixed(6), 'EX', cfg.SPORTS_LIVE_PROB_TTL_S)
      .catch(() => undefined);

    if (edge < cfg.SPORTS_MIN_EDGE) continue;

    candidates.push({
      game,
      market,
      modelHomeProb,
      yesPrice,
      yesIsHome,
      edge,
      direction,
    });
  }

  if (games.length > 0 && !matchedAny) {
    logger.debug('[sports-arb] live games found but no matching PM markets', {
      gameCount: games.length,
      games: games.map((g) => `${g.awayAbbrev}@${g.homeAbbrev} (${g.league})`),
    });
  }

  if (!cfg.SPORTS_ARB_ENABLED) {
    logger.info('[sports-arb] SPORTS_ARB_ENABLED=false — log-only mode', {
      candidateCount: candidates.length,
    });
    return { candidates, signals: [] };
  }

  const signals: TradeSignal[] = [];
  for (const c of candidates) {
    let clobTokenIds: string[];
    try {
      clobTokenIds = parseClobTokenIds(c.market.clobTokenIds);
    } catch {
      continue;
    }

    const modelYesProb = c.yesIsHome ? c.modelHomeProb : 1 - c.modelHomeProb;
    const signal: TradeSignal = {
      marketId: c.market.id,
      conditionId: c.market.conditionId,
      clobTokenIds,
      question: c.market.question,
      direction: c.direction,
      stakeUsd: cfg.SPORTS_MAX_STAKE_USD,
      edgeMagnitude: c.edge,
      consensusProbability: modelYesProb,
      outcomePrice: c.yesPrice,
      sourcedFrom: `sports:${c.game.league}:${c.game.gameId}`,
      reasoning:
        `Live ${c.game.league.toUpperCase()} ${c.game.awayAbbrev}@${c.game.homeAbbrev} ` +
        `${c.game.awayScore}-${c.game.homeScore} Q${c.game.period} ` +
        `${c.game.secondsRemaining}s left; model YES=${modelYesProb.toFixed(3)} vs price ${c.yesPrice.toFixed(3)}.`,
      isFutures: false,
      source: 'sports',
      endDate: c.market.endDate ?? undefined,
      feesEnabled: c.market.feesEnabled ?? false,
    };
    signals.push(signal);
  }

  return { candidates, signals };
}
