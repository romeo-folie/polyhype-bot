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
import { recordCryptoArbGate } from '../shared/telemetry.js';
import { scoreConfluence } from './confluenceScorer.js';
import { resolveHlSymbol } from '../shared/hyperliquid.js';
import { listRecentCryptoEvents, parseClobTokenIds, parseOutcomePrices, parseOutcomes } from '../mapping/gamma.js';
import type { SpotMove } from '../spot/thresholdDetector.js';
import type { Redis } from 'ioredis';

export interface CryptoArbOpportunity {
  marketId: string;
  conditionId: string;
  clobTokenIds: string[];
  question: string;
  direction: 'YES' | 'NO' | 'UP' | 'DOWN';
  tokenId: string;
  currentPmPrice: number;
  fairValuePrice: number;
  edge: number;
  stakeUsd: number;
  assetId: string;
  /** True when the market has fees enabled — executor will skip CLOB submission */
  feesEnabled: boolean;
  volatility?: number | undefined;
  spreadBps?: number | undefined;
  /** The correlated Hyperliquid asset symbol, if available for hedging */
  hlSymbol?: string | undefined;
  endDate?: string | null | undefined;
}

import { ASSET_SEARCH_QUERIES, BINANCE_SYMBOL_TO_ASSET } from '../shared/assets.js';

const MARKET_CACHE_PREFIX = 'crypto:markets:';
const DEDUP_PREFIX = 'arb:crypto:';

/**
 * Compute mean absolute percentage change (MAPC) over the last `periods` ticks.
 * Uses `spot:prices:<symbol>` sorted set (members stored as "ts:price").
 * Invalid entries are forward-filled to preserve tick order and avoid phantom vol spikes.
 * Returns null if insufficient data.
 * Exported for unit testing.
 */
export async function computeVolatility(
  symbol: string,
  redis: Redis,
  periods = 14,
): Promise<number | null> {
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
    } else {
      const last = prices[prices.length - 1];
      if (last !== undefined) prices.push(last); // forward-fill
    }
    // If prices is still empty (first entry is invalid), skip
  }

  if (prices.length < 2) return null;

  let sumAbsChange = 0;
  for (let i = 1; i < prices.length; i++) {
    const curr = prices[i];
    const prev = prices[i - 1];
    if (curr !== undefined && prev !== undefined && prev !== 0) {
      sumAbsChange += Math.abs((curr - prev) / prev);
    }
  }
  return sumAbsChange / (prices.length - 1); // mean absolute % change
}

/**
 * Scan for crypto latency arb opportunities triggered by a spot price move.
 */
