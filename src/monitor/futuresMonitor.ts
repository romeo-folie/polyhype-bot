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
import { closePosition as closeLedgerPosition } from '../execution/positionLedger.js';

const POLL_INTERVAL_MS = 5000; // 5 seconds — safe for rate limits, fast enough for intraday

export async function runFuturesMonitorWorker(): Promise<void> {
  const cfg = loadConfig();
  const redis = getRedis();
  const hl = getHyperliquid();

  if (!cfg.FUTURES_ENABLED) {
    logger.info('[futures-monitor] disabled, exiting');
    return;
  }

  logger.info('[futures-monitor] starting persistent monitor', {
    pollInterval: `${String(POLL_INTERVAL_MS)}ms`,
    stopLoss: `${String(cfg.FUTURES_STOP_LOSS_PCT)}%`,
    takeProfit: `${String(cfg.FUTURES_TAKE_PROFIT_PCT)}%`,
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const positions = await hl.getOpenPositions();
      
      if (positions.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

      for (const pos of positions) {
        const symbol = pos.symbol;
        const entryPx = parseFloat(pos.position.entryPx);
        const pnlUsd = parseFloat(pos.position.unrealizedPnl);
        const size = Math.abs(parseFloat(pos.position.szi));
        const positionValue = size * entryPx;

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
          // 3. Time-based max-hold exit
          const firstSeenKey = `futures:first-seen:${symbol}`;
          let firstSeen = await redis.get(firstSeenKey);
          if (!firstSeen) {
            firstSeen = Date.now().toString();
            await redis.set(firstSeenKey, firstSeen, 'EX', 3600 * 24 * 7);
          }
          const ageHours = (Date.now() - parseInt(firstSeen)) / (1000 * 3600);
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
            // Cleanup ledger and tracking
            const direction = parseFloat(pos.position.szi) > 0 ? 'LONG' : 'SHORT';
            await Promise.all([
              closeLedgerPosition(redis, symbol, direction),
              redis.del(`futures:first-seen:${symbol}`),
            ]);
          } else {
            logger.error('[futures-monitor] exit failed', { symbol, error: result.error });
            await notifyTradeError({ marketId: symbol, question: 'Futures Auto-Exit' } as any, result.error || 'Unknown exit error');
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
  runFuturesMonitorWorker().catch((err) => {
    logger.error('[futures-monitor] fatal worker error', { error: err.message });
    process.exit(1);
  });
}
