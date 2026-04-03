import { getRedis, getSubscriberRedis, closeRedis } from '../shared/redis.js';
import { logger } from '../shared/logger.js';
import { runArbScan } from './scanner.js';
import { loadConfig } from '../shared/config.js';
import { scanCryptoArb, BINANCE_SYMBOL_TO_ASSET } from './cryptoArbScanner.js';
import { executeSignal } from '../execution/executor.js';
import { recordPosition } from '../execution/positionLedger.js';
import { deductStake } from '../shared/bankroll.js';
import { setAgentAutoRedeem } from '../shared/simmer.js';
import { recordCryptoArbGate, recordCryptoArbEvent, recordCryptoArbMetric } from '../shared/telemetry.js';
import { ArbMarketWarmer } from './warmer.js';
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
  private globalMaxTradesPerMin: number;
  private arbMaxTradesPerMin: number;
  private cryptoArbMaxTradesPerMin: number;
  private lastScanTime = 0;
  private lastArbTradeTime = 0;
  private lastCryptoArbTime = 0;
  private lastCryptoArbTradeTime = 0;
  private isCryptoArbRunning = false;
  // Shared rate-limit timestamp across scan and crypto-arb paths.
  // Both consume from the same Polymarket order budget (maxTradesPerMin).
  private lastAnyTradeTime = 0;
  private isScanning = false;
  private timer: NodeJS.Timeout | null = null;
  private warmer: ArbMarketWarmer | null = null;

  constructor(options: WorkerOptions = {}) {
    this.baselineIntervalMs = options.baselineIntervalMs ?? 10000; // 10s baseline
    const defaultMax = options.maxTradesPerMin ?? 45; // safety buffer below 60
    this.globalMaxTradesPerMin = defaultMax;
    this.arbMaxTradesPerMin = defaultMax;
    this.cryptoArbMaxTradesPerMin = defaultMax;
  }

  public async start(): Promise<void> {
    const cfg = loadConfig();
    this.globalMaxTradesPerMin = cfg.ARB_GLOBAL_MAX_TRADES_PER_MIN;
    this.arbMaxTradesPerMin = cfg.ARB_MAX_TRADES_PER_MIN;
    this.cryptoArbMaxTradesPerMin = cfg.CRYPTO_ARB_MAX_TRADES_PER_MIN;
    if (!cfg.ARB_ENABLED) {
      logger.info('[arb-worker] arbitrage disabled in config, exiting');
      return;
    }

    logger.info('[crypto-arb] config snapshot', {
      cryptoArbEnabled: cfg.CRYPTO_ARB_ENABLED,
      volatilityGateEnabled: cfg.CRYPTO_ARB_VOLATILITY_GATE_ENABLED,
      minVolatility: cfg.CRYPTO_ARB_MIN_VOLATILITY,
      maxVolatility: cfg.CRYPTO_ARB_MAX_VOLATILITY,
      minEdge: cfg.CRYPTO_ARB_MIN_EDGE,
      maxStakeFraction: cfg.CRYPTO_ARB_MAX_STAKE_FRACTION,
      dedupTtlSec: cfg.CRYPTO_ARB_DEDUP_TTL_S,
      marketCacheTtlSec: cfg.CRYPTO_ARB_MARKET_CACHE_TTL_S,
      confluenceGateEnabled: cfg.CONFLUENCE_GATE_ENABLED,
      minConfluenceScore: cfg.CRYPTO_ARB_MIN_CONFLUENCE_SCORE,
      binanceWsEnabled: cfg.BINANCE_WS_ENABLED,
      binanceSymbols: cfg.BINANCE_SYMBOLS,
      globalMaxTradesPerMin: cfg.ARB_GLOBAL_MAX_TRADES_PER_MIN,
      arbMaxTradesPerMin: cfg.ARB_MAX_TRADES_PER_MIN,
      cryptoArbMaxTradesPerMin: cfg.CRYPTO_ARB_MAX_TRADES_PER_MIN,
    });

    const symbols = cfg.BINANCE_SYMBOLS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const symbolAssets = symbols.map((s) => BINANCE_SYMBOL_TO_ASSET[s]).filter(Boolean);
    const unknownSymbols = symbols.filter((s) => !BINANCE_SYMBOL_TO_ASSET[s]);
    if (unknownSymbols.length > 0) {
      logger.warn('[crypto-arb] unknown Binance symbols configured', { symbols: unknownSymbols });
    }
    if (cfg.CRYPTO_ARB_ENABLED && !cfg.BINANCE_WS_ENABLED) {
      logger.warn('[crypto-arb] crypto arb enabled but Binance WS disabled');
    }
    if (cfg.CRYPTO_ARB_ENABLED && symbolAssets.length === 0) {
      logger.warn('[crypto-arb] crypto arb enabled but no Binance symbols mapped to assets');
    }
    const spotAssets = cfg.SPOT_CRYPTO_ASSETS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const uncoveredAssets = spotAssets.filter((asset) => !symbolAssets.includes(asset));
    if (cfg.CRYPTO_ARB_ENABLED && uncoveredAssets.length > 0) {
      logger.warn('[crypto-arb] spot assets missing Binance feed coverage', { assets: uncoveredAssets });
    }

    // Sync Simmer agent auto-redeem setting at startup
    void setAgentAutoRedeem(cfg.SIMMER_AUTO_REDEEM_ENABLED).catch((err) => {
      logger.warn('[arb-worker] failed to set Simmer auto-redeem — continuing', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    logger.info('[arb-worker] starting long-running worker', {
      baselineIntervalMs: this.baselineIntervalMs,
      globalMaxTradesPerMin: this.globalMaxTradesPerMin,
      arbMaxTradesPerMin: this.arbMaxTradesPerMin,
      cryptoArbMaxTradesPerMin: this.cryptoArbMaxTradesPerMin,
      cryptoArbEnabled: cfg.CRYPTO_ARB_ENABLED,
      simmerAutoRedeem: cfg.SIMMER_AUTO_REDEEM_ENABLED,
    });

    // 0. Start Market Warmer (Pre-discovery WebSocket warmup)
    this.warmer = new ArbMarketWarmer();
    void this.warmer.start().catch((err) => {
      logger.warn('[arb-worker] warmer failed to start (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // 1. Subscribe to real-time price updates
    const subscriber = getSubscriberRedis();
    await subscriber.subscribe('spot:price_moved');

    subscriber.on('message', (channel, message) => {
      if (channel === 'spot:price_moved') {
        let parsed: { symbol?: string; price?: number; timestamp?: number; previousPrice?: number | null };
        try {
          parsed = JSON.parse(message);
        } catch {
          logger.warn('[arb-worker] invalid spot:price_moved payload');
          return;
        }
        logger.debug('[arb-worker] price move detected (Fast-Path)', parsed);
        void recordCryptoArbEvent(getRedis(), 'spot_event').catch(() => {});
        void this.triggerScan('fast-path');

        // Trigger crypto latency arb path (independent of YES+NO arb scan).
        // Moved to async method to allow awaiting previous-price lookup.
        if (parsed.symbol && parsed.price != null) {
          void this.triggerCryptoArbFromTicker(
            String(parsed.symbol),
            parsed.price as number,
            parsed.timestamp as number | undefined,
            parsed.previousPrice ?? null,
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

    // Rate Limit Governor: global budget + per-strategy budget.
    const now = Date.now();
    const globalMinIntervalMs = 60000 / this.globalMaxTradesPerMin;
    const arbMinIntervalMs = 60000 / this.arbMaxTradesPerMin;
    const globalElapsed = now - this.lastAnyTradeTime;
    const arbElapsed = now - Math.max(this.lastScanTime, this.lastArbTradeTime);

    if (globalElapsed < globalMinIntervalMs) {
      logger.debug(`[arb-worker] global governor throttle: ${globalElapsed}ms < ${globalMinIntervalMs.toFixed(0)}ms, skipping`);
      void recordCryptoArbGate(getRedis(), 'global_governor').catch(() => {});
      return;
    }

    if (arbElapsed < arbMinIntervalMs) {
      logger.debug(`[arb-worker] arb governor throttle: ${arbElapsed}ms < ${arbMinIntervalMs.toFixed(0)}ms, skipping`);
      void recordCryptoArbGate(getRedis(), 'arb_governor').catch(() => {});
      return;
    }

    this.isScanning = true;
    this.lastScanTime = now;
    this.lastArbTradeTime = now;
    this.lastAnyTradeTime = now;

    try {
      logger.info(`[arb-worker] scan started (${source})`);
      const redis = getRedis();
      await recordCryptoArbMetric(redis, 'arb_scans').catch(() => {});
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
  private async triggerCryptoArbFromTicker(
    symbol: string,
    currentPrice: number,
    tsMs?: number,
    previousPrice?: number | null,
  ): Promise<void> {
    const assetId = BINANCE_SYMBOL_TO_ASSET[symbol];
    if (!assetId) return;

    // Use previousPrice from pub/sub payload (read BEFORE the write).
    // Fall back to spot:prices sorted set if payload didn't include it.
    let referencePrice = currentPrice;
    if (previousPrice != null && previousPrice > 0) {
      referencePrice = previousPrice;
    } else {
      // Fallback: read second-to-last entry from the sorted set
      const redis = getRedis();
      const entries = await redis.zrange(`spot:prices:${symbol}`, -2, -2).catch(() => []);
      if (entries.length > 0) {
        const colonIdx = entries[0]!.indexOf(':');
        const histPrice = parseFloat(entries[0]!.substring(colonIdx + 1));
        if (isFinite(histPrice) && histPrice > 0) {
          referencePrice = histPrice;
        }
      }
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
    // Concurrency lock: concurrent pub/sub messages could both pass the time check
    // before either updates lastCryptoArbTime. The lock ensures only one scan runs at a time.
    if (this.isCryptoArbRunning) {
      logger.debug('[crypto-arb] scan already in progress, skipping');
      return;
    }
    try {
      const cfg = loadConfig();
      if (!cfg.CRYPTO_ARB_ENABLED) return;

      // Rate-limit governor (global + per-strategy)
      const globalMinIntervalMs = 60000 / this.globalMaxTradesPerMin;
      const cryptoMinIntervalMs = 60000 / this.cryptoArbMaxTradesPerMin;
      const now = Date.now();
      if (now - this.lastAnyTradeTime < globalMinIntervalMs) {
        logger.debug('[crypto-arb] global governor throttle, skipping');
        void recordCryptoArbGate(getRedis(), 'global_governor').catch(() => {});
        return;
      }
      if (now - this.lastCryptoArbTime < cryptoMinIntervalMs) {
        logger.debug('[crypto-arb] per-strategy governor throttle, skipping');
        void recordCryptoArbGate(getRedis(), 'crypto_arb_governor').catch(() => {});
        return;
      }
      this.isCryptoArbRunning = true;
      this.lastCryptoArbTime = now;

      const redis = getRedis();
      await recordCryptoArbMetric(redis, 'crypto_arb_scans').catch(() => {});
      const opportunities = await scanCryptoArb(move, redis);
      if (opportunities.length > 0) {
        await recordCryptoArbMetric(redis, 'opportunities_found').catch(() => {});
      }

      for (const opp of opportunities) {
        // Per-trade rate limit: check shared budget (scan + crypto-arb share one Polymarket quota).
        const tradeNow = Date.now();
        const globalMinIntervalMs = 60000 / this.globalMaxTradesPerMin;
        const cryptoMinIntervalMs = 60000 / this.cryptoArbMaxTradesPerMin;
        if (tradeNow - this.lastAnyTradeTime < globalMinIntervalMs) {
          logger.debug('[crypto-arb] per-trade global governor throttle, skipping remaining opportunities');
          void recordCryptoArbGate(redis, 'global_governor').catch(() => {});
          break;
        }
        if (tradeNow - this.lastCryptoArbTradeTime < cryptoMinIntervalMs) {
          logger.debug('[crypto-arb] per-trade strategy governor throttle, skipping remaining opportunities');
          void recordCryptoArbGate(redis, 'crypto_arb_governor').catch(() => {});
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
            feesEnabled: opp.feesEnabled,
            source: 'crypto-arb',
          };

          // executor.executeSignal handles execution only — it does NOT record the position
          // or deduct the stake. This worker is the single call site for those operations.
          // Do NOT route through execution/index.executeSignals — that path is for OSINT signals
          // and would double-record.
          const result = await executeSignal(signal, redis);

          if (result.tradeResult?.success) {
            // Use result.signal.stakeUsd (calibration-corrected) rather than opp.stakeUsd.
            const executedStake = result.signal.stakeUsd;
            logger.info('[crypto-arb] trade executed', {
              marketId: opp.marketId,
              executionId: result.signal.executionId,
              direction: opp.direction,
              stakeUsd: executedStake,
              edge: opp.edge.toFixed(4),
            });
            await recordCryptoArbMetric(redis, 'trades_executed').catch(() => {});

            // Single record point for this position — executor.ts does not record.
            await recordPosition(redis, {
              marketId: opp.marketId,
              executionId: result.signal.executionId,
              conditionId: opp.conditionId,
              clobTokenIds: opp.clobTokenIds,
              question: opp.question,
              direction: opp.direction,
              entryPrice: opp.currentPmPrice,
              stakeUsd: executedStake,
              consensusProbability: opp.fairValuePrice,
              edgeMagnitude: result.signal.edgeMagnitude ?? opp.edge,
              openedAt: new Date().toISOString(),
              sourcedFrom: `crypto-arb:${opp.assetId}`,
              executionVenue: result.executionVenue ?? 'simmer',
            });

            // Single deduct point — executor.ts does not deduct.
            await deductStake(redis, executedStake);
            // Update per-trade timestamp so the next iteration respects the rate limit.
            this.lastCryptoArbTradeTime = Date.now();
            this.lastAnyTradeTime = this.lastCryptoArbTradeTime;

            // Set dedup key
            const dedupKey = `arb:crypto:${opp.marketId}:${opp.direction}`;
            await redis.set(dedupKey, '1', 'EX', cfg.CRYPTO_ARB_DEDUP_TTL_S);
          } else if (result.skipped) {
            logger.debug('[crypto-arb] signal skipped', {
              marketId: opp.marketId,
              executionId: result.signal.executionId,
              reason: result.skipReason,
            });
            const skipReason = result.skipReason ? `exec_${result.skipReason}` : 'exec_skipped';
            await recordCryptoArbGate(redis, skipReason).catch(() => {});
          } else if (result.error) {
            logger.warn('[crypto-arb] execution error', {
              marketId: opp.marketId,
              executionId: result.signal.executionId,
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
    } finally {
      this.isCryptoArbRunning = false;
    }
  }

  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const subscriber = getSubscriberRedis();
    void subscriber.unsubscribe('spot:price_moved').catch((e: unknown) => {
      logger.debug('[arb-worker] unsubscribe failed (non-fatal)', { error: String(e) });
    });
    if (this.warmer) {
      this.warmer.stop();
      this.warmer = null;
    }
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

const isMain = (process.argv[1]?.endsWith('arb/worker.ts') ?? false) ||
               (process.argv[1]?.endsWith('arb/worker.js') ?? false);
if (isMain) {
  main().catch((err) => {
    logger.error('[arb-worker] fatal error', { error: String(err) });
    process.exit(1);
  });
}
