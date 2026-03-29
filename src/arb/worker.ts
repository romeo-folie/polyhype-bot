import { getRedis, getSubscriberRedis, closeRedis } from '../shared/redis.js';
import { logger } from '../shared/logger.js';
import { runArbScan } from './scanner.js';
import { loadConfig } from '../shared/config.js';
import { scanCryptoArb, BINANCE_SYMBOL_TO_ASSET } from './cryptoArbScanner.js';
import { executeSignal } from '../execution/executor.js';
import { recordPosition } from '../execution/positionLedger.js';
import { deductStake } from '../shared/bankroll.js';
import type { SpotMove } from '../spot/thresholdDetector.js';
import type { TradeSignal } from '../mapping/index.js';

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
 * 3. Triggers crypto latency arb on spot:price_moved events.
 * 4. Throttles execution to protect account rate limits.
 */
export class ArbitrageWorker {
  private baselineIntervalMs: number;
  private maxTradesPerMin: number;
  private lastScanTime = 0;
  private lastCryptoArbTime = 0;
  private lastCryptoArbTradeTime = 0;
  private isScanning = false;
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
      cryptoArbEnabled: cfg.CRYPTO_ARB_ENABLED,
    });

    // 1. Subscribe to real-time price updates
    const subscriber = getSubscriberRedis();
    await subscriber.subscribe('spot:price_moved');

    subscriber.on('message', (channel, message) => {
      if (channel === 'spot:price_moved') {
        let parsed: { symbol?: string; price?: number; timestamp?: number };
        try {
          parsed = JSON.parse(message);
        } catch {
          logger.warn('[arb-worker] invalid spot:price_moved payload');
          return;
        }
        logger.debug('[arb-worker] price move detected (Fast-Path)', parsed);
        void this.triggerScan('fast-path');

        // Trigger crypto latency arb path (independent of YES+NO arb scan).
        // Moved to async method to allow awaiting previous-price lookup.
        if (parsed.symbol && parsed.price != null) {
          void this.triggerCryptoArbFromTicker(
            String(parsed.symbol),
            parsed.price as number,
            parsed.timestamp as number | undefined,
          );
        }
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

  /**
   * Trigger crypto latency arb path. Runs independently of the YES+NO arb scan.
   * All errors are caught — must never crash the worker.
   */
  private async triggerCryptoArbFromTicker(symbol: string, currentPrice: number, tsMs?: number): Promise<void> {
    const assetId = BINANCE_SYMBOL_TO_ASSET[symbol];
    if (!assetId) return;

    // Resolve previous price for meaningful referencePrice / changePercent.
    const redis = getRedis();
    const lastRaw = await redis.get(`spot:last:${symbol}`).catch(() => null);
    let referencePrice = currentPrice;
    if (lastRaw) {
      try {
        const last = JSON.parse(lastRaw) as { price?: unknown };
        const prevPrice = typeof last.price === 'number' ? last.price : null;
        if (prevPrice != null && prevPrice > 0) referencePrice = prevPrice;
      } catch { /* keep currentPrice as fallback */ }
    }
    const changePercent = referencePrice > 0 && referencePrice !== currentPrice
      ? ((currentPrice - referencePrice) / referencePrice) * 100
      : 0;
    if (changePercent === 0) {
      logger.debug('[crypto-arb] no previous price for reference — changePercent defaulting to 0', { symbol, assetId });
    }

    return this.triggerCryptoArb({
      assetId,
      currentPrice,
      referencePrice,
      changePercent,
      windowMinutes: 0,
      detectedAt: new Date(tsMs ?? Date.now()).toISOString(),
    });
  }

  private async triggerCryptoArb(move: SpotMove): Promise<void> {
    try {
      const cfg = loadConfig();
      if (!cfg.CRYPTO_ARB_ENABLED) return;

      // Rate-limit governor (same logic as triggerScan but independent counter)
      const minIntervalMs = 60000 / this.maxTradesPerMin;
      const now = Date.now();
      if (now - this.lastCryptoArbTime < minIntervalMs) {
        logger.debug('[crypto-arb] governor throttle, skipping');
        return;
      }
      this.lastCryptoArbTime = now;

      const redis = getRedis();
      const opportunities = await scanCryptoArb(move, redis);

      for (const opp of opportunities) {
        // Per-trade rate limit: enforce minInterval between individual trades, not just scans.
        const tradeNow = Date.now();
        if (tradeNow - this.lastCryptoArbTradeTime < minIntervalMs) {
          logger.debug('[crypto-arb] per-trade governor throttle, skipping remaining opportunities');
          break;
        }

        try {
          const signal: TradeSignal = {
            marketId: opp.marketId,
            conditionId: opp.conditionId,
            clobTokenIds: opp.clobTokenIds,
            question: opp.question,
            direction: opp.direction,
            stakeUsd: opp.stakeUsd,
            edgeMagnitude: opp.edge,
            consensusProbability: opp.fairValuePrice,
            outcomePrice: opp.currentPmPrice,
            sourcedFrom: `crypto-arb:${opp.assetId}`,
            reasoning: `Crypto latency arb: fair=${opp.fairValuePrice.toFixed(3)}, pm=${opp.currentPmPrice.toFixed(3)}, edge=${opp.edge.toFixed(3)}`,
          };

          const result = await executeSignal(signal, redis);

          if (result.tradeResult?.success) {
            logger.info('[crypto-arb] trade executed', {
              marketId: opp.marketId,
              direction: opp.direction,
              stakeUsd: opp.stakeUsd,
              edge: opp.edge.toFixed(4),
            });

            // Record position
            await recordPosition(redis, {
              marketId: opp.marketId,
              conditionId: opp.conditionId,
              clobTokenIds: opp.clobTokenIds,
              question: opp.question,
              direction: opp.direction,
              entryPrice: opp.currentPmPrice,
              stakeUsd: opp.stakeUsd,
              consensusProbability: opp.fairValuePrice,
              edgeMagnitude: opp.edge,
              openedAt: new Date().toISOString(),
              sourcedFrom: `crypto-arb:${opp.assetId}`,
              executionVenue: result.executionVenue ?? 'simmer',
            });

            // Deduct stake from bankroll cache
            await deductStake(redis, opp.stakeUsd);
            // Update per-trade timestamp so the next iteration respects the rate limit.
            this.lastCryptoArbTradeTime = Date.now();

            // Set dedup key
            const dedupKey = `arb:crypto:${opp.marketId}:${opp.direction}`;
            await redis.set(dedupKey, '1', 'EX', cfg.CRYPTO_ARB_DEDUP_TTL_S);
          } else if (result.skipped) {
            logger.debug('[crypto-arb] signal skipped', {
              marketId: opp.marketId,
              reason: result.skipReason,
            });
          } else if (result.error) {
            logger.warn('[crypto-arb] execution error', {
              marketId: opp.marketId,
              error: result.error,
            });
          }
        } catch (err) {
          logger.error('[crypto-arb] error executing opportunity', {
            marketId: opp.marketId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.error('[crypto-arb] triggerCryptoArb failed', {
        assetId: move.assetId,
        error: err instanceof Error ? err.message : String(err),
      });
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
