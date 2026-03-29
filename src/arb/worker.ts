import { getRedis, getSubscriberRedis, closeRedis } from '../shared/redis.js';
import { logger } from '../shared/logger.js';
import { runArbScan } from './scanner.js';
import { loadConfig } from '../shared/config.js';

interface WorkerOptions {
  baselineIntervalMs?: number;
  maxTradesPerMin?: number;
}

/**
 * Arbitrage Worker.
 * 
 * Persistent process that:
 * 1. Listens for live price moves via Redis Pub/Sub (Fast-Path).
 * 2. Scans Polymarket on a regular interval (Baseline).
 * 3. Throttles execution to protect account rate limits.
 */
export class ArbitrageWorker {
  private baselineIntervalMs: number;
  private maxTradesPerMin: number;
  private lastScanTime: number = 0;
  private isScanning: boolean = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: WorkerOptions = {}) {
    this.baselineIntervalMs = options.baselineIntervalMs ?? 10000; // 10s baseline
    this.maxTradesPerMin = options.maxTradesPerMin ?? 45; // safety buffer below 60
  }

  public async start(): Promise<void> {
    const cfg = loadConfig();
    if (!cfg.ARB_ENABLED) {
      logger.info('[arb-worker] arbitrage disabled in config, exiting');
      return;
    }

    logger.info('[arb-worker] starting long-running worker', {
      baselineIntervalMs: this.baselineIntervalMs,
      maxTradesPerMin: this.maxTradesPerMin,
    });

    // 1. Subscribe to real-time price updates
    const subscriber = getSubscriberRedis();
    await subscriber.subscribe('spot:price_moved');

    subscriber.on('message', (channel, message) => {
      if (channel === 'spot:price_moved') {
        const move = JSON.parse(message);
        logger.debug('[arb-worker] price move detected (Fast-Path)', move);
        void this.triggerScan('fast-path');
      }
    });

    // 2. Start baseline polling loop
    this.scheduleBaseline();
  }

  private scheduleBaseline(): void {
    this.timer = setTimeout(async () => {
      await this.triggerScan('baseline');
      this.scheduleBaseline();
    }, this.baselineIntervalMs);
  }

  /**
   * Trigger a scan, respecting the rate-limit governor and concurrency locks.
   */
  private async triggerScan(source: 'fast-path' | 'baseline'): Promise<void> {
    if (this.isScanning) {
      logger.debug(`[arb-worker] scan already in progress, skipping ${source} trigger`);
      return;
    }

    // Rate Limit Governor: min time between scans based on maxTradesPerMin.
    // 60,000ms / 45 trades = ~1.3s per trade.
    const minIntervalMs = 60000 / this.maxTradesPerMin;
    const now = Date.now();
    const elapsed = now - this.lastScanTime;

    if (elapsed < minIntervalMs) {
      logger.debug(`[arb-worker] governor throttle: ${elapsed}ms < ${minIntervalMs.toFixed(0)}ms, skipping`);
      return;
    }

    this.isScanning = true;
    this.lastScanTime = now;

    try {
      logger.info(`[arb-worker] scan started (${source})`);
      const redis = getRedis();
      await runArbScan(redis);
    } catch (err) {
      logger.error('[arb-worker] scan failed', { error: String(err) });
    } finally {
      this.isScanning = false;
      logger.debug(`[arb-worker] scan finished (${source})`);
    }
  }

  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const subscriber = getSubscriberRedis();
    void subscriber.unsubscribe('spot:price_moved').catch(() => {});
  }
}

// CLI entrypoint
async function main() {
  const worker = new ArbitrageWorker();
  
  const shutdown = async () => {
    logger.info('[arb-worker] shutting down...');
    worker.stop();
    await closeRedis();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await worker.start();
}

const isMain = process.argv[1]?.endsWith('arb/worker.ts') ?? false;
if (isMain) {
  main().catch((err) => {
    logger.error('[arb-worker] fatal error', { error: String(err) });
    process.exit(1);
  });
}
