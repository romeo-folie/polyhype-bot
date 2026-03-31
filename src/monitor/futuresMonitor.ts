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
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getRedis, closeRedis } from '../shared/redis.js';
import { getHyperliquid } from '../shared/hyperliquid.js';
import { notifyTradeError } from '../execution/telegram.js';
import { closePosition as closeLedgerPosition, getOpenPositions } from '../execution/positionLedger.js';

const POLL_INTERVAL_MS = 5000; // 5 seconds — safe for rate limits, fast enough for intraday
const MONITOR_LOCK_KEY = 'futures-monitor:lock';
const MONITOR_LOCK_TTL_SEC = 30; // Must be > POLL_INTERVAL_MS; refreshed every cycle.

// Module-level reference to releaseLock so the shutdown handler can call it
let _releaseLock: (() => Promise<void>) | null = null;

export async function runFuturesMonitorWorker(): Promise<void> {
  const cfg = loadConfig();
  const redis = getRedis();
  const hl = getHyperliquid();

  if (!cfg.FUTURES_ENABLED) {
    logger.info('[futures-monitor] disabled, exiting');
    return;
  }

  // Distributed lock — prevents duplicate PM2 instances from issuing conflicting close orders.
  const lockToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const acquired = await redis.set(MONITOR_LOCK_KEY, lockToken, 'EX', MONITOR_LOCK_TTL_SEC, 'NX');
  if (!acquired) {
    logger.warn('[futures-monitor] another instance is already running — exiting');
    return;
  }

  logger.info('[futures-monitor] starting persistent monitor', {
    pollInterval: `${String(POLL_INTERVAL_MS)}ms`,
    stopLoss: `${String(cfg.FUTURES_STOP_LOSS_PCT)}%`,
    takeProfit: `${String(cfg.FUTURES_TAKE_PROFIT_PCT)}%`,
  });

  const releaseLock = async () => {
    await redis.eval(
      `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`,
      1, MONITOR_LOCK_KEY, lockToken,
    ).catch((e: unknown) => { logger.warn('[futures-monitor] lock release failed', { error: String(e) }); });
  };
  _releaseLock = releaseLock;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Refresh lock TTL each cycle to stay alive.
    await redis.eval(
      `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("expire",KEYS[1],ARGV[2]) else return 0 end`,
      1, MONITOR_LOCK_KEY, lockToken, String(MONITOR_LOCK_TTL_SEC),
    ).catch((e: unknown) => { logger.warn('[futures-monitor] lock refresh failed', { error: String(e) }); });
    try {
      const positions = await hl.getOpenPositions();
      
      if (positions.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

      // Sync HL positions with ledger to get true 'openedAt' timestamps
      const ledgerPositions = await getOpenPositions(redis);
      const futuresLedger = ledgerPositions.filter(p => p.isFutures);

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

        // Price change % — independent of leverage
        const priceChangePct = (pnlUsd / positionValue) * 100;

        logger.debug('[futures-monitor] checking position', {
          symbol,
          priceChangePct: priceChangePct.toFixed(2),
        });

        let shouldExit = false;
        let reason = '';

        if (priceChangePct <= cfg.FUTURES_STOP_LOSS_PCT) {
          shouldExit = true;
          reason = `Stop-Loss triggered (${priceChangePct.toFixed(2)}%)`;
        } else if (priceChangePct >= cfg.FUTURES_TAKE_PROFIT_PCT) {
          shouldExit = true;
          reason = `Take-Profit triggered (${priceChangePct.toFixed(2)}%)`;
        } else {
          // 3. Time-based max-hold exit using ledger 'openedAt'
          const ledgerPos = futuresLedger.find(p => p.marketId === symbol);
          const openedAt = ledgerPos ? new Date(ledgerPos.openedAt).getTime() : Date.now();
          
          const ageHours = (Date.now() - openedAt) / (1000 * 3600);
          if (ageHours >= cfg.FUTURES_MAX_HOLD_HOURS) {
            shouldExit = true;
            reason = `Max hold hours reached (${ageHours.toFixed(1)}h >= ${cfg.FUTURES_MAX_HOLD_HOURS}h)`;
          }
        }

        if (shouldExit) {
          logger.info('[futures-monitor] executing exit', { symbol, reason });
          
          const result = await hl.closePosition(symbol);
          if (result.success) {
            logger.info('[futures-monitor] exit successful', { symbol, txHash: result.txHash });
            await closeLedgerPosition(redis, symbol, direction);
          } else {
            logger.error('[futures-monitor] exit failed', { symbol, error: result.error });
            await notifyTradeError({ 
              marketId: symbol, 
              question: `Futures Auto-Exit: ${symbol}`, 
              direction,
              stakeUsd: positionValue
            }, result.error || 'Unknown exit error');
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
const isMain = process.argv[1]?.endsWith('futuresMonitor.ts') || process.argv[1]?.endsWith('futuresMonitor.js');
if (isMain) {
  const shutdown = async () => {
    logger.info('[futures-monitor] shutting down...');
    if (_releaseLock) await _releaseLock();
    await closeRedis();
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });

  runFuturesMonitorWorker().catch((err) => {
    logger.error('[futures-monitor] fatal worker error', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
