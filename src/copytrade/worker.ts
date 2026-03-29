import 'dotenv/config';
import dotenv from 'dotenv';
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
export async function runWorker(maxCycles?: number): Promise<void> {
  const redis = getRedis();
  const cfg = loadConfig();

  logger.info('[copytrade-worker] started', { 
    wallets: cfg.COPYTRADE_WALLETS,
    scope: cfg.COPYTRADE_MARKET_SCOPE
  });

  const POLL_INTERVAL_MS = cfg.COPYTRADE_POLL_INTERVAL_MS;
  let iterations = 0;

  while (true) {
    if (maxCycles !== undefined && iterations >= maxCycles) break;

    try {
      // Refresh config from .env every 100 cycles to pick up shortlist updates (hot-reloading).
      // Re-load before reading config for this iteration so the same snapshot is used
      // throughout the cycle — prevents race conditions from mid-cycle config changes.
      if (iterations > 0 && iterations % 100 === 0) {
        dotenv.config({ override: true });
        loadConfig(true); // flush cache
        logger.info('[copytrade-worker] configuration refreshed from .env');
      }
      const cycleConfig = loadConfig(); // snapshot for this iteration

      const bankrollUsd = await getBankroll(redis);
      const { signals, exits } = await runCopytrade(redis, bankrollUsd);

      if (signals.length > 0) {
        logger.info('[copytrade-worker] new signals detected', { count: signals.length });
        for (const signal of signals) {
          // Double-check bankroll before execution
          const currentBankroll = await getBankroll(redis);
          if (signal.stakeUsd > currentBankroll) {
            logger.warn('[copytrade-worker] insufficient bankroll for signal', { signal });
            continue;
          }

          const result = await executeSignal(signal, redis);
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
          }
        }
      }

      if (exits > 0) {
        logger.info('[copytrade-worker] mirror exits processed', { count: exits });
      }

      if (iterations % 100 === 0) {
        logger.info('[copytrade-worker] heartbeat', { iterations });
      }
    } catch (err) {
      logger.error('[copytrade-worker] cycle failed', { error: (err as Error).message });
    }

    iterations++;
    if (maxCycles !== undefined && iterations >= maxCycles) break;
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// Run worker if called directly (script mode).
// The import.meta.url + argv check is the real guard; NODE_ENV is not reliable
// across all test runners and has been removed.
if (import.meta.url.startsWith('file:') && (process.argv[1]?.endsWith('worker.ts') || process.argv[1]?.endsWith('worker.js'))) {
  runWorker().catch(err => {
    logger.error('[copytrade-worker] fatal error', { 
      error: err instanceof Error ? err.message : String(err) 
    });
    process.exit(1);
  });
}
