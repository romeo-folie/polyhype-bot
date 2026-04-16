import { getRedis, getSubscriberRedis, closeRedis } from '../shared/redis.js';
import { logger } from '../shared/logger.js';
import { runArbScan } from './scanner.js';
import { runNegRiskArbScan } from './negRiskScanner.js';
import { loadConfig } from '../shared/config.js';
import { scanCryptoArb, scanUpDownArb } from './cryptoArbScanner.js';
import { BINANCE_SYMBOL_TO_ASSET } from '../shared/assets.js';
import { executeAndRecordSignal } from '../execution/executor.js';
import { priceZoneOf } from '../shared/zones.js';
import { setAgentAutoRedeem } from '../shared/simmer.js';
import { checkGlobalGovernor, recordGlobalTrade } from '../shared/governor.js';
import {
  countRecentUpDownTrades,
  isUpDownMarketLocked,
  lockUpDownMarket,
  recordUpDownTrade,
} from '../shared/updownThrottle.js';
import {
  recordCryptoArbGate,
  recordCryptoArbEvent,
  recordCryptoArbMetric,
} from '../shared/telemetry.js';
import { ArbMarketWarmer } from './warmer.js';
import { OracleLagScanner } from './oracleLagScanner.js';
import { OracleLagExitMonitor } from './oracleLagExitMonitor.js';
import { ChainlinkFeed } from '../spot/feeds/chainlinkFeed.js';
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
  private isScanning = false;
  private isCryptoArbRunning = false;
  private isNegRiskArbRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private negRiskTimer: NodeJS.Timeout | null = null;
  private negRiskScanIntervalMs = 30000;
  private warmer: ArbMarketWarmer | null = null;
  private chainlinkFeed: ChainlinkFeed | null = null;
  private oracleLagScanner: OracleLagScanner | null = null;
  private oracleLagExitMonitor: OracleLagExitMonitor | null = null;

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
    this.negRiskScanIntervalMs = cfg.NEGRISK_ARB_SCAN_INTERVAL_MS;
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

    const symbols = cfg.BINANCE_SYMBOLS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
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
    const spotAssets = cfg.SPOT_CRYPTO_ASSETS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const uncoveredAssets = spotAssets.filter((asset) => !symbolAssets.includes(asset));
    if (cfg.CRYPTO_ARB_ENABLED && uncoveredAssets.length > 0) {
      logger.warn('[crypto-arb] spot assets missing Binance feed coverage', {
        assets: uncoveredAssets,
      });
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

    // 0b. Start Chainlink feed + oracle-lag scanner (oracle-lag-15m epic).
    // The scanner manages its own Redis lock (`lock:oracle-lag-scanner`) via
    // the tri-state refreshLock pattern — worker.ts does not own it. On
    // SIGTERM we await scanner.stop() before closing Redis so the scanner
    // can release its lock.
    try {
      this.chainlinkFeed = new ChainlinkFeed({ symbols: ['btc/usd'] });
      this.chainlinkFeed.start();
      this.oracleLagScanner = new OracleLagScanner({ redis: getRedis() });
      await this.oracleLagScanner.start(this.chainlinkFeed);
    } catch (err) {
      logger.warn('[arb-worker] oracle-lag scanner failed to start (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 0c. Start oracle-lag exit monitor. Shares ChainlinkFeed with the scanner
    // (one WS, two consumers). Holds its own Redis lock
    // (`lock:oracle-lag-exit-monitor`) so only one monitor runs across
    // containers, independent of the scanner's lock.
    if (this.chainlinkFeed) {
      try {
        this.oracleLagExitMonitor = new OracleLagExitMonitor({
          redis: getRedis(),
          chainlinkFeed: this.chainlinkFeed,
        });
        await this.oracleLagExitMonitor.start();
      } catch (err) {
        logger.warn('[arb-worker] oracle-lag exit monitor failed to start (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 1. Subscribe to real-time price updates
    const subscriber = getSubscriberRedis();
    await subscriber.subscribe('spot:price_moved');

    subscriber.on('message', (channel, message) => {
      if (channel === 'spot:price_moved') {
        let parsed: {
          symbol?: string;
          price?: number;
          timestamp?: number;
          previousPrice?: number | null;
        };
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
        if (parsed.symbol && parsed.price != null) {
          void this.triggerCryptoArbFromTicker(
            String(parsed.symbol),
            parsed.price,
            parsed.timestamp,
            parsed.previousPrice ?? null,
          );
        }
      }
    });

    // 2. Start baseline polling loop
    this.scheduleBaseline();

    // 3. Start NegRisk multi-outcome arb scan (separate slower cadence)
    this.scheduleNegRiskScan();
    logger.info('[arb-worker] NegRisk arb scanner scheduled', {
      intervalMs: this.negRiskScanIntervalMs,
      enabled: cfg.NEGRISK_ARB_ENABLED,
    });
  }

  private scheduleBaseline(): void {
    this.timer = setTimeout(async () => {
      await this.triggerScan('baseline');
      this.scheduleBaseline();
    }, this.baselineIntervalMs);
  }

  private scheduleNegRiskScan(): void {
    this.negRiskTimer = setTimeout(async () => {
      if (!this.isNegRiskArbRunning) {
        this.isNegRiskArbRunning = true;
        try {
          await runNegRiskArbScan(getRedis());
        } catch (err) {
          logger.error('[negrisk-arb] scan failed in worker', {
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          this.isNegRiskArbRunning = false;
        }
      }
      this.scheduleNegRiskScan();
    }, this.negRiskScanIntervalMs);
  }

  /**
   * Trigger a scan, respecting the rate-limit governor and concurrency locks.
   */
  private async triggerScan(source: 'fast-path' | 'baseline'): Promise<void> {
    if (this.isScanning) {
      logger.debug(`[arb-worker] scan already in progress, skipping ${source} trigger`);
      return;
    }

    const redis = getRedis();
    const gov = await checkGlobalGovernor(redis, 'polymarket');
    if (!gov.ok) {
      logger.debug(
        `[arb-worker] global governor throttle: ${gov.elapsedMs}ms < ${gov.minIntervalMs.toFixed(0)}ms, skipping`,
      );
      void recordCryptoArbGate(redis, 'global_governor').catch(() => {});
      return;
    }

    const now = Date.now();
    const arbMinIntervalMs = 60000 / this.arbMaxTradesPerMin;
    const arbElapsed = now - Math.max(this.lastScanTime, this.lastArbTradeTime);
    if (arbElapsed < arbMinIntervalMs) {
      logger.debug(
        `[arb-worker] arb governor throttle: ${arbElapsed}ms < ${arbMinIntervalMs.toFixed(0)}ms, skipping`,
      );
      void recordCryptoArbGate(redis, 'arb_governor').catch(() => {});
      return;
    }

    this.isScanning = true;
    this.lastScanTime = now;
    this.lastArbTradeTime = now;

    // Intentionally do NOT call recordGlobalTrade() here. The key is named
    // last_trade_at — a scan start is not a trade. Previous behaviour bumped
    // the shared governor on every Binance-tick-triggered scan, starving
    // mapping/copytrade/monitor-exit of the 45-trades/min budget even on
    // ticks that produced zero orders. Pure-arb trades now record inside
    // executeArb() after a CLOB leg is actually filled; crypto-arb records
    // inside the per-opportunity loop below.

    try {
      logger.info(`[arb-worker] scan started (${source})`);
      await recordCryptoArbMetric(redis, 'arb_scans').catch(() => {});
      await runArbScan(redis);
    } catch (err) {
      logger.error('[arb-worker] scan failed', { error: String(err) });
    } finally {
      this.isScanning = false;
      logger.debug(`[arb-worker] scan finished (${source})`);
    }
  }

  private async triggerCryptoArbFromTicker(
    symbol: string,
    currentPrice: number,
    tsMs?: number,
    previousPrice?: number | null,
  ): Promise<void> {
    const assetId = BINANCE_SYMBOL_TO_ASSET[symbol];
    if (!assetId) return;

    let referencePrice = currentPrice;
    if (previousPrice != null && previousPrice > 0) {
      referencePrice = previousPrice;
    } else {
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

    const changePercent =
      referencePrice > 0 && referencePrice !== currentPrice
        ? ((currentPrice - referencePrice) / referencePrice) * 100
        : 0;

    return this.triggerCryptoArb({
      assetId,
      currentPrice,
      referencePrice,
      changePercent,
      windowMinutes: 0,
      detectedAt: new Date(tsMs ?? Date.now()).toISOString(),
      eventTs: tsMs ?? Date.now(),
    });
  }

  private async triggerCryptoArb(move: SpotMove): Promise<void> {
    if (this.isCryptoArbRunning) {
      logger.debug('[crypto-arb] scan already in progress, skipping');
      return;
    }

    const redis = getRedis();
    try {
      const cfg = loadConfig();
      if (!cfg.CRYPTO_ARB_ENABLED) return;

      const gov = await checkGlobalGovernor(redis, 'polymarket');
      if (!gov.ok) {
        logger.debug('[crypto-arb] global governor throttle, skipping');
        void recordCryptoArbGate(redis, 'global_governor').catch(() => {});
        return;
      }

      const now = Date.now();
      const cryptoMinIntervalMs = 60000 / this.cryptoArbMaxTradesPerMin;
      if (now - this.lastCryptoArbTime < cryptoMinIntervalMs) {
        logger.debug('[crypto-arb] per-strategy governor throttle, skipping');
        void recordCryptoArbGate(redis, 'crypto_arb_governor').catch(() => {});
        return;
      }

      this.isCryptoArbRunning = true;
      this.lastCryptoArbTime = now;

      await recordCryptoArbMetric(redis, 'crypto_arb_scans').catch(() => {});
      const cryptoOpportunities = await scanCryptoArb(move, redis);

      // Scan Up/Down Bitcoin markets (independent of price-target arb)
      let upDownOpps: typeof cryptoOpportunities = [];
      try {
        upDownOpps = await scanUpDownArb(move, redis);
      } catch (err) {
        logger.warn('[crypto-arb] Up/Down scan failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const opportunities = [...cryptoOpportunities, ...upDownOpps];
      if (opportunities.length > 0) {
        await recordCryptoArbMetric(redis, 'opportunities_found').catch(() => {});
      }

      for (const opp of opportunities) {
        const tradeGov = await checkGlobalGovernor(redis, 'polymarket');
        if (!tradeGov.ok) {
          logger.debug(
            '[crypto-arb] per-trade global governor throttle, skipping remaining opportunities',
          );
          void recordCryptoArbGate(redis, 'global_governor').catch(() => {});
          break;
        }

        const tradeNow = Date.now();
        if (tradeNow - this.lastCryptoArbTradeTime < cryptoMinIntervalMs) {
          logger.debug(
            '[crypto-arb] per-trade strategy governor throttle, skipping remaining opportunities',
          );
          void recordCryptoArbGate(redis, 'crypto_arb_governor').catch(() => {});
          break;
        }

        // Per-opp Up/Down rate-cap re-check — defends against one scan
        // returning multiple Up/Down opps (5-min + 15-min variants) that
        // collectively exceed the hourly cap.
        const isUpDown = opp.direction === 'UP' || opp.direction === 'DOWN';
        if (isUpDown) {
          const recent = await countRecentUpDownTrades(redis);
          if (recent >= cfg.UPDOWN_MAX_TRADES_PER_HOUR) {
            logger.debug('[crypto-arb] updown rate cap reached (pre-exec)', {
              marketId: opp.marketId,
              recent,
              cap: cfg.UPDOWN_MAX_TRADES_PER_HOUR,
            });
            void recordCryptoArbGate(redis, 'updown_rate_cap').catch(() => {});
            continue;
          }
          // Per-market lockout re-check — the scanner already filters, but a
          // single scan can return multiple opps on the same market and the
          // lock from the first one only lands after successful execution.
          // We pessimistically lock locally so the second opp in the same
          // scan short-circuits.
          if (await isUpDownMarketLocked(redis, opp.marketId)) {
            logger.debug('[crypto-arb] updown market locked (pre-exec)', {
              marketId: opp.marketId,
            });
            void recordCryptoArbGate(redis, 'updown_market_locked').catch(() => {});
            continue;
          }
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
            priceZone: priceZoneOf(opp.currentPmPrice),
            sourcedFrom: `crypto-arb:${opp.assetId}`,
            reasoning: `Crypto latency arb: fair=${opp.fairValuePrice.toFixed(3)}, pm=${opp.currentPmPrice.toFixed(3)}, edge=${opp.edge.toFixed(3)}`,
            feesEnabled: opp.feesEnabled,
            source: 'crypto-arb',
            assetId: opp.assetId,
            eventTs: move.eventTs,
            // endDate usually doesn't apply to HL symbols, but for clarity:
          };

          // executeAndRecordSignal handles deductStake + recordPosition on success.
          const result = await executeAndRecordSignal(signal, redis);

          if (result.tradeResult?.success) {
            const executedStake = result.signal.stakeUsd;
            logger.info('[crypto-arb] trade executed', {
              marketId: opp.marketId,
              executionId: result.signal.executionId,
              direction: opp.direction,
              stakeUsd: executedStake,
              edge: opp.edge.toFixed(4),
            });
            await recordCryptoArbMetric(redis, 'trades_executed').catch(() => {});

            this.lastCryptoArbTradeTime = Date.now();
            await recordGlobalTrade(redis, 'polymarket');

            const dedupKey = `arb:crypto:${opp.marketId}:${opp.direction}`;
            await redis.set(dedupKey, '1', 'EX', cfg.CRYPTO_ARB_DEDUP_TTL_S);

            if (isUpDown) {
              await recordUpDownTrade(
                redis,
                opp.marketId,
                opp.direction as 'UP' | 'DOWN',
              );
              await lockUpDownMarket(redis, opp.marketId, opp.endDate ?? null);
            }
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
    if (this.negRiskTimer) {
      clearTimeout(this.negRiskTimer);
      this.negRiskTimer = null;
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

  /**
   * Async shutdown for components that must release external resources
   * (Redis locks, WebSockets) before the process exits. Called from
   * `main()`'s SIGTERM handler BEFORE `closeRedis()` so the oracle-lag
   * scanner can release its own `lock:oracle-lag-scanner` key while the
   * connection is still open. Kept separate from `stop()` so tests that
   * call `stop()` synchronously are unaffected.
   */
  public async stopAsyncDeps(): Promise<void> {
    // Tear down exit monitor first so it releases its own lock before the
    // scanner (which shares the same ChainlinkFeed) goes down.
    if (this.oracleLagExitMonitor) {
      try {
        await this.oracleLagExitMonitor.stop();
      } catch (err) {
        logger.warn('[arb-worker] oracle-lag exit monitor stop failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.oracleLagExitMonitor = null;
    }
    // Tear down oracle-lag scanner so it releases its own Redis lock
    // before the caller closes the connection.
    if (this.oracleLagScanner) {
      try {
        await this.oracleLagScanner.stop();
      } catch (err) {
        logger.warn('[arb-worker] oracle-lag scanner stop failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.oracleLagScanner = null;
    }
    if (this.chainlinkFeed) {
      try {
        this.chainlinkFeed.stop();
      } catch (err) {
        logger.warn('[arb-worker] chainlink feed stop failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.chainlinkFeed = null;
    }
  }
}

async function main() {
  const worker = new ArbitrageWorker();
  const shutdown = async () => {
    logger.info('[arb-worker] shutting down...');
    // Order matters:
    //   1. stopAsyncDeps() — oracle-lag scanner releases `lock:oracle-lag-scanner`
    //      and the Chainlink WS shuts down while Redis is still open.
    //   2. stop() — sync teardown of timers, warmer, pub/sub subscriber.
    //   3. closeRedis() — close connections after every lock-holder has
    //      released.
    //   4. process.exit(0) — only the worker entrypoint calls exit.
    try {
      await worker.stopAsyncDeps();
    } catch (err) {
      logger.warn('[arb-worker] stopAsyncDeps threw (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      worker.stop();
    } catch (err) {
      logger.warn('[arb-worker] worker.stop() threw (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await closeRedis();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  await worker.start();
}

const isMain =
  (process.argv[1]?.endsWith('arb/worker.ts') ?? false) ||
  (process.argv[1]?.endsWith('arb/worker.js') ?? false);
if (isMain) {
  main().catch((err) => {
    logger.error('[arb-worker] fatal error', { error: String(err) });
    process.exit(1);
  });
}
