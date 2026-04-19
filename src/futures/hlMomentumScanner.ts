import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { buildCandles } from '../arb/candleAggregator.js';
import { scoreHlTrend } from './hlTrendScorer.js';
import { hasOpenPosition } from '../execution/positionLedger.js';
import { enqueueWrite } from '../db/writeQueue.js';
import type { ChainlinkTick } from '../spot/feeds/chainlinkFeed.js';
import type { TradeSignal } from '../mapping/index.js';

/**
 * Maps each Chainlink oracle symbol to its Hyperliquid perp ticker.
 * Only symbols that have both a Chainlink feed AND a Binance kline feed are
 * included — the scorer needs OHLCV candles from `spot:klines:<binanceSym>`.
 */
const CHAINLINK_TO_HL: Record<string, string> = {
  'btc/usd': 'BTC',
  'eth/usd': 'ETH',
  'sol/usd': 'SOL',
  'xrp/usd': 'XRP',
  'doge/usd': 'DOGE',
  'bnb/usd': 'BNB',
};

/** Redis key for the per-symbol per-side momentum cooldown. */
export function momentumCooldownKey(hlSymbol: string, direction: 'LONG' | 'SHORT'): string {
  return `futures:momentum:cooldown:${hlSymbol}:${direction}`;
}

/**
 * Evaluate a single Chainlink oracle tick for a momentum entry on Hyperliquid.
 *
 * Pure-read: does not write to Redis. The caller (arb worker) sets the momentum
 * cooldown key and calls executeAndRecordSignal after receiving a non-null signal.
 *
 * Shadow-logs to shadow_observations regardless of HL_MOMENTUM_ENABLED so the
 * first 48h of deployment can be reviewed before flipping the live flag.
 *
 * Returns null when:
 *   - symbol not in the configured watch list
 *   - scoreHlTrend returns null (< 2 candles) or score is 0
 *   - score or ADX below threshold
 *   - loss cooldown or momentum cooldown active
 *   - position already open in the same direction
 *   - HL_MOMENTUM_ENABLED is false (dark mode)
 */
export async function scanHlMomentum(
  tick: ChainlinkTick,
  redis: Redis,
): Promise<TradeSignal | null> {
  const cfg = loadConfig();

  const enabledSymbols = cfg.HL_MOMENTUM_SYMBOLS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!enabledSymbols.includes(tick.symbol)) return null;

  const hlSymbol = CHAINLINK_TO_HL[tick.symbol];
  if (!hlSymbol) return null;

  // Fetch OHLCV candles — primary path reads Binance klines from Redis.
  const candles = await buildCandles(hlSymbol, redis, {
    lookbackMs: cfg.HL_MOMENTUM_CANDLE_LOOKBACK_MS,
    timeframe: '1m',
  });

  const trendResult = scoreHlTrend(candles);
  if (trendResult === null) {
    logger.debug('[hl-momentum] insufficient candles', {
      symbol: hlSymbol,
      count: candles.length,
    });
    return null;
  }

  const { score, adx, voters } = trendResult;
  if (score === 0) return null;

  const direction: 'LONG' | 'SHORT' = score > 0 ? 'LONG' : 'SHORT';
  const absScore = Math.abs(score);

  // Gate: minimum confluence score.
  if (absScore < cfg.HL_MOMENTUM_MIN_SCORE) {
    logger.debug('[hl-momentum] score below threshold', {
      symbol: hlSymbol,
      score,
      min: cfg.HL_MOMENTUM_MIN_SCORE,
    });
    return null;
  }

  // Gate: trending regime — ADX must be meaningful.
  if (adx === null || adx < cfg.HL_MOMENTUM_MIN_ADX) {
    logger.debug('[hl-momentum] ADX below threshold', {
      symbol: hlSymbol,
      adx,
      min: cfg.HL_MOMENTUM_MIN_ADX,
    });
    return null;
  }

  // Gate: loss cooldown set by futuresMonitor after any losing close.
  const lossCooldown = await redis.get(`futures:loss-cooldown:${hlSymbol}`);
  if (lossCooldown) {
    logger.debug('[hl-momentum] loss cooldown active', { symbol: hlSymbol });
    return null;
  }

  // Gate: per-side momentum cooldown (prevents re-entering the same thesis immediately).
  const mCooldown = await redis.get(momentumCooldownKey(hlSymbol, direction));
  if (mCooldown) {
    logger.debug('[hl-momentum] momentum cooldown active', { symbol: hlSymbol, direction });
    return null;
  }

  // Gate: any open position on this symbol (either side). Opening a LONG against an
  // existing SHORT — or vice versa — just creates a delta-neutral wash that burns fees.
  const longOpen = await hasOpenPosition(redis, hlSymbol, 'LONG');
  const shortOpen = await hasOpenPosition(redis, hlSymbol, 'SHORT');
  if (longOpen || shortOpen) {
    logger.debug('[hl-momentum] position already open', { symbol: hlSymbol, direction });
    return null;
  }

  // Shadow-log regardless of live flag so dark-mode signals are visible in DB.
  void enqueueWrite('shadow_observations', {
    kind: 'hl_momentum_signal',
    source: 'hl-momentum',
    symbol: hlSymbol,
    direction,
    wouldBlock: !cfg.HL_MOMENTUM_ENABLED,
    metricValue: score,
    payload: {
      score,
      adx,
      voters,
      chainlinkSymbol: tick.symbol,
      chainlinkPrice: tick.value,
      candleCount: candles.length,
    },
  }).catch(() => {});

  if (!cfg.HL_MOMENTUM_ENABLED) {
    logger.info('[hl-momentum] shadow signal (dark)', {
      symbol: hlSymbol,
      direction,
      score,
      adx: adx.toFixed(1),
      voters,
      chainlinkPrice: tick.value,
    });
    return null;
  }

  const stakeUsd = Math.min(cfg.HL_MOMENTUM_STAKE_USD, cfg.FUTURES_MAX_PER_TRADE_USD);

  logger.info('[hl-momentum] signal', {
    symbol: hlSymbol,
    direction,
    score,
    adx: adx.toFixed(1),
    stakeUsd,
    voters,
    chainlinkPrice: tick.value,
  });

  return {
    marketId: hlSymbol,
    question: `HL momentum ${direction} ${hlSymbol}`,
    direction,
    stakeUsd,
    edgeMagnitude: absScore / 6,
    outcomePrice: tick.value,
    sourcedFrom: 'hl-momentum',
    reasoning: `HL trend scorer: score=${score.toString()}, ADX=${adx.toFixed(1)}, voters=${JSON.stringify(voters)}`,
    isFutures: true,
    source: 'hl-momentum',
    eventTs: tick.receivedAt,
  };
}
