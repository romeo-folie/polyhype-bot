/**
 * High-Frequency Futures Monitor.
 *
 * Persistent worker that monitors open positions on Hyperliquid.
 * Triggers sub-second (or fast-poll) exits based on:
 * 1. Stop-Loss (%)
 * 2. Take-Profit (%)
 * 3. Max holding time (Hours)
 *
 * This fills the safety gap for unhedged spot momentum trades.
 */

import 'dotenv/config';
import { hostname } from 'node:os';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getRedis, closeRedis, refreshLock, reacquireLockAfterExpiry } from '../shared/redis.js';
import { getHyperliquid } from '../shared/hyperliquid.js';
import { notifyTradeError, notifyTakeProfitExecuted } from '../execution/telegram.js';
import {
  closePosition as closeLedgerPosition,
  getOpenPositions,
  hasOpenPosition,
  recordPosition,
  updateHighWaterMark,
  type Position,
} from '../execution/positionLedger.js';
import { scoreConfluence } from '../arb/confluenceScorer.js';
import { recordPositionOutcome } from '../shared/positionOutcomeRecorder.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { isMemeSymbol } from '../futures/hlMomentumScanner.js';

const POLL_INTERVAL_MS = 5000; // 5 seconds — safe for rate limits, fast enough for intraday
const MONITOR_LOCK_KEY = 'futures-monitor:lock';
// TTL must be comfortably larger than the WORST-CASE single cycle (HL API stalls,
// LLM calls in recordPositionOutcome, network blips). 120s gives ~24 poll intervals of
// margin before our own TTL would lapse — far beyond any realistic single-cycle
// hang — so 'expired' should be vanishingly rare. See Bug A in
// memory/recurring-worker-deaths.md for the history behind this choice.
const MONITOR_LOCK_TTL_SEC = 120;

// Module-level reference to releaseLock so the shutdown handler can call it
let _releaseLock: (() => Promise<void>) | null = null;

// Per-symbol last re-eval timestamp (process-local, not Redis — scoped to this worker)
const lastRevalCheck = new Map<string, number>();
// Separate cadence tracker for the max-hold-on-loser guard's one-shot log.
// Kept independent of `lastRevalCheck` so the loser-guard firing every tick
// doesn't starve the TA-fade re-eval below (which uses `lastRevalCheck` to
// throttle scoreConfluence calls).
const lastMaxHoldLoserLog = new Map<string, number>();

