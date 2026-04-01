import { promises as fsPromises } from 'fs';
import dotenv from 'dotenv';
dotenv.config();
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getRedis } from '../shared/redis.js';
import { runCopytrade } from './index.js';
import { executeSignal } from '../execution/executor.js';
import { recordPosition } from '../execution/positionLedger.js';
import { deductStake, getBankroll } from '../shared/bankroll.js';

/**
 * Persistent worker for low-latency copy-trading.
 *
 * Runs in a continuous loop to catch whale trades with minimum latency.
 * Does not share a lock with the main OSINT pipeline to avoid blocking.
 *
 * @param maxCycles  Optional limit for testing (runs infinitely if undefined)
 */
const WORKER_LOCK_KEY = 'copytrade:worker:lock';
const WORKER_LOCK_PID_KEY = 'copytrade:worker:pid';
const WORKER_LOCK_TTL_SEC = 90; // 90s — safe with 60s refresh; limits stuck window on crash

/**
 * Check if a process with the given PID is still alive on this host.
 * Returns false if the PID is missing, invalid, or belongs to a dead process.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, never kills
    return true;
  } catch {
    return false; // ESRCH = no such process
  }
}

export async function runWorker(maxCycles?: number): Promise<void> {
  const redis = getRedis();
  const cfg = loadConfig();

  // Duplicate-instance guard: only one worker may run at a time.
  // On startup, if a lock exists, check if the owning PID is still alive.
  // If the previous worker crashed without releasing the lock (SIGKILL, OOM, etc.),
  // the PID will be dead and we force-delete the stale lock rather than waiting for TTL.
  const existingLock = await redis.get(WORKER_LOCK_KEY);
  if (existingLock) {
    const ownerPidStr = await redis.get(WORKER_LOCK_PID_KEY);
    const ownerPid = ownerPidStr ? parseInt(ownerPidStr, 10) : NaN;
    if (!isNaN(ownerPid) && !isPidAlive(ownerPid)) {
      logger.warn('[copytrade-worker] stale lock detected — previous owner PID is dead, force-releasing', { ownerPid });
      await redis.del(WORKER_LOCK_KEY, WORKER_LOCK_PID_KEY);
    }
  }

  const lockToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const acquired = await redis.set(WORKER_LOCK_KEY, lockToken, 'EX', WORKER_LOCK_TTL_SEC, 'NX');
  if (!acquired) {
    logger.warn('[copytrade-worker] another instance is already running — exiting');
    return;
  }

  // Store our PID so the next startup can detect if we crashed without releasing.
  await redis.set(WORKER_LOCK_PID_KEY, String(process.pid), 'EX', WORKER_LOCK_TTL_SEC + 10);

  // Refresh lock every 60s while running.
  // Track consecutive refresh failures: after 3 failures (~3 min), abort the worker
  // rather than silently running without holding the lock (which allows duplicate instances).
  let lockRefreshFailures = 0;
  const MAX_LOCK_REFRESH_FAILURES = 3;
  let lockLost = false;
  const lockRefresh = setInterval(() => {
    // Refresh both the lock key and the PID key TTLs atomically.
    redis.eval(
      `if redis.call("get",KEYS[1])==ARGV[1] then redis.call("expire",KEYS[2],ARGV[2]) return redis.call("expire",KEYS[1],ARGV[2]) else return 0 end`,
      2, WORKER_LOCK_KEY, WORKER_LOCK_PID_KEY, lockToken, String(WORKER_LOCK_TTL_SEC),
    ).then((result) => {
      lockRefreshFailures = 0;
      if (result === 0) {
        // Lock was taken by another instance — stop this worker.
        logger.error('[copytrade-worker] lock lost to another instance — aborting');
        lockLost = true;
      }
    }).catch((err) => {
      lockRefreshFailures++;
      logger.warn('[copytrade-worker] lock refresh failed', {
        attempt: lockRefreshFailures,
        max: MAX_LOCK_REFRESH_FAILURES,
        error: String(err),
      });
      if (lockRefreshFailures >= MAX_LOCK_REFRESH_FAILURES) {
        logger.error('[copytrade-worker] lock refresh failed too many times — aborting to prevent duplicate instances');
        lockLost = true;
      }
    });
  }, 60_000);

  const releaseLock = async () => {
    clearInterval(lockRefresh);
    await redis.eval(
      `if redis.call("get",KEYS[1])==ARGV[1] then redis.call("del",KEYS[2]) return redis.call("del",KEYS[1]) else return 0 end`,
      2, WORKER_LOCK_KEY, WORKER_LOCK_PID_KEY, lockToken,
    ).catch((e: unknown) => { logger.warn('[copytrade-worker] lock release failed', { error: String(e) }); });
  };

  // Release lock on graceful shutdown (PM2 restart, SIGTERM, Ctrl+C).
  // Without this, PM2 restart races the 300s TTL and the new instance exits immediately.
  const onShutdown = (signal: string) => {
    logger.info('[copytrade-worker] shutdown signal received — releasing lock', { signal });
    releaseLock()
      .then(() => {
        redis.quit().catch(() => {});
        process.exit(0);
      })
      .catch(() => process.exit(1));
  };
  process.once('SIGTERM', () => onShutdown('SIGTERM'));
  process.once('SIGINT', () => onShutdown('SIGINT'));

  logger.info('[copytrade-worker] started', { 
    wallets: cfg.COPYTRADE_WALLETS,
    scope: cfg.COPYTRADE_MARKET_SCOPE
  });

  const POLL_INTERVAL_MS = cfg.COPYTRADE_POLL_INTERVAL_MS;
  const MAX_CONSECUTIVE_FAILURES = 10;
  let consecutiveFailures = 0;
  let iterations = 0;

  while (true) {
    if (lockLost) {
      logger.error('[copytrade-worker] stopping — lock lost or refresh failed');
      break;
    }
    if (maxCycles !== undefined && iterations >= maxCycles) break;

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
              logger.warn('[copytrade-worker] config validation failed during hot-reload — keeping previous config', {
                error: configErr instanceof Error ? configErr.message : String(configErr),
              });
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
            continue;
          }

          const result = await executeSignal(signal, redis, sessionExposureUsd);
          if (result.tradeResult?.success) {
            await deductStake(redis, signal.stakeUsd);
            await recordPosition(redis, {
              marketId: signal.marketId,
              conditionId: signal.conditionId,
              clobTokenIds: signal.clobTokenIds,
              question: signal.question,
              direction: signal.direction,
              entryPrice: signal.outcomePrice,
              stakeUsd: signal.stakeUsd,
              consensusProbability: signal.consensusProbability,
              consensusStddev: signal.consensusStddev,
              edgeMagnitude: signal.edgeMagnitude,
              sourcedFrom: signal.sourcedFrom,
              openedAt: new Date().toISOString(),
              txHash: result.tradeResult.tx_hash,
              sharesHeld: result.tradeResult.shares_bought,
              executionVenue: result.executionVenue ?? 'simmer',
            });
            // Accumulate HL margin so subsequent signals in this cycle respect the cap.
            if (result.executionVenue === 'hyperliquid' || result.hedgeAttempted) {
              sessionExposureUsd += signal.stakeUsd;
            }
          }
        }
      }

      if (exits > 0) {
        logger.info('[copytrade-worker] mirror exits processed', { count: exits });
      }

      if (iterations % 100 === 0) {
        logger.info('[copytrade-worker] heartbeat', { iterations });
      }

      consecutiveFailures = 0; // reset circuit breaker on success
    } catch (err) {
      consecutiveFailures++;
      logger.error('[copytrade-worker] cycle failed', {
        error: (err as Error).message,
        consecutiveFailures,
      });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const backoffMs = Math.min(1000 * Math.pow(2, consecutiveFailures - MAX_CONSECUTIVE_FAILURES), 60_000);
        logger.warn('[copytrade-worker] circuit breaker: backing off', { backoffMs, consecutiveFailures });
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }

    iterations++;
    if (maxCycles !== undefined && iterations >= maxCycles) break;
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  await releaseLock();
}

// Run worker if called directly (script mode).
// Both guards are intentional:
//   - import.meta.url + argv: primary ESM guard against accidental execution when imported
//   - NODE_ENV !== 'test': belt-and-suspenders; the test suite sets this explicitly to
//     prevent this block from firing during dynamic import in worker.test.ts
if (process.env.NODE_ENV !== 'test' && import.meta.url.startsWith('file:') && (process.argv[1]?.endsWith('copytrade/worker.ts') || process.argv[1]?.endsWith('copytrade/worker.js'))) {
  runWorker().catch(err => {
    logger.error('[copytrade-worker] fatal error', { 
      error: err instanceof Error ? err.message : String(err) 
    });
    process.exit(1);
  });
}
