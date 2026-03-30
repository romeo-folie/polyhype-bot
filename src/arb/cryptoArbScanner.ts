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
import { scoreConfluence } from './confluenceScorer.js';
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
 * Compute mean absolute percentage change (MAPC) over the last `periods` ticks.
 * Uses `spot:prices:<symbol>` sorted set (members stored as "ts:price").
 * Invalid entries are forward-filled to preserve tick order and avoid phantom vol spikes.
 * Returns null if insufficient data.
 * Exported for unit testing.
 */
export async function computeVolatility(symbol: string, redis: Redis, periods = 14): Promise<number | null> {
  // Retrieve the last (periods + 1) price records — need N+1 to compute N returns.
  const key = `spot:prices:${symbol}`;
  const entries = await redis.zrange(key, -(periods + 1), -1);
  if (entries.length < 2) return null;

  // Parse and forward-fill invalid entries so gaps don't create phantom price jumps.
  const prices: number[] = [];
  for (const e of entries) {
    const p = parseFloat(e.split(':')[1] ?? '0');
    if (isFinite(p) && p > 0) {
      prices.push(p);
    } else if (prices.length > 0) {
      prices.push(prices[prices.length - 1]!); // forward-fill
    }
    // If prices is still empty (first entry is invalid), skip
  }

  if (prices.length < 2) return null;

  let sumAbsChange = 0;
  for (let i = 1; i < prices.length; i++) {
    sumAbsChange += Math.abs((prices[i]! - prices[i - 1]!) / prices[i - 1]!);
  }
  return sumAbsChange / (prices.length - 1); // mean absolute % change
}

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

  // Volatility gate: skip if market is too flat (no edge) or too spiky (unpredictable)
  // Uses the symbol from the SpotMove — maps assetId back to Binance symbol
  let confluenceDirection: 'UP' | 'DOWN' | 'NEUTRAL' | undefined;  // Captured for direction filter in market loop

  // Extract symbol once for both gates (avoid duplicate lookups)
  const symbol = Object.entries(BINANCE_SYMBOL_TO_ASSET).find(([, v]) => v === move.assetId)?.[0];

  if (cfg.CRYPTO_ARB_VOLATILITY_GATE_ENABLED && symbol) {
    const volatility = await computeVolatility(symbol, redis);
    if (volatility !== null) {
      if (volatility < cfg.CRYPTO_ARB_MIN_VOLATILITY) {
        logger.debug('[crypto-arb] volatility below floor — skipping (flat market)', {
          assetId: move.assetId,
          symbol,
          volatility: volatility.toFixed(6),
          floor: cfg.CRYPTO_ARB_MIN_VOLATILITY,
        });
        return [];
      }
      if (volatility > cfg.CRYPTO_ARB_MAX_VOLATILITY) {
        logger.debug('[crypto-arb] volatility above ceiling — skipping (too spiky)', {
          assetId: move.assetId,
          symbol,
          volatility: volatility.toFixed(6),
          ceiling: cfg.CRYPTO_ARB_MAX_VOLATILITY,
        });
        return [];
      }
    }
  }

  // Confluence gate — BTC only, configurable
  if (cfg.CONFLUENCE_GATE_ENABLED && move.assetId === 'bitcoin' && symbol) {
    const confluence = await scoreConfluence(symbol, redis);
    if (confluence.score < cfg.CRYPTO_ARB_MIN_CONFLUENCE_SCORE) {
      // Cold start (score=0, no signals) warrants higher log level for ops visibility
      const isWarmingUp = confluence.score === 0 && Object.keys(confluence.signals).length === 0;
      const logLevel = isWarmingUp ? 'warn' : 'debug';
      logger[logLevel]('[crypto-arb] insufficient indicator confluence — skipping', {
        score: confluence.score,
        direction: confluence.direction,
        signals: confluence.signals,
        assetId: move.assetId,
        reason: isWarmingUp ? 'cold_start_no_indicator_data' : 'conflicting_signals',
      });
      return [];
    }
    // Direction filter: only evaluate YES when bullish, NO when bearish
    confluenceDirection = confluence.direction;
    logger.debug('[crypto-arb] confluence gate passed', {
      score: confluence.score,
      direction: confluence.direction,
      signals: confluence.signals,
      assetId: move.assetId,
    });
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

  // Fetch bankroll once before the loop — avoids a Redis round-trip per market.
  const bankroll = await getBankroll(redis);

  const feed = getPriceFeed(redis);

  for (const market of markets) {
    try {
      // 2. Get current PM YES price (WS cache → fallback to struct)
      const wsPrice = await feed.getCachedPrice(market.marketId);
      const currentPmPrice = wsPrice ?? market.currentYesPrice;
      if (!isFinite(currentPmPrice) || currentPmPrice <= 0 || currentPmPrice >= 1) continue;

      // 3. Estimate fair value via BS formula (no LLM for price-target markets)
      const consensus = await estimateFastConsensus(move, market);

      if (consensus.method === 'llm') {
        logger.debug('[crypto-arb] skipping non-price-target market — LLM path not used in fast arb', {
          marketId: market.marketId,
          question: market.question.slice(0, 80),
        });
        continue;
      }

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

      // Direction alignment with confluence
      // Assumes markets are positively correlated with BTC (e.g., "Will BTC exceed $100k?")
      // For negatively correlated markets, this filter would need inversion
      if (confluenceDirection && confluenceDirection !== 'NEUTRAL') {
        const expectUp = confluenceDirection === 'UP';
        if (direction === 'YES' && !expectUp) {
          logger.debug('[crypto-arb] direction mismatch — confluence bearish, edge bullish — skipping', {
            marketId: market.marketId,
            direction,
            confluenceDirection,
          });
          continue;
        }
        if (direction === 'NO' && expectUp) {
          logger.debug('[crypto-arb] direction mismatch — confluence bullish, edge bearish — skipping', {
            marketId: market.marketId,
            direction,
            confluenceDirection,
          });
          continue;
        }
      }

      // 5. Dedup check
      const dedupKey = `${DEDUP_PREFIX}${market.marketId}:${direction}`;
      const deduped = await redis.get(dedupKey);
      if (deduped) continue;

      // 6. Edge-scaled fixed-fraction sizing
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
