/**
 * Persistent Position Monitor Worker.
 *
 * Continuous replacement for the `runMonitor()` cron entrypoint. Wraps
 * `runMonitorInner()` in a tight loop so that:
 *
 *   1. The ClobPriceFeed WS cache stays warm between cycles (cron was
 *      tearing it down via `destroyPriceFeed()` in its finally block, so
 *      every tick fell through to Gamma REST and missed WS price_change
 *      events).
 *   2. Cadence is decoupled from crontab — default tick is
 *      `MONITOR_LOOP_INTERVAL_MS` (5s) instead of 1min, which tightens
 *      reaction time on fast reversals without bumping Gamma load beyond
 *      the 30 req/s `/markets` ceiling (current load ≈0.23 req/s).
 *
 * Uses the SAME `monitor:lock` key as the cron entrypoint. During the
 * cutover window the cron keeps running as a safety net — it will simply
 * fail to acquire the lock (worker holds it continuously) and skip, which
 * is the same no-op path it takes today when a prior cycle is still
 * running. Once the worker is observed healthy, remove the cron line.
 *
 * Hostname-based stale detection mirrors futuresMonitor.ts: in Docker each
 * container gets a unique hostname, so a mismatch means the previous
 * container is gone and the lock is safe to force-release. The token format
 * `${hostname}:${ts}-${rand}` is deliberately distinct from
 * `acquireLock()`'s opaque random token so that the cron's lock (if held
 * at startup) does NOT match hostname parsing and is left alone — the
 * worker exits non-zero, Docker restarts, and tries again after cron
 * releases.
 */

import 'dotenv/config';
import { hostname } from 'node:os';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import {
  getRedis,
  closeRedis,
  refreshLock,
  reacquireLockAfterExpiry,
} from '../shared/redis.js';
import { destroyPriceFeed } from '../shared/feedSingleton.js';
import { runClobProbe } from '../shared/clobProbe.js';
import { setAgentAutoRedeem } from '../shared/simmer.js';
import { runMonitorInner } from './index.js';
import { rebuildNearZeroThemeSets } from '../shared/themeExtractor.js';
import { runCopytradeHedgeScan } from '../copytrade/hedgeScanner.js';

const MONITOR_LOCK_KEY = 'monitor:lock';
// TTL must be comfortably larger than the worst-case cycle (Simmer latency,
// LLM calls in recordOutcome during exits, Gamma blips). 270s matches the TTL
// the cron entrypoint uses and gives far more than one tick of margin.
// See memory/recurring-worker-deaths.md — Bug A history on this choice.
const MONITOR_LOCK_TTL_SEC = 270;
const HEARTBEAT_INTERVAL_MS = 120_000;

// Module-level releaseLock reference so the shutdown handler can call it.
let _releaseLock: (() => Promise<void>) | null = null;