export async function scanCryptoArb(move: SpotMove, redis: Redis): Promise<CryptoArbOpportunity[]> {
  const cfg = loadConfig();

  if (!cfg.CRYPTO_ARB_ENABLED) {
    await recordCryptoArbGate(redis, 'disabled');
    return [];
  }

  // Extract symbol once for both gates (avoid duplicate lookups)
  const symbol = Object.entries(BINANCE_SYMBOL_TO_ASSET).find(([, v]) => v === move.assetId)?.[0];

  let dynamicAnnualVol: number | undefined;
  if (symbol) {
    const mapc = await computeVolatility(symbol, redis);
    if (mapc !== null) {
      // Annualise 1-minute MAPC: MAPC * sqrt(minutes_per_year)
      // sqrt(365.25 * 24 * 60) ≈ 725.23
      dynamicAnnualVol = mapc * 725.23;

      if (cfg.CRYPTO_ARB_VOLATILITY_GATE_ENABLED) {
        if (mapc < cfg.CRYPTO_ARB_MIN_VOLATILITY) {
          logger.debug('[crypto-arb] volatility below floor — skipping (flat market)', {
            assetId: move.assetId,
            symbol,
            volatility: mapc.toFixed(6),
            floor: cfg.CRYPTO_ARB_MIN_VOLATILITY,
          });
          await recordCryptoArbGate(redis, 'volatility_floor');
          return [];
        }
        if (mapc > cfg.CRYPTO_ARB_MAX_VOLATILITY) {
          logger.debug('[crypto-arb] volatility above ceiling — skipping (too spiky)', {
            assetId: move.assetId,
            symbol,
            volatility: mapc.toFixed(6),
            ceiling: cfg.CRYPTO_ARB_MAX_VOLATILITY,
          });
          await recordCryptoArbGate(redis, 'volatility_ceiling');
          return [];
        }
      }
    }
  }

  let confluenceDirection: 'UP' | 'DOWN' | 'NEUTRAL' | undefined;

  // Confluence gate — BTC only, configurable
  if (cfg.CONFLUENCE_GATE_ENABLED && move.assetId === 'bitcoin' && symbol) {
    const confluence = await scoreConfluence(symbol, redis);
    if (confluence.score < cfg.CRYPTO_ARB_MIN_CONFLUENCE_SCORE) {
      // Cold start (score=0, no signals) warrants higher log level for ops visibility
      const isWarmingUp = confluence.score === 0 && Object.keys(confluence.signals).length === 0;
      // Cold start produces a high volume of fires (every 5s for ~26 min) — keep at debug
      // to avoid warn log flooding during the warmup window.
      logger.debug('[crypto-arb] insufficient indicator confluence — skipping', {
        score: confluence.score,
        direction: confluence.direction,
        signals: confluence.signals,
        assetId: move.assetId,
        reason: isWarmingUp ? 'cold_start_no_indicator_data' : 'conflicting_signals',
      });
      await recordCryptoArbGate(redis, 'confluence_block');
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

  const queries = ASSET_SEARCH_QUERIES[move.assetId];
  if (!queries) {
    logger.debug('[crypto-arb] unknown asset, skipping', { assetId: move.assetId });
    await recordCryptoArbGate(redis, 'unknown_asset');
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
          (typeof (parsed[0] as Record<string, unknown>).marketId === 'string' &&
            typeof (parsed[0] as Record<string, unknown>).conditionId === 'string'))
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
    // Check for active Gamma backoff (set on 429 or repeated empty results)
    const backoffKey = `${MARKET_CACHE_PREFIX}backoff:${move.assetId}`;
    const backoff = await redis.get(backoffKey);
    if (backoff) {
      logger.debug('[crypto-arb] Gamma backoff active — skipping market lookup', {
        assetId: move.assetId,
      });
      await recordCryptoArbGate(redis, 'gamma_backoff');
      return [];
    }

    try {
      markets = await findCorrelatedMarkets(move);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const is429 = msg.includes('429');
      const backoffTtl = is429 ? 300 : 60; // 5 min on 429, 1 min on other errors
      await redis.set(backoffKey, '1', 'EX', backoffTtl);
      logger.warn('[crypto-arb] Gamma market lookup failed — backing off', {
        assetId: move.assetId,
        error: msg,
        backoffSeconds: backoffTtl,
      });
      await recordCryptoArbGate(redis, 'gamma_lookup_error');
      return [];
    }

    // Cache results regardless of length — empty result is valid and prevents
    // hammering Gamma on every tick when no markets match the asset.
    // Use a shorter TTL for empty results so we retry sooner.
    const ttl = markets.length > 0 ? cfg.CRYPTO_ARB_MARKET_CACHE_TTL_S : 120;
    await redis.set(cacheKey, JSON.stringify(markets), 'EX', ttl);
  }

  if (!markets || markets.length === 0) {
    await recordCryptoArbGate(redis, 'no_correlated_market');
    return [];
  }

  const feeRate = cfg.ARB_FEE_RATE;
  const minEdge = cfg.CRYPTO_ARB_MIN_EDGE;
  const opportunities: CryptoArbOpportunity[] = [];

  // Fetch bankroll once before the loop — avoids a Redis round-trip per market.
  const bankroll = await getBankroll(redis);

  const feed = getPriceFeed(redis);

  for (const market of markets) {
    try {
      // 2a. Fee markets: the fee rate is already subtracted from netEdge below
      // via ARB_FEE_RATE, so markets that pass the min edge gate have already
      // cleared the fee hurdle. No need to skip them unconditionally.

      // 2b. Get current PM YES price (WS cache → fallback to struct)
      const wsPrice = await feed.getCachedPrice(market.marketId);
      const currentPmPrice = wsPrice ?? market.currentYesPrice;
      if (!isFinite(currentPmPrice) || currentPmPrice <= 0 || currentPmPrice >= 1) {
        await recordCryptoArbGate(redis, 'invalid_price');
        continue;
      }

      // 3. Estimate fair value via BS formula (no LLM for price-target markets)
      // Pass dynamic annualised volatility if available (calculated from recent candles).
      const consensus = await estimateFastConsensus(move, market, dynamicAnnualVol);

      if (consensus.method === 'llm') {
        logger.debug(
          '[crypto-arb] skipping non-price-target market — LLM path not used in fast arb',
          {
            marketId: market.marketId,
            question: market.question.slice(0, 80),
          },
        );
        await recordCryptoArbGate(redis, 'non_price_target');
        continue;
      }

      const fairValue = consensus.probability;

      // 4. Compute edge and direction
      const rawEdge = Math.abs(fairValue - currentPmPrice);

      // Dynamic spread buffer: account for current bid-ask spread from WS.
      // Helps avoid entering trades where the "edge" is just the market spread.
      const wsSpread = await feed.getCachedSpread(market.marketId);
      const spreadBuffer = wsSpread ?? 0;

      const netEdge = rawEdge - feeRate - spreadBuffer;

      if (netEdge < minEdge) {
        if (rawEdge - feeRate >= minEdge) {
          // Edge existed but was eliminated by spread buffer.
          await recordCryptoArbGate(redis, 'spread_block');
          logger.debug('[crypto-arb] edge eliminated by spread buffer', {
            marketId: market.marketId,
            rawEdge: rawEdge.toFixed(4),
            spread: spreadBuffer.toFixed(4),
            netEdge: netEdge.toFixed(4),
          });
        } else {
          await recordCryptoArbGate(redis, 'min_edge');
        }
        continue;
      }

      let direction: 'YES' | 'NO';
      if (fairValue > currentPmPrice + feeRate) {
        direction = 'YES';
      } else if (fairValue < currentPmPrice - feeRate) {
        direction = 'NO';
      } else {
        continue;
      }

      // Direction alignment with confluence.
      // For positive correlation (BTC up → YES more likely): confluence UP → expect YES.
      // For negative correlation (BTC up → YES less likely): confluence UP → expect NO.
      if (confluenceDirection && confluenceDirection !== 'NEUTRAL') {
        const isPositiveCorrelation = market.correlationDirection !== 'negative';
        const confluenceUp = confluenceDirection === 'UP';
        // Effective expected direction after accounting for correlation sign.
        const expectYes = isPositiveCorrelation ? confluenceUp : !confluenceUp;
        const directionAligned = (direction === 'YES') === expectYes;
        if (!directionAligned) {
          logger.debug(
            '[crypto-arb] direction mismatch — confluence vs edge after correlation adjustment — skipping',
            {
              marketId: market.marketId,
              direction,
              confluenceDirection,
              correlationDirection: market.correlationDirection,
            },
          );
          await recordCryptoArbGate(redis, 'direction_mismatch');
          continue;
        }
      }

      // 5. Dedup check
      const dedupKey = `${DEDUP_PREFIX}${market.marketId}:${direction}`;
      const deduped = await redis.get(dedupKey);
      if (deduped) {
        await recordCryptoArbGate(redis, 'dedup');
        continue;
      }

      // 6. Edge-scaled fixed-fraction sizing
      const kellyStake = bankroll * netEdge * cfg.CRYPTO_ARB_MAX_STAKE_FRACTION;
      const maxStake = cfg.MAX_BET_FRACTION * bankroll;
      const stakeUsd = Math.min(kellyStake, maxStake);

      if (stakeUsd < 0.01) {
        await recordCryptoArbGate(redis, 'stake_floor');
        continue;
      }

      // Resolve tokenId: YES = clobTokenIds[0], NO = clobTokenIds[1]
      const tokenId =
        direction === 'YES' ? (market.clobTokenIds[0] ?? '') : (market.clobTokenIds[1] ?? '');

      // 7. Resolve HL counterpart for delta-neutral arb
      const hlSymbol = resolveHlSymbol(market.question);

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
        feesEnabled: market.feesEnabled,
        volatility: dynamicAnnualVol,
        spreadBps: spreadBuffer * 10000,
        hlSymbol,
        endDate: market.endDate,
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
      topEdge: opportunities[0]?.edge.toFixed(4),
    });
  }

  return opportunities;
}

