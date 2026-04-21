/**
 * Oracle-Lag gap-compression exit monitor.
 *
 * Colocated with `OracleLagScanner` in the arb worker so both share the same
 * ChainlinkFeed WebSocket — no pub/sub, no new feed plumbing. On each tick the
 * monitor:
 *
 *   1. Scans `oracle-lag:exit-state:*` for positions the scanner has stamped.
 *   2. For each, reads current PM YES price (WS cache → Gamma REST fallback)
 *      and the latest Chainlink tick.
 *   3. Evaluates trigger priority via the pure `evaluateOracleLagExit`:
 *        reversal > near_resolution > compression > timeout.
 *   4. If live (`ORACLE_LAG_EXIT_ENABLED=true`): calls `executeTakeProfit`.
 *      If shadow: writes one `shadow_observations` row per position.
 *   5. Always DELs the exit-state key after any trigger so we record one
 *      decision per position, not a stream.
 *
 * Flag semantics (important):
 *   • `ORACLE_LAG_EXIT_ENABLED=false` — monitor runs, shadow-logs the first
 *     trigger per position, does NOT close positions. Inherited TP/SL/stale
 *     continue to decide exits. The goal is a paired dataset to compare
 *     early-exit returns vs hold-to-resolution returns.
 *   • `ORACLE_LAG_EXIT_ENABLED=true` — monitor fires executeTakeProfit on
 *     first trigger.
 *
 * Ships dark — flip only after shadow review proves early-exit beats the
 * inherited path on return.
 */

import { hostname } from 'node:os';
import type { Redis } from 'ioredis';

