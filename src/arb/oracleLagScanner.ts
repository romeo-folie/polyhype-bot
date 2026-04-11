/**
 * Oracle-lag scanner (oracle-lag-15m epic, task 004).
 *
 * Consumes Chainlink RTDS BTC prices from `ChainlinkFeed`, polls Gamma for
 * active BTC Up/Down 15m markets, and — on each tick — evaluates whether a
 * fresh oracle move has outrun Polymarket's reprice on the 15m market.
 * When so, it either shadow-logs a candidate or fires a pre-sized CLOB
 * entry via `executeSignal`.
 *
 * Ships dark: `ORACLE_LAG_ENABLED=false` in `.env`. Shadow logs drive
 * task 009/010 calibration before the flag flips.
 *
 * Key invariants:
 *   • `consensusProbability` is stored as P(YES), never fair-value-of-our-side.
 *     See src/arb/cryptoArbScanner.ts comment around line 604 and the Apr 11
 *     BTC Up/Down burn in MEMORY.md (feedback_consensus_pyes_invariant.md).
 *     The evaluator emits P(YES) = 0.5 + (pctMove / 100) regardless of the
 *     side we intend to take.
 *   • Stake is fixed at `ORACLE_LAG_STAKE_USD` — Half-Kelly is skipped
 *     because the edge is timing, not probability.
 *   • Per-market lockout + hourly rate cap reuse `updownThrottle.ts`, the
 *     same path the deprecated confluence Up/Down scanner uses.
 */

import type { Redis } from 'ioredis';

