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
import { inferCategory, inferSource } from '../shared/outcomeRecorder.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { getOpenPositions, updateHighWaterMark, markPositionPendingSettlement } from '../execution/positionLedger.js';
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
import { evaluateWeatherNearRes } from './weatherNearResExit.js';
import { redeemResolvedPositions } from './resolutionRedeemer.js';
import { runClobProbe } from '../shared/clobProbe.js';
import { runReconciliation } from './reconciliation.js';

export async function runMonitor(): Promise<void> {
  const redis = getRedis();

  // Prevent overlapping runs — a slow cycle (many positions, CLOB API latency)
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

export async function runMonitorInner(redis: ReturnType<typeof getRedis>): Promise<void> {
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

    if (position.isFutures === true || position.executionVenue === 'hyperliquid') {
      held++;
      continue;
    }

    // Oracle-lag positions are governed by the dedicated exit monitor in
    // pga-arb (src/arb/oracleLagExitMonitor.ts) — gap-compression + reversal
    // + max-hold. The generic take-profit evaluator uses the crypto-updown
    // category's 3% TP, which fires on the first tick after fill and caps
    // what should be a structural-edge trade.
    //
    // Gated on ORACLE_LAG_EXIT_ENABLED so this is a true ownership-transfer:
    // flag=true → dedicated monitor owns exits, generic monitor skips;
    // flag=false → dedicated monitor is shadow-only, so generic monitor stays
    // in charge as the documented fallback (see config.ts + oracleLagExitMonitor.ts
    // headers). Prevents an oracle-lag position from losing all exit oversight
    // if the flag is reverted without reverting the skip.
    if (cfg.ORACLE_LAG_EXIT_ENABLED && position.sourcedFrom?.startsWith('oracle-lag:')) {
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

    // Near-resolution gate: when the held outcome's price reaches the near-res
    // threshold (default 0.95), the market is effectively settled — the only way
    // to capture the remaining value is on-chain redemption, not a CLOB sell.
    //
    // Why this matters: the WS best-bid cache derives NO price as (1 − YES bid).
    // When a market resolves, YES bids collapse to ~0.01, so NO appears to be
    // worth ~0.99.  The trailing stop records this as its peak (HWM = +60 %+).
    // Thirty seconds later the WS TTL expires; Gamma REST returns the stale CLOB
    // mid-price (~0.575) and the drawdown from peak fires the trailing stop,
    // selling our position at a significant loss instead of waiting for the
    // redeemer to collect full settlement value.
    //
    // Fix: as soon as currentOutcomePrice ≥ threshold, mark the position as
    // pendingSettlement (skipped by this loop henceforth) and let the redeemer's
    // heavy cycle handle on-chain collection.  The redeemer checks on-chain
    // status before acting — if the market hasn't settled yet it simply waits.
    //
    // The threshold (0.95) is intentionally high so normal in-play price swings
    // never trigger this gate.  At 0.95+, the implied probability of the other
    // side winning is ≤5%; a CLOB exit at that point would capture far less than
    // the settlement payout.
    if (currentPrice.currentOutcomePrice >= cfg.MONITOR_NEAR_RES_PRICE_THRESHOLD) {
      // Gate A — time gate (weather only): block pendingSettlement when the market's
      // endDate is more than MONITOR_NEAR_RES_MIN_HOURS_TO_RES away. A thin-book
      // spike on a market resolving tomorrow cannot be genuine near-resolution.
      // Non-weather markets are excluded: their endDate may not match actual
      // resolution time (markets can resolve early before their stated endDate).
      const isWeatherSource = (position.sourcedFrom?.startsWith('weather:') || position.sourcedFrom?.startsWith('weather-oracle:')) ?? false;
      if (isWeatherSource && position.endDate && cfg.MONITOR_NEAR_RES_MIN_HOURS_TO_RES > 0) {
        const hoursToEnd = (new Date(position.endDate).getTime() - Date.now()) / 3_600_000;
        if (hoursToEnd > cfg.MONITOR_NEAR_RES_MIN_HOURS_TO_RES) {
          logger.debug('[monitor] near-res: price spike on weather market — too far from resolution, ignoring', {
            marketId: position.marketId,
            direction: position.direction,
            currentOutcomePrice: currentPrice.currentOutcomePrice.toFixed(3),
            hoursToEnd: hoursToEnd.toFixed(1),
            minHoursToRes: cfg.MONITOR_NEAR_RES_MIN_HOURS_TO_RES,
          });
          held++;
          continue;
        }
      }

      // Gate B — persistence gate: require the price to have been above threshold
      // for at least MONITOR_NEAR_RES_PERSIST_S seconds. A spike that lasts one
      // monitor tick (~5s) never fires; a genuinely settled market at 0.99 fires
      // after the configured window elapses.
      const persistKey = `near_res_seen:${position.marketId}:${position.direction}`;
      if (cfg.MONITOR_NEAR_RES_PERSIST_S > 0) {
        const firstSeenRaw = await redis.get(persistKey).catch(() => null);
        const now = Date.now();
        if (!firstSeenRaw) {
          // First observation above threshold — record timestamp and skip this tick.
          await redis.set(persistKey, String(now), 'EX', cfg.MONITOR_NEAR_RES_PERSIST_S * 2 + 60).catch(() => null);
          logger.debug('[monitor] near-res: price above threshold — waiting for persistence window', {
            marketId: position.marketId,
            direction: position.direction,
            currentOutcomePrice: currentPrice.currentOutcomePrice.toFixed(3),
            persistWindowS: cfg.MONITOR_NEAR_RES_PERSIST_S,
          });
          held++;
          continue;
        }
        const firstSeen = parseInt(firstSeenRaw, 10);
        if (!Number.isFinite(firstSeen)) {
          // Corrupted value — treat as first observation and overwrite.
          await redis.set(persistKey, String(now), 'EX', cfg.MONITOR_NEAR_RES_PERSIST_S * 2 + 60).catch(() => null);
          held++;
          continue;
        }
        const elapsedS = (now - firstSeen) / 1000;
        if (elapsedS < cfg.MONITOR_NEAR_RES_PERSIST_S) {
          logger.debug('[monitor] near-res: persistence window not yet met', {
            marketId: position.marketId,
            direction: position.direction,
            elapsedS: elapsedS.toFixed(0),
            requiredS: cfg.MONITOR_NEAR_RES_PERSIST_S,
          });
          held++;
          continue;
        }
      }

      // Both gates passed — genuine near-resolution.
      await redis.del(persistKey).catch(() => null);
      logger.info('[monitor] near-resolution detected — routing to redeemer', {
        marketId: position.marketId,
        direction: position.direction,
        currentOutcomePrice: currentPrice.currentOutcomePrice.toFixed(3),
        entryPrice: position.entryPrice.toFixed(3),
        threshold: cfg.MONITOR_NEAR_RES_PRICE_THRESHOLD,
      });
      await markPositionPendingSettlement(redis, position.marketId, position.direction).catch(
        (err: unknown) => {
          logger.warn('[monitor] near-res: failed to mark pendingSettlement — will retry next cycle', {
            marketId: position.marketId,
            error: String(err),
          });
        },
      );
      held++;
      continue;
    }

    // 3b. Tiered thresholds calculation
    let tpThreshold = cfg.TAKE_PROFIT_THRESHOLD;
    let slThreshold = cfg.STOP_LOSS_THRESHOLD;

    // Computed once and reused across all threshold/gate branches below.
    const inferredCategory = inferCategory(position.question);
    const isWeather = inferredCategory === 'weather';

    const isRebateFarming = position.sourcedFrom === 'rebate-farming';
    const isCopytrade = position.sourcedFrom?.startsWith('copytrade:');
    const isFvScanner = position.sourcedFrom?.startsWith('fv-scanner:') ?? false;

    // FV scanner positions are 15-minute binaries that should hold to resolution.
    // The near-res gate (0.95 → redeemer) is the winning exit; SL is the losing
    // exit. TP and trailing would fire prematurely on the natural drift toward 1.0,
    // so tpThreshold is set above any reachable binary return to keep them dormant.
    if (isFvScanner) {
      tpThreshold = Number.POSITIVE_INFINITY; // disables TP and trailing activation for all entry prices
      slThreshold = cfg.CRYPTO_UPDOWN_STOP_LOSS;
    } else if (isRebateFarming) {
      tpThreshold = cfg.REBATE_TAKE_PROFIT_PCT / 100;
      slThreshold = cfg.REBATE_STOP_LOSS_PCT / 100;
    } else if (isCopytrade) {
      tpThreshold = cfg.COPYTRADE_TAKE_PROFIT;
      slThreshold = cfg.COPYTRADE_STOP_LOSS;
      if (inferredCategory.startsWith('sports')) {
        // Sports copytrades get a tighter SL — fast-resolving binaries where
        // losses are catastrophic (-41% to -57% observed over 2 weeks).
        slThreshold = cfg.COPYTRADE_SPORTS_STOP_LOSS;
        // Hold-to-resolution: disable TP + trailing so in-play price swings
        // (a single break of serve can move ±13% in one monitor tick) don't
        // trigger premature exits.  Binary markets resolve at 0 or 1; the only
        // legitimate exits are the SL above and the near-res gate
        // (MONITOR_NEAR_RES_PRICE_THRESHOLD → redeemer).
        // Mirrors the FV-scanner hold-to-res pattern.
        if (cfg.COPYTRADE_SPORTS_HOLD_TO_RES) {
          tpThreshold = Number.POSITIVE_INFINITY;
        }
      }
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

      const isCryptoUpdown = inferredCategory === 'crypto-updown';
      // Sports-arb signals set sourcedFrom='sports:league:gameId'. Don't rely on
      // inferCategory — it misses team-name questions that lack keywords like
      // "mlb"/"baseball", falling through to 'geopolitical' and the default 16% SL.
      const isSports = inferSource(position.sourcedFrom ?? '') === 'sports';

      if (isCryptoUpdown) {
        tpThreshold = cfg.CRYPTO_UPDOWN_TAKE_PROFIT;
        slThreshold = cfg.CRYPTO_UPDOWN_STOP_LOSS;
      } else if (isWeather) {
        // 0 = disabled (hold to resolution). Use Infinity so the evaluator never fires.
        tpThreshold = cfg.WEATHER_TAKE_PROFIT > 0 ? cfg.WEATHER_TAKE_PROFIT : Number.POSITIVE_INFINITY;
        slThreshold = cfg.WEATHER_STOP_LOSS > 0 ? cfg.WEATHER_STOP_LOSS : Number.POSITIVE_INFINITY;
      } else if (isSports) {
        tpThreshold = cfg.SPORTS_TAKE_PROFIT;
        slThreshold = cfg.SPORTS_STOP_LOSS;
      } else if (isCrypto) {
        tpThreshold = cfg.CRYPTO_TAKE_PROFIT;
        slThreshold = cfg.CRYPTO_STOP_LOSS;
      } else if (isShortDuration) {
        tpThreshold = cfg.SHORT_DURATION_TAKE_PROFIT;
        slThreshold = cfg.SHORT_DURATION_STOP_LOSS;
      }
    }

    // For sports positions, replace the entry-time consensus probability with the
    // live model probability that the scanner writes to Redis every poll tick.
    // This makes divergence-close fire the moment the model reverses past the
    // current market price — e.g. the scanner now says YES=0.08 but the market
    // still quotes 0.095 → divergence_closed triggers and we exit cleanly on an
    // active book rather than riding the position to resolution.
    // Redis errors fall back to stored consensus so a transient GET failure never
    // aborts the entire monitor cycle for the remaining positions.
    let evalPosition = position;
    let liveModelProb: number | null = null;
    if (inferSource(position.sourcedFrom ?? '') === 'sports') {
      try {
        const rawLiveProb = await redis.get(`sports:live_prob:${position.marketId}`);
        if (rawLiveProb !== null) {
          const parsed = parseFloat(rawLiveProb);
          if (isFinite(parsed) && parsed >= 0 && parsed <= 1) {
            liveModelProb = parsed;
            evalPosition = { ...position, consensusProbability: parsed };
          }
        }
      } catch (err) {
        logger.warn('[monitor] failed to read sports live prob from Redis — using stored consensus', {
          marketId: position.marketId,
          err: String(err),
        });
      }
    }

    const returnDecimal =
      evalPosition.entryPrice > 0
        ? (currentPrice.currentOutcomePrice - evalPosition.entryPrice) / evalPosition.entryPrice
        : 0;

    const decision = cfg.POLYMARKET_TP_SL_ENABLED
      ? evaluateTakeProfit(evalPosition, currentPrice, tpThreshold, slThreshold, {
          enabled: cfg.ZONE_AWARE_SL_ENABLED,
          extremeLow: cfg.ZONE_AWARE_SL_EXTREME_LOW,
          extremeHigh: cfg.ZONE_AWARE_SL_EXTREME_HIGH,
          minAbsoluteMove: cfg.ZONE_AWARE_SL_MIN_ABS_MOVE,
        })
      : { shouldExit: false, returnDecimal, returnPct: returnDecimal * 100 };

    // Trailing-stop suppression: when enabled, a fixed-TP exit is SUPPRESSED
    // so the trailing block below can take over. SL and divergence_closed still
    // fire. Trend-exit and stale-exit also still run on later ticks as
    // additional safeties (bleed detection, peak-PnL-plus-age) — trailing is
    // the primary post-TP exit mechanism, not the exclusive one.
    //
    // Design (2026-04-16): TP threshold is the ACTIVATION level for trailing,
    // not a fire level. Once price crosses TP, trailing takes over. Its floor
    // is clamped at `max(TP, HWM − giveback)` which keeps the trigger level
    // from drifting below TP after activation; realized exit prices can still
    // land below TP because checks happen on discrete 5s ticks and fills are
    // at the then-current bid (same granularity/slippage story as fixed-TP).
    // The upside is sustained runs capture much more before trailing fires.
    //
    // Prior dead-zone guard (removed) required `HWM >= TP + TRAILING_GIVEBACK_PCT`
    // before suppressing fixed-TP, to protect against the 2026-04-11 1877577:YES
    // burn (+12.42% peak → −41% in one tick). In practice the 5s monitor tick
    // fires fixed-TP the moment price crosses TP in slow-moving markets, so the
    // guard almost always PREVENTED suppression and capped every slow winner
    // at TP. Structural tax on every slow winner outweighed one-off gap-move
    // protection. If gap-down losses become a concern again, the right
    // mitigation is additive (a HARD_TAKE_PROFIT_THRESHOLD ceiling), not
    // re-enabling the dead zone.
    const trailingActive = cfg.TRAILING_STOP_ENABLED && cfg.POLYMARKET_TP_SL_ENABLED;

    const suppressTpExit =
      trailingActive &&
      decision.shouldExit &&
      decision.reason === 'take_profit_threshold';

    logger.info('[monitor] position evaluated', {
      marketId: position.marketId,
      direction: position.direction,
      entryPrice: position.entryPrice.toFixed(3),
      currentPrice: currentPrice.currentOutcomePrice.toFixed(3),
      returnPct: decision.returnPct.toFixed(2),
      shouldExit: decision.shouldExit,
      reason: decision.reason,
      ...(liveModelProb !== null ? { liveModelProb: liveModelProb.toFixed(6) } : {}),
      ...(suppressTpExit ? { suppressedByTrailing: true } : {}),
    });

    // ── Weather near-resolution loss-cut ─────────────────────────────────────
    // Fires when: weather position, within WEATHER_NEAR_RES_HOURS of endDate,
    // losing more than WEATHER_NEAR_RES_MIN_LOSS_PCT. By that point the actual
    // temperature is effectively known and a losing position will not recover.
    // Ships dark (WEATHER_NEAR_RES_ENABLED=false); shadow rows always written.
    if (isWeather) {
      const nearResDecision = evaluateWeatherNearRes(
        position.endDate,
        decision.returnPct,
        {
          nearResHours: cfg.WEATHER_NEAR_RES_HOURS,
          nearResMinLossPct: cfg.WEATHER_NEAR_RES_MIN_LOSS_PCT,
        },
      );

      if (nearResDecision.shouldFire) {
        if (cfg.WEATHER_NEAR_RES_ENABLED) {
          logger.info('[monitor] weather_near_resolution triggered', {
            marketId: position.marketId,
            direction: position.direction,
            hoursLeft: nearResDecision.hoursLeft.toFixed(2),
            returnPct: decision.returnPct.toFixed(2),
            endDate: position.endDate,
          });
          const nearResResult = await executeTakeProfit({
            position,
            currentPrice: currentPrice.currentOutcomePrice,
            returnPct: decision.returnPct,
            reason: 'weather_near_resolution',
            redis,
          });
          if (nearResResult.success) {
            exited++;
          } else {
            logger.warn('[monitor] weather near-res exit failed — will retry next cycle', {
              marketId: position.marketId,
              error: nearResResult.error,
            });
            held++;
          }
          continue;
        }

        // Shadow mode: log would-have-fired event
        logger.info('[monitor] weather_near_resolution shadow', {
          marketId: position.marketId,
          direction: position.direction,
          hoursLeft: nearResDecision.hoursLeft.toFixed(2),
          returnPct: decision.returnPct.toFixed(2),
          endDate: position.endDate,
          wouldExit: true,
        });
        void enqueueWrite('shadow_observations', {
          kind: 'weather_near_resolution',
          source: 'weather',
          marketId: position.marketId,
          direction: position.direction,
          wouldBlock: false,
          metricValue: nearResDecision.hoursLeft,
          threshold: cfg.WEATHER_NEAR_RES_HOURS,
          payload: {
            returnPct: decision.returnPct,
            hoursLeft: nearResDecision.hoursLeft,
            entryPrice: position.entryPrice,
            currentPrice: currentPrice.currentOutcomePrice,
            endDate: position.endDate,
          },
        });
      }
    }

    if (decision.shouldExit && decision.reason && !suppressTpExit) {
      const result = await executeTakeProfit({
        position: evalPosition,
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
        // Activation must match the effective TP the fixed-TP path would have
        // used (COPYTRADE_TAKE_PROFIT for copytrades, TAKE_PROFIT_THRESHOLD
        // otherwise) so trailing takes over at exactly the suppressed-TP line.
        activationPct: tpThreshold * 100,
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
    // Futures are skipped earlier in the loop (handled by futuresMonitor).
    // Copytrades have their own exit logic.
    const isCopytradePos = position.sourcedFrom?.startsWith('copytrade:') ?? false;
    const sampleTrackingNeeded =
      !isCopytradePos && (cfg.TREND_EXIT_ENABLED || cfg.STALE_EXIT_ENABLED);

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
        void enqueueWrite('shadow_observations', {
          kind: 'trend_exit',
          source: inferSource(position.sourcedFrom ?? ''),
          marketId: position.marketId,
          direction: position.direction,
          wouldBlock: !trendDecision.shouldExit,
          metricValue: trendDecision.slopePerH ?? undefined,
          threshold: trendDecision.thresholdSlopePerH,
          payload: {
            category: trendDecision.category,
            r2: trendDecision.r2,
            samples: trendDecision.sampleCount,
            currentPnlPct: trendDecision.currentPnlPct,
            ageH: trendDecision.ageH,
            blockedReason: trendDecision.blockedReason,
            wouldExit: trendDecision.shouldExit,
          },
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
