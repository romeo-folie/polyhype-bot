/**
 * Phase 5: Spot Price Monitor — Pipeline Orchestration.
 *
 * poll() → detect() → correlate() → estimate() → diverge() → execute()
 *
 * Runs as `cron:spot` (1-min interval). Independent from the news pipeline.
 * Emits standard TradeSignal[] and shares the same executor, position ledger,
 * idempotency layer, and Telegram notifications.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getRedis, closeRedis, acquireLock, releaseLock } from '../shared/redis.js';
import { getBankroll, deductStake } from '../shared/bankroll.js';
import { getPriceFeed, destroyPriceFeed } from '../shared/feedSingleton.js';
import { resolveYesPrice } from '../shared/priceCache.js';
import { pollSpotPrices } from './poller.js';
import { detectMoves } from './thresholdDetector.js';
import { findCorrelatedMarkets } from './marketCorrelator.js';
import { estimateFastConsensus } from './fastPathConsensus.js';
import { computeDivergence } from '../mapping/divergenceCalculator.js';
import { executeSignals } from '../execution/executor.js';
import { recordPosition, hasOpenPosition } from '../execution/positionLedger.js';
import { notifyTradeExecuted, notifyTradeError } from '../execution/telegram.js';
import { getOpportunities } from '../shared/simmer.js';
import { HL_SYMBOL_MAP } from '../shared/hyperliquid.js';
import { priceZoneOf } from '../shared/zones.js';
import { scoreConfluence } from '../arb/confluenceScorer.js';
import { computeATR } from '../arb/indicators.js';
import { enqueueWrite } from '../db/writeQueue.js';
import type { TradeSignal } from '../mapping/index.js';

/**
 * Run a single spot monitor cycle.
 */
export async function runSpotMonitor(): Promise<void> {
  const cfg = loadConfig();

  if (!cfg.SPOT_MONITOR_ENABLED) {
    logger.info('[spot] spot monitor disabled, skipping');
    return;
  }

  // Prevent overlapping runs — LLM calls can exceed the 1-min cron interval.
  // Token-based: only the acquiring run can release the lock (safe if TTL expires
  // and a newer run reacquires before the older run finishes).
  const redis = getRedis();
  const lockToken = await acquireLock('spot:lock', 120);
  if (!lockToken) {
    logger.info('[spot] previous cycle still running, skipping');
    return;
  }

  try {
    await runSpotMonitorInner(cfg, redis);
  } finally {
    // Release lock explicitly so the next cron run isn't blocked for the full 120s TTL
    await releaseLock('spot:lock', lockToken).catch(() => {
      /* best effort */
    });
  }
}