import { loadConfig, type AppConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import {
  acquireLock,
  refreshLock,
  releaseLock,
  reacquireLockAfterExpiry,
} from '../shared/redis.js';
import {
  countRecentUpDownTrades,
  isUpDownMarketLocked,
  lockUpDownMarket,
  recordUpDownTrade,
} from '../shared/updownThrottle.js';
import { discoverUpDownMarketsBySlug, type UpDownMarket } from '../mapping/gamma.js';
import { executeSignal } from '../execution/executor.js';
import { recordPosition } from '../execution/positionLedger.js';
import { deductStake } from '../shared/bankroll.js';
import { priceZoneOf } from '../shared/zones.js';
import type { ChainlinkFeed, ChainlinkMove } from '../spot/feeds/chainlinkFeed.js';
import type { TradeSignal } from '../mapping/index.js';

// ── Public types ────────────────────────────────────────────────────────────

/**
 * Shape of a Chainlink move as passed into the pure evaluator. Matches
 * `ChainlinkMove` from `chainlinkFeed.ts` but with `pctMove` expressed as
 * **percent** (not a fraction). A +8 bps move is `pctMove = 0.08`.
 *
 * The scanner calls `ChainlinkFeed.getMoveSince()` (which returns a fraction)
 * and multiplies by 100 before handing it to `evaluateOracleLagEntry`.
 */
export interface OracleLagMove {
  oldPrice: number;
  newPrice: number;
  /** Signed percent change: `0.08` = +8 bps, `-0.12` = -12 bps. */
  pctMove: number;
  ticks: number;
}

export interface EntryEvaluation {
  shouldEnter: boolean;
  side?: 'UP' | 'DOWN';
  entryPrice?: number;
  /**
   * P(YES) — always expressed from the YES side's point of view, regardless
   * of which side we're actually entering. See the BTC Up/Down comment in
   * `cryptoArbScanner.ts` and MEMORY feedback note.
   */
  consensusProbability?: number;
  blockReason?: OracleLagBlockReason;
  timeLeftMin?: number;
}

/**
 * Block reason priority (first failing rule wins):
 *
 *   1. no_move_data            — feed has <2 qualifying ticks in window
 *   2. move_below_threshold    — |pctMove| < config.minMovePct
 *   3. time_left_below_threshold — market resolves in < config.minTimeLeftMin
 *   4. price_above_threshold   — entry-side book price > config.maxEntryPrice
 *
 * Task 008 unit tests pin this order. Do not reorder.
 */
export type OracleLagBlockReason =
  | 'no_move_data'
  | 'move_below_threshold'
  | 'time_left_below_threshold'
  | 'price_above_threshold';

export interface OracleLagEvalConfig {
  minMovePct: number;
  minTimeLeftMin: number;
  maxEntryPrice: number;
}

// ── Pure entry-rule evaluator ───────────────────────────────────────────────

/**
 * Pure function — no Redis, no executor, no feed. Task 008 unit-tests this
 * directly with synthetic markets and moves.
 *
 * `move.pctMove` is in PERCENT (not fraction): +0.08 = +8 bps.
 *
 * Block reason priority is documented on the `OracleLagBlockReason` type.
 */
export function evaluateOracleLagEntry(
  market: UpDownMarket,
  move: OracleLagMove | null,
  config: OracleLagEvalConfig,
  nowMs: number = Date.now(),
): EntryEvaluation {
  // Rule 1 — feed freshness.
  if (!move) {
    return { shouldEnter: false, blockReason: 'no_move_data' };
  }

  // Rule 2 — move magnitude.
  const moveMagnitudePct = Math.abs(move.pctMove);
  if (moveMagnitudePct < config.minMovePct) {
    return { shouldEnter: false, blockReason: 'move_below_threshold' };
  }

  // Determine side from signed move. Evaluated early so tests can inspect
  // `side` even when a later gate blocks the trade.
  const side: 'UP' | 'DOWN' = move.pctMove > 0 ? 'UP' : 'DOWN';

  // P(YES) — stored-as-P(YES) invariant. For a +8 bps move this is ~0.5008;
  // for a -8 bps move this is ~0.4992. The monitor's divergence logic always
  // reads `consensusProbability` as P(YES), so DOWN entries must NOT store
  // 0.5008 here (the fair-value-of-our-side anti-pattern).
  const consensusProbability = 0.5 + move.pctMove / 100;

  // Rule 3 — minimum time-to-resolution.
  const timeLeftMs = market.endDate.getTime() - nowMs;
  const timeLeftMin = timeLeftMs / 60_000;
  if (timeLeftMin < config.minTimeLeftMin) {
    return {
      shouldEnter: false,
      side,
      timeLeftMin,
      consensusProbability,
      blockReason: 'time_left_below_threshold',
    };
  }

  // Rule 4 — entry-side book price ceiling. For fee markets at ~2% taker,
  // entries above ~0.62 compress expected value below zero even with a solid
  // oracle move, so we gate explicitly.
  const entryPrice =
    side === 'UP' ? market.outcomePrices[0] : market.outcomePrices[1];
  if (entryPrice > config.maxEntryPrice) {
    return {
      shouldEnter: false,
      side,
      entryPrice,
      timeLeftMin,
      consensusProbability,
      blockReason: 'price_above_threshold',
    };
  }

  return {
    shouldEnter: true,
    side,
    entryPrice,
    timeLeftMin,
    consensusProbability,
  };
}

// ── Scanner class ───────────────────────────────────────────────────────────

const LOCK_KEY = 'lock:oracle-lag-scanner';
const LOCK_TTL_S = 60;
const LOCK_REFRESH_MS = 20_000;
const TICK_INTERVAL_MS = 1000;
const MARKET_REFRESH_MS = 30_000;
const DEDUP_PREFIX = 'oracle-lag:dedup:';
const DEDUP_TTL_S = 60;
const CHAINLINK_SYMBOL = 'btc/usd';

export interface OracleLagScannerOptions {
  redis: Redis;
  /** Inject a custom config loader — defaults to `loadConfig()`. */
  loadCfg?: () => AppConfig;
}

export class OracleLagScanner {
  private readonly redis: Redis;
  private readonly loadCfg: () => AppConfig;
  private feed: ChainlinkFeed | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private lockRefreshTimer: NodeJS.Timeout | null = null;
  private lockToken: string | null = null;
  private cachedMarkets: UpDownMarket[] = [];
  private lastMarketRefreshMs = 0;
  private marketRefreshInFlight = false;
  private tickInFlight = false;
  private stopped = false;

  constructor(opts: OracleLagScannerOptions) {
    this.redis = opts.redis;
    this.loadCfg = opts.loadCfg ?? loadConfig;
  }

  /**
   * Begin the scan loop. Expects a pre-started `ChainlinkFeed`.
   * Returns early (no-op) when another instance already holds the Redis lock.
   */
  public async start(feed: ChainlinkFeed): Promise<void> {
    this.feed = feed;
    this.stopped = false;

    const token = await acquireLock(LOCK_KEY, LOCK_TTL_S);
    if (!token) {
      logger.warn('[oracle-lag] another instance holds the lock — scanner disabled', {
        lockKey: LOCK_KEY,
      });
      return;
    }
    this.lockToken = token;

    const cfg = this.loadCfg();
    logger.info('[oracle-lag] scanner started', {
      enabled: cfg.ORACLE_LAG_ENABLED,
      minMovePct: cfg.ORACLE_LAG_MIN_MOVE_PCT,
      moveWindowSec: cfg.ORACLE_LAG_MOVE_WINDOW_SEC,
      minTimeLeftMin: cfg.ORACLE_LAG_MIN_TIME_LEFT_MIN,
      maxEntryPrice: cfg.ORACLE_LAG_MAX_ENTRY_PRICE,
      stakeUsd: cfg.ORACLE_LAG_STAKE_USD,
      maxTradesPerHour: cfg.ORACLE_LAG_MAX_TRADES_PER_HOUR,
    });

    this.lockRefreshTimer = setInterval(() => {
      void this.refreshLockOnce();
    }, LOCK_REFRESH_MS);

    this.tickTimer = setInterval(() => {
      void this.onTick();
    }, TICK_INTERVAL_MS);
  }

  /** Clean shutdown. Release the lock; caller handles `closeRedis()`. */
  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.lockRefreshTimer) {
      clearInterval(this.lockRefreshTimer);
      this.lockRefreshTimer = null;
    }
    if (this.lockToken) {
      try {
        await releaseLock(LOCK_KEY, this.lockToken);
      } catch (err) {
        logger.warn('[oracle-lag] release lock failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.lockToken = null;
    }
    logger.info('[oracle-lag] scanner stopped');
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async refreshLockOnce(): Promise<void> {
    if (this.stopped || !this.lockToken) return;
    try {
      const res = await refreshLock(LOCK_KEY, this.lockToken, LOCK_TTL_S);
      if (res === 'refreshed') return;
      if (res === 'expired') {
        const ok = await reacquireLockAfterExpiry(LOCK_KEY, this.lockToken, LOCK_TTL_S);
        if (ok) {
          logger.warn('[oracle-lag] lock expired and was re-acquired under same token', {
            lockKey: LOCK_KEY,
          });
          return;
        }
        logger.error('[oracle-lag] lock expired and reacquire failed — another instance grabbed it', {
          lockKey: LOCK_KEY,
        });
        await this.stop();
        return;
      }
      // 'stolen' — another instance sneaked in. Abort.
      logger.error('[oracle-lag] lock stolen by another instance — scanner stopping', {
        lockKey: LOCK_KEY,
      });
      this.lockToken = null;
      await this.stop();
    } catch (err) {
      logger.warn('[oracle-lag] lock refresh threw (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async refreshMarketsIfStale(): Promise<void> {
    if (this.marketRefreshInFlight) return;
    const now = Date.now();
    if (now - this.lastMarketRefreshMs < MARKET_REFRESH_MS) {
      return;
    }
    // Stamp the refresh time BEFORE the fetch so that failures and empty
    // results still back off to the 30s cadence — otherwise an empty cache
    // would retry every 1s tick and hammer Gamma.
    this.lastMarketRefreshMs = now;
    this.marketRefreshInFlight = true;
    try {
      // Slug-based discovery: Gamma's `/events?tag=crypto` endpoint orders by
      // startDate only, and Up/Down markets are listed ~24h before resolution,
      // so the about-to-resolve window sits >500 entries deep (past Gamma's
      // response cap). We predict the deterministic slugs instead — current
      // window + 2 future windows — and fetch them directly.
      const markets = await discoverUpDownMarketsBySlug({
        asset: 'bitcoin',
        lifetime: '15m',
        windowsAhead: 2,
      });
      this.cachedMarkets = markets;
      logger.debug('[oracle-lag] market refresh', { count: markets.length });
    } catch (err) {
      logger.warn('[oracle-lag] market refresh failed — keeping stale cache', {
        error: err instanceof Error ? err.message : String(err),
        cachedCount: this.cachedMarkets.length,
      });
    } finally {
      this.marketRefreshInFlight = false;
    }
  }

  private async onTick(): Promise<void> {
    if (this.stopped || !this.feed || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      await this.refreshMarketsIfStale();
      if (this.cachedMarkets.length === 0) return;

      const cfg = this.loadCfg();
      const evalConfig: OracleLagEvalConfig = {
        minMovePct: cfg.ORACLE_LAG_MIN_MOVE_PCT,
        minTimeLeftMin: cfg.ORACLE_LAG_MIN_TIME_LEFT_MIN,
        maxEntryPrice: cfg.ORACLE_LAG_MAX_ENTRY_PRICE,
      };

      const rawMove = this.feed.getMoveSince(
        CHAINLINK_SYMBOL,
        cfg.ORACLE_LAG_MOVE_WINDOW_SEC * 1000,
      );
      const move = rawMove ? this.toPercentMove(rawMove) : null;

      for (const market of this.cachedMarkets) {
        await this.evaluateMarket(market, move, cfg, evalConfig);
      }
    } catch (err) {
      logger.warn('[oracle-lag] tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.tickInFlight = false;
    }
  }

  /** Convert `ChainlinkMove.pctMove` (fraction) → percent-shaped `OracleLagMove`. */
  private toPercentMove(raw: ChainlinkMove): OracleLagMove {
    return {
      oldPrice: raw.oldPrice,
      newPrice: raw.newPrice,
      pctMove: raw.pctMove * 100,
      ticks: raw.ticks,
    };
  }

  private async evaluateMarket(
    market: UpDownMarket,
    move: OracleLagMove | null,
    cfg: AppConfig,
    evalConfig: OracleLagEvalConfig,
  ): Promise<void> {
    const evaluation = evaluateOracleLagEntry(market, move, evalConfig);

    // Runtime gates (Redis state) — evaluated AFTER the pure rules so the
    // shadow log still sees candidate-level data. Block reason reported is
    // the first of: pure-rule block, market_locked, rate_cap.
    let runtimeBlockReason: string | undefined;
    let rateCapHit = false;
    let marketLocked = false;

    if (evaluation.shouldEnter) {
      marketLocked = await isUpDownMarketLocked(this.redis, market.marketId);
      if (marketLocked) {
        runtimeBlockReason = 'market_locked';
      } else {
        const recentCount = await countRecentUpDownTrades(this.redis);
        if (recentCount >= cfg.ORACLE_LAG_MAX_TRADES_PER_HOUR) {
          rateCapHit = true;
          runtimeBlockReason = 'rate_cap_reached';
        }
      }
    }

    const blockReason = evaluation.blockReason ?? runtimeBlockReason;
    const blocked = !evaluation.shouldEnter || !!runtimeBlockReason;
    // `wouldTrade` reflects "passed all gates" regardless of whether the
    // ORACLE_LAG_ENABLED flag is set. Task 010's shadow analysis counts
    // wouldTrade=true events to measure expected fire rate — so we must
    // compute it as if the flag were on. The flag itself is logged as
    // `enabled` and gates the actual fire() below.
    const wouldTrade = !blocked;

    // Shadow log — always emitted (task 009/010 parse these).
    logger.info('[oracle-lag] shadow candidate', {
      marketId: market.marketId,
      slug: market.slug,
      movePct: move ? +move.pctMove.toFixed(4) : null,
      oldPrice: move ? +move.oldPrice.toFixed(2) : null,
      newPrice: move ? +move.newPrice.toFixed(2) : null,
      entrySide: evaluation.side,
      entryPrice:
        evaluation.entryPrice !== undefined ? +evaluation.entryPrice.toFixed(4) : null,
      timeLeftMin:
        evaluation.timeLeftMin !== undefined ? +evaluation.timeLeftMin.toFixed(2) : null,
      consensusProbability:
        evaluation.consensusProbability !== undefined
          ? +evaluation.consensusProbability.toFixed(6)
          : null,
      wouldTrade,
      blockReason,
      enabled: cfg.ORACLE_LAG_ENABLED,
    });

    if (!wouldTrade) return;
    // Shadow mode — logged but never fires until ORACLE_LAG_ENABLED flips.
    if (!cfg.ORACLE_LAG_ENABLED) return;
    if (
      !evaluation.side ||
      evaluation.entryPrice === undefined ||
      evaluation.consensusProbability === undefined ||
      move === null
    ) {
      return;
    }
    // Explicitly short-circuit the shadow branch — belt-and-braces with the
    // `blocked` check above (rate cap / lockout were already handled).
    if (marketLocked || rateCapHit) return;

    await this.fire(market, move, evaluation, cfg);
  }

  private async fire(
    market: UpDownMarket,
    move: OracleLagMove,
    evaluation: EntryEvaluation,
    cfg: AppConfig,
  ): Promise<void> {
    if (
      !evaluation.side ||
      evaluation.entryPrice === undefined ||
      evaluation.consensusProbability === undefined
    ) {
      return;
    }

    // Per-market + side dedup. The executor also runs its own idempotency key
    // keyed on stakeUsd, but we dedup upstream to avoid racing multiple ticks
    // while a single fire is in flight.
    const dedupKey = `${DEDUP_PREFIX}${market.marketId}:${evaluation.side}`;
    const claimed = await this.redis.set(dedupKey, '1', 'EX', DEDUP_TTL_S, 'NX');
    if (claimed !== 'OK') {
      logger.debug('[oracle-lag] dedup skip', {
        marketId: market.marketId,
        side: evaluation.side,
      });
      return;
    }

    const direction = evaluation.side; // 'UP' | 'DOWN'
    const tokenId =
      direction === 'UP' ? market.yesTokenId : market.noTokenId;
    const entryPrice = evaluation.entryPrice;

    const signal: TradeSignal = {
      marketId: market.marketId,
      clobTokenIds: [market.yesTokenId, market.noTokenId],
      question: market.question,
      direction,
      stakeUsd: cfg.ORACLE_LAG_STAKE_USD,
      // Edge is timing, not probability — we report the absolute move as a
      // coarse edge proxy so telemetry still has something to bucket on.
      edgeMagnitude: Math.abs(move.pctMove) / 100,
      consensusProbability: evaluation.consensusProbability,
      outcomePrice: entryPrice,
      priceZone: priceZoneOf(entryPrice),
      sourcedFrom: `oracle-lag:btc:${move.pctMove.toFixed(3)}pct:${cfg.ORACLE_LAG_MOVE_WINDOW_SEC}s`,
      reasoning: `Chainlink BTC oracle move ${move.pctMove.toFixed(3)}% over ${cfg.ORACLE_LAG_MOVE_WINDOW_SEC}s — ${market.slug} reprice lag expected`,
      source: 'oracle-lag',
      assetId: 'bitcoin',
      endDate: market.endDate.toISOString(),
    };

    try {
      const result = await executeSignal(signal, this.redis);

      if (result.tradeResult?.success) {
        // Use result.signal for post-execution state — the executor reassigns
        // internally (bumping the stake, stamping executionId). This is the
        // documented footgun from CLAUDE.md lessons learned.
        const executedStake = result.signal.stakeUsd;
        const executedEntryPrice = result.entryPrice ?? entryPrice;

        logger.info('[oracle-lag] entry', {
          marketId: market.marketId,
          slug: market.slug,
          executionId: result.signal.executionId,
          direction,
          stakeUsd: executedStake,
          entryPrice: executedEntryPrice,
          movePct: +move.pctMove.toFixed(4),
          venue: result.executionVenue,
        });

        try {
          await recordPosition(this.redis, {
            marketId: market.marketId,
            executionId: result.signal.executionId,
            clobTokenIds: [market.yesTokenId, market.noTokenId],
            question: market.question,
            direction,
            entryPrice: executedEntryPrice,
            stakeUsd: executedStake,
            consensusProbability: evaluation.consensusProbability,
            edgeMagnitude: result.signal.edgeMagnitude ?? signal.edgeMagnitude,
            openedAt: new Date().toISOString(),
            sourcedFrom: signal.sourcedFrom,
            executionVenue: result.executionVenue ?? 'clob',
            assetId: 'bitcoin',
            endDate: market.endDate.toISOString(),
            priceZone: result.signal.priceZone,
          });
        } catch (err) {
          logger.warn('[oracle-lag] recordPosition failed (non-fatal)', {
            marketId: market.marketId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        try {
          await deductStake(this.redis, executedStake);
        } catch (err) {
          logger.warn('[oracle-lag] deductStake failed (non-fatal)', {
            marketId: market.marketId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Reuse the Up/Down throttle store — single source of truth for
        // per-market lockout + hourly rate cap on binary BTC markets.
        await lockUpDownMarket(
          this.redis,
          market.marketId,
          market.endDate.toISOString(),
        );
        await recordUpDownTrade(this.redis, market.marketId, direction);

        // The tokenId is embedded in the CLOB signal via clobTokenIds; log it
        // explicitly so the trail includes the exact token we tried to buy.
        logger.debug('[oracle-lag] entry token resolved', {
          marketId: market.marketId,
          direction,
          tokenId,
        });
      } else if (result.skipped) {
        logger.debug('[oracle-lag] executor skipped', {
          marketId: market.marketId,
          reason: result.skipReason,
        });
        // Release the dedup key so a later tick can retry (e.g. transient
        // global-governor skip).
        await this.redis.del(dedupKey).catch(() => {});
      } else if (result.error) {
        logger.warn('[oracle-lag] executor error', {
          marketId: market.marketId,
          error: result.error,
        });
        await this.redis.del(dedupKey).catch(() => {});
      }
    } catch (err) {
      logger.error('[oracle-lag] fire threw', {
        marketId: market.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.redis.del(dedupKey).catch(() => {});
    }
  }
}
