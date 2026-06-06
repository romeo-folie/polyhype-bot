/**
 * Market selector for rebate farming.
 *
 * Maker rebates are paid only on FILLED maker liquidity, so selection
 * optimizes for current fill probability, not book presence:
 *
 *   1. Cheap prefilter on a Gamma universe ordered by TRAILING-24H volume —
 *      binary, fee-enabled (the only markets that pay rebates), unexpired,
 *      volume/liquidity floors, price tails excluded. Recent volume matters:
 *      the lifetime-volume watchlist cache surfaced ~99 mostly-resolved
 *      markets (96 at price extremes, the rest ghost books) → 0 candidates
 *      every cycle, while 24h ordering surfaces live fee markets with real
 *      1–2¢ books. The cache remains the fallback when Gamma is down.
 *   2. Per surviving market (capped for rate limits): fetch the YES + NO CLOB
 *      books and the recent public trade tape, then gate out ghost books
 *      (wide absolute spread, mid detached from where trades actually print)
 *      and dead tape (no recent taker flow).
 *   3. Score by recent fee-equivalent flow per hour — the exact quantity the
 *      rebate pool is built from — and quote both tokens at effective
 *      mid − edge (a NO bid at q is an ask on YES at 1−q, so this is
 *      two-sided liquidity with no inventory requirement).
 *
 * Rework of the lifetime-volume × inverse-spread selector that produced 2,204
 * placed orders / 0 fills (docs/issues/maker-rebates-not-earning-2026-06-05.md,
 * findings 2, 4, 5).
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getCachedMarkets } from '../shared/watchlist.js';
import type { CachedMarket } from '../shared/watchlist.js';
import { getClobOrderBook } from '../shared/clob.js';
import { getBookTouch } from '../shared/bookTouch.js';
import {
  getActiveMarkets,
  parseOutcomes,
  parseOutcomePrices,
  parseClobTokenIds,
} from '../mapping/gamma.js';
import { fetchRecentMarketFlow, makerRebateShare } from './flowAnalyzer.js';
import type { RebateMarketCandidate, RebateQuote } from './types.js';

/** Max markets to fetch books + trade tape for per cycle (rate limit guard).
 * Each costs 2 book fetches + 1 data-api tape fetch. */
const MAX_MARKET_FETCHES = 15;
/** Universe size fetched from Gamma per cycle. Gamma silently caps pages at
 * 100 rows, so this paginates as 2 pages of 100. */
const UNIVERSE_SIZE = 200;
const UNIVERSE_PAGE_SIZE = 100;

/** Fields the prefilter consumes — satisfied by both GammaMarket (primary
 * universe) and CachedMarket (fallback; lacks volume24hr). */
type UniverseMarket = CachedMarket & { volume24hr?: string | number };

export type SportsClass =
  | 'pre_game'              // sports, gameStartTime in the future — eligible
  | 'live'                  // sports, gameStartTime passed — ineligible
  | 'no_game_time_excluded' // sports, no usable gameStartTime, near-term — ineligible (fail closed)
  | 'outright_exempt'       // sports, no usable gameStartTime, long-dated — eligible
  | 'non_sports';           // not a sports fee type — eligible (gate doesn't apply)

/**
 * Sports eligibility classification (pure — exported for tests).
 *
 * Fail-closed rule: a sports-typed market (feeType `sports_*`) with no
 * parseable FUTURE gameStartTime reads as in-play risk — missing metadata on
 * a near-term event must not grant a pass. Long-dated outrights (World Cup
 * winner etc.) legitimately have no single game time and are exempted when
 * endDate is more than `outrightMinDays` away.
 */
export function classifySportsEligibility(
  market: Pick<UniverseMarket, 'feeType' | 'gameStartTime' | 'endDate'>,
  outrightMinDays: number,
): SportsClass {
  if (!market.feeType?.startsWith('sports_')) return 'non_sports';

  const start = market.gameStartTime ? new Date(market.gameStartTime).getTime() : NaN;
  if (!isNaN(start)) {
    return start > Date.now() ? 'pre_game' : 'live';
  }

  const end = market.endDate ? new Date(market.endDate).getTime() : NaN;
  const daysToEnd = isNaN(end) ? 0 : (end - Date.now()) / 86_400_000;
  return daysToEnd > outrightMinDays ? 'outright_exempt' : 'no_game_time_excluded';
}

