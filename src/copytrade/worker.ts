import { promises as fsPromises } from 'fs';
import { hostname } from 'node:os';
import dotenv from 'dotenv';
// Note: top-level dotenv.config() removed — config.ts loads dotenv via 'import dotenv/config'.
// The dotenv import is retained for the hot-reload path (~line 148) which uses dotenv.config({ override: true }).
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getRedis, refreshLock, reacquireLockAfterExpiry } from '../shared/redis.js';
import { runCopytrade } from './index.js';
import { executeAndRecordSignal } from '../execution/executor.js';
import { getBankroll } from '../shared/bankroll.js';
import { recordCopytradeFilter, recordCopytradeMetric } from '../shared/telemetry.js';

/**
 * Persistent worker for low-latency copy-trading.
 *
 * Runs in a continuous loop to catch whale trades with minimum latency.
 * Does not share a lock with the main OSINT pipeline to avoid blocking.
 *
 * @param maxCycles  Optional limit for testing (runs infinitely if undefined)
 */
const WORKER_LOCK_KEY = 'copytrade:worker:lock';
// TTL must comfortably exceed the worst-case delay between refresh ticks
// (setInterval jitter under event-loop pressure, GC pauses on ARM, Redis AOF
// rewrites, etc.). 300s gives 5x headroom over the 60s refresh interval.
// See Bug A in memory/recurring-worker-deaths.md for why the old 90s killed
// the worker during routine slowdowns.
const WORKER_LOCK_TTL_SEC = 300;

