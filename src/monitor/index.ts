/**
 * Phase 4: Position Monitor & Take-Profit
 *
 * Cron entrypoint — runs every 5 minutes.
 *
 * For each open position in the Redis ledger:
 *   1. Fetch current Polymarket price via Gamma API
 *   2. Evaluate take-profit conditions (threshold + divergence closed)
 *   3. If exit triggered: execute sell via Simmer, remove from ledger, notify Telegram
 */

import 'dotenv/config';
import { getRedis, closeRedis, acquireLock, releaseLock } from '../shared/redis.js';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { isCryptoAsset } from '../shared/assets.js';
import { getOpenPositions, updateHighWaterMark } from '../execution/positionLedger.js';
import { evaluateTrailingStop } from './trailingStopExit.js';
import { fetchAllCurrentPrices } from './priceFetcher.js';
import { getPriceFeed, destroyPriceFeed } from '../shared/feedSingleton.js';
import { evaluateTakeProfit } from './takeProfitEvaluator.js';
import { executeTakeProfit } from './takeProfitExecutor.js';
import {
  evaluateStale,
  recordStaleSample,
  computePnlRangePct,
  markStaleCooldown,
} from './staleExit.js';
import { evaluateTrend, fetchTrendSamples } from './trendExit.js';
import { redeemResolvedPositions } from './resolutionRedeemer.js';
import { runClobProbe } from '../shared/clobProbe.js';
import { setAgentAutoRedeem } from '../shared/simmer.js';
import { runReconciliation } from './reconciliation.js';