export async function runFuturesMonitorWorker(): Promise<void> {
  const cfg = loadConfig();
  const redis = getRedis();
  const hl = getHyperliquid();

  if (!cfg.FUTURES_ENABLED) {
    logger.info('[futures-monitor] disabled, exiting');
    return;
  }

  // Distributed lock — prevents duplicate instances from issuing conflicting close orders.
  // Hostname-based stale detection: in Docker, each container gets a unique hostname,
  // so a mismatch means the old container is gone and the lock is safe to force-delete.
  const myHostname = hostname();
  const existingLock = await redis.get(MONITOR_LOCK_KEY);
  if (existingLock) {
    const ownerHostname = existingLock.split(':')[0];
    if (ownerHostname !== myHostname) {
      logger.warn(
        '[futures-monitor] stale lock detected — owner hostname differs, force-releasing',
        { ownerHostname, myHostname },
      );
      await redis.del(MONITOR_LOCK_KEY);
    }
  }

  const lockToken = `${myHostname}:${Date.now().toString()}-${Math.random().toString(36).slice(2)}`;
  const acquired = await redis.set(MONITOR_LOCK_KEY, lockToken, 'EX', MONITOR_LOCK_TTL_SEC, 'NX');
  if (!acquired) {
    logger.warn('[futures-monitor] another instance is already running — exiting');
    process.exit(1);
  }

  logger.info('[futures-monitor] starting persistent monitor', {
    pollInterval: `${POLL_INTERVAL_MS.toString()}ms`,
    stopLoss: `${cfg.FUTURES_STOP_LOSS_PCT.toString()}%`,
    takeProfit: `${cfg.FUTURES_TAKE_PROFIT_PCT.toString()}%`,
    revalMinAgeSec: cfg.FUTURES_REEVAL_MIN_AGE_S,
    exitConfluenceScore: cfg.FUTURES_EXIT_CONFLUENCE_SCORE,
    atrSltpEnabled: cfg.FUTURES_ATR_SLTP_ENABLED,
  });

  const releaseLock = async () => {
    await redis
      .eval(
        `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`,
        1,
        MONITOR_LOCK_KEY,
        lockToken,
      )
      .catch((e: unknown) => {
        logger.warn('[futures-monitor] lock release failed', { error: String(e) });
      });
  };
  _releaseLock = releaseLock;
  let lastHeartbeat = 0;
  const HEARTBEAT_INTERVAL_MS = 120000; // 2 minutes

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Refresh lock TTL each cycle. Tri-state semantics: 'expired' means our
    // OWN TTL lapsed with no contender present (recoverable — just re-acquire);
    // 'stolen' means a different token is in the key (true duplicate instance —
    // fatal). Old code conflated these and killed the worker on every slow cycle.
    let refreshState: 'refreshed' | 'expired' | 'stolen';
    try {
      refreshState = await refreshLock(MONITOR_LOCK_KEY, lockToken, MONITOR_LOCK_TTL_SEC);
    } catch (e) {
      // Redis blip — treat as indeterminate, warn and continue. The next tick
      // will retry. If the blip persists and the lock actually expires, the
      // recovery path below will catch it.
      logger.warn('[futures-monitor] lock refresh failed', { error: String(e) });
      refreshState = 'refreshed';
    }

    if (refreshState === 'stolen') {
      logger.error('[futures-monitor] lock stolen by another instance — shutting down');
      break;
    }
    if (refreshState === 'expired') {
      logger.warn('[futures-monitor] own lock TTL expired — attempting re-acquire', {
        ttlSec: MONITOR_LOCK_TTL_SEC,
      });
      const reacquired = await reacquireLockAfterExpiry(
        MONITOR_LOCK_KEY,
        lockToken,
        MONITOR_LOCK_TTL_SEC,
      ).catch((e: unknown) => {
        logger.warn('[futures-monitor] re-acquire failed', { error: String(e) });
        return false;
      });
      if (!reacquired) {
        logger.error(
          '[futures-monitor] lock expired AND re-acquire found another holder — shutting down',
        );
        break;
      }
      logger.info('[futures-monitor] lock re-acquired after expiry');
    }

    try {
      const positions = await hl.getOpenPositions();

      // Heartbeat Status Report (every 2 minutes)
      const now = Date.now();
      if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
        const totalPnl = positions.reduce(
          (sum, p) => sum + parseFloat(p.position.unrealizedPnl),
          0,
        );
        logger.info('[futures-monitor] heartbeat — worker active', {
          lockStatus: 'acquired',
          activePositions: positions.length,
          totalUnrealizedPnl: totalPnl.toFixed(2),
          pollIntervalMs: POLL_INTERVAL_MS,
        });
        lastHeartbeat = now;
      }

      // Sync HL positions with ledger to get true 'openedAt' timestamps
      let ledgerPositions = await getOpenPositions(redis);
      let futuresLedger = ledgerPositions.filter((p) => p.isFutures);

      if (positions.length === 0) {
        // No HL positions — close any stale ledger entries left over from previous sessions
        for (const lp of futuresLedger) {
          logger.warn('[futures-monitor] pruning orphaned ledger entry — HL has no open positions', {
            marketId: lp.marketId,
            symbol: lp.symbol ?? lp.marketId,
            direction: lp.direction,
          });
          await closeLedgerPosition(redis, lp.marketId, lp.direction);
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

      // BACKFILL: if HL holds a position the ledger doesn't know about, write
      // a ledger row so the trailing-stop HWM can ratchet, stale-exit timers
      // work, and recordPositionOutcome can produce analytics on close. Without this,
      // a ledger row lost during a worker restart/crash stays lost forever,
      // silently disabling trailing stops on real money. See Bug B in
      // memory/recurring-worker-deaths.md.
      let backfilled = false;
      for (const pos of positions) {
        const size = Math.abs(parseFloat(pos.position.szi));
        const entryPx = parseFloat(pos.position.entryPx);
        if (size === 0 || !Number.isFinite(entryPx) || entryPx === 0) continue;
        const direction: 'LONG' | 'SHORT' = parseFloat(pos.position.szi) > 0 ? 'LONG' : 'SHORT';
        const alreadyTracked = await hasOpenPosition(redis, pos.symbol, direction);
        if (alreadyTracked) continue;
        const backfillPos: Position = {
          marketId: pos.symbol,
          direction,
          entryPrice: entryPx,
          stakeUsd: size * entryPx,
          edgeMagnitude: 0,
          sourcedFrom: 'backfill:futures-monitor',
          openedAt: new Date().toISOString(),
          question: `${pos.symbol} perpetual (backfilled)`,
          executionVenue: 'hyperliquid',
          isFutures: true,
          symbol: pos.symbol,
          sharesHeld: size,
        };
        await recordPosition(redis, backfillPos);
        logger.warn('[futures-monitor] backfilled missing ledger row', {
          symbol: pos.symbol,
          direction,
          entryPrice: entryPx,
          size,
        });
        backfilled = true;
      }
      if (backfilled) {
        ledgerPositions = await getOpenPositions(redis);
        futuresLedger = ledgerPositions.filter((p) => p.isFutures);
      }

      // PRUNE: close ledger entries whose HL position no longer exists.
      // Handles external closes, liquidations, and manual exits during downtime.
      // The backfill loop above already skips szi==0; use the same threshold here.
      const hlOpenSet = new Set(
        positions
          .filter((p) => Math.abs(parseFloat(p.position.szi)) > 0)
          .map((p) => {
            const d: 'LONG' | 'SHORT' = parseFloat(p.position.szi) > 0 ? 'LONG' : 'SHORT';
            return `${p.symbol}:${d}`;
          }),
      );
      for (const lp of futuresLedger) {
        const d = lp.direction === 'LONG' ? 'LONG' : 'SHORT';
        if (!hlOpenSet.has(`${lp.marketId}:${d}`)) {
          logger.warn('[futures-monitor] pruning orphaned ledger entry — no matching HL position', {
            marketId: lp.marketId,
            symbol: lp.symbol ?? lp.marketId,
            direction: lp.direction,
          });
          await closeLedgerPosition(redis, lp.marketId, lp.direction);
        }
      }
      // Refresh futuresLedger so the exit loop below only sees live positions
      futuresLedger = (await getOpenPositions(redis)).filter((p) => p.isFutures);

      for (const pos of positions) {
        const symbol = pos.symbol;
        const entryPx = parseFloat(pos.position.entryPx);
        const pnlUsd = parseFloat(pos.position.unrealizedPnl);
        const sziRaw = parseFloat(pos.position.szi);
        const size = Math.abs(sziRaw);
        // Skip dust positions (szi == 0) and invalid entry prices to avoid
        // division-by-zero in priceChangePct and spurious stop-loss exits.
        if (size === 0 || !Number.isFinite(entryPx) || entryPx === 0) continue;
        const positionValue = size * entryPx;
        const direction = sziRaw > 0 ? 'LONG' : 'SHORT';

        // Price change % — independent of leverage (used for SL/TP gate comparisons)
        const priceChangePct = (pnlUsd / positionValue) * 100;
        // ROE % — matches what Hyperliquid UI displays (pnlUsd / margin, leverage-scaled)
        const marginUsed = parseFloat(pos.position.marginUsed ?? '0');
        const roePct = marginUsed > 0 ? (pnlUsd / marginUsed) * 100 : priceChangePct;

        logger.debug('[futures-monitor] checking position', {
          symbol,
          priceChangePct: priceChangePct.toFixed(2),
          roePct: roePct.toFixed(2),
        });

        let shouldExit = false;
        let reason = '';

        // Resolve effective SL/TP/trailing thresholds. ATR mode (when enabled
        // AND the position has an entryAtrPct snapshot) derives them from the
        // ATR captured at entry, clamped to min/max bounds. Legacy positions
        // and positions with missing ATR fall back to fixed-percent thresholds.
        const ledgerPosForAtr = futuresLedger.find((p) => p.marketId === symbol);
        let slPct = cfg.FUTURES_STOP_LOSS_PCT; // negative
        let tpPct = cfg.FUTURES_TAKE_PROFIT_PCT; // positive
        let trailStopPct = cfg.FUTURES_TRAILING_STOP_PCT;

        // Per-source override: hl-momentum uses wider 15m-appropriate SL/TP.
        if (ledgerPosForAtr?.sourcedFrom === 'hl-momentum') {
          slPct = -cfg.HL_MOMENTUM_STOP_LOSS_PCT;
          tpPct = cfg.HL_MOMENTUM_TAKE_PROFIT_PCT;
        }

        // Issue #264: meme ATR-scaled SL/TP. Frozen entry-time values; the monitor
        // only consumes them — never re-derives from current ATR. Sits between the
        // per-source override and the global ATR overlay so the global overlay
        // (currently dark) still wins if both are enabled (legacy precedence).
        let usingMemeAtr = false;
        if (
          cfg.HL_MOMENTUM_MEME_ATR_SLTP_ENABLED &&
          ledgerPosForAtr?.sourcedFrom === 'hl-momentum' &&
          isMemeSymbol(symbol, cfg.HL_MOMENTUM_MEME_SYMBOLS) &&
          ledgerPosForAtr?.memeAtrSlPct !== undefined &&
          Number.isFinite(ledgerPosForAtr.memeAtrSlPct) &&
          ledgerPosForAtr.memeAtrSlPct > 0 &&
          ledgerPosForAtr?.memeAtrTpPct !== undefined &&
          Number.isFinite(ledgerPosForAtr.memeAtrTpPct) &&
          ledgerPosForAtr.memeAtrTpPct > 0
        ) {
          slPct = -ledgerPosForAtr.memeAtrSlPct;
          tpPct = ledgerPosForAtr.memeAtrTpPct;
          usingMemeAtr = true;
        }

        // Global ATR overlay is calibrated for 1m crypto-arb scalps (SL floor 1%,
        // TP floor 2%). Applying it to hl-momentum 15m swing positions produces
        // absurdly tight stops that SL every entry on intraday noise (burned on
        // WIF 2026-04-22: three consecutive SL-outs at -1%). hl-momentum
        // positions instead use the per-source override (HL_MOMENTUM_STOP_LOSS_PCT
        // fixed) plus the meme-ATR path when enabled for meme symbols.
        let usingAtrMode = false;
        if (
          cfg.FUTURES_ATR_SLTP_ENABLED &&
          ledgerPosForAtr?.sourcedFrom !== 'hl-momentum' &&
          ledgerPosForAtr?.entryAtrPct !== undefined &&
          Number.isFinite(ledgerPosForAtr.entryAtrPct) &&
          ledgerPosForAtr.entryAtrPct > 0
        ) {
          const atrPct = ledgerPosForAtr.entryAtrPct;
          const slMag = Math.min(
            Math.max(atrPct * cfg.FUTURES_ATR_SL_MULT, cfg.FUTURES_ATR_SL_MIN_PCT),
            cfg.FUTURES_ATR_SL_MAX_PCT,
          );
          const tpMag = Math.min(
            Math.max(atrPct * cfg.FUTURES_ATR_TP_MULT, cfg.FUTURES_ATR_TP_MIN_PCT),
            cfg.FUTURES_ATR_TP_MAX_PCT,
          );
          slPct = -slMag;
          tpPct = tpMag;
          trailStopPct = atrPct * cfg.FUTURES_ATR_TRAIL_STOP_MULT;
          usingAtrMode = true;
        }

        // Shadow comparison: when ATR mode is OFF but we have an entryAtrPct snapshot,
        // compute what the ATR-derived thresholds WOULD be and log when their verdict
        // diverges from the active fixed-pct verdict. Lets us validate ATR sizing
        // without enabling exits.
        if (
          !cfg.FUTURES_ATR_SLTP_ENABLED &&
          ledgerPosForAtr?.entryAtrPct !== undefined &&
          Number.isFinite(ledgerPosForAtr.entryAtrPct) &&
          ledgerPosForAtr.entryAtrPct > 0
        ) {
          const atrPct = ledgerPosForAtr.entryAtrPct;
          const shadowSlMag = Math.min(
            Math.max(atrPct * cfg.FUTURES_ATR_SL_MULT, cfg.FUTURES_ATR_SL_MIN_PCT),
            cfg.FUTURES_ATR_SL_MAX_PCT,
          );
          const shadowTpMag = Math.min(
            Math.max(atrPct * cfg.FUTURES_ATR_TP_MULT, cfg.FUTURES_ATR_TP_MIN_PCT),
            cfg.FUTURES_ATR_TP_MAX_PCT,
          );
          const shadowSlPct = -shadowSlMag;
          const shadowTpPct = shadowTpMag;
          const fixedSlHit = priceChangePct <= cfg.FUTURES_STOP_LOSS_PCT;
          const fixedTpHit = priceChangePct >= cfg.FUTURES_TAKE_PROFIT_PCT;
          const atrSlHit = priceChangePct <= shadowSlPct;
          const atrTpHit = priceChangePct >= shadowTpPct;
          if (fixedSlHit !== atrSlHit || fixedTpHit !== atrTpHit) {
            logger.info('[futures-monitor] atr shadow divergence', {
              symbol,
              direction,
              priceChangePct: priceChangePct.toFixed(2),
              entryAtrPct: atrPct.toFixed(3),
              fixedSlPct: cfg.FUTURES_STOP_LOSS_PCT,
              fixedTpPct: cfg.FUTURES_TAKE_PROFIT_PCT,
              atrSlPct: shadowSlPct.toFixed(2),
              atrTpPct: shadowTpPct.toFixed(2),
              fixedVerdict: fixedSlHit ? 'SL' : fixedTpHit ? 'TP' : 'hold',
              atrVerdict: atrSlHit ? 'SL' : atrTpHit ? 'TP' : 'hold',
            });
            void enqueueWrite('shadow_observations', {
              kind: 'atr_shadow', source: 'futures', symbol,
              direction,
              wouldBlock: false,
              metricValue: atrPct,
              payload: {
                priceChangePct, fixedSlPct: cfg.FUTURES_STOP_LOSS_PCT,
                fixedTpPct: cfg.FUTURES_TAKE_PROFIT_PCT,
                atrSlPct: shadowSlPct, atrTpPct: shadowTpPct,
                fixedVerdict: fixedSlHit ? 'SL' : fixedTpHit ? 'TP' : 'hold',
                atrVerdict: atrSlHit ? 'SL' : atrTpHit ? 'TP' : 'hold',
              },
            });
          }
        }

        // Issue #264: meme ATR-scaled SL/TP shadow divergence. Fires when the
        // feature is OFF but the position has a frozen meme SL/TP snapshot,
        // so we can validate sizing before flipping the live flag. Logs only on
        // verdict mismatch (SL/TP/hold) between fixed-pct and meme-ATR thresholds.
        if (
          !cfg.HL_MOMENTUM_MEME_ATR_SLTP_ENABLED &&
          ledgerPosForAtr?.sourcedFrom === 'hl-momentum' &&
          isMemeSymbol(symbol, cfg.HL_MOMENTUM_MEME_SYMBOLS) &&
          ledgerPosForAtr?.memeAtrSlPct !== undefined &&
          Number.isFinite(ledgerPosForAtr.memeAtrSlPct) &&
          ledgerPosForAtr.memeAtrSlPct > 0 &&
          ledgerPosForAtr?.memeAtrTpPct !== undefined &&
          Number.isFinite(ledgerPosForAtr.memeAtrTpPct) &&
          ledgerPosForAtr.memeAtrTpPct > 0
        ) {
          const memeSlPct = -ledgerPosForAtr.memeAtrSlPct;
          const memeTpPct = ledgerPosForAtr.memeAtrTpPct;
          // Fixed baseline is the hl-momentum per-source override, NOT the active
          // slPct/tpPct — those may already have been mutated by the global ATR
          // overlay (FUTURES_ATR_SLTP_ENABLED). Use cfg values directly so the
          // shadow stays interpretable as "meme-ATR vs fixed HL pcts".
          const fixedBaselineSlPct = -cfg.HL_MOMENTUM_STOP_LOSS_PCT;
          const fixedBaselineTpPct = cfg.HL_MOMENTUM_TAKE_PROFIT_PCT;
          const fixedSlHit = priceChangePct <= fixedBaselineSlPct;
          const fixedTpHit = priceChangePct >= fixedBaselineTpPct;
          const memeSlHit = priceChangePct <= memeSlPct;
          const memeTpHit = priceChangePct >= memeTpPct;
          if (fixedSlHit !== memeSlHit || fixedTpHit !== memeTpHit) {
            const fixedVerdict = fixedSlHit ? 'SL' : fixedTpHit ? 'TP' : 'hold';
            const memeVerdict = memeSlHit ? 'SL' : memeTpHit ? 'TP' : 'hold';
            logger.info('[hl-momentum] meme atr sltp shadow', {
              symbol,
              direction,
              priceChangePct: priceChangePct.toFixed(2),
              memeAtrSlPct: ledgerPosForAtr.memeAtrSlPct.toFixed(2),
              memeAtrTpPct: ledgerPosForAtr.memeAtrTpPct.toFixed(2),
              fixedSlPct: fixedBaselineSlPct,
              fixedTpPct: fixedBaselineTpPct,
              fixedVerdict,
              memeVerdict,
            });
            void enqueueWrite('shadow_observations', {
              kind: 'meme_atr_sltp_shadow',
              source: 'futures',
              symbol,
              direction,
              wouldBlock: false,
              metricValue: ledgerPosForAtr.memeAtrSlPct,
              payload: {
                priceChangePct,
                memeAtrSlPct: ledgerPosForAtr.memeAtrSlPct,
                memeAtrTpPct: ledgerPosForAtr.memeAtrTpPct,
                fixedSlPct: fixedBaselineSlPct,
                fixedTpPct: fixedBaselineTpPct,
                fixedVerdict,
                memeVerdict,
              },
            });
          }
        }

        if (priceChangePct <= slPct) {
          shouldExit = true;
          const slTag = usingAtrMode
            ? ` atr_sl=${slPct.toFixed(2)}`
            : usingMemeAtr
              ? ` meme_atr_sl=${slPct.toFixed(2)}`
              : '';
          reason = `Stop-Loss triggered (${priceChangePct.toFixed(2).toString()}%${slTag})`;
        } else if (!cfg.FUTURES_TRAILING_STOP_ENABLED && priceChangePct >= tpPct) {
          // Fixed TP only when trailing is disabled. When trailing is on, it
          // supersedes fixed TP so winners can run beyond the TP line; the
          // floor is clamped to TP below so the worst case at the TP line is
          // identical to fixed-TP behavior.
          shouldExit = true;
          const tpTag = usingAtrMode
            ? ` atr_tp=${tpPct.toFixed(2)}`
            : usingMemeAtr
              ? ` meme_atr_tp=${tpPct.toFixed(2)}`
              : '';
          reason = `Take-Profit triggered (${priceChangePct.toFixed(2).toString()}%${tpTag})`;
        }

        // 2b. Trailing stop — supersedes fixed TP when enabled. Arms once the
        // peak crosses the TP line, then ratchets a floor up with the HWM so
        // winners keep running until they give back `trailStopPct` from peak.
        // Floor is clamped to TP so immediate reversal at TP exits at TP.
        // `hwm` and `trailingArmed` are lifted out of the trailing block so
        // the max-hold bypass below can consult them.
        let hwm: number | undefined;
        let trailingArmed = false;
        if (cfg.FUTURES_TRAILING_STOP_ENABLED) {
          const ledgerPos = futuresLedger.find((p) => p.marketId === symbol);
          const priorHwm = ledgerPos?.highWaterMarkPct;
          hwm = typeof priorHwm === 'number' && Number.isFinite(priorHwm) ? priorHwm : priceChangePct;
          if (priceChangePct > hwm) {
            hwm = priceChangePct;
            updateHighWaterMark(redis, symbol, direction, hwm).catch(() => {});
          }
          trailingArmed = hwm >= tpPct;
          if (!shouldExit && trailingArmed) {
            const floorPct = Math.max(tpPct, hwm - trailStopPct);
            if (priceChangePct <= floorPct) {
              shouldExit = true;
              reason = `Trailing stop (peak +${hwm.toFixed(2)}%, floor +${floorPct.toFixed(2)}%, now +${priceChangePct.toFixed(2)}%${usingAtrMode ? ` atr_trail=${trailStopPct.toFixed(2)}` : ''})`;
            } else {
              logger.debug('[futures-monitor] trailing active', {
                symbol, hwm: hwm.toFixed(2), floor: floorPct.toFixed(2), current: priceChangePct.toFixed(2),
              });
            }
          }
        }

        if (!shouldExit) {
          // 3. Time-based max-hold exit using ledger 'openedAt'
          const ledgerPos = futuresLedger.find((p) => p.marketId === symbol);
          const openedAt = ledgerPos ? new Date(ledgerPos.openedAt).getTime() : Date.now();

          const ageHours = (Date.now() - openedAt) / (1000 * 3600);
          if (ageHours >= cfg.FUTURES_MAX_HOLD_HOURS) {
            let bypassed = false;
            // Loser guard: max-hold never kicks a position that's underwater.
            // Observed failure mode: ETH LONG at -2.16% cut at 24h; had it held
            // to TP/trailing it might have recovered. Losers stay open until
            // SL (ATR), TP, trailing, or TA-fade fires — max-hold only enforces
            // the time cap on breakeven / profitable positions. A subsequent
            // tick will re-check and fire max-hold if the position climbs ≥0%.
            if (cfg.FUTURES_MAX_HOLD_BLOCK_ON_LOSER && priceChangePct < 0) {
              bypassed = true;
              // One-shot log per REEVAL_INTERVAL_S so we don't spam every 5s
              // poll. Uses a dedicated map (lastMaxHoldLoserLog) rather than
              // the shared lastRevalCheck so we don't starve the TA-fade
              // re-eval below — that block reads lastRevalCheck to throttle
              // scoreConfluence calls.
              const lastLog = lastMaxHoldLoserLog.get(symbol) ?? 0;
              const secSinceLog = (Date.now() - lastLog) / 1000;
              if (secSinceLog >= cfg.FUTURES_REEVAL_INTERVAL_S) {
                lastMaxHoldLoserLog.set(symbol, Date.now());
                logger.info('[futures-monitor] max_hold suppressed on loser', {
                  symbol,
                  direction,
                  ageHours: ageHours.toFixed(1),
                  priceChangePct: priceChangePct.toFixed(2),
                });
              }
            }
            // Bypass gate: winning runners with still-aligned TA escape the
            // time cap. Zombies (trailing not armed) always exit here.
            // Shares `lastRevalCheck` cadence with the TA-fade block below
            // so we don't double-call scoreConfluence on the same tick.
            if (!bypassed && cfg.FUTURES_MAX_HOLD_BYPASS_ON_WINNER && trailingArmed) {
              const lastCheck = lastRevalCheck.get(symbol) ?? 0;
              const secSinceCheck = (Date.now() - lastCheck) / 1000;
              let taAgrees = true;
              let taChecked = false;
              if (secSinceCheck >= cfg.FUTURES_REEVAL_INTERVAL_S) {
                try {
                  const confluence = await scoreConfluence(symbol, redis);
                  // Only advance the cadence on success so that failures don't
                  // silently suppress retries for the full REEVAL_INTERVAL_S.
                  // The next 5s tick can retry after an infra blip.
                  lastRevalCheck.set(symbol, Date.now());
                  taChecked = true;
                  const oppositeDir = direction === 'LONG' ? 'DOWN' : 'UP';
                  if (
                    confluence.direction === oppositeDir &&
                    confluence.score >= cfg.FUTURES_EXIT_CONFLUENCE_SCORE
                  ) {
                    taAgrees = false;
                  }
                } catch (err) {
                  // Fail open on infra errors (redis/candle fetch blip). Forcing
                  // a winner to exit because the TA pipeline hiccuped would defeat
                  // the whole point of the bypass. Cadence was not advanced, so
                  // the next poll tick will retry immediately.
                  logger.warn('[futures-monitor] max_hold bypass TA check failed; skipping TA gate', {
                    symbol, error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
              if (taAgrees) {
                bypassed = true;
                // Only log when TA was actually re-checked this tick — otherwise
                // this would fire every 5s poll for hours once past the time cap.
                if (taChecked) {
                  logger.info('[futures-monitor] max_hold bypassed on winner', {
                    symbol,
                    direction,
                    ageHours: ageHours.toFixed(1),
                    priceChangePct: priceChangePct.toFixed(2),
                    hwm: hwm?.toFixed(2),
                    tpPct,
                  });
                }
              }
            }
            if (!bypassed) {
              shouldExit = true;
              reason = `Max hold hours reached (${ageHours.toFixed(1).toString()}h >= ${cfg.FUTURES_MAX_HOLD_HOURS.toString()}h)`;
            }
          }

          // 4. TA re-evaluation — exit if confluence flips against held direction.
          // Only applies when position is flat or negative; profitable positions
          // skip this TA-fade check so a short-term blip doesn't cut a live winner.
          if (!shouldExit && cfg.FUTURES_EXIT_ON_SIGNAL_FADE && priceChangePct <= 0) {
            const ageSec = (Date.now() - openedAt) / 1000;
            const lastCheck = lastRevalCheck.get(symbol) ?? 0;
            const secSinceCheck = (Date.now() - lastCheck) / 1000;

            if (ageSec >= cfg.FUTURES_REEVAL_MIN_AGE_S && secSinceCheck >= cfg.FUTURES_REEVAL_INTERVAL_S) {
              lastRevalCheck.set(symbol, Date.now());

              try {
                const confluence = await scoreConfluence(symbol, redis);
                const oppositeDir = direction === 'LONG' ? 'DOWN' : 'UP';

                if (confluence.direction === oppositeDir && confluence.score >= cfg.FUTURES_EXIT_CONFLUENCE_SCORE) {
                  shouldExit = true;
                  const signalDetails = Object.entries(confluence.signals)
                    .filter(([, v]) => v !== 'neutral')
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(', ');
                  reason = `TA reversal (${signalDetails}, score=${confluence.score.toString()})`;
                }
              } catch (err) {
                logger.warn('[futures-monitor] confluence re-eval failed', {
                  symbol, error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
        }

        if (shouldExit) {
          logger.info('[futures-monitor] executing exit', { symbol, reason });

          const result = await hl.closePosition(symbol);
          if (result.success) {
            logger.info('[futures-monitor] exit successful', { symbol, txHash: result.txHash });

            // Record futures outcome for analytics
            const ledgerPos = futuresLedger.find((p) => p.marketId === symbol);
            const exitPrice = entryPx + pnlUsd / sziRaw;
            const tpReason = reason.startsWith('Stop-Loss')
              ? 'futures_sl'
              : reason.startsWith('Take-Profit')
                ? 'futures_tp'
                : reason.startsWith('Trailing')
                  ? 'futures_tp'
                  : reason.startsWith('TA reversal')
                    ? 'signal_reeval'
                    : reason.startsWith('Max hold')
                      ? 'futures_max_hold'
                      : 'stop_loss';
            await notifyTakeProfitExecuted({
              position: ledgerPos ?? {
                marketId: symbol,
                question: `Futures ${symbol}`,
                direction,
                entryPrice: entryPx,
                stakeUsd: positionValue,
                edgeMagnitude: 0,
                sourcedFrom: 'futures-monitor',
                openedAt: new Date().toISOString(),
                executionVenue: 'hyperliquid',
                isFutures: true,
              },
              currentPrice: exitPrice,
              returnPct: priceChangePct,
              reason: tpReason,
              mechanismDetail: `${reason} | ROE: ${roePct.toFixed(2)}%`,
            }).catch((e: unknown) => {
              logger.warn('[futures-monitor] notification failed', { symbol, error: String(e) });
            });

            if (ledgerPos) {
              // Persist the closed-position outcome before we prune the ledger row.
              // This closes the gap where successful HL exits could disappear from
              // Postgres analytics if the worker died after scheduling the async
              // recorder but before the promise settled.
              const outcomeResult = pnlUsd > 0 ? 'won' : pnlUsd < 0 ? 'lost' : 'pushed';
              try {
                await recordPositionOutcome(redis, ledgerPos, {
                  result: outcomeResult,
                  returnPct: priceChangePct,
                  executionVenueOverride: 'hyperliquid',
                  exitReason: reason,
                });
              } catch (e: unknown) {
                logger.warn('[futures-monitor] recordPositionOutcome failed (non-fatal)', {
                  symbol, error: String(e),
                });
              }
            }

            await closeLedgerPosition(redis, symbol, direction);

            // Set a per-symbol cooldown on losses so the entry path can't immediately
            // re-enter the same symbol and create a cascade of small losing trades.
            if (pnlUsd < 0) {
              const cooldownKey = `futures:loss-cooldown:${symbol}`;
              await redis.setex(cooldownKey, 1800, '1');
              logger.info('[futures-monitor] loss cooldown set', { symbol, ttlSec: 1800 });
            }
          } else {
            logger.error('[futures-monitor] exit failed', { symbol, error: result.error });
            await notifyTradeError(
              {
                marketId: symbol,
                question: `Futures Auto-Exit: ${symbol}`,
                direction,
                stakeUsd: positionValue,
              },
              result.error ?? 'Unknown exit error',
            );
          }
        }
      }
    } catch (err) {
      logger.error('[futures-monitor] error in monitor loop', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// CLI entrypoint
const isMain =
  (process.argv[1]?.endsWith('futuresMonitor.ts') ?? false) ||
  (process.argv[1]?.endsWith('futuresMonitor.js') ?? false);
if (isMain) {
  const shutdown = async () => {
    logger.info('[futures-monitor] shutting down...');
    if (_releaseLock) await _releaseLock();
    await closeRedis();
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });

  runFuturesMonitorWorker().catch((err: unknown) => {
    logger.error('[futures-monitor] fatal worker error', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