export async function runWorker(maxCycles?: number): Promise<void> {
  const redis = getRedis();
  const cfg = loadConfig();

  // Duplicate-instance guard: only one worker may run at a time.
  // On startup, if a lock exists, check if the owning container's hostname matches ours.
  // In Docker, each container gets a unique hostname (container ID prefix), so a mismatch
  // means the old container is gone and the lock is stale — safe to force-delete.
  const myHostname = hostname();
  const existingLock = await redis.get(WORKER_LOCK_KEY);
  if (existingLock) {
    const ownerHostname = existingLock.split(':')[0];
    if (ownerHostname !== myHostname) {
      logger.warn(
        '[copytrade-worker] stale lock detected — owner hostname differs, force-releasing',
        { ownerHostname, myHostname },
      );
      await redis.del(WORKER_LOCK_KEY);
    }
  }

  const lockToken = `${myHostname}:${Date.now().toString()}-${Math.random().toString(36).slice(2)}`;
  const acquired = await redis.set(WORKER_LOCK_KEY, lockToken, 'EX', WORKER_LOCK_TTL_SEC, 'NX');
  if (!acquired) {
    logger.warn('[copytrade-worker] another instance is already running — exiting');
    process.exit(1);
  }

  // Refresh lock every 60s. Tri-state semantics (see refreshLock in redis.ts):
  //   'refreshed' — all good
  //   'expired'   — our own TTL lapsed (event-loop stall / Redis blip); recover
  //                 by re-acquiring the same token atomically. NOT fatal.
  //   'stolen'    — a different token is in the key; genuine duplicate instance.
  //                 Only this case aborts the worker.
  // Refresh failures (network/Redis errors) still trip the abort after 3 in a
  // row, to prevent us running without a lock during a persistent Redis outage.
  let lockRefreshFailures = 0;
  const MAX_LOCK_REFRESH_FAILURES = 3;
  let lockLost = false;
  const lockRefresh = setInterval(() => {
    refreshLock(WORKER_LOCK_KEY, lockToken, WORKER_LOCK_TTL_SEC)
      .then(async (state) => {
        lockRefreshFailures = 0;
        if (state === 'refreshed') return;
        if (state === 'stolen') {
          logger.error('[copytrade-worker] lock stolen by another instance — aborting');
          lockLost = true;
          return;
        }
        // 'expired' — we outran our own TTL. Try to re-acquire with the same
        // token atomically. If something else got there first, THEN abort.
        logger.warn('[copytrade-worker] own lock TTL expired — attempting re-acquire', {
          ttlSec: WORKER_LOCK_TTL_SEC,
        });
        const reacquired = await reacquireLockAfterExpiry(
          WORKER_LOCK_KEY,
          lockToken,
          WORKER_LOCK_TTL_SEC,
        ).catch(() => false);
        if (!reacquired) {
          logger.error(
            '[copytrade-worker] lock expired AND re-acquire found another holder — aborting',
          );
          lockLost = true;
        } else {
          logger.info('[copytrade-worker] lock re-acquired after expiry');
        }
      })
      .catch((err: unknown) => {
        lockRefreshFailures++;
        logger.warn('[copytrade-worker] lock refresh failed', {
          attempt: lockRefreshFailures,
          max: MAX_LOCK_REFRESH_FAILURES,
          error: String(err),
        });
        if (lockRefreshFailures >= MAX_LOCK_REFRESH_FAILURES) {
          logger.error(
            '[copytrade-worker] lock refresh failed too many times — aborting to prevent duplicate instances',
          );
          lockLost = true;
        }
      });
  }, 60_000);

  const releaseLock = async () => {
    clearInterval(lockRefresh);
    await redis
      .eval(
        `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`,
        1,
        WORKER_LOCK_KEY,
        lockToken,
      )
      .catch((e: unknown) => {
        logger.warn('[copytrade-worker] lock release failed', { error: String(e) });
      });
  };

  // Release lock on graceful shutdown (PM2 restart, SIGTERM, Ctrl+C).
  // Without this, PM2 restart races the 300s TTL and the new instance exits immediately.
  const onShutdown = (signal: string) => {
    logger.info('[copytrade-worker] shutdown signal received — releasing lock', { signal });
    releaseLock()
      .then(() => {
        redis.quit().catch(() => {
          /* ignore quit errors */
        });
        process.exit(0);
      })
      .catch(() => process.exit(1));
  };
  process.once('SIGTERM', () => { onShutdown('SIGTERM'); });
  process.once('SIGINT', () => { onShutdown('SIGINT'); });

  logger.info('[copytrade-worker] started', {
    wallets: cfg.COPYTRADE_WALLETS,
    scope: cfg.COPYTRADE_MARKET_SCOPE,
  });

  const POLL_INTERVAL_MS = cfg.COPYTRADE_POLL_INTERVAL_MS;
  const MAX_CONSECUTIVE_FAILURES = 10;
  let consecutiveFailures = 0;
  let iterations = 0;

  let running = true;
  while (running) {
    if (lockLost) {
      logger.error('[copytrade-worker] stopping — lock lost or refresh failed');
      break;
    }
    if (maxCycles !== undefined && iterations >= maxCycles) {
      running = false;
      break;
    }

    try {
      // Refresh config from .env every 100 cycles to pick up shortlist updates (hot-reloading).
      // Re-load before reading config for this iteration so the same snapshot is used
      // throughout the cycle — prevents race conditions from mid-cycle config changes.
      if (iterations > 0 && iterations % 100 === 0) {
        // Guard against reading a partially-written .env during shortlist auto-apply.
        // The shortlist writer uses atomic rename (temp → .env), so stat the file and
        // only reload if it was last modified more than 2s ago (rename has completed).
        try {
          const envStat = await fsPromises.stat('.env');
          const ageMs = Date.now() - envStat.mtimeMs;
          if (ageMs > 2_000) {
            dotenv.config({ override: true });
            try {
              loadConfig(true); // flush cache
              logger.info('[copytrade-worker] configuration refreshed from .env');
            } catch (configErr) {
              logger.warn(
                '[copytrade-worker] config validation failed during hot-reload — keeping previous config',
                {
                  error: configErr instanceof Error ? configErr.message : String(configErr),
                },
              );
            }
          }
        } catch (err) {
          // .env missing, unreadable, or permissions error — skip reload, keep running with cached config
          logger.debug('[copytrade-worker] .env stat failed during hot-reload check', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const bankrollUsd = await getBankroll(redis);
      const { signals, exits } = await runCopytrade(redis, bankrollUsd);

      if (signals.length > 0) {
        logger.info('[copytrade-worker] new signals detected', { count: signals.length });
        let sessionExposureUsd = 0;
        for (const signal of signals) {
          // Double-check bankroll before execution
          const currentBankroll = await getBankroll(redis);
          if (signal.stakeUsd > currentBankroll) {
            logger.warn('[copytrade-worker] insufficient bankroll for signal', { signal });
            await recordCopytradeFilter(redis, 'insufficient_bankroll').catch(() => {
              /* ignore telemetry errors */
            });
            continue;
          }

          // executeAndRecordSignal handles deductStake + recordPosition on success.
          const result = await executeAndRecordSignal(signal, redis, sessionExposureUsd);
          if (!result.skipped && !result.error && result.entryExecutionPath !== 'maker_pending') {
            await recordCopytradeMetric(redis, 'executed').catch(() => {
              /* ignore telemetry errors */
            });
            // Accumulate HL margin so subsequent signals in this cycle respect the cap.
            if (result.executionVenue === 'hyperliquid') {
              sessionExposureUsd += result.signal.stakeUsd;
            }
          }
        }
      }

      if (exits > 0) {
        logger.info('[copytrade-worker] mirror exits processed', { count: exits });
        await recordCopytradeMetric(redis, 'exits').catch(() => {
          /* ignore telemetry errors */
        });
      }

      if (iterations % 100 === 0) {
        logger.info('[copytrade-worker] heartbeat', { iterations });
      }

      consecutiveFailures = 0; // reset circuit breaker on success
    } catch (err: unknown) {
      consecutiveFailures++;
      logger.error('[copytrade-worker] cycle failed', {
        error: err instanceof Error ? err.message : String(err),
        consecutiveFailures,
      });

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const backoffMs = Math.min(
          1000 * Math.pow(2, consecutiveFailures - MAX_CONSECUTIVE_FAILURES),
          60_000,
        );
        logger.warn('[copytrade-worker] circuit breaker: backing off', {
          backoffMs,
          consecutiveFailures,
        });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    iterations++;
    if (maxCycles !== undefined && iterations >= maxCycles) {
      running = false;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  await releaseLock();
}

// Run worker if called directly (script mode).
// Both guards are intentional:
//   - import.meta.url + argv: primary ESM guard against accidental execution when imported
//   - NODE_ENV !== 'test': belt-and-suspenders; the test suite sets this explicitly to
//     prevent this block from firing during dynamic import in worker.test.ts
if (
  process.env.NODE_ENV !== 'test' &&
  import.meta.url.startsWith('file:') &&
  (process.argv[1]?.endsWith('copytrade/worker.ts') ??
    process.argv[1]?.endsWith('copytrade/worker.js'))
) {
  runWorker().catch((err: unknown) => {
    logger.error('[copytrade-worker] fatal error', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
