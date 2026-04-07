/**
 * Sports arb poller worker.
 *
 * Long-running worker (mirrors `src/clob/flowMonitor.ts`): acquires a Redis
 * lock, heartbeats it, and on each tick runs `scanLiveSportsArb()` → hands
 * signals to `executeSignal()`. Self-gates on ESPN game state — no host cron.
 */

import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getRedis, closeRedis, acquireLock, releaseLock } from '../shared/redis.js';
import { scanLiveSportsArb } from './scanner.js';
import { executeSignal } from '../execution/executor.js';

const LOCK_KEY = 'lock:sports:poller';
const LOCK_TTL_S = 90;

async function tick(): Promise<void> {
  const cfg = loadConfig();
  const redis = getRedis();

  if (!cfg.SPORTS_ARB_ENABLED) {
    // Still run a scan to produce log-only divergence lines.
    await scanLiveSportsArb(redis, cfg);
    return;
  }

  const { signals } = await scanLiveSportsArb(redis, cfg);
  if (signals.length === 0) return;

  logger.info('[sports-poller] emitting signals', { count: signals.length });
  for (const signal of signals) {
    try {
      await executeSignal(signal, redis);
    } catch (err) {
      logger.error('[sports-poller] executeSignal failed', {
        marketId: signal.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const redis = getRedis();

  const lockToken = await acquireLock(LOCK_KEY, LOCK_TTL_S);
  if (!lockToken) {
    logger.warn('[sports-poller] another instance holds the lock; exiting');
    return;
  }

  let stopped = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let lockRefreshTimer: NodeJS.Timeout | null = null;

  const shutdown = async (signal: string) => {
    if (stopped) return;
    stopped = true;
    logger.info('[sports-poller] shutting down', { signal });
    if (pollTimer) clearInterval(pollTimer);
    if (lockRefreshTimer) clearInterval(lockRefreshTimer);
    try {
      await releaseLock(LOCK_KEY, lockToken);
    } catch (err) {
      logger.warn('[sports-poller] lock release failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await closeRedis();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  lockRefreshTimer = setInterval(() => {
    void redis.expire(LOCK_KEY, LOCK_TTL_S).catch(() => {});
  }, (LOCK_TTL_S * 1000) / 3);

  const runTick = () => {
    void tick().catch((err: unknown) => {
      logger.warn('[sports-poller] tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  pollTimer = setInterval(runTick, cfg.SPORTS_POLL_INTERVAL_S * 1000);
  runTick();

  logger.info('[sports-poller] worker running', {
    intervalS: cfg.SPORTS_POLL_INTERVAL_S,
    leagues: [...cfg.SPORTS_LEAGUES],
    enabled: cfg.SPORTS_ARB_ENABLED,
  });
}

const isMain = process.argv[1]?.endsWith('poller.ts') || process.argv[1]?.endsWith('poller.js');
if (isMain) {
  main().catch((err: unknown) => {
    logger.error('[sports-poller] fatal', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}

export { main as runSportsPoller, tick as sportsPollerTick };
