import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { buildCandles } from '../arb/candleAggregator.js';
import { computeEMA, computeMACDFromCandles } from '../arb/indicators.js';
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
 * Triggered off spot:price_moved, but only pairs listed in this mapping AND included
 * in the configured watch list are supported — including meme coins that are absent
 * from the 7-symbol Chainlink RTDS feed.
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
  penguusdt: 'PENGU',
};

/** Redis key for the per-symbol per-side momentum cooldown. */
export function momentumCooldownKey(hlSymbol: string, direction: 'LONG' | 'SHORT'): string {
  return `futures:momentum:cooldown:${hlSymbol}:${direction}`;
}

/**
 * Evaluate a single Binance spot price tick for a momentum entry on Hyperliquid.
 *
 * Multi-timeframe confluence gate (Option A swing rework):
 *   - Primary scorer: 15m candles, 6 voters, |score|≥4, ADX≥20.
 *   - 4h bias gate (HL_MOMENTUM_MTF_4H_GATE_ENABLED): EMA_FAST > EMA_SLOW for LONG,
 *     < for SHORT. Prevents counter-trend entries on the macro timeframe.
 *   - 1h MACD gate (HL_MOMENTUM_MTF_1H_GATE_ENABLED): MACD line > signal line for LONG,
 *     < for SHORT. Confirms the intermediate momentum direction.
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
 *   - 4h EMA bias disagrees with signal direction
 *   - 1h MACD direction disagrees with signal direction
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

  // Primary scoring on 15m candles — swing-appropriate timeframe.
  const primaryCandles = await buildCandles(hlSymbol, redis, {
    lookbackMs: cfg.HL_MOMENTUM_PRIMARY_LOOKBACK_MS,
    timeframe: '15m',
  });

  const trendResult = scoreHlTrend(primaryCandles);
  if (trendResult === null) {
    logger.debug('[hl-momentum] insufficient candles', {
      symbol: hlSymbol,
      count: primaryCandles.length,
      timeframe: '15m',
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

  // ── Multi-timeframe gates ────────────────────────────────────────────────

  // Gate: 4h EMA bias — macro trend must agree with signal direction.
  let fourHBiasOk: boolean | null = null;
  if (cfg.HL_MOMENTUM_MTF_4H_GATE_ENABLED) {
    const fourHCandles = await buildCandles(hlSymbol, redis, {
      lookbackMs: cfg.HL_MOMENTUM_4H_LOOKBACK_MS,
      timeframe: '4h',
    });
    const closes4h = fourHCandles.map((c) => c.close);
    const ema4hFast = computeEMA(closes4h, cfg.HL_MOMENTUM_4H_EMA_FAST);
    const ema4hSlow = computeEMA(closes4h, cfg.HL_MOMENTUM_4H_EMA_SLOW);
    if (ema4hFast && ema4hSlow) {
      const fastLast = ema4hFast[ema4hFast.length - 1]!;
      const slowLast = ema4hSlow[ema4hSlow.length - 1]!;
      fourHBiasOk = direction === 'LONG' ? fastLast > slowLast : fastLast < slowLast;
      if (!fourHBiasOk) {
        logger.debug('[hl-momentum] 4h bias mismatch', {
          symbol: hlSymbol,
          direction,
          ema4hFast: fastLast.toFixed(4),
          ema4hSlow: slowLast.toFixed(4),
        });
        return null;
      }
    } else {
      logger.debug('[hl-momentum] 4h EMA insufficient data', {
        symbol: hlSymbol,
        candleCount: fourHCandles.length,
        fastPeriod: cfg.HL_MOMENTUM_4H_EMA_FAST,
        slowPeriod: cfg.HL_MOMENTUM_4H_EMA_SLOW,
      });
    }
  }

  // Gate: 1h MACD direction — intermediate momentum must agree.
  let oneHMacdOk: boolean | null = null;
  if (cfg.HL_MOMENTUM_MTF_1H_GATE_ENABLED) {
    const oneHCandles = await buildCandles(hlSymbol, redis, {
      lookbackMs: cfg.HL_MOMENTUM_1H_LOOKBACK_MS,
      timeframe: '1h',
    });
    const macd1h = computeMACDFromCandles(oneHCandles, 12, 26, 9);
    if (macd1h) {
      oneHMacdOk = direction === 'LONG'
        ? macd1h.macdLine > macd1h.signalLine
        : macd1h.macdLine < macd1h.signalLine;
      if (!oneHMacdOk) {
        logger.debug('[hl-momentum] 1h MACD mismatch', {
          symbol: hlSymbol,
          direction,
          macdLine: macd1h.macdLine.toFixed(6),
          signalLine: macd1h.signalLine.toFixed(6),
        });
        return null;
      }
    } else {
      logger.debug('[hl-momentum] 1h MACD insufficient data', {
        symbol: hlSymbol,
        candleCount: oneHCandles.length,
      });
    }
  }

  // ────────────────────────────────────────────────────────────────────────

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

  // spot:price_moved timestamp comes from Binance kline close time (T), which can be
  // slightly in the future for in-progress bars. Clamp to now to keep latency metrics sane.
  const now = Date.now();
  const eventTs =
    typeof tick.ts === 'number' && Number.isFinite(tick.ts) && tick.ts <= now ? tick.ts : now;

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
      candleCount: primaryCandles.length,
      fourHBiasOk,
      oneHMacdOk,
      primaryTimeframe: '15m',
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
    reasoning: `HL trend scorer (15m): score=${score.toString()}, ADX=${adx.toFixed(1)}, voters=${JSON.stringify(voters)}`,
    isFutures: true,
    source: 'hl-momentum',
    eventTs,
  };
}
