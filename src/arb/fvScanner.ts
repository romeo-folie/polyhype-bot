/**
 * Fair-Value scanner for Polymarket 15m BTC/ETH Up/Down markets.
 *
 * Signal: Black-Scholes p_model vs Gamma book mid. Replaces the oracle-lag
 * taker approach, which showed 21.1% WR on 15m (n=38) — MMs track Chainlink
 * and reprice fast enough that any OL edge is phantom. Empirical data from the
 * sister bot confirms FV at 87.6% WR (n=14,134) on the same market class.
 *
 * Entry logic (in gate order):
 *   1. σ warmup (180 ticks) — suppress all signals until calibrated
 *   2. τ gate (≥120 s) — Gaussian overconfidence bites below 2 min
 *   3. Strike resolved — K must come from RTDS at window_start_ts (not sentinel)
 *   4. p_model gate — YES: [0.80, 0.95]; NO: ≤0.10 (asymmetric, mutually exclusive)
 *   5. Edge gate — YES ≥2pp; NO 8–10pp (NO cap prevents σ-floor spuriousness)
 *   6. Momentum suppression — 10s log-return: suppress NO if +10bps, YES if −10bps
 *   7. Rate cap + per-market lockout (shared updownThrottle)
 *
 * Sizing: Half-Kelly (quarter-Kelly fraction = 25% of full Kelly) via
 * computeHalfKelly(), capped at FV_MAX_STAKE_USD and MIN_BET_USD floor.
 * Order type: maker-post via hybrid execution path (fv-scanner is in MAKER_ELIGIBLE_SOURCES
 * and MAKER_EMPTY_BOOK_ALLOWED_SOURCES — ghost-book GTC posting is the primary fill path).
 * consensusProbability is ALWAYS stored as P(YES) per codebase invariant.
 */

import type { Redis } from 'ioredis';

