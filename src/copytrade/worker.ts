import { promises as fsPromises } from 'fs';
import { hostname } from 'node:os';
import dotenv from 'dotenv';
// Note: top-level dotenv.config() removed — config.ts loads dotenv via 'import dotenv/config'.
// The dotenv import is retained for the hot-reload path (~line 148) which uses dotenv.config({ override: true }).
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getRedis } from '../shared/redis.js';
import { runCopytrade } from './index.js';
import { executeSignal } from '../execution/executor.js';
import { recordPosition } from '../execution/positionLedger.js';
import { deductStake, getBankroll } from '../shared/bankroll.js';
import { SimmerError } from '../shared/simmer.js';
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
const WORKER_LOCK_TTL_SEC = 90; // 90s — safe with 60s refresh; limits stuck window on crash

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

  // Refresh lock every 60s while running.
  // Track consecutive refresh failures: after 3 failures (~3 min), abort the worker
  // rather than silently running without holding the lock (which allows duplicate instances).
  let lockRefreshFailures = 0;
  const MAX_LOCK_REFRESH_FAILURES = 3;
  let lockLost = false;
  const lockRefresh = setInterval(() => {
    redis
      .eval(
        `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("expire",KEYS[1],ARGV[2]) else return 0 end`,
        1,
        WORKER_LOCK_KEY,
        lockToken,
        String(WORKER_LOCK_TTL_SEC),
      )
      .then((result) => {
        lockRefreshFailures = 0;
        if (result === 0) {
          // Lock was taken by another instance — stop this worker.
          logger.error('[copytrade-worker] lock lost to another instance — aborting');
          lockLost = true;
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

          const result = await executeSignal(signal, redis, sessionExposureUsd);
          if (result.tradeResult?.success) {
            await deductStake(redis, result.signal.stakeUsd);
            await recordPosition(redis, {
              marketId: signal.marketId,
              executionId: result.signal.executionId,
              conditionId: signal.conditionId,
              clobTokenIds: signal.clobTokenIds,
              question: signal.question,
              direction: signal.direction,
              entryPrice: result.entryPrice ?? signal.outcomePrice,
              stakeUsd: result.signal.stakeUsd,
              consensusProbability: signal.consensusProbability,
              consensusStddev: signal.consensusStddev,
              edgeMagnitude: result.signal.edgeMagnitude,
              sourcedFrom: signal.sourcedFrom,
              openedAt: new Date().toISOString(),
              txHash: result.tradeResult.tx_hash,
              sharesHeld: result.tradeResult.shares_bought,
              executionVenue: result.executionVenue ?? 'simmer',
            });
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

      // 429: Simmer is rate-limiting — back off immediately with exponential delay
      // (cap at 5 minutes) and do NOT count towards the circuit breaker since this
      // is an expected transient condition, not a code/config failure.
      if (err instanceof SimmerError && err.statusCode === 429) {
        const rateLimitBackoffMs = Math.min(5_000 * Math.pow(2, consecutiveFailures - 1), 300_000);
        logger.warn('[copytrade-worker] rate-limited by Simmer — backing off', {
          backoffMs: rateLimitBackoffMs,
        });
        await new Promise((resolve) => setTimeout(resolve, rateLimitBackoffMs));
        consecutiveFailures--; // 429 is not a real failure — don't advance the circuit breaker
      } else if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
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
