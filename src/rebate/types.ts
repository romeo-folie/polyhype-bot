/**
 * Types for the rebate farming / passive liquidity provision system.
 */

import type { MarketFlowStats } from './flowAnalyzer.js';

export interface RestingOrder {
  orderId: string;
  marketId: string;
  conditionId: string;
  tokenId: string;
  clobTokenIds: [string, string]; // [yesTokenId, noTokenId]
  direction: 'YES' | 'NO';
  price: number;
  size: number;
  sizeUsd: number;
  placedAt: string; // ISO timestamp
  tickSize: string;
  negRisk: boolean;
  question: string;
  /**
   * Fee parameters captured at placement so fill-time rebate estimates use the
   * rates the order was quoted under. Optional: orders persisted before the
   * 2026-06-05 audit rework lack them (callers fall back to config defaults).
   */
  feeRateBps?: number;
  rebateShare?: number;
}

/** One post-only bid the farmer wants resting on a specific token. */
export interface RebateQuote {
  direction: 'YES' | 'NO';
  tokenId: string;
  /** Target post price — anchored to the effective YES-book mid, not the
   * (possibly hollow) per-token book. */
  price: number;
  /** Physical book for this token at decision time (0 when side empty). */
  bestBid: number;
  bestAsk: number;
}

export interface RebateMarketCandidate {
  marketId: string;
  conditionId: string;
  question: string;
  clobTokenIds: [string, string];
  feesEnabled: boolean;
  feeType: string | null;
  /** Effective mid from the YES book — price discovery lives here; the NO
   * book is often hollow (audit finding 4: NO bid 0.02 vs NO trading 0.85). */
  yesMid: number;
  /** YES-book bestAsk − bestBid (absolute). */
  spreadAbs: number;
  spreadBps: number;
  /** 1 (single-sided) or 2 (two-sided YES+NO) quotes to place. */
  quotes: RebateQuote[];
  volume: number;
  liquidity: number;
  flow: MarketFlowStats;
  /** Maker rebate share for this market's fee category (0.20 crypto / 0.25 rest). */
  rebateShare: number;
  /** Selection score = recent fee-equivalent USD per hour (what rebates pay on). */
  score: number;
  tickSize: string;
  negRisk: boolean;
  endDate: string | null;
}