// ── Up/Down Scanner ─────────────────────────────────────────────────────────

const UPDOWN_MARKET_CACHE_KEY = 'crypto:updown:markets';
// Use the same dedup prefix as the arb worker writes on execution success
const UPDOWN_DEDUP_PREFIX = 'arb:crypto:';

/**
 * Map confluence score (0–3) to a directional probability.
 * These are conservative: Up/Down markets are ~50/50, so any edge above 0.50 matters.
 */
function confluenceScoreToFairValue(score: number): number {
  if (score >= 3) return 0.65;
  if (score >= 2) return 0.58;
  return 0.52;
}

/**
 * Scan for Up/Down Bitcoin market opportunities using confluence indicators.
 *
 * Unlike the price-target arb scanner (which uses Black-Scholes), this uses
 * the RSI/MACD/Stochastic confluence scorer to determine directional bias
 * on 5-min and 15-min "Bitcoin Up or Down" markets.
 */
export async function scanUpDownArb(
  move: SpotMove,
  redis: Redis,
): Promise<CryptoArbOpportunity[]> {
  const cfg = loadConfig();

  if (!cfg.UPDOWN_ENABLED) return [];

  // Only process Bitcoin moves
  if (move.assetId !== 'bitcoin') return [];

  // Resolve Binance symbol for confluence scoring
  const symbol = Object.entries(BINANCE_SYMBOL_TO_ASSET).find(([, v]) => v === 'bitcoin')?.[0];
  if (!symbol) return [];

  // 1. Confluence signal
  const confluence = await scoreConfluence(symbol, redis);
  if (confluence.direction === 'NEUTRAL' || confluence.score < 2) {
    logger.debug('[updown-arb] insufficient confluence for Up/Down', {
      score: confluence.score,
      direction: confluence.direction,
    });
    return [];
  }

  // 2. Discover Up/Down markets (cached, short TTL for ephemeral markets)
  let markets: {
    marketId: string;
    conditionId: string;
    clobTokenIds: string[];
    question: string;
    currentUpPrice: number;
    feesEnabled: boolean;
    endDate: string | null;
  }[] = [];

  const cached = await redis.get(UPDOWN_MARKET_CACHE_KEY);
  if (cached) {
    try {
      markets = JSON.parse(cached) as typeof markets;
    } catch {
      markets = [];
    }
  }

  if (markets.length === 0) {
    try {
      const events = await listRecentCryptoEvents({ maxHoursToResolution: cfg.UPDOWN_MAX_HOURS_TO_RESOLUTION });
      for (const event of events) {
        for (const market of event.markets) {
          if (!market.active || market.closed) continue;
          const outcomes = parseOutcomes(market.outcomes);
          const hasUpDown = outcomes.some((o) => o.toLowerCase() === 'up') &&
            outcomes.some((o) => o.toLowerCase() === 'down');
          if (!hasUpDown) continue;
          if (!market.question.toLowerCase().includes('bitcoin')) continue;

          const rawClobTokenIds = parseClobTokenIds(market.clobTokenIds);
          const prices = parseOutcomePrices(market.outcomePrices);
          if (rawClobTokenIds.length !== 2 || prices.length !== 2) continue;

          // Normalize ordering: ensure index 0 = UP, index 1 = DOWN
          const upIdx = outcomes.findIndex((o) => o.toLowerCase() === 'up');
          const downIdx = outcomes.findIndex((o) => o.toLowerCase() === 'down');
          if (upIdx === -1 || downIdx === -1 || upIdx === downIdx) continue;

          const clobTokenIds = [rawClobTokenIds[upIdx]!, rawClobTokenIds[downIdx]!];
          const upPrice = parseFloat(prices[upIdx] ?? '0.5');

          markets.push({
            marketId: market.id,
            conditionId: market.conditionId,
            clobTokenIds,
            question: market.question,
            currentUpPrice: isFinite(upPrice) ? upPrice : 0.5,
            feesEnabled: market.feesEnabled ?? false,
            endDate: market.endDate,
          });
        }
      }
      // Cache for 2 minutes (short because these markets are ephemeral)
      await redis.set(UPDOWN_MARKET_CACHE_KEY, JSON.stringify(markets), 'EX', 120);
    } catch (err) {
      logger.warn('[updown-arb] market discovery failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  if (markets.length === 0) {
    logger.debug('[updown-arb] no Up/Down markets found');
    return [];
  }

  const feeRate = cfg.ARB_FEE_RATE;
  const minEdge = cfg.UPDOWN_MIN_EDGE;
  const bankroll = await getBankroll(redis);
  const feed = getPriceFeed(redis);
  const opportunities: CryptoArbOpportunity[] = [];

  for (const market of markets) {
    try {
      // Get current price from WS if available
      const wsPrice = await feed.getCachedPrice(market.marketId);
      const currentUpPrice = wsPrice ?? market.currentUpPrice;
      if (!isFinite(currentUpPrice) || currentUpPrice <= 0 || currentUpPrice >= 1) continue;

      // Direction: confluence UP → buy UP token, DOWN → buy DOWN token
      const direction: 'UP' | 'DOWN' = confluence.direction;
      const currentPmPrice = direction === 'UP' ? currentUpPrice : 1 - currentUpPrice;

      // Fair value from confluence score
      const fairValue = confluenceScoreToFairValue(confluence.score);

      // Edge calculation
      const wsSpread = await feed.getCachedSpread(market.marketId);
      const spreadBuffer = wsSpread ?? 0;
      const netEdge = Math.abs(fairValue - currentPmPrice) - feeRate - spreadBuffer;

      if (netEdge < minEdge) continue;

      // Check that fair value suggests our direction (fair > current for our token)
      if (fairValue <= currentPmPrice) continue;

      // Dedup
      const dedupKey = `${UPDOWN_DEDUP_PREFIX}${market.marketId}:${direction}`;
      const deduped = await redis.get(dedupKey);
      if (deduped) continue;

      // Stake sizing (same Kelly-fraction approach as crypto arb)
      const kellyStake = bankroll * netEdge * cfg.CRYPTO_ARB_MAX_STAKE_FRACTION;
      const maxStake = cfg.MAX_BET_FRACTION * bankroll;
      const stakeUsd = Math.min(kellyStake, maxStake);
      if (stakeUsd < 0.01) continue;

      // Token selection: UP = token[0], DOWN = token[1] (normalized at discovery)
      if (market.clobTokenIds.length !== 2) continue;
      const tokenId = direction === 'UP'
        ? market.clobTokenIds[0]
        : market.clobTokenIds[1];
      if (!tokenId) continue;

      const hlSymbol = resolveHlSymbol(market.question);

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
        assetId: 'bitcoin',
        feesEnabled: market.feesEnabled,
        spreadBps: spreadBuffer * 10000,
        hlSymbol,
        endDate: market.endDate,
      });
    } catch (err) {
      logger.warn('[updown-arb] error processing market', {
        marketId: market.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  opportunities.sort((a, b) => b.edge - a.edge);

  if (opportunities.length > 0) {
    logger.info('[updown-arb] opportunities found', {
      count: opportunities.length,
      topEdge: opportunities[0]?.edge.toFixed(4),
      confluenceScore: confluence.score,
      confluenceDirection: confluence.direction,
    });
  }

  return opportunities;
}
