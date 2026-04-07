/**
 * CME settlement arb scanner.
 *
 * Detects drift between Yahoo front-month commodity futures (gold, silver,
 * crude oil — see SPOT_COMMODITY_ASSETS) and PM markets that resolve against
 * the same daily settlement fix. Designed to fire in the 5-minute window
 * before the settlement print, where the front-month future is the best
 * available oracle proxy.
 *
 * Resolution math:
 *   Binary cutoff (e.g. "Gold above $X on YYYY-MM-DD?"):
 *     implied_prob = sigmoid((spot - cutoff) / smoothing_band)
 *   Over/under (same shape today — kept simple, refined when live).
 *
 * Reuses:
 *   - spot:last:{assetId}        (poller-populated ticker)
 *   - watchlist:market_cache     (Gamma local cache)
 *   - executeSignal()            (full execution pipeline)
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getCachedMarkets } from '../shared/watchlist.js';
import { executeSignal } from '../execution/executor.js';
import { parseClobTokenIds } from '../mapping/gamma.js';
import type { GammaMarket } from '../mapping/gamma.js';
import type { TradeSignal } from '../mapping/index.js';

interface CommodityKeywordSpec {
  ticker: string;        // Yahoo symbol stored in spot:last:{ticker}
  keywords: string[];    // lowercase substrings to look for in market.question
}

const COMMODITY_KEYWORDS: CommodityKeywordSpec[] = [
  { ticker: 'GC=F', keywords: ['gold'] },
  { ticker: 'SI=F', keywords: ['silver'] },
  { ticker: 'CL=F', keywords: ['crude', 'oil', 'wti'] },
];

const PRICE_REGEX = /\$?\s*([0-9]+(?:[,_][0-9]{3})*(?:\.[0-9]+)?)/g;

interface SpotLast {
  price: number;
  timestamp: number;
}

async function readSpotLast(redis: Redis, ticker: string): Promise<SpotLast | null> {
  const raw = await redis.get(`spot:last:${ticker}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { price?: unknown; timestamp?: unknown };
    if (typeof parsed.price !== 'number' || typeof parsed.timestamp !== 'number') return null;
    return { price: parsed.price, timestamp: parsed.timestamp };
  } catch {
    return null;
  }
}

interface MarketImplied {
  market: GammaMarket;
  ticker: string;
  spot: number;
  cutoff: number;
  impliedYesProb: number;
  marketYesPrice: number;
  edge: number;     // signed: positive => YES underpriced
  direction: 'YES' | 'NO';
}

/** Extract the first plausible $-denominated number from a question string. */
export function extractCutoffPrice(question: string): number | null {
  PRICE_REGEX.lastIndex = 0;
  const matches: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = PRICE_REGEX.exec(question)) !== null) {
    const cleaned = (m[1] ?? '').replace(/[,_]/g, '');
    const n = parseFloat(cleaned);
    if (Number.isFinite(n) && n > 1) matches.push(n);
  }
  return matches[0] ?? null;
}

/**
 * Sigmoid-smoothed binary resolution probability.
 * Smoothing band defaults to 0.3% of the cutoff (tight — these print fast).
 */
export function impliedYesProb(spot: number, cutoff: number, bandPct = 0.003): number {
  if (!Number.isFinite(spot) || !Number.isFinite(cutoff) || cutoff <= 0) return 0.5;
  const band = cutoff * bandPct;
  if (band <= 0) return spot >= cutoff ? 1 : 0;
  const z = (spot - cutoff) / band;
  return 1 / (1 + Math.exp(-z));
}