export async function runMonitorWorker(): Promise<void> {
  const cfg = loadConfig();
  const redis = getRedis();

  const myHostname = hostname();
  const existingLock = await redis.get(MONITOR_LOCK_KEY);
  if (existingLock) {
    // Our worker token format is `${hostname}:${ts}-${rand}`. If the stored
    // value starts with a different hostname prefix AND has our shape, it's
    // a dead worker container — force-release. If it doesn't match the shape
    // at all (e.g. cron's opaque token), leave it alone — exit non-zero and
    // let Docker retry after cron releases.
    const looksLikeWorkerToken = /^[^:]+:[0-9]+-[a-z0-9]+$/.test(existingLock);
    if (looksLikeWorkerToken) {
      const ownerHostname = existingLock.split(':')[0];
      if (ownerHostname !== myHostname) {
        logger.warn(
          '[monitor-worker] stale worker lock detected — owner hostname differs, force-releasing',
          { ownerHostname, myHostname },
        );
        await redis.del(MONITOR_LOCK_KEY);
      }
    } else {
      logger.warn(
        '[monitor-worker] monitor:lock held by non-worker token (cron active?) — exiting for retry',
      );
      process.exit(1);
    }
  }

  const lockToken = `${myHostname}:${Date.now().toString()}-${Math.random().toString(36).slice(2)}`;
  const acquired = await redis.set(
    MONITOR_LOCK_KEY,
    lockToken,
    'EX',
    MONITOR_LOCK_TTL_SEC,
    'NX',
  );
  if (!acquired) {
    logger.warn('[monitor-worker] another instance is already running — exiting');
    process.exit(1);
  }

  const releaseLock = async () => {
    await redis
      .eval(
        `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`,
        1,
        MONITOR_LOCK_KEY,
        lockToken,
      )
      .catch((e: unknown) => {
        logger.warn('[monitor-worker] lock release failed', { error: String(e) });
      });
  };
  _releaseLock = releaseLock;

  logger.info('[monitor-worker] starting persistent monitor', {
    loopIntervalMs: cfg.MONITOR_LOOP_INTERVAL_MS,
    lockTtlSec: MONITOR_LOCK_TTL_SEC,
    heavyIntervalMin: cfg.MONITOR_HEAVY_INTERVAL_MIN,
  });

  // One-shot startup tasks (mirror the CLI entrypoint in index.ts):
  //   1. Sync Simmer agent auto-redeem setting
  //   2. Warm up the CLOB probe (10s timeout, fire-and-forget)
  void setAgentAutoRedeem(cfg.SIMMER_AUTO_REDEEM_ENABLED).catch((err: unknown) => {
    logger.warn('[monitor-worker] failed to set Simmer auto-redeem — continuing', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  void Promise.race([
    runClobProbe(),
    new Promise<void>((_, reject) =>
      setTimeout(() => {
        reject(new Error('probe timeout'));
      }, 10_000),
    ),
  ]).catch((err: unknown) => {
    logger.warn('[monitor-worker] CLOB probe failed — continuing', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  let lastHeartbeat = 0;
  let lastNearZeroReconcile = 0;
  let nearZeroReconcileInFlight = false;
  let lastCopytradeHedgeScan = 0;
  let copytradeHedgeScanInFlight = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Tri-state refresh, identical to futuresMonitor.ts pattern.
    let refreshState: 'refreshed' | 'expired' | 'stolen';
    try {
      refreshState = await refreshLock(MONITOR_LOCK_KEY, lockToken, MONITOR_LOCK_TTL_SEC);
    } catch (e) {
      logger.warn('[monitor-worker] lock refresh failed', { error: String(e) });
      refreshState = 'refreshed';
    }

    if (refreshState === 'stolen') {
      logger.error('[monitor-worker] lock stolen by another instance — shutting down');
      break;
    }
    if (refreshState === 'expired') {
      logger.warn('[monitor-worker] own lock TTL expired — attempting re-acquire', {
        ttlSec: MONITOR_LOCK_TTL_SEC,
      });
      const reacquired = await reacquireLockAfterExpiry(
        MONITOR_LOCK_KEY,
        lockToken,
        MONITOR_LOCK_TTL_SEC,
      ).catch((err: unknown) => {
        logger.warn('[monitor-worker] re-acquire failed', { error: String(err) });
        return false;
      });
      if (!reacquired) {
        logger.error(
          '[monitor-worker] lock expired AND re-acquire found another holder — shutting down',
        );
        break;
      }
      logger.info('[monitor-worker] lock re-acquired after expiry');
    }

    try {
      await runMonitorInner(redis);
    } catch (err) {
      logger.error('[monitor-worker] error in monitor cycle', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const nowMs = Date.now();
    if (nowMs - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      logger.info('[monitor-worker] heartbeat');
      lastHeartbeat = nowMs;
    }

    // Periodically rebuild near-zero-arb theme open sets from the live ledger
    // to heal any drift caused by missed SREM calls (e.g. worker crash on exit).
    if (
      !nearZeroReconcileInFlight &&
      nowMs - lastNearZeroReconcile >= cfg.NEAR_ZERO_THEME_RECONCILE_INTERVAL_MS
    ) {
      lastNearZeroReconcile = nowMs; // set before async so interval is measured from start
      nearZeroReconcileInFlight = true;
      rebuildNearZeroThemeSets(redis)
        .catch((err: unknown) => {
          logger.warn('[monitor-worker] near-zero theme reconcile failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          nearZeroReconcileInFlight = false;
        });
    }

    if (
      !copytradeHedgeScanInFlight &&
      nowMs - lastCopytradeHedgeScan >= cfg.COPYTRADE_HEDGE_INTERVAL_MS
    ) {
      lastCopytradeHedgeScan = nowMs; // set before async so interval is measured from start
      copytradeHedgeScanInFlight = true;
      runCopytradeHedgeScan(redis)
        .catch((err: unknown) => {
          logger.warn('[monitor-worker] copytrade hedge scan failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          copytradeHedgeScanInFlight = false;
        });
    }

    await new Promise((resolve) => setTimeout(resolve, cfg.MONITOR_LOOP_INTERVAL_MS));
  }

  // Loop exited via break (lock stolen or unrecoverable expiry) — exit so Docker
  // restarts the container rather than leaving a zombie process.
  process.exit(1);
}

// CLI entrypoint
const isMain =
  (process.argv[1]?.endsWith('monitor/worker.ts') ?? false) ||
  (process.argv[1]?.endsWith('monitor/worker.js') ?? false);
if (isMain) {
  const shutdown = async () => {
    logger.info('[monitor-worker] shutting down...');
    if (_releaseLock) await _releaseLock();
    destroyPriceFeed();
    await closeRedis();
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });

  runMonitorWorker().catch((err: unknown) => {
    logger.error('[monitor-worker] fatal worker error', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
