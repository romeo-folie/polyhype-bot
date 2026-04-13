/**
 * Types for the rebate farming / passive liquidity provision system.
 */

export interface RestingOrder {
  orderId: string;
  marketId: string;
  conditionId: string;
  tokenId: string;
  direction: 'YES' | 'NO';
  price: number;
  size: number;
  sizeUsd: number;
  placedAt: string; // ISO timestamp
  tickSize: string;
  negRisk: boolean;
  question: string;
}

export interface RebateMarketCandidate {
  marketId: string;
  conditionId: string;
  question: string;
  clobTokenIds: string[];
  direction: 'YES' | 'NO';
  tokenId: string;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  midPrice: number;
  volume: number;
  liquidity: number;
  score: number;
  tickSize: string;
  negRisk: boolean;
  endDate: string | null;
}
