import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { buildCandles } from '../arb/candleAggregator.js';
import { scoreHlTrend } from './hlTrendScorer.js';
import { hasOpenPosition } from '../execution/positionLedger.js';
import { enqueueWrite } from '../db/writeQueue.js';
import type { TradeSignal } from '../mapping/index.js';

export interface BinancePriceTick {
  symbol: string;   // Binance USDT pair, e.g. 'ethusdt'
  price: number;
  ts?: number;      // Unix ms timestamp
}

/**
 * Maps Binance USDT pair names → Hyperliquid perp ticker.
 * Triggered off spot:price_moved so any pair with Binance kline data is supported,
 * including meme coins that are absent from the 7-symbol Chainlink RTDS feed.
 */
const BINANCE_TO_HL: Record<string, string> = {
  // Majors
  btcusdt:  'BTC',
  ethusdt:  'ETH',
  solusdt:  'SOL',
  xrpusdt:  'XRP',
  dogeusdt: 'DOGE',
  bnbusdt:  'BNB',
  // Meme / political
  pepeusdt: 'kPEPE',   // HL trades 1000× units; same direction as Binance PEPEUSDT
  wifusdt:  'WIF',
  bonkusdt: 'kBONK',   // HL trades 1000× units; same direction as Binance BONKUSDT
  penguusdt:'PENGU',
};

/** Redis key for the per-symbol per-side momentum cooldown. */
export function momentumCooldownKey(hlSymbol: string, direction: 'LONG' | 'SHORT'): string {
  return `futures:momentum:cooldown:${hlSymbol}:${direction}`;
}

/**
 * Evaluate a single Binance spot price tick for a momentum entry on Hyperliquid.
 *
 * Pure-read: does not write to Redis. The caller (arb worker) sets the momentum
 * cooldown key and calls executeAndRecordSignal after receiving a non-null signal.
 *
 * Shadow-logs to shadow_observations regardless of HL_MOMENTUM_ENABLED so the
 * first period of deployment can be reviewed before flipping the live flag.
 *
 * Returns null when:
 *   - symbol not in the configured watch list
 *   - no HL perp mapping for this Binance pair
 *   - scoreHlTrend returns null (< 2 candles) or score is 0
 *   - score or ADX below threshold
 *   - loss cooldown or momentum cooldown active
 *   - any position already open on this symbol (either direction)
 *   - HL_MOMENTUM_ENABLED is false (dark mode)
 */
export async function scanHlMomentum(
  tick: BinancePriceTick,
  redis: Redis,
): Promise<TradeSignal | null> {
  const cfg = loadConfig();

  const enabledSymbols = cfg.HL_MOMENTUM_SYMBOLS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!enabledSymbols.includes(tick.symbol.toLowerCase())) return null;

  const hlSymbol = BINANCE_TO_HL[tick.symbol.toLowerCase()];
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
  const [longOpen, shortOpen] = await Promise.all([
    hasOpenPosition(redis, hlSymbol, 'LONG'),
    hasOpenPosition(redis, hlSymbol, 'SHORT'),
  ]);
  if (longOpen || shortOpen) {
    logger.debug('[hl-momentum] position already open', { symbol: hlSymbol, direction });
    return null;
  }

  const eventTs = tick.ts ?? Date.now();

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
      binanceSymbol: tick.symbol,
      binancePrice: tick.price,
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
      binancePrice: tick.price,
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
    binancePrice: tick.price,
  });

  return {
    marketId: hlSymbol,
    question: `HL momentum ${direction} ${hlSymbol}`,
    direction,
    stakeUsd,
    edgeMagnitude: absScore / 6,
    outcomePrice: tick.price,
    sourcedFrom: 'hl-momentum',
    reasoning: `HL trend scorer: score=${score.toString()}, ADX=${adx.toFixed(1)}, voters=${JSON.stringify(voters)}`,
    isFutures: true,
    source: 'hl-momentum',
    eventTs,
  };
}
