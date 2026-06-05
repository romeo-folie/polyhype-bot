/**
 * Recent taker-flow analysis for rebate-market selection.
 *
 * Maker rebates are paid only on FILLED maker liquidity, proportional to the
 * maker's share of executed fee-equivalent liquidity in each market:
 *
 *   fee_equivalent = shares × feeRate × p × (1 − p)
 *
 * So the only markets worth quoting are ones where takers are trading NOW.
 * This module measures that from the public data-api trade tape (no auth):
 *
 *   GET https://data-api.polymarket.com/trades?market=<conditionId>&limit=N
 *
 * The 2026-06-05 audit (docs/issues/maker-rebates-not-earning-2026-06-05.md,
 * finding 4) showed lifetime-volume selection produced 2,204 placed orders and
 * 0 fills — book presence without executed maker liquidity earns nothing.
 */

import { logger } from '../shared/logger.js';
import { fetchWithTimeout } from '../mapping/gamma.js';

const DATA_API_BASE = 'https://data-api.polymarket.com';
const REQUEST_TIMEOUT_MS = 10_000;
/** Max trade rows per market — bounds payload size; ~last few hours on active markets. */
const TRADE_FETCH_LIMIT = 500;
/**
 * Floor for the effective per-hour window. When a market printed its entire
 * fetched tape in the last few minutes, dividing by wall-clock span would
 * inflate flow/hour to absurdity; 15 minutes is the smallest window we trust.
 */
const MIN_EFFECTIVE_WINDOW_HOURS = 0.25;

/** One row of the public data-api trade tape (fields we consume). */
interface DataApiTrade {
  side?: string;
  size?: number;
  price?: number;
  timestamp?: number; // unix seconds
  outcomeIndex?: number; // 0 = YES, 1 = NO
}

export interface MarketFlowStats {
  /** Trades inside the lookback window. */
  tradeCount: number;
  /** Σ size × price over the window (cash actually exchanged). */
  takerNotionalUsd: number;
  takerNotionalUsdPerHour: number;
  /** Σ size × feeRate × p × (1−p) — the quantity rebate pools are built from. */
  feeEquivalentUsd: number;
  feeEquivalentUsdPerHour: number;
  /**
   * Volume-weighted average price in the YES frame (NO trades flipped to
   * 1 − price). Null when no window trade carries a usable outcomeIndex.
   * Used to detect books whose visible quotes detached from printed trades.
   */
  vwapYes: number | null;
  /** Effective window the per-hour figures were computed over. */
  effectiveWindowHours: number;
}

/**
 * Fetch the recent trade tape for a market and reduce it to flow stats.
 * Returns null when the tape cannot be fetched or parsed — callers should
 * treat that as "do not quote" rather than assuming flow exists.
 */
export async function fetchRecentMarketFlow(
  conditionId: string,
  opts: {
    lookbackHours: number;
    feeRateBps: number;
    nowMs?: number;
  },
): Promise<MarketFlowStats | null> {
  const nowMs = opts.nowMs ?? Date.now();

  let rows: DataApiTrade[];
  try {
    const url = `${DATA_API_BASE}/trades?market=${conditionId}&limit=${TRADE_FETCH_LIMIT.toString()}`;
    const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
    if (!res.ok) {
      logger.warn('[rebate] trade tape fetch failed', {
        conditionId,
        status: res.status,
      });
      return null;
    }
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return null;
    rows = data as DataApiTrade[];
  } catch (err) {
    logger.warn('[rebate] trade tape fetch error', {
      conditionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const windowStartS = nowMs / 1000 - opts.lookbackHours * 3600;
  const feeRate = opts.feeRateBps / 10_000;

  let tradeCount = 0;
  let notional = 0;
  let feeEquivalent = 0;
  let vwapNotional = 0;
  let vwapWeightedSum = 0;
  let oldestTsS = Infinity;

  for (const t of rows) {
    const ts = t.timestamp;
    const size = t.size;
    const price = t.price;
    if (typeof ts !== 'number' || !isFinite(ts) || ts < windowStartS) continue;
    if (typeof size !== 'number' || !isFinite(size) || size <= 0) continue;
    if (typeof price !== 'number' || !isFinite(price) || price <= 0 || price >= 1) continue;

    tradeCount++;
    if (ts < oldestTsS) oldestTsS = ts;
    const rowNotional = size * price;
    notional += rowNotional;
    // p(1−p) is symmetric, so the YES/NO frame of `price` doesn't matter here.
    feeEquivalent += size * feeRate * price * (1 - price);

    // VWAP needs a consistent frame — flip NO prints to the YES frame.
    if (t.outcomeIndex === 0 || t.outcomeIndex === 1) {
      const yesPrice = t.outcomeIndex === 0 ? price : 1 - price;
      vwapWeightedSum += yesPrice * rowNotional;
      vwapNotional += rowNotional;
    }
  }

  // When the fetched tape is full (hit the limit) the oldest row may be newer
  // than the lookback start — per-hour rates must use the span we actually
  // observed, not the requested window, or active markets get understated.
  let effectiveWindowHours = opts.lookbackHours;
  if (rows.length >= TRADE_FETCH_LIMIT && tradeCount > 0 && isFinite(oldestTsS)) {
    effectiveWindowHours = Math.min(opts.lookbackHours, (nowMs / 1000 - oldestTsS) / 3600);
  }
  effectiveWindowHours = Math.max(effectiveWindowHours, MIN_EFFECTIVE_WINDOW_HOURS);

  return {
    tradeCount,
    takerNotionalUsd: notional,
    takerNotionalUsdPerHour: notional / effectiveWindowHours,
    feeEquivalentUsd: feeEquivalent,
    feeEquivalentUsdPerHour: feeEquivalent / effectiveWindowHours,
    vwapYes: vwapNotional > 0 ? vwapWeightedSum / vwapNotional : null,
    effectiveWindowHours,
  };
}

/**
 * Maker rebate share for a market's fee category, per current Polymarket docs
 * (https://docs.polymarket.com/market-makers/maker-rebates): crypto 20%, all
 * other fee-enabled categories 25%. Geopolitics markets are fee-free —
 * feesEnabled=false — so they never reach this function through selection;
 * a null/unknown feeType on a fee-enabled market gets the common 25%.
 */
export function makerRebateShare(feeType: string | null | undefined): number {
  if (feeType?.toLowerCase().startsWith('crypto')) return 0.20;
  return 0.25;
}

/**
 * Estimated rebate accrual for one maker fill, in USD:
 *   shares × feeRate × p × (1−p) × rebateShare
 * This is an estimate — the actual daily payout is pool/share based per market.
 */
export function estimateFillRebateUsd(
  shares: number,
  price: number,
  feeRateBps: number,
  rebateShare: number,
): number {
  if (!isFinite(shares) || shares <= 0) return 0;
  if (!isFinite(price) || price <= 0 || price >= 1) return 0;
  return shares * (feeRateBps / 10_000) * price * (1 - price) * rebateShare;
}