function parseYesPrice(market: GammaMarket): number | null {
  const op = market.outcomePrices;
  if (!op) return null;
  let arr: unknown = op;
  if (typeof op === 'string') {
    try {
      arr = JSON.parse(op);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const first = arr[0];
  const n = typeof first === 'string' ? parseFloat(first) : typeof first === 'number' ? first : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Pure logic: scan a list of markets and current spot tickers and emit any
 * settlement-arb opportunities that clear the edge gate. Exposed for testing.
 */
export function detectOpportunities(
  markets: GammaMarket[],
  spotByTicker: Map<string, SpotLast>,
  cfg: { SETTLEMENT_MIN_EDGE: number },
  now = Date.now(),
): MarketImplied[] {
  const out: MarketImplied[] = [];
  const horizonMs = 24 * 60 * 60 * 1000;

  for (const m of markets) {
    if (!m.endDate) continue;
    const end = new Date(m.endDate).getTime();
    if (!Number.isFinite(end)) continue;
    if (end < now) continue; // expired
    if (end - now > horizonMs) continue; // > 24h out

    const q = (m.question ?? '').toLowerCase();
    const spec = COMMODITY_KEYWORDS.find((c) => c.keywords.some((k) => q.includes(k)));
    if (!spec) continue;

    const spot = spotByTicker.get(spec.ticker);
    if (!spot) continue;

    const cutoff = extractCutoffPrice(m.question ?? '');
    if (cutoff === null) continue;

    const impliedYes = impliedYesProb(spot.price, cutoff);
    const yesPrice = parseYesPrice(m);
    if (yesPrice === null) continue;

    const signedEdge = impliedYes - yesPrice;
    const absEdge = Math.abs(signedEdge);
    if (absEdge < cfg.SETTLEMENT_MIN_EDGE) continue;

    out.push({
      market: m,
      ticker: spec.ticker,
      spot: spot.price,
      cutoff,
      impliedYesProb: impliedYes,
      marketYesPrice: yesPrice,
      edge: signedEdge,
      direction: signedEdge > 0 ? 'YES' : 'NO',
    });
  }
  return out;
}

function buildSignal(opp: MarketImplied, cfg: { SETTLEMENT_MAX_STAKE_USD: number }): TradeSignal {
  const stake = Math.max(0, cfg.SETTLEMENT_MAX_STAKE_USD);
  const outcomePrice =
    opp.direction === 'YES' ? opp.marketYesPrice : 1 - opp.marketYesPrice;
  const consensusProb =
    opp.direction === 'YES' ? opp.impliedYesProb : 1 - opp.impliedYesProb;
  let clobTokenIds: string[] | undefined;
  if (opp.market.clobTokenIds) {
    try {
      clobTokenIds = parseClobTokenIds(opp.market.clobTokenIds);
    } catch {
      clobTokenIds = undefined;
    }
  }
  const signal: TradeSignal = {
    marketId: String(opp.market.id),
    conditionId: opp.market.conditionId,
    question: opp.market.question,
    direction: opp.direction,
    stakeUsd: stake,
    edgeMagnitude: Math.abs(opp.edge),
    consensusProbability: consensusProb,
    outcomePrice,
    sourcedFrom: `settlement:${opp.ticker}`,
    reasoning: `Settlement arb: spot=${opp.spot.toFixed(2)} cutoff=${opp.cutoff.toFixed(2)} impliedYes=${opp.impliedYesProb.toFixed(3)} marketYes=${opp.marketYesPrice.toFixed(3)}`,
    source: 'spot',
  };
  if (clobTokenIds) signal.clobTokenIds = clobTokenIds;
  if (opp.market.feesEnabled !== undefined) signal.feesEnabled = opp.market.feesEnabled;
  if (opp.market.endDate) signal.endDate = opp.market.endDate;
  return signal;
}

export interface SettlementScanResult {
  opportunities: number;
  emitted: number;
  loggedOnly: boolean;
}

export async function scanSettlementArb(redis: Redis): Promise<SettlementScanResult> {
  const cfg = loadConfig();
  const markets = await getCachedMarkets(redis);
  if (markets.length === 0) {
    return { opportunities: 0, emitted: 0, loggedOnly: !cfg.SETTLEMENT_ARB_ENABLED };
  }

  const spotByTicker = new Map<string, SpotLast>();
  for (const spec of COMMODITY_KEYWORDS) {
    const sp = await readSpotLast(redis, spec.ticker);
    if (sp) spotByTicker.set(spec.ticker, sp);
  }

  const opps = detectOpportunities(markets, spotByTicker, cfg);

  if (opps.length === 0) {
    logger.info('[settlement-arb] no opportunities', {
      marketsScanned: markets.length,
      tickersAvailable: spotByTicker.size,
    });
    return { opportunities: 0, emitted: 0, loggedOnly: !cfg.SETTLEMENT_ARB_ENABLED };
  }

  let emitted = 0;
  for (const opp of opps) {
    logger.info('[settlement-arb] opportunity', {
      marketId: opp.market.id,
      ticker: opp.ticker,
      spot: opp.spot,
      cutoff: opp.cutoff,
      impliedYes: opp.impliedYesProb,
      marketYes: opp.marketYesPrice,
      edge: opp.edge,
      direction: opp.direction,
      enabled: cfg.SETTLEMENT_ARB_ENABLED,
    });
    if (!cfg.SETTLEMENT_ARB_ENABLED) continue;

    const signal = buildSignal(opp, cfg);
    try {
      await executeSignal(signal, redis);
      emitted++;
    } catch (err: unknown) {
      logger.error('[settlement-arb] executeSignal failed', {
        marketId: signal.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { opportunities: opps.length, emitted, loggedOnly: !cfg.SETTLEMENT_ARB_ENABLED };
}
