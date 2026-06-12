import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { buildCandles } from '../arb/candleAggregator.js';
import { computeATRFromCandles, computeEMA, computeMACDFromCandles, computeRSIFromCandles, computeVWAP } from '../arb/indicators.js';
import { scoreHlTrend } from './hlTrendScorer.js';
import { detectBreakoutRetestHold } from './breakoutRetest.js';
import type { BreakoutRetestMatch } from './breakoutRetest.js';
import { fundingRateToApr, getCachedAssetCtx, getOrSetOiBaseline } from './hlAssetCtxCache.js';
import type { CachedAssetCtx } from './hlAssetCtxCache.js';
import { hasOpenPosition } from '../execution/positionLedger.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { shouldDropSampledDecision } from './decisionSampling.js';
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
  // Alt L1s / ecosystem
  suiusdt:  'SUI',
  avaxusdt: 'AVAX',
  linkusdt: 'LINK',
  tonusdt:  'TON',
  aptusdt:  'APT',
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

/** Redis key for one-bar persistence on borderline stretched momentum setups. */
export function momentumStretchConfirmationKey(hlSymbol: string, direction: 'LONG' | 'SHORT'): string {
  return `futures:momentum:stretch-confirm:${hlSymbol}:${direction}`;
}

function oppositeDirection(direction: 'LONG' | 'SHORT'): 'LONG' | 'SHORT' {
  return direction === 'LONG' ? 'SHORT' : 'LONG';
}

/**
 * Strip the `usdt` suffix (Binance pair form) and, only for actual Hyperliquid
 * 1000× unit markers (literal lowercase `k` followed by an uppercase base asset
 * letter, e.g. `kPEPE`, `kBONK`, `kSHIB`), the leading `k`. Detection happens
 * before lowercasing so legitimate symbols starting with `K`/`k` like `KAVA`
 * are not mangled.
 */
function normaliseMemeBase(s: string): string {
  const trimmed = s.trim();
  const dekayed = /^k[A-Z]/.test(trimmed) ? trimmed.slice(1) : trimmed;
  return dekayed.toLowerCase().replace(/usdt$/, '');
}

/**
 * True when the symbol is in the meme-perp ATR-SL/TP set. Accepts all three forms:
 * Binance pair (`pepeusdt`), HL 1000× ticker (`kPEPE`, `kBONK`), or plain HL base
 * (`WIF`, `PENGU`). Comparison happens on the normalised base name so callers
 * don't need to translate before checking.
 */
