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
 * Two scoring modes (HL_MOMENTUM_MTF_SCORING_MODE):
 *
 *   'hard' (default): MTF gates are vetoes. Trades require 15m |score|≥MIN_SCORE,
 *     ADX≥MIN_ADX, AND 4h EMA bias aligned (when enabled), AND 1h MACD aligned (when
 *     enabled). Original behavior — preserved verbatim for zero-change merges.
 *
 *   'weighted': MTF signals become score boosts. The 4h EMA bias contributes
 *     +2/0/-2 (aligned / neutral band / opposed); the 1h MACD contributes +1/0
 *     (aligned / not). Trade if (15m absScore + MTF bonuses) ≥ MIN_TOTAL_SCORE.
 *     ADX still hard-gates (chop filter). Per-gate ENABLED flags become no-ops
 *     in weighted mode — MTF signals are always computed when candle data is
 *     available, gracefully treating missing data as 0 contribution.
 *
 * Pure-read: does not write to Redis. The caller (arb worker) sets the momentum
 * cooldown key and calls executeAndRecordSignal after receiving a non-null signal.
 *
 * Shadow-logs to shadow_observations regardless of HL_MOMENTUM_ENABLED so the
 * first period of deployment can be reviewed before flipping the live flag.
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
  const isWeighted = cfg.HL_MOMENTUM_MTF_SCORING_MODE === 'weighted';

  // Gate: minimum confluence score (hard mode only — weighted uses total score below).
  if (!isWeighted && absScore < cfg.HL_MOMENTUM_MIN_SCORE) {
    logger.debug('[hl-momentum] score below threshold', {
      symbol: hlSymbol,
      score,
      min: cfg.HL_MOMENTUM_MIN_SCORE,
    });
    return null;
  }

  // Gate: trending regime — ADX must be meaningful (both modes).
  if (adx === null || adx < cfg.HL_MOMENTUM_MIN_ADX) {
    logger.debug('[hl-momentum] ADX below threshold', {
      symbol: hlSymbol,
      adx,
      min: cfg.HL_MOMENTUM_MIN_ADX,
    });
    return null;
  }

  // ── Multi-timeframe signals ──────────────────────────────────────────────
  // In hard mode: behave as before — gate flag controls fetch + veto.
  // In weighted mode: always fetch (gate flag is a no-op), missing data → 0 bonus.

  let fourHBiasOk: boolean | null = null;
  let fourHSpreadPct: number | null = null;
  let fourHBonus = 0;
  if (cfg.HL_MOMENTUM_MTF_4H_GATE_ENABLED || isWeighted) {
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
      fourHSpreadPct = ((fastLast - slowLast) / slowLast) * 100;

      if (isWeighted) {
        const absSpread = Math.abs(fourHSpreadPct);
        if (absSpread < cfg.HL_MOMENTUM_4H_NEUTRAL_BAND_PCT) {
          fourHBonus = 0;
        } else if (fourHBiasOk) {
          fourHBonus = 2;
        } else {
          fourHBonus = -2;
          logger.debug('[hl-momentum] weighted mode: 4h headwind penalty applied', {
            symbol: hlSymbol,
            direction,
            spreadPct: fourHSpreadPct.toFixed(3),
            neutralBandPct: cfg.HL_MOMENTUM_4H_NEUTRAL_BAND_PCT,
          });
        }
      } else if (cfg.HL_MOMENTUM_MTF_4H_GATE_ENABLED && !fourHBiasOk) {
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

  let oneHMacdOk: boolean | null = null;
  let oneHBonus = 0;
  if (cfg.HL_MOMENTUM_MTF_1H_GATE_ENABLED || isWeighted) {
    const oneHCandles = await buildCandles(hlSymbol, redis, {
      lookbackMs: cfg.HL_MOMENTUM_1H_LOOKBACK_MS,
      timeframe: '1h',
    });
    const macd1h = computeMACDFromCandles(oneHCandles, 12, 26, 9);
    if (macd1h) {
      oneHMacdOk = direction === 'LONG'
        ? macd1h.macdLine > macd1h.signalLine
        : macd1h.macdLine < macd1h.signalLine;

      if (isWeighted) {
        oneHBonus = oneHMacdOk ? 1 : 0;
      } else if (cfg.HL_MOMENTUM_MTF_1H_GATE_ENABLED && !oneHMacdOk) {
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

  const mtfBonus = fourHBonus + oneHBonus;
  const totalScore = absScore + mtfBonus;

  // Weighted mode: total score gate replaces MIN_SCORE / individual MTF vetoes.
  if (isWeighted && totalScore < cfg.HL_MOMENTUM_MIN_TOTAL_SCORE) {
    logger.debug('[hl-momentum] weighted mode: totalScore below threshold', {
      symbol: hlSymbol,
      direction,
      absScore,
      mtfBonus,
      totalScore,
      threshold: cfg.HL_MOMENTUM_MIN_TOTAL_SCORE,
    });
    return null;
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
    metricValue: isWeighted ? totalScore : score,
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
      scoringMode: cfg.HL_MOMENTUM_MTF_SCORING_MODE,
      mtfBonus,
      totalScore,
    },
  }).catch(() => {});

  if (!cfg.HL_MOMENTUM_ENABLED) {
    logger.info(
      isWeighted ? '[hl-momentum] shadow signal (weighted dark)' : '[hl-momentum] shadow signal (dark)',
      {
        symbol: hlSymbol,
        direction,
        score,
        adx: adx.toFixed(1),
        voters,
        binancePrice: tick.price,
        ...(isWeighted ? { mtfBonus, totalScore } : {}),
      },
    );
    return null;
  }

  const stakeUsd = Math.min(cfg.HL_MOMENTUM_STAKE_USD, cfg.FUTURES_MAX_PER_TRADE_USD);
  const edgeMagnitude = isWeighted ? totalScore / 9 : absScore / 6;

  logger.info('[hl-momentum] signal', {
    symbol: hlSymbol,
    direction,
    score,
    scoringMode: cfg.HL_MOMENTUM_MTF_SCORING_MODE,
    ...(isWeighted ? { mtfBonus, totalScore } : {}),
    adx: adx.toFixed(1),
    stakeUsd,
    voters,
    binancePrice: tick.price,
  });

  const reasoningSuffix = isWeighted
    ? `, totalScore=${totalScore.toString()} (mtfBonus=${mtfBonus.toString()})`
    : '';

  return {
    marketId: hlSymbol,
    question: `HL momentum ${direction} ${hlSymbol}`,
    direction,
    stakeUsd,
    edgeMagnitude,
    outcomePrice: tick.price,
    sourcedFrom: 'hl-momentum',
    reasoning: `HL trend scorer (15m): score=${score.toString()}, ADX=${adx.toFixed(1)}, voters=${JSON.stringify(voters)}${reasoningSuffix}`,
    isFutures: true,
    source: 'hl-momentum',
    eventTs,
  };
}
