/**
 * Crypto latency arbitrage scanner.
 *
 * Maps spot price moves to correlated Polymarket price-target markets,
 * computes fair value via Black-Scholes formula (no LLM), and returns
 * actionable opportunities when edge > CRYPTO_ARB_MIN_EDGE.
 */

import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getPriceFeed } from '../shared/feedSingleton.js';
import { findCorrelatedMarkets, type CorrelatedMarket } from '../spot/marketCorrelator.js';
import { estimateFastConsensus } from '../spot/fastPathConsensus.js';
import { getBankroll } from '../shared/bankroll.js';
import type { SpotMove } from '../spot/thresholdDetector.js';
import type { Redis } from 'ioredis';

export interface CryptoArbOpportunity {
  marketId: string;
  conditionId: string;
  clobTokenIds: string[];
  question: string;
  direction: 'YES' | 'NO';
  tokenId: string;
  currentPmPrice: number;
  fairValuePrice: number;
  edge: number;
  stakeUsd: number;
  assetId: string;
}

/** Asset-specific search queries for Gamma API. */
export const CRYPTO_ASSET_SEARCH_QUERIES: Record<string, string[]> = {
  bitcoin: ['bitcoin', 'BTC'],
  ethereum: ['ethereum', 'ETH'],
  solana: ['solana', 'SOL'],
  ripple: ['XRP', 'ripple'],
  binancecoin: ['BNB', 'binance coin'],
  bittensor: ['TAO', 'bittensor'],
  dogecoin: ['dogecoin', 'DOGE'],
  cardano: ['cardano', 'ADA'],
  avalanche: ['avalanche', 'AVAX'],
  chainlink: ['chainlink', 'LINK'],
  'shiba-inu': ['SHIB', 'shiba'],
  sui: ['SUI'],
  pepe: ['PEPE'],
};

/** Binance WebSocket symbol → CoinGecko asset ID mapping. */
export const BINANCE_SYMBOL_TO_ASSET: Record<string, string> = {
  btcusdt: 'bitcoin',
  ethusdt: 'ethereum',
  solusdt: 'solana',
  xrpusdt: 'ripple',
  bnbusdt: 'binancecoin',
  taousdt: 'bittensor',
  dogeusdt: 'dogecoin',
  adausdt: 'cardano',
  avaxusdt: 'avalanche',
  linkusdt: 'chainlink',
  suiusdt: 'sui',
  shibusdt: 'shiba-inu',
  pepeusdt: 'pepe',
};

const MARKET_CACHE_PREFIX = 'crypto:markets:';
const DEDUP_PREFIX = 'arb:crypto:';

/**
 * Scan for crypto latency arb opportunities triggered by a spot price move.
 */
export async function scanCryptoArb(
  move: SpotMove,
  redis: Redis,
): Promise<CryptoArbOpportunity[]> {
  const cfg = loadConfig();

  if (!cfg.CRYPTO_ARB_ENABLED) {
    return [];
  }

  // Unknown asset — no search queries mapped
  const queries = CRYPTO_ASSET_SEARCH_QUERIES[move.assetId];
  if (!queries) {
    logger.debug('[crypto-arb] unknown asset, skipping', { assetId: move.assetId });
    return [];
  }

  // 1. Resolve correlated markets (cached in Redis)
  const cacheKey = `${MARKET_CACHE_PREFIX}${move.assetId}`;
  let markets;

  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as unknown;
      // Validate shape: must be an array of objects with at minimum marketId + conditionId.
      if (
        Array.isArray(parsed) &&
        (parsed.length === 0 ||
          (typeof (parsed[0] as Record<string, unknown>)['marketId'] === 'string' &&
           typeof (parsed[0] as Record<string, unknown>)['conditionId'] === 'string'))
      ) {
        markets = parsed as CorrelatedMarket[];
      } else {
        logger.warn('[crypto-arb] cached market data has unexpected shape — discarding');
        markets = null;
        await redis.del(cacheKey);
      }
    } catch {
      markets = null;
    }
  }

  if (!markets) {
    markets = await findCorrelatedMarkets(move);
    if (markets.length > 0) {
      await redis.set(cacheKey, JSON.stringify(markets), 'EX', cfg.CRYPTO_ARB_MARKET_CACHE_TTL_S);
    }
  }

  const feeRate = cfg.ARB_FEE_RATE;
  const minEdge = cfg.CRYPTO_ARB_MIN_EDGE;
  const opportunities: CryptoArbOpportunity[] = [];

  const feed = getPriceFeed(redis);

  for (const market of markets) {
    try {
      // 2. Get current PM YES price (WS cache → fallback to struct)
      const wsPrice = await feed.getCachedPrice(market.marketId);
      const currentPmPrice = wsPrice ?? market.currentYesPrice;
      if (!isFinite(currentPmPrice) || currentPmPrice <= 0 || currentPmPrice >= 1) continue;

      // 3. Estimate fair value via BS formula (no LLM for price-target markets)
      const consensus = await estimateFastConsensus(move, market);
      const fairValue = consensus.probability;

      // 4. Compute edge and direction
      const rawEdge = Math.abs(fairValue - currentPmPrice);
      const netEdge = rawEdge - feeRate;

      if (netEdge < minEdge) continue;

      let direction: 'YES' | 'NO';
      if (fairValue > currentPmPrice + feeRate) {
        direction = 'YES';
      } else if (fairValue < currentPmPrice - feeRate) {
        direction = 'NO';
      } else {
        continue;
      }

      // 5. Dedup check
      const dedupKey = `${DEDUP_PREFIX}${market.marketId}:${direction}`;
      const deduped = await redis.get(dedupKey);
      if (deduped) continue;

      // 6. Edge-scaled fixed-fraction sizing
      const bankroll = await getBankroll(redis);
      const kellyStake = bankroll * netEdge * cfg.CRYPTO_ARB_MAX_STAKE_FRACTION;
      const maxStake = cfg.MAX_BET_FRACTION * bankroll;
      const stakeUsd = Math.min(kellyStake, maxStake);

      if (stakeUsd < 0.01) continue;

      // Resolve tokenId: YES = clobTokenIds[0], NO = clobTokenIds[1]
      const tokenId = direction === 'YES'
        ? (market.clobTokenIds?.[0] ?? '')
        : (market.clobTokenIds?.[1] ?? '');

      opportunities.push({
        marketId: market.marketId,
        conditionId: market.conditionId,
        clobTokenIds: market.clobTokenIds,
        question: market.question,
        direction,
        tokenId,
        currentPmPrice,
        fairValuePrice: fairValue,
        edge: netEdge,
        stakeUsd,
        assetId: move.assetId,
      });
    } catch (err) {
      logger.warn('[crypto-arb] error processing market', {
        marketId: market.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Sort by edge descending
  opportunities.sort((a, b) => b.edge - a.edge);

  if (opportunities.length > 0) {
    logger.info('[crypto-arb] opportunities found', {
      assetId: move.assetId,
      count: opportunities.length,
      topEdge: opportunities[0]!.edge.toFixed(4),
    });
  }

  return opportunities;
}