/**
 * Candidate universe: active markets ordered by trailing-24h volume. Falls
 * back to the (lifetime-volume) watchlist cache when Gamma is unavailable —
 * mostly useless for selection but keeps the cycle alive and observable.
 */
async function fetchUniverse(redis: Redis): Promise<{ markets: UniverseMarket[]; source: string }> {
  try {
    const markets = await getActiveMarkets(UNIVERSE_SIZE, UNIVERSE_PAGE_SIZE, {
      order: 'volume24hr',
    });
    if (markets.length > 0) return { markets, source: 'gamma_volume24hr' };
    logger.warn('[rebate] gamma universe fetch returned empty — falling back to watchlist cache');
  } catch (err) {
    logger.warn('[rebate] gamma universe fetch failed — falling back to watchlist cache', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { markets: await getCachedMarkets(redis), source: 'watchlist_cache' };
}

function roundDownToTick(value: number, tick: number): number {
  if (!isFinite(value) || !isFinite(tick) || tick <= 0) return value;
  // Epsilon absorbs FP noise (1 − 0.41 → 0.5899999…) without changing the
  // round-DOWN semantics that keep the post-only clamp safe.
  const rounded = Math.floor(value / tick + 1e-9) * tick;
  return parseFloat(rounded.toFixed(6));
}

/**
 * Build a post-only bid for one token, anchored to the effective mid and
 * clamped so it can rest on the token's physical book:
 *   - never at/above the physical best ask (post-only would reject),
 *   - inside [tick, 1 − tick],
 *   - rounded down to tick.
 * Returns null when no valid resting price exists.
 */
function buildQuote(
  direction: 'YES' | 'NO',
  tokenId: string,
  effectiveMid: number,
  edge: number,
  tick: number,
  bestBid: number,
  bestAsk: number,
): RebateQuote | null {
  let price = effectiveMid - edge;
  if (bestAsk > 0) price = Math.min(price, bestAsk - tick);
  price = Math.max(price, tick);
  price = Math.min(price, 1 - tick);
  price = roundDownToTick(price, tick);

  if (price <= 0 || price >= 1) return null;
  if (bestAsk > 0 && price >= bestAsk) return null;

  return { direction, tokenId, price, bestBid, bestAsk };
}

export async function selectRebateMarkets(
  redis: Redis,
  maxMarkets: number,
): Promise<RebateMarketCandidate[]> {
  const cfg = loadConfig();
  const { markets, source: universeSource } = await fetchUniverse(redis);
  if (markets.length === 0) {
    logger.debug('[rebate] candidate universe empty — skipping selection');
    return [];
  }

  // Phase 1: Pre-filter on cached data (cheap — no API calls).
  const preFiltered: {
    marketId: string;
    conditionId: string;
    question: string;
    clobTokenIds: [string, string];
    feesEnabled: boolean;
    feeType: string | null;
    volume: number;
    liquidity: number;
    endDate: string | null;
  }[] = [];
  const sportsTelemetry: Record<SportsClass, number> = {
    pre_game: 0,
    live: 0,
    no_game_time_excluded: 0,
    outright_exempt: 0,
    non_sports: 0,
  };

  for (const market of markets) {
    // Binary-only gate.
    if (market.outcomes) {
      try {
        if (parseOutcomes(market.outcomes).length !== 2) continue;
      } catch {
        continue;
      }
    }

    // Fee market gate — maker rebates exist ONLY on fee-enabled markets.
    if (cfg.REBATE_REQUIRE_FEE_MARKETS && market.feesEnabled !== true) continue;

    // Expired market gate.
    if (market.endDate) {
      const end = new Date(market.endDate).getTime();
      if (!isNaN(end) && end < Date.now()) continue;
    }

    // Sports eligibility: in-play gate + fail-closed metadata gate. Live
    // games carry the most informed taker flow — resting bids get hit
    // precisely when the game turns (day-one naked legs ran 4W/10L); the
    // fee-equiv ranking otherwise ranks these FIRST, because informed flow
    // is flow. Sports markets with NO usable gameStartTime are treated as
    // in-play risk unless long-dated (outrights).
    if (cfg.REBATE_EXCLUDE_LIVE_GAMES) {
      const sportsClass = classifySportsEligibility(market, cfg.REBATE_SPORTS_OUTRIGHT_MIN_DAYS);
      sportsTelemetry[sportsClass]++;
      if (sportsClass === 'live' || sportsClass === 'no_game_time_excluded') continue;
    }

    // Recent (24h) volume when the universe provides it; lifetime volume
    // otherwise (cache fallback). Recency is what predicts taker flow — the
    // authoritative flow gate below still re-checks from the trade tape.
    const volume = parseFloat(String(market.volume24hr ?? market.volume ?? '0'));
    if (!isFinite(volume) || volume < cfg.REBATE_MIN_VOLUME) continue;

    const liquidity = parseFloat(market.liquidity ?? '0');
    if (!isFinite(liquidity) || liquidity < cfg.REBATE_MIN_LIQUIDITY) continue;

    // Skip extreme cached prices — poor dynamics at the tails. Live-book
    // gates below are the authority; this only saves API calls.
    try {
      const prices = parseOutcomePrices(market.outcomePrices);
      if (prices.length === 0) continue;
      const yesPrice = parseFloat(prices[0] ?? '0');
      if (!isFinite(yesPrice) || yesPrice < 0.10 || yesPrice > 0.90) continue;
    } catch {
      continue;
    }

    let clobTokenIds: string[];
    try {
      clobTokenIds = parseClobTokenIds(market.clobTokenIds ?? []);
      if (clobTokenIds.length < 2) continue;
    } catch {
      continue;
    }

    preFiltered.push({
      marketId: market.id,
      conditionId: market.conditionId,
      question: market.question,
      clobTokenIds: [clobTokenIds[0]!, clobTokenIds[1]!],
      feesEnabled: market.feesEnabled === true,
      feeType: market.feeType ?? null,
      volume,
      liquidity,
      endDate: market.endDate ?? null,
    });
  }

  // Volume is only the fetch-priority heuristic here — final ranking is by
  // recent fee-equivalent flow, fetched below.
  preFiltered.sort((a, b) => b.volume - a.volume);
  const toFetch = preFiltered.slice(0, MAX_MARKET_FETCHES);

  // Phase 2: Fetch live books + trade tape, gate, and score.
  const candidates: RebateMarketCandidate[] = [];
  const skips: Record<string, number> = {};
  const skip = (reason: string): void => {
    skips[reason] = (skips[reason] ?? 0) + 1;
  };

  for (const m of toFetch) {
    const [yesTokenId, noTokenId] = m.clobTokenIds;

    // Price discovery lives on the YES book — gate on it.
    const yesBook = await getClobOrderBook(yesTokenId);
    if (!yesBook) {
      skip('no_yes_book');
      continue;
    }

    // Order-agnostic touch — the REST book puts the best price at the END of
    // each array; bids[0] is the worst bid (see getBookTouch).
    const { bestBid: yesBid, bestAsk: yesAsk } = getBookTouch(yesBook);
    if (yesBid <= 0 || yesAsk <= 0 || yesAsk <= yesBid) {
      skip('hollow_yes_book');
      continue;
    }

    const yesMid = (yesBid + yesAsk) / 2;
    const spreadAbs = yesAsk - yesBid;
    const spreadBps = (spreadAbs / yesMid) * 10_000;

    // Ghost-book gate 1: wide absolute spread means the visible quotes are
    // not where this market trades (audit: NO bid 0.01 / market at 0.85).
    if (spreadAbs > cfg.REBATE_MAX_SPREAD_ABS) {
      skip('spread_too_wide');
      continue;
    }
    // No room to improve the bid.
    if (spreadBps < cfg.REBATE_MIN_SPREAD_BPS) {
      skip('spread_too_tight');
      continue;
    }

    // Recent taker flow — the thing rebates are actually paid on.
    const flow = await fetchRecentMarketFlow(m.conditionId, {
      lookbackHours: cfg.REBATE_FLOW_LOOKBACK_HOURS,
      feeRateBps: cfg.REBATE_FEE_RATE_BPS,
    });
    if (!flow) {
      skip('flow_fetch_failed');
      continue;
    }
    if (flow.takerNotionalUsdPerHour < cfg.REBATE_MIN_FLOW_USD_PER_HOUR) {
      skip('insufficient_flow');
      continue;
    }

    // Ghost-book gate 2: book mid must sit near where trades actually print.
    // Fail closed when the tape carries no usable outcomeIndex: real flow
    // exists (gate above passed) but we cannot verify the book isn't detached
    // from it — warn per market so a data-api schema change that blanks
    // outcomeIndex across the board is visible immediately, not just as an
    // aggregate skip count.
    if (flow.vwapYes === null) {
      logger.warn('[rebate] tape has flow but no usable outcomeIndex — failing closed', {
        marketId: m.marketId,
        conditionId: m.conditionId,
        tradeCount: flow.tradeCount,
      });
      skip('no_usable_vwap');
      continue;
    }
    if (Math.abs(yesMid - flow.vwapYes) > cfg.REBATE_MAX_MID_VWAP_DIVERGENCE) {
      skip('mid_vwap_divergence');
      continue;
    }

    const tick = parseFloat(yesBook.tick_size);
    if (!isFinite(tick) || tick <= 0) {
      skip('bad_tick');
      continue;
    }

    // Build quotes. The NO book is fetched only for post-only clamping — its
    // (often hollow) quotes never drive pricing; the YES mid does.
    const quotes: RebateQuote[] = [];
    const yesQuote = buildQuote('YES', yesTokenId, yesMid, cfg.REBATE_QUOTE_EDGE, tick, yesBid, yesAsk);
    const wantNo = cfg.REBATE_TWO_SIDED || yesMid < 0.5;
    let noQuote: RebateQuote | null = null;
    if (wantNo) {
      const noBook = await getClobOrderBook(noTokenId);
      const { bestBid: noBid, bestAsk: noAsk } = noBook
        ? getBookTouch(noBook)
        : { bestBid: 0, bestAsk: 0 };
      noQuote = buildQuote('NO', noTokenId, 1 - yesMid, cfg.REBATE_QUOTE_EDGE, tick, noBid, noAsk);
    }

    if (cfg.REBATE_TWO_SIDED) {
      // Strict pairs: a fresh market is entered as a PAIR or not at all.
      // Anything less than two quotes under the combined ceiling means the
      // market cannot host a riskless pair right now — skip it entirely
      // (audit P1: the old behavior spliced one side off and quoted the
      // survivor, which is exactly a naked fresh leg).
      if (!yesQuote || !noQuote) {
        skip('no_valid_quote');
        continue;
      }
      if (yesQuote.price + noQuote.price > 1 - cfg.REBATE_MIN_COMBINED_EDGE) {
        skip('combined_above_ceiling');
        continue;
      }
      quotes.push(yesQuote, noQuote);
    } else {
      // Single-sided: quote the majority side (more natural taker flow).
      // Documented-intentional one-sided inventory mode — not pair-farming.
      const single = yesMid >= 0.5 ? yesQuote : noQuote;
      if (single) quotes.push(single);
    }

    if (quotes.length === 0) {
      skip('no_valid_quote');
      continue;
    }

    candidates.push({
      marketId: m.marketId,
      conditionId: m.conditionId,
      question: m.question,
      clobTokenIds: m.clobTokenIds,
      feesEnabled: m.feesEnabled,
      feeType: m.feeType,
      yesMid,
      spreadAbs,
      spreadBps,
      quotes,
      volume: m.volume,
      liquidity: m.liquidity,
      flow,
      rebateShare: makerRebateShare(m.feeType),
      score: flow.feeEquivalentUsdPerHour,
      tickSize: yesBook.tick_size,
      negRisk: yesBook.neg_risk ?? false,
      endDate: m.endDate,
    });
  }

  // Rank by recent fee-equivalent flow — what the rebate pool pays on.
  candidates.sort((a, b) => b.score - a.score);
  const selected = candidates.slice(0, maxMarkets);

  // Selection telemetry (audit P1.3) — one line per selected market.
  for (const c of selected) {
    logger.info('[rebate] candidate selected', {
      marketId: c.marketId,
      question: c.question.slice(0, 60),
      feesEnabled: c.feesEnabled,
      feeType: c.feeType,
      rebateShare: c.rebateShare,
      yesMid: c.yesMid.toFixed(3),
      spreadAbs: c.spreadAbs.toFixed(3),
      quotes: c.quotes.map((q) => `${q.direction}@${q.price.toFixed(3)}`).join(','),
      flowUsdPerHour: c.flow.takerNotionalUsdPerHour.toFixed(0),
      feeEquivUsdPerHour: c.flow.feeEquivalentUsdPerHour.toFixed(3),
      vwapYes: c.flow.vwapYes?.toFixed(3),
      windowH: c.flow.effectiveWindowHours.toFixed(1),
    });
  }

  logger.info('[rebate] market selection complete', {
    universe: universeSource,
    universeSize: markets.length,
    sports: sportsTelemetry,
    preFiltered: preFiltered.length,
    fetched: toFetch.length,
    passedGates: candidates.length,
    selected: selected.length,
    skips,
  });

  return selected;
}