export function isMemeSymbol(symbol: string, memeList: string): boolean {
  const candidate = normaliseMemeBase(symbol);
  if (!candidate) return false;
  for (const raw of memeList.split(',')) {
    const meme = normaliseMemeBase(raw);
    if (!meme) continue;
    if (candidate === meme) return true;
  }
  return false;
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
 * Mostly read-only. The only scanner-owned write is the borderline-stretch
 * confirmation key used to require one additional closed 15m bar before entering
 * near anti-chase thresholds. The caller (arb worker) still sets the momentum
 * cooldown key and calls executeAndRecordSignal after receiving a non-null signal.
 *
 * Shadow-logs to shadow_observations regardless of HL_MOMENTUM_ENABLED so the
 * first period of deployment can be reviewed before flipping the live flag.
 *
 * Logs every evaluated candidate (including all skips) to signal_decisions with a
 * stable decisionId per scan so rows can be joined to execution_events and outcomes.
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

  // HL-native voters (issue #265). Both Sub-PR 1 (funding contra) and Sub-PR 2
  // (OI divergence) share one getCachedAssetCtx fetch — fetch once when either
  // is enabled, then derive the per-voter inputs from the single ctx.
  let hlCtx: CachedAssetCtx | null = null;
  if (cfg.HL_FUNDING_CONTRA_ENABLED || cfg.HL_OI_DIVERGENCE_ENABLED) {
    hlCtx = await getCachedAssetCtx(hlSymbol, redis, cfg.HL_FUNDING_CONTRA_CACHE_TTL_SEC);
  }

  // Sub-PR 1: funding-rate contra voter.
  let fundingApr: number | null = null;
  if (cfg.HL_FUNDING_CONTRA_ENABLED && hlCtx) {
    fundingApr = fundingRateToApr(hlCtx.fundingRate);
    logger.debug('[hl-momentum] funding APR computed', {
      symbol: hlSymbol,
      fundingRate: hlCtx.fundingRate,
      fundingApr: fundingApr.toFixed(2),
    });
  }

  // Sub-PR 2: OI divergence voter.
  let oiPctChange: number | null = null;
  let pricePctChange: number | null = null;
  if (cfg.HL_OI_DIVERGENCE_ENABLED && hlCtx) {
    const baseline = await getOrSetOiBaseline(
      hlSymbol, redis, hlCtx.openInterest, hlCtx.markPrice, cfg.HL_OI_BASELINE_TTL_SEC,
    );
    if (baseline && baseline.oi > 0 && baseline.markPrice > 0) {
      oiPctChange = (hlCtx.openInterest - baseline.oi) / baseline.oi * 100;
      pricePctChange = (hlCtx.markPrice - baseline.markPrice) / baseline.markPrice * 100;
      logger.debug('[hl-momentum] OI divergence computed', {
        symbol: hlSymbol,
        oiPctChange: oiPctChange.toFixed(2),
        pricePctChange: pricePctChange.toFixed(2),
        baselineAgeSec: Number.isFinite(baseline.ts) ? Math.round((Date.now() - baseline.ts) / 1000) : null,
      });
    }
  }

  const trendResult = scoreHlTrend(primaryCandles, {
    fundingApr,
    fundingAprThreshold: cfg.HL_FUNDING_CONTRA_APR_THRESHOLD,
    oiPctChange,
    pricePctChange,
    oiDivergenceThreshold: cfg.HL_OI_DIVERGENCE_THRESHOLD_PCT,
  });
  if (trendResult === null) {
    logger.debug('[hl-momentum] insufficient candles', {
      symbol: hlSymbol,
      count: primaryCandles.length,
      timeframe: '15m',
    });
    return null;
  }

  const { score, adx, voters, voterCount } = trendResult;
  if (score === 0) return null;

  const momentumDirection: 'LONG' | 'SHORT' = score > 0 ? 'LONG' : 'SHORT';
  // Contrarian is active only when globally enabled AND ADX is below the strong-trend ceiling
  // AND the symbol is not a meme coin. Meme coins rely on ATR-scaled SL/TP sized for
  // their high-volatility regime; contrarian mean-reversion logic degrades their win rate.
  const isContrarian =
    cfg.HL_MOMENTUM_CONTRARIAN_ENABLED &&
    adx !== null &&
    adx < cfg.HL_MOMENTUM_CONTRARIAN_ADX_CEILING &&
    !isMemeSymbol(hlSymbol, cfg.HL_MOMENTUM_MEME_SYMBOLS);
  const tradeDirection: 'LONG' | 'SHORT' = isContrarian
    ? oppositeDirection(momentumDirection)
    : momentumDirection;
  const absScore = Math.abs(score);
  const isWeighted = cfg.HL_MOMENTUM_MTF_SCORING_MODE === 'weighted';

  // One stable UUID per scan: used in signal_decisions row AND returned in the
  // TradeSignal so callers can join signal_decisions → execution_events → outcomes.
  const decisionId = randomUUID();

  // Hoist MTF context variables so logDecision can read their current values at any
  // gate exit point (captures whatever has been computed up to that moment).
  let fourHBiasOk: boolean | null = null;
  let fourHBonus = 0;
  let oneHMacdOk: boolean | null = null;
  let oneHBonus = 0;
  let mtfBonus = 0;
  let totalScore = absScore;
  let softConfirmationRequired = false;
  let softConfirmationPassed = false;
  let softConfirmationReasons: string[] = [];
  let softConfirmationAnchorOpenTime: number | null = null;
  let breakoutRetestMatch: BreakoutRetestMatch | null = null;

  // Compute RSI and VWAP distance on primary candles. Used by the anti-chase gate and
  // included in every signal_decisions row for future stretch-metric audits.
  const closedPrimaryCandles = primaryCandles.filter((c) => c.closed !== false);
  const indicatorCandles = closedPrimaryCandles.length > 0 ? closedPrimaryCandles : primaryCandles;
  const latestClosedPrimaryCandle = indicatorCandles[indicatorCandles.length - 1]!;
  const lastClose = latestClosedPrimaryCandle.close;
  const rsi = computeRSIFromCandles(indicatorCandles, cfg.HL_MOMENTUM_RSI_PERIOD);
  const vwapVal = computeVWAP(indicatorCandles);
  const vwapDistPct = (vwapVal !== null && vwapVal > 0)
    ? (lastClose - vwapVal) / vwapVal * 100
    : null;

  /** Enqueue one signal_decisions row for this hl-momentum candidate evaluation. */
  const logDecision = (hasTrade: boolean, skipReason?: string, skipDetail?: string): void => {
    // Throttle the per-tick skip flood: persist every trade, sample skip rows at
    // HL_DECISION_LOG_SAMPLE_RATE to bound signal_decisions write rate.
    if (shouldDropSampledDecision(hasTrade, cfg.HL_DECISION_LOG_SAMPLE_RATE)) return;
    void enqueueWrite('signal_decisions', {
      decisionId,
      source: 'hl-momentum' as const,
      marketId: hlSymbol,
      question: `HL momentum ${tradeDirection} ${hlSymbol}`,
      category: 'futures',
      direction: tradeDirection,
      confluenceDirection: momentumDirection,
      hasTrade,
      skipReason: skipReason ?? (hasTrade ? undefined : 'other'),
      skipDetail,
      confluenceScore: absScore,
      regimeAdx: adx ?? undefined,
      raw: {
        score,
        adx,
        voters,
        voterCount,
        momentumDirection,
        tradeDirection,
        isContrarian,
        scoringMode: cfg.HL_MOMENTUM_MTF_SCORING_MODE,
        fourHBiasOk,
        oneHMacdOk,
        mtfBonus,
        totalScore,
        fundingApr,
        oiPctChange,
        pricePctChange,
        binancePrice: tick.price,
        rsi,
        vwapDistPct,
        softConfirmationRequired,
        softConfirmationPassed,
        softConfirmationReasons,
        softConfirmationAnchorOpenTime,
        breakoutRetestMatch,
      },
    }).catch(() => {});
  };

  // Gate: minimum confluence score (hard mode only — weighted uses total score below).
  if (!isWeighted && absScore < cfg.HL_MOMENTUM_MIN_SCORE) {
    logger.debug('[hl-momentum] score below threshold', {
      symbol: hlSymbol,
      score,
      min: cfg.HL_MOMENTUM_MIN_SCORE,
    });
    logDecision(false, 'score_below_min');
    return null;
  }

  // Gate: trending regime — ADX must be meaningful (both modes).
  if (adx === null || adx < cfg.HL_MOMENTUM_MIN_ADX) {
    logger.debug('[hl-momentum] ADX below threshold', {
      symbol: hlSymbol,
      adx,
      min: cfg.HL_MOMENTUM_MIN_ADX,
    });
    logDecision(false, 'regime_no_trend');
    return null;
  }

  // Gate: momentum-direction LONGs disabled. Trend-chasing longs measured Apr–Jun 2026
  // at −4.7 cumulative price-% vs SHORTs +24.2; contrarian LONGs (RSI-exhaustion bounce
  // buys, 66% WR post-gate) are exempt — they enter on washouts, not chases.
  if (cfg.HL_MOMENTUM_BLOCK_MOMENTUM_LONGS && !isContrarian && tradeDirection === 'LONG') {
    logger.debug('[hl-momentum] momentum LONG blocked', {
      symbol: hlSymbol,
      momentumDirection,
      score,
    });
    logDecision(false, 'momentum_long_blocked');
    return null;
  }

  // Gate: contrarian entries require RSI to confirm genuine exhaustion.
  // Contrarian LONG (momentum DOWN) needs RSI ≤ oversold threshold — the down move must be
  // stretched enough that a snap-back is plausible. Contrarian SHORT (momentum UP) needs
  // RSI ≥ overbought. All 10 historical contrarian losses had RSI 30-40/60-70, never in
  // the true exhaustion zone. rsi===null means insufficient candle history → skip.
  if (isContrarian) {
    const rsiOk =
      rsi !== null &&
      (tradeDirection === 'LONG'
        ? rsi <= cfg.HL_MOMENTUM_CONTRARIAN_RSI_OVERSOLD
        : rsi >= cfg.HL_MOMENTUM_CONTRARIAN_RSI_OVERBOUGHT);
    if (!rsiOk) {
      logger.debug('[hl-momentum] contrarian RSI exhaustion gate failed', {
        symbol: hlSymbol,
        tradeDirection,
        rsi,
        oversold: cfg.HL_MOMENTUM_CONTRARIAN_RSI_OVERSOLD,
        overbought: cfg.HL_MOMENTUM_CONTRARIAN_RSI_OVERBOUGHT,
      });
      logDecision(false, 'contrarian_rsi_not_exhausted');
      return null;
    }
  }

  // Gate: HL-native voters must not actively contradict the momentum direction.
  // fundingContra DOWN on a LONG = longs already crowded, APR at ceiling — mean-reversion
  // risk that the correlated price-lag voters cannot outweigh.
  // oiDivergence DOWN on a LONG = OI contracting while price rises — short covering only,
  // not real buying; the breakout is likely fake.
  // Both checks are naturally no-ops when the voter is disabled (voter key absent from
  // `voters`, so the === comparison is false).
  if (!isContrarian) {
    if (
      (momentumDirection === 'LONG' && voters.fundingContra === 'DOWN') ||
      (momentumDirection === 'SHORT' && voters.fundingContra === 'UP')
    ) {
      logger.debug('[hl-momentum] funding contra veto', {
        symbol: hlSymbol,
        momentumDirection,
        tradeDirection,
        fundingApr,
      });
      logDecision(false, 'funding_adverse');
      return null;
    }
    if (
      (momentumDirection === 'LONG' && voters.oiDivergence === 'DOWN') ||
      (momentumDirection === 'SHORT' && voters.oiDivergence === 'UP')
    ) {
      logger.debug('[hl-momentum] OI divergence veto', {
        symbol: hlSymbol,
        momentumDirection,
        tradeDirection,
        oiPctChange,
        pricePctChange,
      });
      logDecision(false, 'oi_divergence_veto');
      return null;
    }
    if (momentumDirection === 'LONG' && cfg.HL_MOMENTUM_LONG_REQUIRE_HL_CONFIRMATION) {
      const longConfirmationVotes = [voters.fundingContra, voters.oiDivergence].filter(
        (vote): vote is 'UP' | 'DOWN' | 'neutral' => vote !== undefined,
      );
      if (longConfirmationVotes.length > 0 && !longConfirmationVotes.includes('UP')) {
        logger.debug('[hl-momentum] long HL confirmation missing', {
          symbol: hlSymbol,
          momentumDirection,
          tradeDirection,
          fundingContraVote: voters.fundingContra ?? null,
          oiDivergenceVote: voters.oiDivergence ?? null,
        });
        logDecision(false, 'long_hl_confirmation_missing');
        return null;
      }
    }
  }

  // Gate: anti-chase stretch filter — block entries when the primary-TF move is already
  // overextended, reducing the chance of buying/selling exhaustion peaks or troughs.
  // RSI ≥ overbought on LONG = momentum indicator showing overheated buying.
  // RSI ≤ oversold on SHORT = momentum indicator showing washed-out selling.
  // VWAP distance > threshold in momentum direction = price stretched too far from fair value.
  // Skipped for contrarian entries: overextension in the momentum direction is a *favourable*
  // condition for a mean-reversion snap-back. The contrarian RSI exhaustion gate (above)
  // already requires confirmed exhaustion before allowing contrarian entries.
  if (cfg.HL_MOMENTUM_ANTI_CHASE_ENABLED && !isContrarian) {
    if (rsi !== null) {
      if (momentumDirection === 'LONG' && rsi >= cfg.HL_MOMENTUM_RSI_OVERBOUGHT) {
        logger.debug('[hl-momentum] anti-chase: RSI overbought on LONG', {
          symbol: hlSymbol, momentumDirection, tradeDirection, rsi: rsi.toFixed(1), threshold: cfg.HL_MOMENTUM_RSI_OVERBOUGHT,
        });
        logDecision(false, 'anti_chase_rsi', rsi.toFixed(1));
        return null;
      }
      if (momentumDirection === 'SHORT' && rsi <= cfg.HL_MOMENTUM_RSI_OVERSOLD) {
        logger.debug('[hl-momentum] anti-chase: RSI oversold on SHORT', {
          symbol: hlSymbol, momentumDirection, tradeDirection, rsi: rsi.toFixed(1), threshold: cfg.HL_MOMENTUM_RSI_OVERSOLD,
        });
        logDecision(false, 'anti_chase_rsi', rsi.toFixed(1));
        return null;
      }
    }
    if (vwapDistPct !== null) {
      if (momentumDirection === 'LONG' && vwapDistPct > cfg.HL_MOMENTUM_VWAP_MAX_DIST_PCT) {
        logger.debug('[hl-momentum] anti-chase: price too far above VWAP', {
          symbol: hlSymbol, momentumDirection, tradeDirection, vwapDistPct: vwapDistPct.toFixed(2), threshold: cfg.HL_MOMENTUM_VWAP_MAX_DIST_PCT,
        });
        logDecision(false, 'anti_chase_vwap', vwapDistPct.toFixed(2));
        return null;
      }
      if (momentumDirection === 'SHORT' && vwapDistPct < -cfg.HL_MOMENTUM_VWAP_MAX_DIST_PCT) {
        logger.debug('[hl-momentum] anti-chase: price too far below VWAP', {
          symbol: hlSymbol, momentumDirection, tradeDirection, vwapDistPct: vwapDistPct.toFixed(2), threshold: cfg.HL_MOMENTUM_VWAP_MAX_DIST_PCT,
        });
        logDecision(false, 'anti_chase_vwap', vwapDistPct.toFixed(2));
        return null;
      }
    }
  }

  // Breakout-retest-hold detection — always computed so shadow_observations shows
  // hit-rate even while HL_MOMENTUM_REQUIRE_BREAKOUT_RETEST=false (dark mode).
  // Gate enforcement is conditional on the flag.
  {
    const atrResult = computeATRFromCandles(indicatorCandles, cfg.FUTURES_ATR_PERIOD);
    breakoutRetestMatch = detectBreakoutRetestHold(indicatorCandles, momentumDirection, {
      lookbackBars: cfg.HL_MOMENTUM_BREAKOUT_LOOKBACK_BARS,
      freshBars: cfg.HL_MOMENTUM_BREAKOUT_FRESH_BARS,
      retestPct: cfg.HL_MOMENTUM_RETEST_TOL_PCT,
      retestAtrMult: cfg.HL_MOMENTUM_RETEST_TOL_ATR_MULT,
      atr: atrResult?.atr ?? null,
    });
    if (cfg.HL_MOMENTUM_REQUIRE_BREAKOUT_RETEST && breakoutRetestMatch === null) {
      logger.debug('[hl-momentum] breakout-retest-hold pattern not found', {
        symbol: hlSymbol,
        momentumDirection,
        tradeDirection,
        lookbackBars: cfg.HL_MOMENTUM_BREAKOUT_LOOKBACK_BARS,
        freshBars: cfg.HL_MOMENTUM_BREAKOUT_FRESH_BARS,
      });
      logDecision(false, 'breakout_retest_missing');
      return null;
    }
  }

  if (cfg.HL_MOMENTUM_SOFT_CONFIRM_ENABLED) {
    const rsiLongBand = cfg.HL_MOMENTUM_RSI_OVERBOUGHT - cfg.HL_MOMENTUM_SOFT_CONFIRM_RSI_BUFFER;
    const rsiShortBand = cfg.HL_MOMENTUM_RSI_OVERSOLD + cfg.HL_MOMENTUM_SOFT_CONFIRM_RSI_BUFFER;
    const vwapBand = Math.min(
      cfg.HL_MOMENTUM_SOFT_CONFIRM_VWAP_DIST_PCT,
      cfg.HL_MOMENTUM_VWAP_MAX_DIST_PCT,
    );

    if (rsi !== null) {
      if (momentumDirection === 'LONG' && rsi >= rsiLongBand) softConfirmationReasons.push('rsi');
      if (momentumDirection === 'SHORT' && rsi <= rsiShortBand) softConfirmationReasons.push('rsi');
    }
    if (vwapDistPct !== null) {
      if (momentumDirection === 'LONG' && vwapDistPct >= vwapBand) softConfirmationReasons.push('vwap');
      if (momentumDirection === 'SHORT' && vwapDistPct <= -vwapBand) softConfirmationReasons.push('vwap');
    }
    softConfirmationRequired = softConfirmationReasons.length > 0;
  }

  // ── Multi-timeframe signals ──────────────────────────────────────────────
  // In hard mode: behave as before — gate flag controls fetch + veto.
  // In weighted mode: always fetch (gate flag is a no-op), missing data → 0 bonus.

  let fourHSpreadPct: number | null = null;
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
      fourHBiasOk = momentumDirection === 'LONG' ? fastLast > slowLast : fastLast < slowLast;
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
            momentumDirection,
            tradeDirection,
            spreadPct: fourHSpreadPct.toFixed(3),
            neutralBandPct: cfg.HL_MOMENTUM_4H_NEUTRAL_BAND_PCT,
          });
        }
      } else if (cfg.HL_MOMENTUM_MTF_4H_GATE_ENABLED && !fourHBiasOk) {
        logger.debug('[hl-momentum] 4h bias mismatch', {
          symbol: hlSymbol,
          momentumDirection,
          tradeDirection,
          ema4hFast: fastLast.toFixed(4),
          ema4hSlow: slowLast.toFixed(4),
        });
        logDecision(false, '4h_ema_bias_mismatch');
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

  if (cfg.HL_MOMENTUM_MTF_1H_GATE_ENABLED || isWeighted) {
    const oneHCandles = await buildCandles(hlSymbol, redis, {
      lookbackMs: cfg.HL_MOMENTUM_1H_LOOKBACK_MS,
      timeframe: '1h',
    });
    const macd1h = computeMACDFromCandles(oneHCandles, 12, 26, 9);
    if (macd1h) {
      oneHMacdOk = momentumDirection === 'LONG'
        ? macd1h.macdLine > macd1h.signalLine
        : macd1h.macdLine < macd1h.signalLine;

      if (isWeighted) {
        oneHBonus = oneHMacdOk ? 1 : 0;
      } else if (cfg.HL_MOMENTUM_MTF_1H_GATE_ENABLED && !oneHMacdOk) {
        logger.debug('[hl-momentum] 1h MACD mismatch', {
          symbol: hlSymbol,
          momentumDirection,
          tradeDirection,
          macdLine: macd1h.macdLine.toFixed(6),
          signalLine: macd1h.signalLine.toFixed(6),
        });
        logDecision(false, '1h_macd_mismatch');
        return null;
      }
    } else {
      logger.debug('[hl-momentum] 1h MACD insufficient data', {
        symbol: hlSymbol,
        candleCount: oneHCandles.length,
      });
    }
  }

  mtfBonus = fourHBonus + oneHBonus;
  totalScore = absScore + mtfBonus;

  // Weighted mode: total score gate replaces MIN_SCORE / individual MTF vetoes.
  if (isWeighted && totalScore < cfg.HL_MOMENTUM_MIN_TOTAL_SCORE) {
    logger.debug('[hl-momentum] weighted mode: totalScore below threshold', {
      symbol: hlSymbol,
      momentumDirection,
      tradeDirection,
      absScore,
      mtfBonus,
      totalScore,
      threshold: cfg.HL_MOMENTUM_MIN_TOTAL_SCORE,
    });
    logDecision(false, 'weighted_total_score_low');
    return null;
  }

  // ────────────────────────────────────────────────────────────────────────

  // Gate: loss cooldown set by futuresMonitor after any losing close.
  const lossCooldown = await redis.get(`futures:loss-cooldown:${hlSymbol}`);
  if (lossCooldown) {
    logger.debug('[hl-momentum] loss cooldown active', { symbol: hlSymbol });
    logDecision(false, 'loss_cooldown');
    return null;
  }

  // Gate: per-side momentum cooldown (prevents re-entering the same thesis immediately).
  const mCooldown = await redis.get(momentumCooldownKey(hlSymbol, tradeDirection));
  if (mCooldown) {
    logger.debug('[hl-momentum] momentum cooldown active', { symbol: hlSymbol, momentumDirection, tradeDirection });
    logDecision(false, 'momentum_cooldown');
    return null;
  }

  // Gate: any open position on this symbol (either side). Opening a LONG against an
  // existing SHORT — or vice versa — just creates a delta-neutral wash that burns fees.
  const [longOpen, shortOpen] = await Promise.all([
    hasOpenPosition(redis, hlSymbol, 'LONG'),
    hasOpenPosition(redis, hlSymbol, 'SHORT'),
  ]);
  if (longOpen || shortOpen) {
    logger.debug('[hl-momentum] position already open', { symbol: hlSymbol, momentumDirection, tradeDirection });
    logDecision(false, 'position_already_open');
    return null;
  }

  if (cfg.HL_MOMENTUM_SOFT_CONFIRM_ENABLED) {
    softConfirmationAnchorOpenTime = latestClosedPrimaryCandle.openTime;
    const confirmKey = momentumStretchConfirmationKey(hlSymbol, momentumDirection);
    const pendingRaw = await redis.get(confirmKey);
    const pendingOpenTime = pendingRaw ? parseInt(pendingRaw, 10) : NaN;
    const hasPending = Number.isFinite(pendingOpenTime);

    if (hasPending && pendingOpenTime < latestClosedPrimaryCandle.openTime) {
      softConfirmationPassed = true;
      void redis.del(confirmKey).catch(() => {});
    } else if (softConfirmationRequired || (hasPending && pendingOpenTime === latestClosedPrimaryCandle.openTime)) {
      if (!hasPending || pendingOpenTime !== latestClosedPrimaryCandle.openTime) {
        void redis.set(
          confirmKey,
          String(latestClosedPrimaryCandle.openTime),
          'EX',
          cfg.HL_MOMENTUM_SOFT_CONFIRM_TTL_SEC,
        ).catch(() => {});
      }
      logger.debug('[hl-momentum] stretch confirmation pending', {
        symbol: hlSymbol,
        momentumDirection,
        tradeDirection,
        barOpenTime: latestClosedPrimaryCandle.openTime,
        reasons: softConfirmationReasons,
      });
      logDecision(false, 'stretch_confirmation_pending', softConfirmationReasons.join(','));
      return null;
    }
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
    direction: tradeDirection,
    wouldBlock: !cfg.HL_MOMENTUM_ENABLED,
    metricValue: isWeighted ? totalScore : score,
    payload: {
      score,
      adx,
      voters,
      voterCount,
      momentumDirection,
      tradeDirection,
      isContrarian,
      binancePrice: tick.price,
      candleCount: primaryCandles.length,
      fourHBiasOk,
      oneHMacdOk,
      primaryTimeframe: '15m',
      scoringMode: cfg.HL_MOMENTUM_MTF_SCORING_MODE,
      mtfBonus,
      totalScore,
      fundingApr,
      fundingContraVote: voters.fundingContra ?? null,
      oiPctChange,
      pricePctChange,
      oiDivergenceVote: voters.oiDivergence ?? null,
      rsi,
      vwapDistPct,
      softConfirmationRequired,
      softConfirmationPassed,
      softConfirmationReasons,
      softConfirmationAnchorOpenTime,
      breakoutRetestMatch,
    },
  }).catch(() => {});

  if (!cfg.HL_MOMENTUM_ENABLED) {
    logger.info(
      isWeighted ? '[hl-momentum] shadow signal (weighted dark)' : '[hl-momentum] shadow signal (dark)',
      {
        symbol: hlSymbol,
        momentumDirection,
        tradeDirection,
        score,
        adx: adx.toFixed(1),
        voters,
        binancePrice: tick.price,
        ...(isWeighted ? { mtfBonus, totalScore } : {}),
        rsi: rsi !== null ? rsi.toFixed(1) : null,
        vwapDistPct: vwapDistPct !== null ? vwapDistPct.toFixed(2) : null,
        softConfirmationRequired,
        softConfirmationPassed,
        softConfirmationReasons,
      },
    );
    logDecision(false, 'scanner_dark');
    return null;
  }

  const stakeUsd = Math.min(cfg.HL_MOMENTUM_STAKE_USD, cfg.FUTURES_MAX_PER_TRADE_USD);
  // Max possible totalScore = voterCount + 3 (2 for 4h aligned, 1 for 1h aligned).
  // Max possible absScore = voterCount. Both denominators scale with voterCount
  // so edge stays in [0,1] regardless of whether the funding voter is active.
  const edgeMagnitude = isWeighted ? totalScore / (voterCount + 3) : absScore / voterCount;

  logger.info('[hl-momentum] signal', {
    symbol: hlSymbol,
    momentumDirection,
    tradeDirection,
    score,
    scoringMode: cfg.HL_MOMENTUM_MTF_SCORING_MODE,
    ...(isWeighted ? { mtfBonus, totalScore } : {}),
    adx: adx.toFixed(1),
    stakeUsd,
    voters,
    binancePrice: tick.price,
    rsi: rsi !== null ? rsi.toFixed(1) : null,
    vwapDistPct: vwapDistPct !== null ? vwapDistPct.toFixed(2) : null,
    softConfirmationRequired,
    softConfirmationPassed,
    softConfirmationReasons,
  });

  logDecision(true);

  const reasoningSuffix = isWeighted
    ? `, totalScore=${totalScore.toString()} (mtfBonus=${mtfBonus.toString()})`
    : '';

  return {
    marketId: hlSymbol,
    question: `HL momentum ${tradeDirection} ${hlSymbol}`,
    direction: tradeDirection,
    stakeUsd,
    edgeMagnitude,
    outcomePrice: tick.price,
    sourcedFrom: 'hl-momentum',
    reasoning: `HL trend scorer (15m): momentum=${momentumDirection}, trade=${tradeDirection}, contrarian=${isContrarian ? 'true' : 'false'}, score=${score.toString()}, ADX=${adx.toFixed(1)}, voters=${JSON.stringify(voters)}${reasoningSuffix}`,
    isFutures: true,
    source: 'hl-momentum',
    eventTs,
    decisionId,
    isContrarian: isContrarian || undefined,
  };
}