import { loadConfig, type AppConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { refreshLock, reacquireLockAfterExpiry } from '../shared/redis.js';
import { getPosition, type Position } from '../execution/positionLedger.js';
import { fetchCurrentPrice } from '../monitor/priceFetcher.js';
import { executeTakeProfit } from '../monitor/takeProfitExecutor.js';
import type { ChainlinkFeed } from '../spot/feeds/chainlinkFeed.js';

// ── Exit-state hash (written by scanner, read by monitor) ───────────────────

const EXIT_STATE_PREFIX = 'oracle-lag:exit-state:';
const EXIT_STATE_TTL_SEC = 30 * 60; // generously larger than MAX_HOLD_SEC
const SCANNER_VERSION = 'oracle-lag-v1';

export function oracleLagExitStateKey(
  marketId: string,
  direction: 'UP' | 'DOWN',
): string {
  return `${EXIT_STATE_PREFIX}${marketId}:${direction}`;
}

export interface OracleLagExitStateWrite {
  marketId: string;
  direction: 'UP' | 'DOWN';
  /** Chainlink RTDS symbol for this asset (e.g. 'btc/usd', 'eth/usd'). */
  chainlinkSymbol: string;
  /** PM YES-side price at entry (always YES, not the side we bought). */
  entryPmYesPrice: number;
  /** PM NO-side price at entry (stored so DOWN returnPct is exact). */
  entryPmNoPrice: number;
  /** Chainlink mid at entry for this asset. */
  entryChainlinkPrice: number;
  /** Triggering scanner move, in percent (e.g. +0.08 for +8 bps). */
  entryChainlinkMovePct: number;
  /** Wall-clock entry timestamp in ms. */
  entryTsMs: number;
  /** Market resolution timestamp in ms — drives the near-resolution exit trigger. */
  endDateMs: number;
}

/**
 * Called by `oracleLagScanner.fire()` after `recordPosition` succeeds. Writes
 * the exit-state hash + TTL in a single pipeline. Clamps `entryFairPyes` into
 * [0.02, 0.98] as a belt-and-suspenders (scanner's RELEVANCE check already
 * precludes entries at extreme bounds).
 */
export async function writeOracleLagExitState(
  redis: Redis,
  input: OracleLagExitStateWrite,
): Promise<void> {
  const entryFairPyes = Math.max(
    0.02,
    Math.min(0.98, 0.5 + input.entryChainlinkMovePct / 100),
  );
  const key = oracleLagExitStateKey(input.marketId, input.direction);
  await redis
    .multi()
    .hset(key, {
      chainlinkSymbol: input.chainlinkSymbol,
      entryPmYesPrice: input.entryPmYesPrice.toFixed(6),
      entryPmNoPrice: input.entryPmNoPrice.toFixed(6),
      entryChainlinkPrice: input.entryChainlinkPrice.toFixed(4),
      entryChainlinkMovePct: input.entryChainlinkMovePct.toFixed(6),
      entryFairPyes: entryFairPyes.toFixed(6),
      direction: input.direction,
      entryTs: String(input.entryTsMs),
      endDateMs: String(input.endDateMs),
      scannerVersion: SCANNER_VERSION,
    })
    .expire(key, EXIT_STATE_TTL_SEC)
    .exec();
}

export interface OracleLagExitState {
  marketId: string;
  direction: 'UP' | 'DOWN';
  /** Chainlink RTDS symbol for this asset. Falls back to 'btc/usd' for states written before this field was added. */
  chainlinkSymbol: string;
  entryPmYesPrice: number;
  entryPmNoPrice: number;
  entryChainlinkPrice: number;
  entryChainlinkMovePct: number;
  entryFairPyes: number;
  entryTsMs: number;
  /** Market resolution timestamp in ms. 0 for legacy states written before this field was added (near-res trigger won't fire). */
  endDateMs: number;
  scannerVersion: string;
}

export async function readOracleLagExitState(
  redis: Redis,
  marketId: string,
  direction: 'UP' | 'DOWN',
): Promise<OracleLagExitState | null> {
  const key = oracleLagExitStateKey(marketId, direction);
  const raw = await redis.hgetall(key);
  if (!raw.direction) return null;
  const entryTsMs = Number(raw.entryTs ?? '0');
  const entryPmYesPrice = Number(raw.entryPmYesPrice ?? '0');
  const entryPmNoPrice = Number(raw.entryPmNoPrice ?? '0');
  const entryChainlinkPrice = Number(raw.entryChainlinkPrice ?? '0');
  const entryChainlinkMovePct = Number(raw.entryChainlinkMovePct ?? '0');
  const entryFairPyes = Number(raw.entryFairPyes ?? '0.5');
  // endDateMs defaults to 0 for legacy states — near-res trigger simply won't
  // fire when timeLeftMin is deeply negative.
  const endDateMs = Number(raw.endDateMs ?? '0');
  if (
    !Number.isFinite(entryTsMs) ||
    !Number.isFinite(entryPmYesPrice) ||
    !Number.isFinite(entryPmNoPrice) ||
    !Number.isFinite(entryChainlinkPrice) ||
    entryChainlinkPrice <= 0 ||
    !Number.isFinite(entryChainlinkMovePct) ||
    !Number.isFinite(entryFairPyes)
  ) {
    // Corrupt or partially-written hash — DEL so future ticks are a no-op.
    await redis.del(key).catch(() => {});
    return null;
  }
  return {
    marketId,
    direction: raw.direction === 'DOWN' ? 'DOWN' : 'UP',
    chainlinkSymbol: raw.chainlinkSymbol ?? 'btc/usd',
    entryPmYesPrice,
    entryPmNoPrice,
    entryChainlinkPrice,
    entryChainlinkMovePct,
    entryFairPyes,
    entryTsMs,
    endDateMs,
    scannerVersion: raw.scannerVersion ?? SCANNER_VERSION,
  };
}

export async function clearOracleLagExitState(
  redis: Redis,
  marketId: string,
  direction: 'UP' | 'DOWN',
): Promise<void> {
  await redis.del(oracleLagExitStateKey(marketId, direction));
}

// ── Pure evaluator ──────────────────────────────────────────────────────────

export type OracleLagExitTrigger =
  | 'oracle_lag_compressed'
  | 'oracle_lag_reversed'
  | 'oracle_lag_timeout'
  | 'oracle_lag_near_resolution';

export interface OracleLagExitDecision {
  trigger: OracleLagExitTrigger;
  compressionPct: number;
  reversalBps: number;
  ageSec: number;
  /** Realized return on the side we bought, in percent. */
  returnPct: number;
}

export interface OracleLagExitEvalInput {
  state: OracleLagExitState;
  currentYesPrice: number;
  currentNoPrice: number;
  currentChainlinkPrice: number;
  chainlinkStale: boolean;
  nowMs: number;
  compressionThreshold: number;
  reversalBps: number;
  /** Only fire reversal when PM return on the held side is >= this (%). Prevents selling into spread when PM hasn't repriced. */
  reversalMinReturnPct: number;
  maxHoldSec: number;
  /** Exit when profitable with < this many minutes left before resolution. */
  nearResMinLeftMin: number;
  /** Minimum return (%) on the held token before near-resolution trigger fires. */
  nearResMinReturnPct: number;
}

/**
 * Pure function — no Redis, no feed. Decides whether (and why) to early-exit.
 *
 * Trigger priority (first matching rule wins):
 *   1. Reversal        — Chainlink has moved against us past the configured buffer AND
 *                        PM return on the held side is >= `reversalMinReturnPct`.
 *                        Skipped when `chainlinkStale` (don't exit on missing data).
 *                        Skipped when PM hasn't repriced: selling into the spread at
 *                        entry price is a guaranteed loss vs holding to resolution.
 *   2. Near-resolution — profitable with < nearResMinLeftMin remaining before market
 *                        resolution (locks in gains before a last-minute reversal).
 *                        Skipped when endDateMs=0 (legacy states without endDateMs).
 *   3. Compression     — PM has closed `>= compressionThreshold` of the entry gap.
 *   4. Timeout         — position has been held longer than `maxHoldSec`.
 *
 * Returns `null` when no trigger applies. `compressionPct` is clamped to
 * [0, 1] (overshoot past fair value still fires as 1.0).
 */
export function evaluateOracleLagExit(
  input: OracleLagExitEvalInput,
): OracleLagExitDecision | null {
  const {
    state,
    currentYesPrice,
    currentNoPrice,
    currentChainlinkPrice,
    chainlinkStale,
    nowMs,
    compressionThreshold,
    reversalBps,
    reversalMinReturnPct,
    maxHoldSec,
    nearResMinLeftMin,
    nearResMinReturnPct,
  } = input;

  const ageSec = Math.max(0, (nowMs - state.entryTsMs) / 1000);

  // Compression math — uniform by storing the gap relative to P(YES):
  //   UP (fair > entryYes):  entryGap = entryFair - entryYes; currentGap = entryFair - currentYes
  //   DOWN (fair < entryYes): entryGap = entryYes - entryFair; currentGap = currentYes - entryFair
  const isUp = state.direction === 'UP';
  const entryGap = isUp
    ? state.entryFairPyes - state.entryPmYesPrice
    : state.entryPmYesPrice - state.entryFairPyes;
  const currentGap = isUp
    ? state.entryFairPyes - currentYesPrice
    : currentYesPrice - state.entryFairPyes;
  const compressionPct =
    entryGap > 0 ? Math.max(0, Math.min(1, 1 - currentGap / entryGap)) : 0;

  // returnPct on the side we actually hold (used for ledger/bankroll math and reversal gate).
  // UP → bought YES at entryPmYesPrice → current = currentYesPrice.
  // DOWN → bought NO at entryPmNoPrice → current = currentNoPrice.
  const heldEntryPrice = isUp ? state.entryPmYesPrice : state.entryPmNoPrice;
  const heldCurrentPrice = isUp ? currentYesPrice : currentNoPrice;
  const returnPct =
    heldEntryPrice > 0
      ? ((heldCurrentPrice - heldEntryPrice) / heldEntryPrice) * 100
      : 0;

  // Reversal math — Chainlink move against us past the buffer.
  // UP entries bet on Chainlink trending up; reversal = current < entry * (1 - bps).
  // DOWN entries bet on Chainlink trending down; reversal = current > entry * (1 + bps).
  const reversalRatio = reversalBps / 10000;
  const actualReversalBps = isUp
    ? ((state.entryChainlinkPrice - currentChainlinkPrice) /
        state.entryChainlinkPrice) *
      10000
    : ((currentChainlinkPrice - state.entryChainlinkPrice) /
        state.entryChainlinkPrice) *
      10000;
  const reversed =
    !chainlinkStale &&
    actualReversalBps >= reversalBps &&
    returnPct >= reversalMinReturnPct;

  // Belt+suspenders against scanner regression — don't fire compression on
  // degenerate gaps (shouldn't happen since scanner requires ORACLE_LAG_MIN_MOVE_PCT).
  const compressionFiredEligible = entryGap > 0;

  if (reversed) {
    return {
      trigger: 'oracle_lag_reversed',
      compressionPct,
      reversalBps: actualReversalBps,
      ageSec,
      returnPct,
    };
  }

  // Near-resolution profit lock — fired after reversal but before compression
  // so we lock in any positive return in the final window regardless of whether
  // PM has fully repriced. endDateMs=0 on legacy states → timeLeftMin deeply
  // negative → the `timeLeftMin > 0` guard silently skips.
  const timeLeftMin = (state.endDateMs - nowMs) / 60_000;
  if (timeLeftMin > 0 && timeLeftMin < nearResMinLeftMin && returnPct >= nearResMinReturnPct) {
    return {
      trigger: 'oracle_lag_near_resolution',
      compressionPct,
      reversalBps: actualReversalBps,
      ageSec,
      returnPct,
    };
  }

  if (compressionFiredEligible && compressionPct >= compressionThreshold) {
    return {
      trigger: 'oracle_lag_compressed',
      compressionPct,
      reversalBps: actualReversalBps,
      ageSec,
      returnPct,
    };
  }

  if (ageSec > maxHoldSec) {
    return {
      trigger: 'oracle_lag_timeout',
      compressionPct,
      reversalBps: actualReversalBps,
      ageSec,
      returnPct,
    };
  }

  // Reference to reversalRatio for typecheck (kept for future threshold tuning).
  void reversalRatio;
  return null;
}

// ── Monitor class ───────────────────────────────────────────────────────────

const LOCK_KEY = 'lock:oracle-lag-exit-monitor';
const LOCK_TTL_SEC = 120;
const LOCK_REFRESH_MS = 60_000;
const SCAN_BATCH = 200;
const _CHAINLINK_SYMBOL = 'btc/usd';
const CHAINLINK_STALE_MS = 10_000;

export interface OracleLagExitMonitorOptions {
  redis: Redis;
  chainlinkFeed: ChainlinkFeed;
  loadCfg?: () => AppConfig;
}

export class OracleLagExitMonitor {
  private readonly redis: Redis;
  private readonly feed: ChainlinkFeed;
  private readonly loadCfg: () => AppConfig;
  private readonly hostId: string;
  private lockToken: string | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private lockRefreshTimer: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private stopped = false;

  constructor(opts: OracleLagExitMonitorOptions) {
    this.redis = opts.redis;
    this.feed = opts.chainlinkFeed;
    this.loadCfg = opts.loadCfg ?? loadConfig;
    this.hostId = hostname();
  }

  public async start(): Promise<void> {
    this.stopped = false;

    // Hostname-prefixed token — matches futuresMonitor pattern so a restarted
    // container can force-release its own stale lock on startup.
    const existing = await this.redis.get(LOCK_KEY);
    if (existing) {
      const ownerHost = existing.split(':')[0];
      if (ownerHost !== this.hostId) {
        logger.warn(
          '[oracle-lag-exit] stale lock detected — owner hostname differs, force-releasing',
          { ownerHost, myHost: this.hostId },
        );
        await this.redis.del(LOCK_KEY);
      }
    }

    const token = `${this.hostId}:${Date.now().toString()}-${Math.random().toString(36).slice(2)}`;
    const acquired = await this.redis.set(LOCK_KEY, token, 'EX', LOCK_TTL_SEC, 'NX');
    if (!acquired) {
      logger.warn(
        '[oracle-lag-exit] another instance holds the lock — monitor disabled',
        { lockKey: LOCK_KEY },
      );
      return;
    }
    this.lockToken = token;

    const cfg = this.loadCfg();
    logger.info('[oracle-lag-exit] monitor started', {
      enabled: cfg.ORACLE_LAG_EXIT_ENABLED,
      compressionPct: cfg.ORACLE_LAG_EXIT_COMPRESSION_PCT,
      reversalBps: cfg.ORACLE_LAG_EXIT_REVERSAL_BPS,
      reversalMinReturnPct: cfg.ORACLE_LAG_EXIT_REVERSAL_MIN_RETURN_PCT,
      maxHoldSec: cfg.ORACLE_LAG_EXIT_MAX_HOLD_SEC,
      nearResMinLeftMin: cfg.ORACLE_LAG_EXIT_NEAR_RES_MIN_LEFT_MIN,
      nearResMinReturnPct: cfg.ORACLE_LAG_EXIT_NEAR_RES_MIN_RETURN_PCT,
      tickMs: cfg.ORACLE_LAG_EXIT_TICK_MS,
    });

    this.lockRefreshTimer = setInterval(() => {
      void this.refreshLockOnce();
    }, LOCK_REFRESH_MS);

    this.tickTimer = setInterval(() => {
      void this.onTick();
    }, cfg.ORACLE_LAG_EXIT_TICK_MS);
  }

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
        await this.redis.eval(
          `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
          1,
          LOCK_KEY,
          this.lockToken,
        );
      } catch (err) {
        logger.warn('[oracle-lag-exit] release lock failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.lockToken = null;
    }
    logger.info('[oracle-lag-exit] monitor stopped');
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async refreshLockOnce(): Promise<void> {
    if (this.stopped || !this.lockToken) return;
    try {
      const res = await refreshLock(LOCK_KEY, this.lockToken, LOCK_TTL_SEC);
      if (res === 'refreshed') return;
      if (res === 'expired') {
        const ok = await reacquireLockAfterExpiry(LOCK_KEY, this.lockToken, LOCK_TTL_SEC);
        if (ok) {
          logger.warn(
            '[oracle-lag-exit] lock expired and was re-acquired under same token',
            { lockKey: LOCK_KEY },
          );
          return;
        }
        logger.error(
          '[oracle-lag-exit] lock expired and reacquire failed — another instance grabbed it',
          { lockKey: LOCK_KEY },
        );
        await this.stop();
        return;
      }
      logger.error(
        '[oracle-lag-exit] lock stolen by another instance — monitor stopping',
        { lockKey: LOCK_KEY },
      );
      this.lockToken = null;
      await this.stop();
    } catch (err) {
      logger.warn('[oracle-lag-exit] lock refresh threw (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async onTick(): Promise<void> {
    if (this.stopped || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const cfg = this.loadCfg();
      const keys = await this.scanExitStateKeys(SCAN_BATCH);
      if (keys.length === 0) return;

      for (const key of keys) {
        try {
          await this.evaluateKey(key, cfg);
        } catch (err) {
          logger.warn('[oracle-lag-exit] key evaluation threw (non-fatal)', {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  private async scanExitStateKeys(limit: number): Promise<string[]> {
    const out: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await this.redis.scan(
        cursor,
        'MATCH',
        `${EXIT_STATE_PREFIX}*`,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      for (const k of batch) {
        out.push(k);
        if (out.length >= limit) return out;
      }
    } while (cursor !== '0');
    return out;
  }

  private async evaluateKey(key: string, cfg: AppConfig): Promise<void> {
    const rest = key.slice(EXIT_STATE_PREFIX.length);
    const sepIdx = rest.lastIndexOf(':');
    if (sepIdx < 0) return;
    const marketId = rest.slice(0, sepIdx);
    const directionRaw = rest.slice(sepIdx + 1);
    if (directionRaw !== 'UP' && directionRaw !== 'DOWN') return;
    const direction: 'UP' | 'DOWN' = directionRaw;

    const state = await readOracleLagExitState(this.redis, marketId, direction);
    if (!state) {
      await this.redis.del(key).catch(() => {});
      return;
    }

    // Position may have been closed by an inherited exit (TP/SL/stale/resolution)
    // between scanner-stamp and this tick. Drop the exit-state and move on.
    const position = await getPosition(this.redis, marketId, direction);
    if (!position) {
      // Maker orders fill asynchronously — the reconciler imports the position
      // minutes after the scanner writes the exit state. Skip this tick if the
      // state is young (< 15 min); the position should land soon. Only delete
      // once the state is old enough that a fill would have been imported.
      if (Date.now() - state.entryTsMs < 15 * 60 * 1000) {
        return;
      }
      await this.redis.del(key).catch(() => {});
      return;
    }
    if (position.pendingSettlement) {
      await this.redis.del(key).catch(() => {});
      return;
    }

    // Read current PM prices. fetchCurrentPrice uses WS cache first, falls
    // back to Gamma REST, already handles UP/DOWN side mapping. We need both
    // yes and no sides — UP returnPct uses YES, DOWN returnPct uses NO.
    const priceResult = await fetchCurrentPrice(position);
    if (!priceResult) {
      logger.debug('[oracle-lag-exit] skipping — price fetch failed', {
        marketId,
        direction,
      });
      return;
    }
    const currentYesPrice = priceResult.currentYesPrice;

    // Polymarket best-bid quotes for YES/NO are NOT guaranteed to sum to 1 —
    // they are independent sides of the order book. Deriving `currentNoPrice`
    // as `1 - currentYesPrice` would skew DOWN-side returnPct (and, live, the
    // price handed to executeTakeProfit). For DOWN we therefore read the
    // explicit WS NO quote when present, only falling back to the REST-path
    // `priceResult.currentOutcomePrice` (which is an explicit NO on the Gamma
    // branch but a 1-YES approximation when the WS cache hit).
    let currentNoPrice: number;
    if (direction === 'DOWN') {
      const wsNoRaw = await this.redis
        .get(`ws:price:no:${marketId}`)
        .catch(() => null);
      const wsNoPrice = wsNoRaw != null ? Number(wsNoRaw) : Number.NaN;
      currentNoPrice = Number.isFinite(wsNoPrice)
        ? wsNoPrice
        : priceResult.currentOutcomePrice;
    } else {
      // UP positions don't use currentNoPrice downstream (evaluator reads NO
      // only for DOWN returnPct); the value is inert for UP.
      currentNoPrice = 1 - currentYesPrice;
    }

    // Chainlink feed staleness check (skip reversal if stale, not the whole tick).
    const latestTick = this.feed.getLatest(state.chainlinkSymbol);
    const now = Date.now();
    const chainlinkStale =
      !latestTick || now - latestTick.receivedAt > CHAINLINK_STALE_MS;
    const currentChainlinkPrice = latestTick?.value ?? state.entryChainlinkPrice;

    const decision = evaluateOracleLagExit({
      state,
      currentYesPrice,
      currentNoPrice,
      currentChainlinkPrice,
      chainlinkStale,
      nowMs: now,
      compressionThreshold: cfg.ORACLE_LAG_EXIT_COMPRESSION_PCT,
      reversalBps: cfg.ORACLE_LAG_EXIT_REVERSAL_BPS,
      reversalMinReturnPct: cfg.ORACLE_LAG_EXIT_REVERSAL_MIN_RETURN_PCT,
      maxHoldSec: cfg.ORACLE_LAG_EXIT_MAX_HOLD_SEC,
      nearResMinLeftMin: cfg.ORACLE_LAG_EXIT_NEAR_RES_MIN_LEFT_MIN,
      nearResMinReturnPct: cfg.ORACLE_LAG_EXIT_NEAR_RES_MIN_RETURN_PCT,
    });

    if (!decision) return;

    if (cfg.ORACLE_LAG_EXIT_ENABLED) {
      // Only DEL on a successful live exit. If executeTakeProfit fails or
      // throws, retain the exit-state so the next tick retries — otherwise a
      // transient venue error would leave the position open with no further
      // oracle-lag exit attempts (inherited TP/SL would eventually pick it up,
      // but the oracle-lag thesis has a ~180s window).
      const success = await this.fireLive(
        position,
        priceResult.currentOutcomePrice,
        decision,
      );
      if (success) {
        await this.redis.del(key).catch(() => {});
      }
    } else {
      this.writeShadow(position, state, decision);
      // Shadow stays one-shot — we want one observation per position, not a
      // stream of triggers as the gap continues compressing.
      await this.redis.del(key).catch(() => {});
    }
  }

  private async fireLive(
    position: Position,
    currentOutcomePrice: number,
    decision: OracleLagExitDecision,
  ): Promise<boolean> {
    logger.info('[oracle-lag-exit] firing live exit', {
      marketId: position.marketId,
      direction: position.direction,
      trigger: decision.trigger,
      compressionPct: +decision.compressionPct.toFixed(3),
      reversalBps: +decision.reversalBps.toFixed(1),
      ageSec: +decision.ageSec.toFixed(1),
      returnPct: +decision.returnPct.toFixed(2),
    });
    try {
      const result = await executeTakeProfit({
        position,
        currentPrice: currentOutcomePrice,
        returnPct: decision.returnPct,
        reason: decision.trigger,
        redis: this.redis,
      });
      if (!result.success) {
        logger.warn('[oracle-lag-exit] executeTakeProfit reported failure', {
          marketId: position.marketId,
          error: result.error,
        });
        return false;
      }
      return true;
    } catch (err) {
      logger.error('[oracle-lag-exit] executeTakeProfit threw', {
        marketId: position.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private writeShadow(
    position: Position,
    state: OracleLagExitState,
    decision: OracleLagExitDecision,
  ): void {
    logger.info('[oracle-lag-exit] shadow trigger', {
      marketId: position.marketId,
      direction: position.direction,
      trigger: decision.trigger,
      compressionPct: +decision.compressionPct.toFixed(3),
      reversalBps: +decision.reversalBps.toFixed(1),
      ageSec: +decision.ageSec.toFixed(1),
      wouldReturnPct: +decision.returnPct.toFixed(2),
    });
    void enqueueWrite('shadow_observations', {
      kind: 'oracle_lag_exit',
      source: 'arb',
      symbol: 'BTC',
      marketId: position.marketId,
      direction: position.direction,
      wouldBlock: false,
      metricValue: decision.compressionPct,
      threshold: 0,
      payload: {
        trigger: decision.trigger,
        compressionPct: decision.compressionPct,
        reversalBps: decision.reversalBps,
        ageSec: decision.ageSec,
        wouldReturnPct: decision.returnPct,
        executionId: position.executionId,
        entryPmYesPrice: state.entryPmYesPrice,
        entryPmNoPrice: state.entryPmNoPrice,
        entryChainlinkPrice: state.entryChainlinkPrice,
        entryChainlinkMovePct: state.entryChainlinkMovePct,
        entryFairPyes: state.entryFairPyes,
        entryTsMs: state.entryTsMs,
      },
    });
  }
}