async function runSpotMonitorInner(
  cfg: ReturnType<typeof loadConfig>,
  redis: ReturnType<typeof getRedis>,
): Promise<void> {
  logger.info('[spot] starting spot monitor cycle');

  const bankrollUsd = await getBankroll(redis);

  // 1. Poll spot prices
  const prices = await pollSpotPrices();
  if (prices.length === 0) {
    logger.info('[spot] no prices fetched, skipping cycle');
    return;
  }

  // 2. Detect significant moves
  const moves = await detectMoves(prices);
  if (moves.length === 0) {
    logger.info('[spot] no significant moves detected');
    return;
  }

  logger.info('[spot] detected moves', { count: moves.length });

  // 3. For each move, identify Futures signals first (High Speed)
  const signals: TradeSignal[] = [];

  for (const move of moves) {
    // Futures Path: Immediate execution for crypto perps
    const hlSymbol = HL_SYMBOL_MAP[move.assetId];
    if (cfg.FUTURES_ENABLED && hlSymbol) {
      // Check if we're already holding this perp on this side
      const alreadyOpen = await hasOpenPosition(
        redis,
        hlSymbol,
        move.changePercent > 0 ? 'LONG' : 'SHORT',
      );

      if (!alreadyOpen) {
        const moveDirection = move.changePercent > 0 ? 'LONG' : 'SHORT';

        // TA confluence gate — block if indicators disagree with the move
        if (cfg.FUTURES_CONFLUENCE_GATE_ENABLED) {
          const confluence = await scoreConfluence(hlSymbol, redis);
          const expectedConfluenceDir = moveDirection === 'LONG' ? 'UP' : 'DOWN';

          // === Shadow logs (Phase 2/3 validation) ===
          // Hoisted above the score gate so they accumulate samples on every
          // confluence evaluation, not just the rare ones that pass. Each
          // shadow only fires when its corresponding hard gate is disabled.
          if (confluence.volume?.ratio !== null && confluence.volume?.ratio !== undefined) {
            if (!cfg.VOLUME_SPIKE_GATE_ENABLED) {
              const ratio = confluence.volume.ratio;
              const passed = ratio >= cfg.VOLUME_SPIKE_MULT;
              logger.info('[spot] volume_spike shadow', {
                symbol: hlSymbol, moveDirection,
                wouldBlock: !passed,
                volRatio: ratio.toFixed(2),
                volMult: cfg.VOLUME_SPIKE_MULT,
                confluenceScore: confluence.score,
              });
              void enqueueWrite('shadow_observations', {
                kind: 'volume_spike', source: 'spot', symbol: hlSymbol, direction: moveDirection,
                wouldBlock: !passed, metricValue: ratio, threshold: cfg.VOLUME_SPIKE_MULT,
                payload: { confluenceScore: confluence.score },
              });
            }
          }
          const adxValShadow = confluence.regime?.adx ?? null;
          if (adxValShadow !== null && !cfg.ADX_GATE_ENABLED) {
            const adxPassed = adxValShadow >= cfg.ADX_MIN;
            logger.info('[spot] adx shadow', {
              symbol: hlSymbol, moveDirection,
              wouldBlock: !adxPassed,
              adx: adxValShadow.toFixed(2), adxMin: cfg.ADX_MIN,
              confluenceScore: confluence.score,
            });
            void enqueueWrite('shadow_observations', {
              kind: 'adx', source: 'spot', symbol: hlSymbol, direction: moveDirection,
              wouldBlock: !adxPassed, metricValue: adxValShadow, threshold: cfg.ADX_MIN,
              payload: { confluenceScore: confluence.score },
            });
          }
          const chopValShadow = confluence.regime?.choppiness ?? null;
          if (chopValShadow !== null && !cfg.CHOPPINESS_GATE_ENABLED) {
            const chopPassed = chopValShadow <= cfg.CHOPPINESS_MAX;
            logger.info('[spot] choppiness shadow', {
              symbol: hlSymbol, moveDirection,
              wouldBlock: !chopPassed,
              choppiness: chopValShadow.toFixed(2), chopMax: cfg.CHOPPINESS_MAX,
              confluenceScore: confluence.score,
            });
            void enqueueWrite('shadow_observations', {
              kind: 'choppiness', source: 'spot', symbol: hlSymbol, direction: moveDirection,
              wouldBlock: !chopPassed, metricValue: chopValShadow, threshold: cfg.CHOPPINESS_MAX,
              payload: { confluenceScore: confluence.score },
            });
          }

          // === Hard gates ===
          if (confluence.score < cfg.FUTURES_MIN_CONFLUENCE_SCORE) {
            logger.info('[spot] futures confluence_block — score too low', {
              symbol: hlSymbol, moveDirection, score: confluence.score,
              signals: confluence.signals,
            });
            continue;
          }
          if (confluence.direction !== expectedConfluenceDir) {
            logger.info('[spot] futures confluence_block — direction mismatch', {
              symbol: hlSymbol, moveDirection,
              confluenceDirection: confluence.direction, score: confluence.score,
              signals: confluence.signals,
            });
            continue;
          }
          if (
            cfg.VOLUME_SPIKE_GATE_ENABLED &&
            confluence.volume?.ratio !== null && confluence.volume?.ratio !== undefined &&
            confluence.volume.ratio < cfg.VOLUME_SPIKE_MULT
          ) {
            logger.info('[spot] futures volume_spike_block', {
              symbol: hlSymbol, moveDirection,
              volRatio: confluence.volume.ratio.toFixed(2),
              volMult: cfg.VOLUME_SPIKE_MULT,
            });
            continue;
          }
          const adxVal = confluence.regime?.adx ?? null;
          if (cfg.ADX_GATE_ENABLED && adxVal !== null && adxVal < cfg.ADX_MIN) {
            logger.info('[spot] futures regime_no_trend', {
              symbol: hlSymbol, moveDirection,
              adx: adxVal.toFixed(2), adxMin: cfg.ADX_MIN,
            });
            continue;
          }
          const chopVal = confluence.regime?.choppiness ?? null;
          if (cfg.CHOPPINESS_GATE_ENABLED && chopVal !== null && chopVal > cfg.CHOPPINESS_MAX) {
            logger.info('[spot] futures regime_chop', {
              symbol: hlSymbol, moveDirection,
              choppiness: chopVal.toFixed(2), chopMax: cfg.CHOPPINESS_MAX,
            });
            continue;
          }

          logger.info('[spot] futures confluence_pass', {
            symbol: hlSymbol, moveDirection, score: confluence.score,
            signals: confluence.signals,
            volRatio: confluence.volume?.ratio?.toFixed(2),
            adx: confluence.regime?.adx?.toFixed(2),
            choppiness: confluence.regime?.choppiness?.toFixed(2),
            bbRegime: confluence.regime?.bbRegime,
          });
        }

        let stakeUsd = Math.min(
          cfg.FUTURES_MAX_PER_TRADE_USD,
          bankrollUsd * cfg.MAX_BET_FRACTION,
        );

        // Volatility-adjusted sizing: scale stake inversely with ATR
        if (cfg.FUTURES_VOL_SIZING_ENABLED) {
          const atrResult = await computeATR(hlSymbol, redis);
          if (atrResult && atrResult.atrPct > 0) {
            const volMultiplier = Math.max(0.3, Math.min(1.5, cfg.FUTURES_ATR_BASELINE_PCT / atrResult.atrPct));
            stakeUsd *= volMultiplier;
            logger.info('[spot] vol-adjusted sizing', {
              symbol: hlSymbol, atrPct: atrResult.atrPct.toFixed(3),
              baseline: cfg.FUTURES_ATR_BASELINE_PCT, volMultiplier: volMultiplier.toFixed(2),
              adjustedStake: stakeUsd.toFixed(2),
            });
          }
        }

        signals.push({
          marketId: hlSymbol,
          question: `Hyperliquid Perp: ${hlSymbol} ${moveDirection}`,
          direction: moveDirection,
          stakeUsd,
          edgeMagnitude: Math.abs(move.changePercent) / 100, // proxy edge by move magnitude
          outcomePrice: move.currentPrice,
          isFutures: true,
          leverage: cfg.FUTURES_DEFAULT_LEVERAGE,
          priceZone: priceZoneOf(move.currentPrice),
          sourcedFrom: `Spot: ${move.assetId} ${move.changePercent > 0 ? '+' : ''}${move.changePercent.toFixed(1)}% in ${move.windowMinutes.toString()}min`,
          reasoning: `Intraday momentum detected on ${move.assetId}. Current price: ${move.currentPrice.toString()}. Scaling into ${hlSymbol} perp.`,
          assetId: move.assetId,
          eventTs: move.eventTs,
          source: 'spot',
          decisionId: randomUUID(),
        });
      }
    }

    let markets;
    try {
      markets = await findCorrelatedMarkets(move);
    } catch (err: unknown) {
      logger.error('[spot] failed to find correlated markets', {
        assetId: move.assetId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (markets.length === 0) {
      logger.info('[spot] no correlated markets for move', { assetId: move.assetId });
      continue;
    }

    const feed = getPriceFeed(redis);

    for (const market of markets) {
      // Subscribe to WS price updates for this correlated market
      await feed.watch(market.marketId, market.clobTokenIds);

      // Resolve price: WS cache first, Gamma snapshot fallback
      let currentYesPrice = market.currentYesPrice;
      const wsPrice = await resolveYesPrice(market.marketId, redis, feed);
      if (wsPrice !== null) currentYesPrice = wsPrice;

      // 4. Estimate consensus probability
      let consensus;
      try {
        consensus = await estimateFastConsensus(move, market);
      } catch (err: unknown) {
        logger.warn('[spot] consensus estimation failed', {
          marketId: market.marketId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // Adjust probability based on correlation direction AND actual move direction.
      // correlationDirection answers: "does asset RISING make YES more likely?"
      //   positive + price up   → consensus as-is
      //   positive + price down → invert (asset falling makes YES less likely)
      //   negative + price up   → invert (asset rising makes YES less likely)
      //   negative + price down → as-is  (asset falling makes YES more likely)
      const shouldInvert =
        (market.correlationDirection === 'positive' && move.changePercent < 0) ||
        (market.correlationDirection === 'negative' && move.changePercent > 0);
      const adjustedProbability = shouldInvert ? 1 - consensus.probability : consensus.probability;

      // 5. Compute divergence
      // Spot fast-path: formula-based estimates are deterministic (stddev=0).
      // LLM fallback goes through estimateConsensusProbability which returns real stddev.
      // Both cases now propagate correctly — EV gate is properly conservative for LLM calls.
      const consensusStddev = consensus.stddev;
      const { hasTrade, decision } = computeDivergence({
        consensusProbability: adjustedProbability,
        consensusStddev,
        currentYesPrice,
        bankrollUsd,
        divergenceThreshold: cfg.SPOT_DIVERGENCE_THRESHOLD,
        maxBetFraction: cfg.MAX_BET_FRACTION,
        minPriceForLlmTrust: cfg.MIN_PRICE_FOR_LLM_TRUST,
        maxLlmProbAtLowPrice: cfg.MAX_LLM_PROB_AT_LOW_PRICE,
        ...(market.endDate ? { endDate: market.endDate } : {}),
        source: 'spot',
        maxHoursToResolution: cfg.PM_MAX_HOURS_TO_RESOLUTION_SPOT,
        minHoursToResolution: cfg.PM_MIN_HOURS_TO_RESOLUTION,
        zone3FeeBuffer: cfg.ZONE3_FEE_BUFFER,
        zone4DirectionalBlock: cfg.ZONE4_DIRECTIONAL_BLOCK,
        zone5DirectionalBlock: cfg.ZONE5_DIRECTIONAL_BLOCK,
        kellyProbeDelta: cfg.KELLY_PROBE_DELTA,
        kellyRequireSignStable: cfg.KELLY_REQUIRE_SIGN_STABLE,
      });

      if (!hasTrade || !decision) continue;

      const sourcedFrom =
        `Spot: ${move.assetId} ${move.changePercent > 0 ? '+' : ''}${move.changePercent.toFixed(1)}% ` +
        `in ${move.windowMinutes.toString()}min`;

      signals.push({
        marketId: market.marketId,
        conditionId: market.conditionId,
        clobTokenIds: market.clobTokenIds,
        question: market.question,
        direction: decision.direction,
        stakeUsd: decision.stakeUsd,
        edgeMagnitude: decision.edgeMagnitude,
        consensusProbability: decision.consensusProbability,
        consensusStddev,
        outcomePrice: decision.outcomePrice,
        halfKellyFraction: decision.halfKellyFraction,
        priceZone: decision.priceZone,
        sourcedFrom,
        reasoning: consensus.reasoning,
        source: 'spot',
        assetId: move.assetId,
        eventTs: move.eventTs,
        endDate: market.endDate ?? undefined,
      });
    }
  }

  if (signals.length === 0) {
    logger.info('[spot] no trade signals after divergence check');
    return;
  }

  // 5b. Cross-check with Simmer opportunities — boost confidence when Simmer agrees
  // Fetch opportunities once per cycle (not per signal) to avoid rate limit pressure.
  // If Simmer's AI oracle disagrees with our direction, log it and reduce stake by 50%.
  const simmerOpps = await getOpportunities({
    venue: 'polymarket',
    limit: 50,
    minDivergence: 0.03,
  });
  const simmerOppByQuestion = new Map(simmerOpps.map((o) => [o.question.toLowerCase().trim(), o]));

  const crossCheckedSignals = signals.map((signal) => {
    const oppKey = signal.question.toLowerCase().trim();
    const opp = simmerOppByQuestion.get(oppKey);
    if (!opp) return signal; // no Simmer view — proceed as-is

    const simmerAgreesDirection = opp.recommended_side === signal.direction.toLowerCase();
    if (!simmerAgreesDirection && opp.signal_source === 'oracle') {
      // Oracle-grade disagreement — reduce stake (don't skip, LLM reasoning may still be valid)
      logger.warn('[spot] Simmer oracle disagrees with signal direction — halving stake', {
        marketId: signal.marketId,
        ourDirection: signal.direction,
        simmerSide: opp.recommended_side,
        simmerDivergence: opp.divergence,
      });
      return { ...signal, stakeUsd: signal.stakeUsd * 0.5 };
    }

    if (simmerAgreesDirection && opp.signal_source === 'oracle') {
      logger.info('[spot] Simmer oracle confirms signal direction', {
        marketId: signal.marketId,
        direction: signal.direction,
        simmerDivergence: opp.divergence,
      });
    }

    return signal;
  });

  // 6a. Deduplicate signals by marketId:direction — multiple spot moves in one
  // cycle can correlate to the same market. Keep the highest-edge signal only
  // to prevent duplicate execution before position is recorded.
  const bestByKey = new Map<string, TradeSignal>();
  for (const signal of crossCheckedSignals) {
    const key = `${signal.marketId}:${signal.direction}`;
    const existing = bestByKey.get(key);
    if (!existing || signal.edgeMagnitude > existing.edgeMagnitude) {
      bestByKey.set(key, signal);
    }
  }
  const dedupedSignals = Array.from(bestByKey.values());

  // 6b. Pre-check: skip signals where a position is already open (guards against
  // the race between executeSignals and recordPosition in the same cycle).
  const filteredSignals: TradeSignal[] = [];
  for (const signal of dedupedSignals) {
    const alreadyOpen = await hasOpenPosition(redis, signal.marketId, signal.direction);
    if (alreadyOpen) {
      logger.info('[spot] skipping signal — position already open', {
        marketId: signal.marketId,
        direction: signal.direction,
      });
      continue;
    }
    filteredSignals.push(signal);
  }

  if (filteredSignals.length === 0) {
    logger.info('[spot] all signals filtered (dedup or existing positions)');
    return;
  }

  logger.info('[spot] executing trade signals', {
    raw: signals.length,
    afterDedup: dedupedSignals.length,
    afterPositionCheck: filteredSignals.length,
  });

  // 6c. Execute signals via shared executor
  const results = await executeSignals(filteredSignals, redis);

  for (const result of results) {
    if (result.skipped) {
      logger.info('[spot] signal skipped', {
        marketId: result.signal.marketId,
        executionId: result.signal.executionId,
        reason: result.skipReason,
      });
      continue;
    }

    if (result.error) {
      logger.error('[spot] trade execution failed', {
        marketId: result.signal.marketId,
        executionId: result.signal.executionId,
        error: result.error,
      });
      await notifyTradeError(result.signal, result.error);
      continue;
    }

    if (!result.tradeResult?.success) {
      await notifyTradeError(result.signal, result.tradeResult?.error ?? 'unknown error');
      continue;
    }

    // Record position
    await recordPosition(redis, {
      marketId: result.signal.marketId,
      executionId: result.signal.executionId,
      conditionId: result.signal.conditionId,
      clobTokenIds: result.signal.clobTokenIds,
      question: result.signal.question,
      direction: result.signal.direction,
      entryPrice: result.signal.outcomePrice,
      stakeUsd: result.signal.stakeUsd,
      openedAt: new Date().toISOString(),
      sourcedFrom: result.signal.sourcedFrom,
      consensusProbability: result.signal.consensusProbability,
      consensusStddev: result.signal.consensusStddev,
      edgeMagnitude: result.signal.edgeMagnitude,
      executionVenue: result.executionVenue ?? 'simmer',
      assetId: result.signal.assetId,
      endDate: result.signal.endDate,
      priceZone: result.signal.priceZone,
    });

    await deductStake(redis, result.signal.stakeUsd);
    await notifyTradeExecuted(result.signal, result.tradeResult.tx_hash);

    logger.info('[spot] trade executed', {
      marketId: result.signal.marketId,
      executionId: result.signal.executionId,
      direction: result.signal.direction,
      stakeUsd: result.signal.stakeUsd,
      venue: result.executionVenue,
    });
  }

  logger.info('[spot] spot monitor cycle complete', {
    signalsGenerated: signals.length,
    executed: results.filter((r) => !r.skipped && !r.error).length,
    skipped: results.filter((r) => r.skipped).length,
    errors: results.filter((r) => r.error).length,
  });
}

// CLI entrypoint — only runs when executed directly, not when imported
async function main() {
  try {
    await runSpotMonitor();
  } catch (err: unknown) {
    logger.error('[spot] fatal error', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  } finally {
    destroyPriceFeed();
    await closeRedis();
  }
}

// Entrypoint when run directly (npx tsx src/spot/index.ts)
const isMain = process.argv[1]?.endsWith('spot/index.ts') ?? false;
if (isMain) {
  void main();
}