export async function runMonitor(): Promise<void> {
  const redis = getRedis();

  // Prevent overlapping runs — a slow cycle (many positions, Simmer API latency)
  // can exceed the 5-min cron interval and stack processes on low-memory hosts.
  // Token-based: only the acquiring run can release the lock (safe if TTL expires
  // and a newer run reacquires before the older run finishes).
  const lockToken = await acquireLock('monitor:lock', 270);
  if (!lockToken) {
    logger.info('[monitor] previous cycle still running, skipping');
    return;
  }

  // Truly fire-and-forget CLOB probe — must not block or delay the monitor.
  // Wrapped in a 10s timeout so upstream latency can never stall startup.
  void Promise.race([
    runClobProbe(),
    new Promise<void>((_, reject) =>
      setTimeout(() => {
        reject(new Error('probe timeout'));
      }, 10_000),
    ),
  ]).catch((err) => {
    logger.warn('[monitor] CLOB probe failed — continuing', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  try {
    await runMonitorInner(redis);
  } finally {
    await releaseLock('monitor:lock', lockToken).catch(() => {
      /* best effort */
    });
    destroyPriceFeed();
  }
}

async function runMonitorInner(redis: ReturnType<typeof getRedis>): Promise<void> {
  const cfg = loadConfig();
  
  // 0. Determine cycle type (Heavy vs Light)
  // Heavy cycle: Resolution redemption + Reconciliation + Full Balance Sync.
  // Light cycle: Just Price Check + SL/TP evaluation (High Speed).
  const nowMs = Date.now();
  const lastHeavyStr = await redis.get('monitor:last_heavy_ms');
  const lastHeavyMs = lastHeavyStr && Number.isFinite(parseInt(lastHeavyStr, 10))
    ? parseInt(lastHeavyStr, 10)
    : 0;
  const isHeavyCycle = (nowMs - lastHeavyMs) >= cfg.MONITOR_HEAVY_INTERVAL_MIN * 60 * 1000;

  logger.info('[monitor] starting position check', { 
    cycleType: isHeavyCycle ? 'HEAVY' : 'LIGHT',
    interval: cfg.MONITOR_HEAVY_INTERVAL_MIN
  });

  if (isHeavyCycle) {
    // 1. Initial reconciliation pass (self-healing)
    logger.info('[monitor] running heavy reconciliation pass');
    await runReconciliation(redis, { forceFix: true });

    // 2. Redeem any resolved winning positions
    const redemptions = await redeemResolvedPositions(redis);
    if (redemptions.length > 0) {
      const succeeded = redemptions.filter((r) => r.success).length;
      const failed = redemptions.length - succeeded;
      logger.info('[monitor] redemption cycle complete', { succeeded, failed });
    }
    
    // Update last heavy timestamp
    await redis.set('monitor:last_heavy_ms', nowMs.toString());
  }

  // 1. Load all open positions
  const positions = await getOpenPositions(redis);

  if (positions.length === 0) {
    logger.info('[monitor] no open positions — nothing to do');
    return;
  }

  logger.info('[monitor] checking positions', { count: positions.length });

  // 2a. Register watches for all positions before reading prices.
  // feed.watch() is idempotent and CONNECTING-safe — safe to call in bulk here.
  const feed = getPriceFeed(redis);
  await Promise.all(
    positions.map((p) => feed.watch(p.marketId, p.clobTokenIds ?? []).catch(() => undefined)),
  );

  // 2b. Fetch current prices for all positions
  const priceMap = await fetchAllCurrentPrices(positions);

  // 3. Evaluate and act on each position
  let exited = 0;
  let held = 0;
  let priceError = 0;

  for (const position of positions) {
    // Positions flagged as pendingSettlement are below the CLOB $1 minimum —
    // skip them silently; the resolution redeemer handles settlement.
    if (position.pendingSettlement === true) {
      logger.debug('[monitor] skipping pendingSettlement position', {
        marketId: position.marketId,
        direction: position.direction,
      });
      held++;
      continue;
    }

    if (position.reconciliationStatus === 'terminal_no_balance') {
      logger.debug('[monitor] skipping terminal_no_balance position', {
        marketId: position.marketId,
        direction: position.direction,
      });
      held++;
      continue;
    }

    const currentPrice = priceMap.get(`${position.marketId}:${position.direction}`);

    if (!currentPrice) {
      // Price unavailable — skip, monitor will retry next cycle
      logger.warn('[monitor] price unavailable — skipping', {
        marketId: position.marketId,
      });
      priceError++;
      continue;
    }

    // 3b. Tiered thresholds calculation
    let tpThreshold = cfg.TAKE_PROFIT_THRESHOLD;
    let slThreshold = cfg.STOP_LOSS_THRESHOLD;

    const isCopytrade = position.sourcedFrom?.startsWith('copytrade:');
    if (isCopytrade) {
      tpThreshold = cfg.COPYTRADE_TAKE_PROFIT;
      slThreshold = cfg.COPYTRADE_STOP_LOSS;
    } else if (cfg.TIERED_LOGIC_ENABLED) {
      const isCrypto = position.assetId ? isCryptoAsset(position.assetId) : false;

      // Check for short duration: resolution within SHORT_DURATION_HOURS
      let isShortDuration = false;
      if (position.endDate) {
        const endMs = new Date(position.endDate).getTime();
        const diffHrs = (endMs - Date.now()) / (1000 * 60 * 60);
        if (diffHrs > 0 && diffHrs <= cfg.SHORT_DURATION_HOURS) {
          isShortDuration = true;
        }
      }

      if (isCrypto) {
        tpThreshold = cfg.CRYPTO_TAKE_PROFIT;
        slThreshold = cfg.CRYPTO_STOP_LOSS;
      } else if (isShortDuration) {
        tpThreshold = cfg.SHORT_DURATION_TAKE_PROFIT;
        slThreshold = cfg.SHORT_DURATION_STOP_LOSS;
      }
    }

    const decision = evaluateTakeProfit(
      position,
      currentPrice,
      tpThreshold,
      slThreshold,
      {
        enabled: cfg.ZONE_AWARE_SL_ENABLED,
        extremeLow: cfg.ZONE_AWARE_SL_EXTREME_LOW,
        extremeHigh: cfg.ZONE_AWARE_SL_EXTREME_HIGH,
        minAbsoluteMove: cfg.ZONE_AWARE_SL_MIN_ABS_MOVE,
      },
    );

    logger.info('[monitor] position evaluated', {
      marketId: position.marketId,
      direction: position.direction,
      entryPrice: position.entryPrice.toFixed(3),
      currentPrice: currentPrice.currentOutcomePrice.toFixed(3),
      returnPct: decision.returnPct.toFixed(2),
      shouldExit: decision.shouldExit,
      reason: decision.reason,
    });

    // Trailing-stop suppression: when enabled, a fixed-TP exit is SUPPRESSED
    // so the trailing block below can take over. SL and divergence_closed still fire.
    const isFuturesPosTop =
      position.isFutures === true || position.executionVenue === 'hyperliquid';
    const isCopytradePosTop = position.sourcedFrom?.startsWith('copytrade:') ?? false;
    const trailingActive =
      cfg.TRAILING_STOP_ENABLED && !isFuturesPosTop && !isCopytradePosTop;

    const suppressTpExit =
      trailingActive &&
      decision.shouldExit &&
      decision.reason === 'take_profit_threshold';

    if (decision.shouldExit && decision.reason && !suppressTpExit) {
      const result = await executeTakeProfit({
        position,
        currentPrice: currentPrice.currentOutcomePrice,
        returnPct: decision.returnPct,
        reason: decision.reason,
        redis,
      });

      if (result.success) {
        exited++;
      } else {
        // Failed to exit — position stays in ledger, will retry next cycle
        logger.warn('[monitor] exit failed — will retry next cycle', {
          marketId: position.marketId,
          error: result.error,
        });
      }
      continue;
    }

    // Trailing-stop evaluation — runs on every tick when enabled so HWM stays fresh.
    if (trailingActive) {
      const trailingDecision = evaluateTrailingStop({
        position,
        currentPnlPct: decision.returnPct,
        currentBid: currentPrice.currentOutcomePrice,
        cfg,
      });

      // Persist HWM unconditionally so peak tracking is always up to date.
      if (
        !Number.isFinite(position.highWaterMarkPct ?? NaN) ||
        trailingDecision.newHwmPct > (position.highWaterMarkPct ?? Number.NEGATIVE_INFINITY)
      ) {
        await updateHighWaterMark(
          redis,
          position.marketId,
          position.direction,
          trailingDecision.newHwmPct,
        ).catch((err: unknown) => {
          logger.debug('[monitor] updateHighWaterMark failed (non-fatal)', {
            marketId: position.marketId,
            error: String(err),
          });
        });
      }

      if (trailingDecision.shouldExit) {
        logger.info('[monitor] trailing_stop triggered', {
          marketId: position.marketId,
          direction: position.direction,
          peakPct: trailingDecision.peakPct.toFixed(2),
          floorPct: trailingDecision.floorPct.toFixed(2),
          currentPnlPct: decision.returnPct.toFixed(2),
          drawdownPct: trailingDecision.drawdownPct.toFixed(2),
        });
        const trailResult = await executeTakeProfit({
          position,
          currentPrice: currentPrice.currentOutcomePrice,
          returnPct: decision.returnPct,
          reason: 'trailing_stop',
          redis,
        });
        if (trailResult.success) {
          exited++;
        } else {
          logger.warn('[monitor] trailing-stop exit failed — will retry next cycle', {
            marketId: position.marketId,
            error: trailResult.error,
          });
          held++;
        }
        continue;
      }
    }

    // Trend-exit and stale-exit paths — only run when TP/SL/divergence did NOT fire.
    // Excludes futures (handled by futuresMonitor) and copytrades (own exit logic).
    const isFuturesPos =
      position.isFutures === true || position.executionVenue === 'hyperliquid';
    const isCopytradePos = position.sourcedFrom?.startsWith('copytrade:') ?? false;
    const sampleTrackingNeeded =
      !isFuturesPos && !isCopytradePos &&
      (cfg.TREND_EXIT_ENABLED || cfg.STALE_EXIT_ENABLED);

    if (!sampleTrackingNeeded) {
      held++;
      continue;
    }

    // Update rolling peak PnL + price sample window — shared by both evaluators.
    const sampleState = await recordStaleSample(redis, position, decision.returnPct).catch(
      (err: unknown) => {
        logger.debug('[monitor] recordStaleSample failed (non-fatal)', {
          marketId: position.marketId,
          error: String(err),
        });
        return { peakPnlPct: decision.returnPct, firstSeenMs: Date.now() };
      },
    );

    // ── Trend-exit evaluation ──────────────────────────────────────────────────
    // Runs regardless of TREND_EXIT_ENABLED so shadow lines appear while dark.
    // Re-entry uses the shared stale:cooldown key (markStaleCooldown).
    {
      const trendWindowMs = cfg.TREND_EXIT_WINDOW_H * 60 * 60 * 1000;
      const trendSamples = await fetchTrendSamples(
        redis,
        position,
        trendWindowMs,
      ).catch(() => [] as { tH: number; pct: number }[]);

      const trendDecision = evaluateTrend({
        position,
        currentPnlPct: decision.returnPct,
        firstSeenMs: sampleState.firstSeenMs,
        samples: trendSamples,
        cfg,
      });

      const trendLogFields = {
        marketId: position.marketId,
        direction: position.direction,
        category: trendDecision.category,
        slopePerH: trendDecision.slopePerH?.toFixed(3) ?? null,
        thresholdPerH: trendDecision.thresholdSlopePerH,
        r2: trendDecision.r2?.toFixed(3) ?? null,
        samples: trendDecision.sampleCount,
        currentPnlPct: trendDecision.currentPnlPct.toFixed(2),
        ageH: trendDecision.ageH.toFixed(2),
        blockedReason: trendDecision.blockedReason,
      };

      if (trendDecision.shouldExit && cfg.TREND_EXIT_ENABLED) {
        logger.info('[monitor] trend_exit triggered', trendLogFields);
        const trendResult = await executeTakeProfit({
          position,
          currentPrice: currentPrice.currentOutcomePrice,
          returnPct: decision.returnPct,
          reason: 'trend_exit',
          redis,
        });
        if (trendResult.success) {
          exited++;
          await markStaleCooldown(redis, position.marketId).catch(() => {
            /* non-fatal */
          });
        } else {
          logger.warn('[monitor] trend-exit failed — will retry next cycle', {
            marketId: position.marketId,
            error: trendResult.error,
          });
          held++;
        }
        continue;
      } else if (!cfg.TREND_EXIT_ENABLED) {
        // Shadow mode: log every evaluation so we can see what gates are blocking
        logger.info('[monitor] trend_exit shadow', {
          ...trendLogFields,
          wouldExit: trendDecision.shouldExit,
        });
      }
    }

    // ── Stale-exit evaluation ─────────────────────────────────────────────────
    if (!cfg.STALE_EXIT_ENABLED) {
      held++;
      continue;
    }

    const windowMs = cfg.STALE_VOL_WINDOW_H * 60 * 60 * 1000;
    const priceRangePct = await computePnlRangePct(redis, position, windowMs).catch(
      () => null,
    );

    const staleDecision = evaluateStale({
      position,
      currentPnlPct: decision.returnPct,
      peakPnlPct: sampleState.peakPnlPct,
      firstSeenMs: sampleState.firstSeenMs,
      priceRangePct,
      cfg,
    });

    if (!staleDecision.shouldExit) {
      held++;
      continue;
    }

    logger.info('[monitor] stale-exit triggered', {
      marketId: position.marketId,
      direction: position.direction,
      rule: staleDecision.rule,
      ageH: staleDecision.ageH.toFixed(2),
      trackedH: staleDecision.trackedH.toFixed(2),
      categoryAgeH: staleDecision.categoryAgeH,
      peakPnlPct: staleDecision.peakPnlPct.toFixed(2),
      currentPnlPct: staleDecision.currentPnlPct.toFixed(2),
      priceRangePct: staleDecision.priceRangePct?.toFixed(2),
    });

    const staleResult = await executeTakeProfit({
      position,
      currentPrice: currentPrice.currentOutcomePrice,
      returnPct: decision.returnPct,
      reason: 'stale_exit',
      redis,
    });

    if (staleResult.success) {
      exited++;
      await markStaleCooldown(redis, position.marketId).catch(() => {
        /* non-fatal */
      });
    } else {
      logger.warn('[monitor] stale-exit failed — will retry next cycle', {
        marketId: position.marketId,
        error: staleResult.error,
      });
      held++;
    }
  }

  logger.info('[monitor] cycle complete', { exited, held, priceError });
}

// Entrypoint when run directly (npx tsx src/monitor/index.ts)
const isMain = process.argv[1]?.endsWith('monitor/index.ts') ?? false;
if (isMain) {
  // Sync Simmer agent auto-redeem setting at startup
  const cfg = loadConfig();
  void setAgentAutoRedeem(cfg.SIMMER_AUTO_REDEEM_ENABLED).catch((err) => {
    logger.warn('[monitor] failed to set Simmer auto-redeem — continuing', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  runMonitor()
    .catch((err: unknown) => {
      logger.error('[monitor] fatal error', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exitCode = 1;
    })
    .finally(() => {
      destroyPriceFeed();
      closeRedis().catch(() => undefined);
    });
}