import { loadConfig, type AppConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { enqueueWrite } from '../db/writeQueue.js';
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
import { executeAndRecordSignal } from '../execution/executor.js';
import { getBankroll } from '../shared/bankroll.js';
import { computeHalfKelly } from '../mapping/divergenceCalculator.js';
import { priceZoneOf } from '../shared/zones.js';
import { computePModel } from '../pricing/blackScholes.js';
import { SigmaCalibrator } from '../pricing/sigmaCalibrator.js';
import type { ChainlinkFeed } from '../spot/feeds/chainlinkFeed.js';
import type { TradeSignal } from '../mapping/index.js';

// ── Mapping: PGA asset name → Chainlink symbol ────────────────────────────

export const FV_ASSET_TO_CHAINLINK: Record<string, string> = {
  bitcoin: 'btc/usd',
  ethereum: 'eth/usd',
};

// ── Shared scanner lock ───────────────────────────────────────────────────

const LOCK_KEY = 'lock:fv-scanner';
const LOCK_TTL_S = 60;
const LOCK_REFRESH_MS = 20_000;
const TICK_INTERVAL_MS = 1_000;
const MARKET_REFRESH_MS = 30_000;
/** Window_start for a 15m market is exactly 15 min before resolution. */
const WINDOW_DURATION_S = 900;

// ── Redis keys ────────────────────────────────────────────────────────────

const DEDUP_PREFIX = 'fv:dedup:';
const STRIKE_PREFIX = 'fv:strike:';
const DEDUP_TTL_S = 60;

// ── Pure evaluator ────────────────────────────────────────────────────────

export interface FvEvalConfig {
  tauMinSec: number;
  yesPModelMin: number;
  yesPModelMax: number;
  noPModelMax: number;
  yesMinEdge: number;
  noMinEdge: number;
  noMaxEdge: number;
  momentumSuppressBps: number;
  kellyFraction: number;
  maxStakeUsd: number;
  bankrollUsd: number;
}

export type FvBlockReason =
  | 'sigma_not_warmed_up'
  | 'strike_not_resolved'
  | 'tau_below_minimum'
  | 'bs_invalid'
  | 'p_model_out_of_range'
  | 'yes_edge_below_minimum'
  | 'no_edge_below_minimum'
  | 'no_edge_above_maximum'
  | 'momentum_suppressed'
  | 'zero_stake';

export interface FvEvalResult {
  shouldEnter: boolean;
  blockReason?: FvBlockReason;
  side?: 'YES' | 'NO';
  pYes: number;
  pNo: number;
  edge: number;
  tauSec: number;
  stakeUsd: number;
  /** Always P(YES) per codebase invariant. */
  consensusProbability: number;
  entryPrice: number;
}

/**
 * Pure entry-rule evaluator — no Redis, no executor. Tested in isolation.
 *
 * @param spot         Current Chainlink price
 * @param strike       K resolved from RTDS at window_start_ts (0 = sentinel = unresolved)
 * @param sigma        Active σ (clamped, annualized) from SigmaCalibrator
 * @param sigmaWarmedUp Whether SigmaCalibrator has passed its warmup gate
 * @param tenSecLogReturn Signed log-return over last 10 s (from ChainlinkFeed.getMoveSince)
 * @param market       Active 15m UP/DOWN market
 * @param cfg          Eval config derived from AppConfig
 * @param nowMs        Wall-clock override for testing
 */
export function evaluateFvEntry(
  spot: number,
  strike: number,
  sigma: number,
  sigmaWarmedUp: boolean,
  tenSecLogReturn: number | null,
  market: UpDownMarket,
  cfg: FvEvalConfig,
  nowMs = Date.now(),
): FvEvalResult {
  const blank = (blockReason: FvBlockReason): FvEvalResult => ({
    shouldEnter: false,
    blockReason,
    pYes: 0.5,
    pNo: 0.5,
    edge: 0,
    tauSec: 0,
    stakeUsd: 0,
    consensusProbability: 0.5,
    entryPrice: 0,
  });

  if (!sigmaWarmedUp) return blank('sigma_not_warmed_up');
  if (strike <= 0) return blank('strike_not_resolved');

  const tauSec = (market.endDate.getTime() - nowMs) / 1000;
  // Preserve tauSec in diagnostic returns from here on
  const withTau = (blockReason: FvBlockReason): FvEvalResult => ({ ...blank(blockReason), tauSec });
  if (tauSec < cfg.tauMinSec) return withTau('tau_below_minimum');

  const bs = computePModel(spot, strike, sigma, tauSec);
  if (!bs.valid) return withTau('bs_invalid');

  const { pYes, pNo } = bs;
  // Preserve tauSec + pYes/pNo in diagnostic returns from here on
  const withBs = (blockReason: FvBlockReason): FvEvalResult => ({
    ...blank(blockReason), tauSec, pYes, pNo, consensusProbability: pYes,
  });

  // YES gate: p_model in [yesPModelMin, yesPModelMax]
  const inYesRange = pYes >= cfg.yesPModelMin && pYes <= cfg.yesPModelMax;
  // NO gate: p_model ≤ noPModelMax (mutually exclusive with YES gate)
  const inNoRange = pYes <= cfg.noPModelMax;

  if (!inYesRange && !inNoRange) return withBs('p_model_out_of_range');

  // Determine side and compute edge vs Gamma book mid
  let side: 'YES' | 'NO';
  let edge: number;
  let entryPrice: number;

  if (inYesRange) {
    side = 'YES';
    // outcomePrices[0] = YES token price (Gamma mid)
    entryPrice = market.outcomePrices[0];
    edge = pYes - entryPrice;
  } else {
    side = 'NO';
    // outcomePrices[1] = NO token price (Gamma mid)
    entryPrice = market.outcomePrices[1];
    edge = pNo - entryPrice;
  }

  // Preserve all computed fields in diagnostic returns from here on
  const withEdge = (blockReason: FvBlockReason): FvEvalResult => ({
    ...blank(blockReason), tauSec, pYes, pNo, consensusProbability: pYes, side, edge, entryPrice,
  });

  if (inYesRange && edge < cfg.yesMinEdge) return withEdge('yes_edge_below_minimum');
  if (!inYesRange && edge < cfg.noMinEdge) return withEdge('no_edge_below_minimum');
  if (!inYesRange && edge > cfg.noMaxEdge) return withEdge('no_edge_above_maximum');

  // Momentum suppression: 10 bps threshold as signed fraction
  if (tenSecLogReturn !== null) {
    const thresholdFrac = cfg.momentumSuppressBps / 10_000;
    if (side === 'NO' && tenSecLogReturn > thresholdFrac) {
      return withEdge('momentum_suppressed'); // trending up → don't buy NO
    }
    if (side === 'YES' && tenSecLogReturn < -thresholdFrac) {
      return withEdge('momentum_suppressed'); // trending down → don't buy YES
    }
  }

  // Half-Kelly sizing (quarter-Kelly fraction = 25% of full Kelly)
  const kellyFrac = computeHalfKelly(
    side === 'YES' ? pYes : pNo,
    entryPrice,
    cfg.kellyFraction,
  );
  const stakeUsd = Math.min(cfg.bankrollUsd * kellyFrac, cfg.maxStakeUsd);
  if (stakeUsd <= 0) return withEdge('zero_stake');

  return {
    shouldEnter: true,
    side,
    pYes,
    pNo,
    edge,
    tauSec,
    stakeUsd,
    consensusProbability: pYes, // ALWAYS P(YES)
    entryPrice,
  };
}

// ── Scanner class ─────────────────────────────────────────────────────────

export class FvScanner {
  private readonly redis: Redis;
  private feed: ChainlinkFeed | null = null;
  private calibrator: SigmaCalibrator | null = null;
  private cfg: AppConfig | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private lockRefreshTimer: NodeJS.Timeout | null = null;
  private lockToken: string | null = null;
  private stopped = false;
  private tickInFlight = false;

  private readonly marketCache = new Map<string, UpDownMarket[]>();
  private readonly lastMarketRefreshMs = new Map<string, number>();
  private readonly marketRefreshInFlight = new Set<string>();
  // Track last-seen oracleTs per symbol — only call calibrator.onTick() on new ticks
  private readonly lastSeenOracleTs = new Map<string, number>();
  /** Parsed, lowercased, filtered-to-supported assets. Set in start(). */
  private assets: string[] = [];

  constructor({ redis }: { redis: Redis }) {
    this.redis = redis;
  }

  public async start(feed: ChainlinkFeed): Promise<void> {
    const cfg = loadConfig();
    const token = await acquireLock(LOCK_KEY, LOCK_TTL_S);
    if (!token) {
      logger.warn('[fv-scanner] another instance holds the lock — scanner disabled', {
        lockKey: LOCK_KEY,
      });
      return;
    }
    this.cfg = cfg;
    this.feed = feed;
    this.lockToken = token;

    // Parse FV_ASSETS once: normalize case, filter to assets we have a
    // Chainlink mapping for, warn on anything we drop. Reused each tick so
    // the inner loop never pays the per-tick regex / case-sensitivity cost.
    const parsed = cfg.FV_ASSETS.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
    const unsupported = parsed.filter((a) => !(a in FV_ASSET_TO_CHAINLINK));
    this.assets = parsed.filter((a) => a in FV_ASSET_TO_CHAINLINK);
    if (unsupported.length > 0) {
      logger.warn('[fv-scanner] dropping unsupported FV_ASSETS entries', {
        unsupported,
        configuredAssets: cfg.FV_ASSETS,
        supportedKeys: Object.keys(FV_ASSET_TO_CHAINLINK),
      });
    }
    if (this.assets.length === 0) {
      logger.warn('[fv-scanner] no supported assets configured — scanner will idle', {
        configuredAssets: cfg.FV_ASSETS,
      });
    }

    this.calibrator = new SigmaCalibrator({
      rollingWindowMs: cfg.FV_SIGMA_ROLLING_WINDOW_MS,
      ewmaHalfLifeS: cfg.FV_SIGMA_EWMA_HALF_LIFE_S,
      ewmaSpikeMultiplier: cfg.FV_SIGMA_EWMA_SPIKE_MULT,
      sigmaMin: cfg.FV_SIGMA_MIN,
      sigmaMax: cfg.FV_SIGMA_MAX,
      warmupTicks: cfg.FV_SIGMA_WARMUP_TICKS,
      warmupMinMs: cfg.FV_SIGMA_WARMUP_MIN_S * 1000,
    });

    logger.info('[fv-scanner] scanner started', { assets: this.assets, lockKey: LOCK_KEY });

    this.lockRefreshTimer = setInterval(() => {
      void this.refreshLockOnce();
    }, LOCK_REFRESH_MS);

    this.tickTimer = setInterval(() => {
      void this.onTick();
    }, TICK_INTERVAL_MS);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    if (this.lockRefreshTimer) { clearInterval(this.lockRefreshTimer); this.lockRefreshTimer = null; }
    if (this.lockToken) {
      try {
        await releaseLock(LOCK_KEY, this.lockToken);
      } catch (err) {
        logger.warn('[fv-scanner] release lock failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.lockToken = null;
    }
    logger.info('[fv-scanner] scanner stopped');
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async refreshLockOnce(): Promise<void> {
    if (this.stopped || !this.lockToken) return;
    try {
      const res = await refreshLock(LOCK_KEY, this.lockToken, LOCK_TTL_S);
      if (res === 'refreshed') return;
      if (res === 'expired') {
        const ok = await reacquireLockAfterExpiry(LOCK_KEY, this.lockToken, LOCK_TTL_S);
        if (ok) {
          logger.warn('[fv-scanner] lock expired and re-acquired under same token', { lockKey: LOCK_KEY });
          return;
        }
        logger.error('[fv-scanner] lock expired and reacquire failed', { lockKey: LOCK_KEY });
        await this.stop();
        return;
      }
      logger.error('[fv-scanner] lock stolen — scanner stopping', { lockKey: LOCK_KEY });
      this.lockToken = null;
      await this.stop();
    } catch (err) {
      logger.warn('[fv-scanner] lock refresh threw (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async refreshMarketsIfStale(asset: string): Promise<void> {
    if (this.marketRefreshInFlight.has(asset)) return;
    const now = Date.now();
    if (now - (this.lastMarketRefreshMs.get(asset) ?? 0) < MARKET_REFRESH_MS) return;
    this.lastMarketRefreshMs.set(asset, now);
    this.marketRefreshInFlight.add(asset);
    try {
      // asset has already been lowercase-normalized and filtered to keys of
      // FV_ASSET_TO_CHAINLINK in start(), so the UpDownAsset contract holds.
      const markets = await discoverUpDownMarketsBySlug({
        asset,
        lifetime: '15m',
        windowsAhead: 2,
      });
      this.marketCache.set(asset, markets);
      logger.debug('[fv-scanner] market refresh', { asset, count: markets.length });
    } catch (err) {
      logger.warn('[fv-scanner] market refresh failed (non-fatal)', {
        asset,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.marketRefreshInFlight.delete(asset);
    }
  }

  /**
   * Resolve and cache the strike price K for a market.
   * K = RTDS Chainlink price closest to window_start_ts, within ±toleranceS.
   * window_start_ts = market.endDate - WINDOW_DURATION_S seconds.
   */
  private async resolveStrike(
    market: UpDownMarket,
    asset: string,
    toleranceS: number,
  ): Promise<number> {
    const redisKey = `${STRIKE_PREFIX}${market.marketId}`;

    // Fast path: already cached in Redis
    const cached = await this.redis.get(redisKey).catch(() => null);
    if (cached !== null) {
      const v = parseFloat(cached);
      return Number.isFinite(v) && v > 0 ? v : 0;
    }

    const symbol = FV_ASSET_TO_CHAINLINK[asset];
    if (!symbol || !this.feed) return 0;

    const windowStartMs = market.endDate.getTime() - WINDOW_DURATION_S * 1000;
    const tick = this.feed.findTickAt(symbol, windowStartMs, toleranceS * 1000);
    if (!tick) return 0;

    // Cache until market resolves + 1 h
    const ttlS = Math.max(
      3600,
      Math.ceil((market.endDate.getTime() - Date.now()) / 1000) + 3600,
    );
    await this.redis.set(redisKey, String(tick.value), 'EX', ttlS).catch(() => null);
    logger.debug('[fv-scanner] strike resolved', {
      marketId: market.marketId,
      strike: tick.value,
      lagMs: Math.abs(tick.oracleTs - windowStartMs),
    });
    return tick.value;
  }

  private async onTick(): Promise<void> {
    if (this.stopped || this.tickInFlight || !this.cfg || !this.feed || !this.calibrator) return;
    this.tickInFlight = true;
    try {
      const cfg = this.cfg;
      // Fetch bankroll once per tick cycle — not per market — to avoid one Redis
      // round-trip per market in the inner loop.
      const bankrollUsd = await getBankroll(this.redis).catch(() => 0);

      for (const asset of this.assets) {
        const symbol = FV_ASSET_TO_CHAINLINK[asset];
        if (!symbol) continue;

        // Feed latest tick into calibrator EWMA — skip stale ticks so a
        // Chainlink stall doesn't inflate tickCount or distort EWMA.
        const latestTick = this.feed.getLatest(symbol);
        if (latestTick && latestTick.oracleTs !== this.lastSeenOracleTs.get(symbol)) {
          this.lastSeenOracleTs.set(symbol, latestTick.oracleTs);
          this.calibrator.onTick(latestTick);
        }

        // Compute σ from 1-hour rolling window
        const recentTicks = this.feed.getTicksSince(symbol, cfg.FV_SIGMA_ROLLING_WINDOW_MS);
        const sigmaResult = this.calibrator.getSigma(symbol, recentTicks);

        // 10-second momentum for suppression
        const momentumMove = this.feed.getMoveSince(symbol, cfg.FV_MOMENTUM_LOOKBACK_S * 1000);
        // getMoveSince returns pctMove as a fraction (0.01 = 1%); convert to log-return approx
        const tenSecLogReturn = momentumMove ? Math.log(1 + momentumMove.pctMove) : null;

        await this.refreshMarketsIfStale(asset);
        const markets = this.marketCache.get(asset) ?? [];

        for (const market of markets) {
          await this.evaluateMarket(market, asset, symbol, sigmaResult.sigma, sigmaResult.warmedUp, tenSecLogReturn, cfg, bankrollUsd);
        }
      }
    } catch (err) {
      logger.warn('[fv-scanner] tick threw (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.tickInFlight = false;
    }
  }

  private async evaluateMarket(
    market: UpDownMarket,
    asset: string,
    symbol: string,
    sigma: number,
    sigmaWarmedUp: boolean,
    tenSecLogReturn: number | null,
    cfg: AppConfig,
    bankrollUsd: number,
  ): Promise<void> {
    const latestTick = this.feed!.getLatest(symbol);
    if (!latestTick) return;

    const spot = latestTick.value;
    const strike = await this.resolveStrike(market, asset, cfg.FV_STRIKE_TOLERANCE_S);

    const evalCfg: FvEvalConfig = {
      tauMinSec: cfg.FV_TAU_MIN_S,
      yesPModelMin: cfg.FV_YES_P_MODEL_MIN,
      yesPModelMax: cfg.FV_YES_P_MODEL_MAX,
      noPModelMax: cfg.FV_NO_P_MODEL_MAX,
      yesMinEdge: cfg.FV_YES_MIN_EDGE,
      noMinEdge: cfg.FV_NO_MIN_EDGE,
      noMaxEdge: cfg.FV_NO_MAX_EDGE,
      momentumSuppressBps: cfg.FV_MOMENTUM_SUPPRESS_BPS,
      kellyFraction: cfg.FV_KELLY_FRACTION,
      maxStakeUsd: cfg.FV_MAX_STAKE_USD,
      bankrollUsd,
    };

    const evaluation = evaluateFvEntry(
      spot,
      strike,
      sigma,
      sigmaWarmedUp,
      tenSecLogReturn,
      market,
      evalCfg,
    );

    const wouldTrade = evaluation.shouldEnter;

    // Shadow log always writes — regardless of FV_SCANNER_ENABLED
    logger.info('[fv-scanner] shadow candidate', {
      marketId: market.marketId,
      asset,
      spot,
      strike,
      sigma: sigma.toFixed(4),
      sigmaWarmedUp,
      tauSec: evaluation.tauSec.toFixed(0),
      pYes: evaluation.pYes.toFixed(4),
      pNo: evaluation.pNo.toFixed(4),
      side: evaluation.side,
      edge: evaluation.edge.toFixed(4),
      stakeUsd: evaluation.stakeUsd.toFixed(2),
      wouldTrade,
      blockReason: evaluation.blockReason,
    });

    // Gate DB writes to meaningful rows. Pre-model early blocks fire on every
    // tick for every market during warmup/strike-lookup and carry no p_model
    // signal — skipping them keeps shadow_observations focused on gate
    // analysis (p_model, edge, momentum, sizing) and prevents table spam.
    // Would-trade rows are always persisted.
    const NOISY_BLOCK_REASONS: ReadonlySet<FvBlockReason> = new Set([
      'sigma_not_warmed_up',
      'strike_not_resolved',
      'bs_invalid',
    ]);
    const shouldPersistShadow =
      wouldTrade ||
      !evaluation.blockReason ||
      !NOISY_BLOCK_REASONS.has(evaluation.blockReason);

    if (shouldPersistShadow) {
      void enqueueWrite('shadow_observations', {
        kind: 'fv_scanner',
        source: 'fv-scanner',
        marketId: market.marketId,
        direction: evaluation.side ?? undefined,
        wouldBlock: !wouldTrade,
        metricValue: evaluation.edge,
        payload: {
          asset,
          spot,
          strike,
          sigma,
          sigmaWarmedUp,
          tauSec: evaluation.tauSec,
          pYes: evaluation.pYes,
          pNo: evaluation.pNo,
          stakeUsd: evaluation.stakeUsd,
          blockReason: evaluation.blockReason ?? null,
        },
      });
    }

    if (!wouldTrade || !cfg.FV_SCANNER_ENABLED) return;

    // ── Live execution path ────────────────────────────────────────────────

    // Rate cap (shared hourly bucket).
    // Fail-CLOSED on Redis error: if we can't read the throttle counter, we
    // can't assume the cap isn't hit — treating a Redis outage as "no trades
    // recorded" would let the scanner fire uncapped while throttle state is
    // unreadable. Default to blocking.
    let recentCount: number;
    try {
      recentCount = await countRecentUpDownTrades(this.redis);
    } catch (err) {
      logger.warn('[fv-scanner] rate cap read failed — blocking as fail-safe', {
        asset,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (recentCount >= cfg.FV_MAX_TRADES_PER_HOUR) {
      logger.debug('[fv-scanner] rate cap hit', { asset, recentCount, cap: cfg.FV_MAX_TRADES_PER_HOUR });
      return;
    }

    // Per-market lockout (prevents re-entry on same market this window)
    const marketLocked = await isUpDownMarketLocked(this.redis, market.marketId).catch(() => true);
    if (marketLocked) {
      logger.debug('[fv-scanner] market locked', { marketId: market.marketId });
      return;
    }

    const { side } = evaluation;
    if (!side) return;

    // Dedup: prevent firing on the same market+side within one tick cycle
    const dedupKey = `${DEDUP_PREFIX}${market.marketId}:${side}`;
    const isNew = await this.redis.set(dedupKey, '1', 'EX', DEDUP_TTL_S, 'NX').catch(() => null);
    if (!isNew) {
      logger.debug('[fv-scanner] dedup suppressed', { marketId: market.marketId, side });
      return;
    }

    const direction = side; // 'YES' | 'NO' — executor.ts canonical mapping handles UP/DOWN alias
    const throttleDir = side === 'YES' ? 'UP' : 'DOWN'; // updownThrottle uses UP/DOWN
    const entryPrice = evaluation.entryPrice;

    const signal: TradeSignal = {
      marketId: market.marketId,
      clobTokenIds: [market.yesTokenId, market.noTokenId],
      question: market.question,
      direction,
      stakeUsd: evaluation.stakeUsd,
      edgeMagnitude: evaluation.edge,
      consensusProbability: evaluation.consensusProbability,
      outcomePrice: entryPrice,
      priceZone: priceZoneOf(entryPrice),
      sourcedFrom: `fv-scanner:${asset}:${side}:p${evaluation.pYes.toFixed(3)}:e${evaluation.edge.toFixed(3)}`,
      reasoning: `FV BS p_model=${evaluation.pYes.toFixed(3)} vs book_mid=${entryPrice.toFixed(3)}, edge=${evaluation.edge.toFixed(3)}, σ=${sigma.toFixed(3)}, τ=${evaluation.tauSec.toFixed(0)}s`,
      source: 'fv-scanner',
      assetId: asset,
      endDate: market.endDate.toISOString(),
    };

    logger.info('[fv-scanner] entry', {
      marketId: market.marketId,
      asset,
      side,
      spot,
      strike,
      sigma: sigma.toFixed(4),
      pYes: evaluation.pYes.toFixed(4),
      edge: evaluation.edge.toFixed(4),
      stakeUsd: evaluation.stakeUsd.toFixed(2),
      tauSec: evaluation.tauSec.toFixed(0),
      entryPrice,
    });

    let executorOutcome: 'success' | 'error' | 'skipped' | 'pending' = 'pending';

    try {
      const result = await executeAndRecordSignal(signal, this.redis);
      if (result.skipped) {
        executorOutcome = 'skipped';
        logger.info('[fv-scanner] executor skipped', {
          marketId: market.marketId,
          skipReason: result.skipReason,
        });
        return;
      }

      executorOutcome = 'success';
      const execPath = result.entryExecutionPath;

      if (execPath === 'maker_pending') {
        // Lock market to prevent opposite-side whipsaw while order is pending
        try {
          await lockUpDownMarket(this.redis, market.marketId, market.endDate.toISOString());
          await recordUpDownTrade(this.redis, market.marketId, throttleDir);
        } catch (err) {
          logger.warn('[fv-scanner] maker_pending lock/record failed (non-fatal)', {
            marketId: market.marketId,
            direction,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      await lockUpDownMarket(this.redis, market.marketId, market.endDate.toISOString());
      await recordUpDownTrade(this.redis, market.marketId, throttleDir);

      logger.info('[fv-scanner] trade recorded', {
        marketId: market.marketId,
        side,
        stakeUsd: evaluation.stakeUsd,
        execPath,
      });
    } catch (err) {
      executorOutcome = 'error';
      logger.error('[fv-scanner] executor threw', {
        marketId: market.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Release dedup on error so a later tick can retry
      await this.redis.del(dedupKey).catch(() => null);
    } finally {
      void enqueueWrite('shadow_observations', {
        kind: 'fv_scanner_executor',
        source: 'fv-scanner',
        marketId: market.marketId,
        direction: side,
        wouldBlock: false,
        payload: {
          asset,
          stakeUsd: evaluation.stakeUsd,
          entryPrice,
          outcome: executorOutcome,
        },
      });
    }
  }
}
