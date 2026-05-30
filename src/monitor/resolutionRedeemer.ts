/**
 * Resolution redeemer.
 *
 * Checks CLOB positions tracked in Redis for resolution and redeems on-chain.
 *
 * Flow:
 *   1. Check Redis for CLOB-venue positions and resolve independently
 *   2. On-chain CTF redemption via ProxyWalletFactory / CLOB client
 *   3. Remove redeemed positions from Redis ledger
 *   4. Credit proceeds to bankroll and notify Telegram
 */

import { Contract } from 'ethers';
import { logger } from '../shared/logger.js';
import { closePosition, getOpenPositions, getPosition } from '../execution/positionLedger.js';
import type { Position } from '../execution/positionLedger.js';
import { getHyperliquid } from '../shared/hyperliquid.js';
import {
  redeemClobOutcome,
  getPolygonProvider,
  resetPolygonProvider,
  getClobClient,
  fetchClobTokenBalance,
} from '../shared/clob.js';
import { creditProceeds } from '../shared/bankroll.js';
import { markRecentlyClosed, isRecentlyClosed, markRecentlyResolved, isRecentlyResolved } from '../shared/closedGuard.js';

/** @deprecated Use isRecentlyClosed from shared/closedGuard.js. Kept for external callers. */
export const isRecentlyRedeemed = isRecentlyClosed;
import { notifyRedemptionExecuted, notifyManualRedemptionRequired, notifyMarketResolved, notify } from '../execution/telegram.js';
import {
  recordPositionOutcome,
  recordRedemptionOutcome,
} from '../shared/positionOutcomeRecorder.js';
import { Wallet } from 'ethers';
import {
  loadConfig,
  type AppConfig,
  CTF_ADDRESS,
  POLYGON_FALLBACK_RPCS,
} from '../shared/config.js';
import { getRedis } from '../shared/redis.js';
import type { Redis } from 'ioredis';

export interface RedemptionResult {
  marketId: string;
  side: 'yes' | 'no';
  success: boolean;
  txHash?: string;
  valueUsdc?: number;
  error?: string;
}

const REDEEMER_SUCCESS_PREFIX = 'redeemer:recent-success:';
const REDEEMER_FALLBACK_STALE_PREFIX = 'redeemer:stale-fallback:';
const REDEEMER_MANUAL_NOTIFY_KEY = 'redeemer:manual-notified';

async function closePositionWithHedge(
  redis: Redis,
  marketId: string,
  direction: Position['direction'],
): Promise<void> {
  // C5: wrap in try-catch — if Redis throws mid-close the HL leg must not be touched
  // (state is uncertain; redeemer will retry PM close on the next cycle).
  try {
    await closePosition(redis, marketId, direction);
  } catch (err) {
    logger.warn('[redeemer] ledger close failed; skipping HL hedge close', {
      marketId, error: String(err),
    });
    return;
  }
  const hlSymbol = await redis.get(`hedge:link:${marketId}`).catch(() => null);
  if (hlSymbol) {
    try {
      const result = await getHyperliquid().closePosition(hlSymbol);
      if (result.success) {
        logger.info('[redeemer] closed linked HL hedge on PM resolution', { marketId, hlSymbol });
        // C2: only delete the key when the HL close actually succeeded — on failure the key
        // persists so the futuresMonitor continues to exempt the hedge from max-hold and
        // the position remains visible for manual inspection or retry.
        await redis.del(`hedge:link:${marketId}`).catch(() => {});
      } else {
        logger.warn('[redeemer] failed to close linked HL hedge on PM resolution', {
          marketId, hlSymbol, error: result.error,
        });
        void notify(
          `⚠️ HL hedge close failed — manual action needed\nPM market: ${marketId}\nHL symbol: ${hlSymbol}\nError: ${result.error ?? 'unknown'}`,
        ).catch(() => {});
      }
    } catch (err) {
      logger.warn('[redeemer] error closing linked HL hedge on PM resolution', {
        marketId, hlSymbol, error: String(err),
      });
      void notify(
        `⚠️ HL hedge close error — manual action needed\nPM market: ${marketId}\nHL symbol: ${hlSymbol}\nError: ${String(err)}`,
      ).catch(() => {});
    }
  }
}
const REDEEMER_MANUAL_NOTIFY_TTL_S = 30 * 24 * 3600;
const STALE_EXPIRED_NOTICE_SUPPRESS_AFTER_MS = 24 * 3600 * 1000;
type RedeemerSkipReason = 'skipped_recent_success' | 'skipped_dust' | 'stale_no_balance';

interface RedemptionState {
  timestamp: number;
  balanceAfter: number;
  amount: number;
}

type RedeemSide = 'yes' | 'no';

const dedupKey = (conditionId: string, side: RedeemSide) =>
  `${REDEEMER_SUCCESS_PREFIX}${conditionId}:${side}`;
const staleKey = (conditionId: string, side: RedeemSide) =>
  `${REDEEMER_FALLBACK_STALE_PREFIX}${conditionId}:${side}`;

function parseNumber(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

function shouldNotifyExpiredResolution(endDate: string | undefined): boolean {
  if (!endDate) return true;
  const endMs = Date.parse(endDate);
  if (!Number.isFinite(endMs)) return true;
  return Date.now() - endMs <= STALE_EXPIRED_NOTICE_SUPPRESS_AFTER_MS;
}

async function getRedeemerState(
  redis: Redis,
  conditionId: string,
  side: RedeemSide,
): Promise<RedemptionState | null> {
  const raw = await redis.hgetall(dedupKey(conditionId, side));
  if (!raw.timestamp) return null;
  const timestamp = Number.parseInt(raw.timestamp, 10);
  if (!Number.isFinite(timestamp)) return null;
  return {
    timestamp,
    balanceAfter: parseNumber(raw.balanceAfter),
    amount: parseNumber(raw.amount),
  };
}

async function markRedeemerSuccess(
  redis: Redis,
  conditionId: string,
  side: RedeemSide,
  amount: number,
  balance: number,
  cfg: AppConfig,
  txHash?: string,
): Promise<void> {
  await redis.hset(dedupKey(conditionId, side), {
    timestamp: String(Date.now()),
    amount: String(amount),
    balanceAfter: String(balance),
    txHash: txHash ?? '',
  });
  await redis.expire(dedupKey(conditionId, side), cfg.REDEEMER_DUPLICATE_WINDOW_S);
}

async function markFallbackStale(
  redis: Redis,
  conditionId: string,
  side: RedeemSide,
  cfg: AppConfig,
): Promise<void> {
  await redis.set(staleKey(conditionId, side), '1', 'EX', cfg.REDEEMER_FALLBACK_STALE_TTL_S);
}

async function shouldSkipRedeemer(
  redis: Redis,
  conditionId: string,
  side: RedeemSide,
  reportedBalance: number | null,
  cfg: AppConfig,
): Promise<RedeemerSkipReason | null> {
  if (await redis.exists(staleKey(conditionId, side))) {
    return 'stale_no_balance';
  }

  const state = await getRedeemerState(redis, conditionId, side);
  const balanceAfter = state?.balanceAfter ?? 0;
  const hasFiniteReported = Number.isFinite(reportedBalance ?? NaN);
  const currentBalance = hasFiniteReported ? reportedBalance! : balanceAfter;

  if (
    (hasFiniteReported || state) &&
    currentBalance <= cfg.REDEEMER_DUST_THRESHOLD_USDC &&
    (!state || balanceAfter <= cfg.REDEEMER_DUST_THRESHOLD_USDC)
  ) {
    return 'skipped_dust';
  }

  if (!state) return null;

  const ageMs = Date.now() - state.timestamp;
  if (ageMs >= cfg.REDEEMER_DUPLICATE_WINDOW_S * 1_000) {
    await redis.del(dedupKey(conditionId, side));
    return null;
  }

  const diff = Math.abs(currentBalance - balanceAfter);
  if (diff <= cfg.REDEEMER_DUST_THRESHOLD_USDC) {
    return 'skipped_recent_success';
  }
  return null;
}

async function shouldNotifyManual(red: Redis, conditionId: string): Promise<boolean> {
  const already = await red.sismember(REDEEMER_MANUAL_NOTIFY_KEY, conditionId).catch(() => 0);
  if (already) return false;
  await red.sadd(REDEEMER_MANUAL_NOTIFY_KEY, conditionId).catch(() => {});
  await red.expire(REDEEMER_MANUAL_NOTIFY_KEY, REDEEMER_MANUAL_NOTIFY_TTL_S).catch(() => {});
  return true;
}

function logRedeemerSkip(
  reason: RedeemerSkipReason,
  conditionId: string,
  metadata: Record<string, unknown> = {},
): void {
  logger.info('[redeemer] skipping redundant redemption', {
    reason,
    conditionId,
    ...metadata,
  });
}

function pickClobTokenId(position: Position): string | undefined {
  if (!position.clobTokenIds || position.clobTokenIds.length === 0) return undefined;
  if (position.direction === 'YES' || position.direction === 'UP') return position.clobTokenIds[0];
  if (position.direction === 'NO' || position.direction === 'DOWN') return position.clobTokenIds[1];
  return undefined;
}

async function refreshTokenBalance(tokenId?: string): Promise<number | null> {
  if (!tokenId) return null;
  const balanceResult = await fetchClobTokenBalance(tokenId);
  return balanceResult.ok ? balanceResult.balance : null;
}

function classifyRedemptionStatus(
  balanceAfter: number | null,
  cfg: AppConfig,
): 'partial_redemption' | 'fully_redeemed' {
  if (balanceAfter === null) return 'fully_redeemed';
  return balanceAfter > cfg.REDEEMER_DUST_THRESHOLD_USDC ? 'partial_redemption' : 'fully_redeemed';
}

function logRedemptionOutcome(
  conditionId: string,
  status: 'partial_redemption' | 'fully_redeemed',
  metadata: Record<string, unknown> = {},
): void {
  logger.info('[redeemer] redemption status', {
    conditionId,
    status,
    ...metadata,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find and redeem all resolved winning CLOB positions.
 *
 * Never throws — errors are logged and captured per-position.
 * Returns an array of results (one per redeemable position attempted).
 */
export async function redeemResolvedPositions(redis: Redis): Promise<RedemptionResult[]> {
  const results: RedemptionResult[] = [];
  const cfg = loadConfig();

  // ── CLOB position redemptions ─────────────────────────────────────────────
  try {
    await redeemClobPositions(redis, results, cfg);
  } catch (err) {
    logger.warn('[redeemer] CLOB position redemption scan failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Orphan CLOB sweep ──────────────────────────────────────────────────────
  // Catches positions that executed on-chain but were never recorded in the Redis
  // ledger (e.g. due to the parseOrderResponse crash). Queries the CLOB trades API
  // directly, checks on-chain token balances, and redeems any won-but-unredeemed
  // tokens found — regardless of whether a ledger entry exists.
  const allRedeemedMarkets = new Set(results.filter((r) => r.success).map((r) => r.marketId));
  try {
    await redeemOrphanClobPositions(results, allRedeemedMarkets, cfg);
  } catch (err) {
    logger.warn('[redeemer] orphan CLOB sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return results;
}

/**
 * Check Redis for CLOB-venue positions that may have resolved.
 *
 * We check each one against the Gamma API for resolution status and close accordingly.
 */
async function redeemClobPositions(
  redis: Redis,
  results: RedemptionResult[],
  cfg: AppConfig,
): Promise<void> {
  const allPositions = await getOpenPositions(redis);
  const clobPositions = allPositions.filter((p: Position) => p.executionVenue === 'clob');

  if (clobPositions.length === 0) return;

  logger.info('[redeemer] checking CLOB positions for resolution', { count: clobPositions.length });

  for (const pos of clobPositions) {
    // CLOB positions are YES/NO/UP/DOWN — LONG/SHORT are HL-only and filtered above
    if (pos.direction !== 'YES' && pos.direction !== 'NO'
        && pos.direction !== 'UP' && pos.direction !== 'DOWN') continue;

    if (await isRecentlyResolved(redis, pos.marketId)) {
      // A sibling side of this binary market resolved on-chain — close this position too.
      logger.info('[redeemer] closing CLOB position — sibling side resolved on-chain', {
        marketId: pos.marketId,
        direction: pos.direction,
      });
      await closePositionWithHedge(redis, pos.marketId, pos.direction);
      await markRecentlyResolved(redis, pos.marketId);
      const q = pos.question || pos.marketId;
      await recordPositionOutcome(
        redis,
        { ...pos, question: q },
        {
          result: 'lost',
          returnPct: -100,
          executionVenueOverride: 'clob',
          exitReason: 'sibling_resolved',
        },
      );
      void notifyMarketResolved({
        question: q,
        direction: pos.direction,
        result: 'lost',
        stakeUsd: pos.stakeUsd,
        reason: 'sibling position already resolved',
      }).catch(() => {});
      continue;
    }

    const conditionId = pos.conditionId;
    if (!conditionId) {
      logger.warn('[redeemer] CLOB position missing conditionId — skipping', {
        marketId: pos.marketId,
      });
      continue;
    }

    const pmDirection = pos.direction;
    const isYesSide = pmDirection === 'YES' || pmDirection === 'UP';
    const side: 'yes' | 'no' = isYesSide ? 'yes' : 'no';

    const tokenId = pickClobTokenId(pos);
    const preBalance = await refreshTokenBalance(tokenId);
    const reportedBalance =
      preBalance ?? pos.sharesHeld ?? (pos.entryPrice > 0 ? pos.stakeUsd / pos.entryPrice : null);
    const skipReason = await shouldSkipRedeemer(redis, conditionId, side, reportedBalance, cfg);
    if (skipReason && skipReason !== 'skipped_dust') {
      logRedeemerSkip(skipReason, conditionId, { marketId: pos.marketId, reportedBalance });
      continue;
    }

    // Dust positions: skip on-chain redemption but still check resolution
    // to close zombie ledger entries and record outcomes.
    const isDust = skipReason === 'skipped_dust';
    if (isDust) {
      logRedeemerSkip(skipReason, conditionId, { marketId: pos.marketId, reportedBalance });
    }

    try {
      // Check resolution via Gamma API — pass token ID for reliable lookup
      const resolved = await checkMarketResolved(conditionId, tokenId);
      // Rate limit Gamma calls (200ms inter-call delay)
      await new Promise((r) => setTimeout(r, 200));

      if (!resolved) {
        // Gamma can't find some markets (e.g. Up/Down binaries).
        // For positions whose endDate has passed, close them —
        // the market is definitively over and Gamma will never resolve it.
        if (pos.endDate && new Date(pos.endDate).getTime() < Date.now()) {
          logger.info('[redeemer] handling expired CLOB position (Gamma unresolvable)', {
            marketId: pos.marketId,
            direction: pos.direction,
            endDate: pos.endDate,
            isDust,
            reportedBalance,
          });
          const q = pos.question || pos.marketId;

          // Oracle-lag positions are stored with canonicalized YES/NO directions.
          // Derive the user-facing label (UP/DOWN) from sourcedFrom so all
          // notifications in this expired path (dust, loss, win) are consistent.
          const displayDir =
            pos.sourcedFrom?.startsWith('oracle-lag')
              ? pos.direction === 'YES' ? 'UP' : pos.direction === 'NO' ? 'DOWN' : pos.direction
              : pos.direction;

          // Dust or no-balance positions: before writing -100% loss, verify
          // on-chain resolution. A zero balance on an expired market can mean
          // either (a) Polymarket's auto-redeemer already paid out our winning
          // shares (they get burned by CTF at payout → we see 0 balance) or
          // (b) we really hold nothing of value. Distinguish via CTF
          // payoutDenominator before assuming loss.
          //
          // Polymarket's auto-redeem is a user-account setting on their side,
          // not in our config. When on, our local redeemer never sees the
          // winning balance — Polymarket pays out first, our on-chain query
          // runs afterward and sees zero shares.
          // Dust left behind by a maker-exit partial fill has already had its
          // realized outcome recorded by `finalizeClobExit`. Writing a second
          // outcome row here (typically -100% / expired_dust) would both
          // double-count the loss and mask the realized win. The partial-exit
          // marker on reconciliationStatus is the signal.
          const alreadyRecordedViaPartialExit =
            typeof pos.reconciliationStatus === 'string' &&
            pos.reconciliationStatus.startsWith('partial_exit:');
          if (alreadyRecordedViaPartialExit) {
            logger.info(
              '[redeemer] skipping expired-dust outcome — partial_exit already recorded a realized outcome',
              {
                marketId: pos.marketId,
                direction: pos.direction,
                reconciliationStatus: pos.reconciliationStatus,
                reportedBalance,
              },
            );
            await closePositionWithHedge(redis, pos.marketId, pos.direction);
            await markRecentlyClosed(redis, pos.marketId);
            await markRecentlyResolved(redis, pos.marketId);
            results.push({ marketId: pos.marketId, side, success: true });
            continue;
          }

          if (isDust || (reportedBalance ?? 0) <= 0.01) {
            // `isDust` can mean either "never really filled" (ledger shares ≈ 0,
            // like healed_mismatch remnants) OR "had a real position that
            // Polymarket auto-redeemed down to 0 balance" OR "had a real
            // position that got reconciler-healed to dust after a maker-exit
            // partial fill".
            //
            // Distinguishing gate: BOTH a positive original stake AND some
            // non-zero on-ledger share count must be present. Either signal
            // alone is insufficient:
            //   - `stakeUsd > X` alone: misclassifies recorded-but-never-
            //     filled entries (stakeUsd is persisted at signal time on
            //     some paths, before fill confirmation) as real positions.
            //   - `sharesHeld > 0.01` alone: the 2026-04-24 incident — a
            //     reconciler-healed winner has sharesHeld = 0.0044, below
            //     the threshold, so we'd miss the auto-redeemed-win branch.
            // Requiring `sharesHeld > 0` (any non-zero) catches healed-to-
            // dust positions (any real fill leaves residual shares in the
            // ledger even after a heal) AND excludes never-filled entries
            // (which have sharesHeld = 0 exactly). Pairing with a stake-
            // populated check rules out rows missing stakeUsd entirely.
            //
            // 2026-04-24 incident: an ETH Up-or-Down winner was healed from
            // 9.9944 → 0.0044 shares when a maker-exit sold 9.99 of our YES
            // to an external buyer; reading post-heal sharesHeld here with
            // the old > 0.01 threshold routed it to the `expired_dust`
            // −100% branch instead of the `auto_redeemed_win` branch.
            const stakePopulated =
              typeof pos.stakeUsd === 'number' &&
              Number.isFinite(pos.stakeUsd) &&
              pos.stakeUsd > 0;
            const sharesNonZero =
              typeof pos.sharesHeld === 'number' &&
              Number.isFinite(pos.sharesHeld) &&
              pos.sharesHeld > 0;
            const hadRealPosition = stakePopulated && sharesNonZero;
            const onChainOutcomeDust = await checkOnChainResolution(conditionId);
            if (onChainOutcomeDust) {
              const normalizedDirDust = isYesSide ? 'YES' : 'NO';
              const weWonDust = onChainOutcomeDust.outcome === normalizedDirDust;
              await closePositionWithHedge(redis, pos.marketId, pos.direction);
              await markRecentlyClosed(redis, pos.marketId);
              await markRecentlyResolved(redis, pos.marketId);
              if (weWonDust && hadRealPosition) {
                // Auto-redeemed win: Polymarket's CTF pays $1 per winning
                // share, so the realized return is (sharesHeld − stakeUsd) /
                // stakeUsd. We prefer this over (1 − entryPrice)/entryPrice
                // because stakeUsd + sharesHeld capture any fees/slippage the
                // entryPrice doesn't. Fall back to the entryPrice formula
                // when stake/shares are missing or invalid.
                const stakeSafe =
                  typeof pos.stakeUsd === 'number' &&
                  Number.isFinite(pos.stakeUsd) &&
                  pos.stakeUsd > 0;
                const entryPriceSafeDust =
                  typeof pos.entryPrice === 'number' &&
                  Number.isFinite(pos.entryPrice) &&
                  pos.entryPrice > 0;
                let returnPctDust: number;
                // Each winning share = $1 at resolution; use sharesHeld as proceeds.
                // `hadRealPosition` already guarantees sharesHeld is a positive finite number.
                const proceedsUsdcDust = pos.sharesHeld as number;
                if (stakeSafe && typeof pos.sharesHeld === 'number' && Number.isFinite(pos.sharesHeld)) {
                  returnPctDust = ((pos.sharesHeld - pos.stakeUsd) / pos.stakeUsd) * 100;
                } else if (entryPriceSafeDust) {
                  returnPctDust = ((1 - pos.entryPrice) / pos.entryPrice) * 100;
                } else {
                  returnPctDust = 0;
                }
                if (proceedsUsdcDust > 0) {
                  await creditProceeds(redis, proceedsUsdcDust);
                }
                await recordPositionOutcome(
                  redis,
                  { ...pos, question: q, direction: pmDirection },
                  {
                    result: 'won',
                    returnPct: returnPctDust,
                    executionVenueOverride: 'clob',
                    exitReason: 'auto_redeemed_win',
                  },
                );
                void notifyMarketResolved({
                  question: q,
                  direction: displayDir,
                  result: 'won',
                  stakeUsd: pos.stakeUsd,
                  ...(proceedsUsdcDust > 0 && { proceedsUsdc: proceedsUsdcDust }),
                  reason: 'auto-redeemed by Polymarket (zero balance post-resolution)',
                }).catch(() => {});
                results.push({ marketId: pos.marketId, side, success: true });
                logger.info('[redeemer] detected auto-redeemed win via dust/zero-balance path', {
                  marketId: pos.marketId,
                  direction: pos.direction,
                  entryPrice: pos.entryPrice,
                  sharesHeld: pos.sharesHeld,
                  proceedsUsdc: proceedsUsdcDust,
                  returnPct: returnPctDust.toFixed(2),
                });
                continue;
              }
              // Either on-chain confirms loss, or we never held a real position
              // (ledger dust without a prior meaningful fill).
              const exitReasonDust = hadRealPosition
                ? 'resolved_as_loss'
                : 'expired_dust';
              await recordPositionOutcome(
                redis,
                { ...pos, question: q, direction: pmDirection },
                {
                  result: 'lost',
                  returnPct: -100,
                  executionVenueOverride: 'clob',
                  exitReason: exitReasonDust,
                },
              );
              void notifyMarketResolved({
                question: q,
                direction: displayDir,
                result: 'lost',
                stakeUsd: pos.stakeUsd,
                reason: hadRealPosition
                  ? 'resolved (on-chain confirmed loss)'
                  : 'expired dust position',
              }).catch(() => {});
              results.push({
                marketId: pos.marketId,
                side,
                success: false,
                error: exitReasonDust,
              });
              continue;
            }
            // On-chain not yet settled.
            if (!hadRealPosition) {
              // Genuine dust (ledger never recorded real shares) with no
              // resolution yet: never going to become real. Close as expired_dust.
              await closePositionWithHedge(redis, pos.marketId, pos.direction);
              await markRecentlyClosed(redis, pos.marketId);
              await recordPositionOutcome(
                redis,
                { ...pos, question: q, direction: pmDirection },
                {
                  result: 'lost',
                  returnPct: -100,
                  executionVenueOverride: 'clob',
                  exitReason: 'expired_dust',
                },
              );
              void notifyMarketResolved({
                question: q,
                direction: displayDir,
                result: 'lost',
                stakeUsd: pos.stakeUsd,
                reason: 'expired dust position',
              }).catch(() => {});
              results.push({
                marketId: pos.marketId,
                side,
                success: false,
                error: 'expired_dust',
              });
              continue;
            }
            // We held a real position; balance is 0 but CTF hasn't finalized yet.
            // Previously this wrote -100% 'expired_unresolvable' immediately,
            // silently marking auto-redeemed wins as losses whenever CTF payout
            // data lagged Polymarket's backend. Retry next cycle so we can
            // distinguish win from loss correctly when on-chain settles.
            logger.info(
              '[redeemer] zero balance on expired real position — on-chain not yet settled, retrying',
              {
                marketId: pos.marketId,
                direction: pos.direction,
                sharesHeld: pos.sharesHeld,
                endDate: pos.endDate,
              },
            );
            continue;
          }

          // Verify the on-chain outcome before attempting redemption. The CTF
          // contract's redeemPositions() lands successfully even for losing outcomes
          // (paying 0 proceeds), so a success=true tx is not evidence of a win.
          // If the denominator is still 0 (not yet settled), skip and retry next cycle
          // rather than firing a false-win notification.
          const onChainOutcome = await checkOnChainResolution(conditionId);
          if (!onChainOutcome) {
            logger.info('[redeemer] expired CLOB position not yet settled on-chain — will retry', {
              marketId: pos.marketId,
              direction: pos.direction,
              endDate: pos.endDate,
            });
            continue;
          }

          const normalizedDirExpired = isYesSide ? 'YES' : 'NO';
          const wonExpired = onChainOutcome.outcome === normalizedDirExpired;

          if (!wonExpired) {
            await closePositionWithHedge(redis, pos.marketId, pos.direction);
            await markRecentlyClosed(redis, pos.marketId);
            await markRecentlyResolved(redis, pos.marketId);
            await recordPositionOutcome(
              redis,
              { ...pos, question: q, direction: pmDirection },
              { result: 'lost', returnPct: -100, executionVenueOverride: 'clob', exitReason: 'expired_unresolvable' },
            );
            if (shouldNotifyExpiredResolution(pos.endDate)) {
              void notifyMarketResolved({
                question: q,
                direction: displayDir,
                result: 'lost',
                stakeUsd: pos.stakeUsd,
                reason: 'expired (Gamma unresolvable)',
              }).catch(() => {});
            } else {
              logger.info('[redeemer] suppressed stale expired-resolution notification', {
                marketId: pos.marketId,
                direction: pos.direction,
                endDate: pos.endDate,
                exitReason: 'expired_unresolvable',
              });
            }
            results.push({ marketId: pos.marketId, side, success: false, error: 'expired_unresolvable' });
            continue;
          }

          // Won — attempt on-chain redemption.
          const redeemResult = await redeemClobOutcome({ conditionId, direction: normalizedDirExpired });

          if (!redeemResult.success) {
            logger.warn('[redeemer] on-chain redemption failed for expired position — will retry next cycle', {
              marketId: pos.marketId,
              error: redeemResult.error,
            });
            results.push({ marketId: pos.marketId, side, success: false, error: 'redemption_rpc_error' });
            continue;
          }

          const entryPriceSafe =
            typeof pos.entryPrice === 'number' &&
            Number.isFinite(pos.entryPrice) &&
            pos.entryPrice > 0;
          const proceedsUsdc =
            typeof preBalance === 'number' && Number.isFinite(preBalance) && preBalance > 0
              ? preBalance
              : typeof pos.sharesHeld === 'number' && Number.isFinite(pos.sharesHeld) && pos.sharesHeld > 0
                ? pos.sharesHeld
                : typeof pos.stakeUsd === 'number' && Number.isFinite(pos.stakeUsd) && entryPriceSafe
                  ? pos.stakeUsd / pos.entryPrice
                  : null;

          if (!(typeof proceedsUsdc === 'number' && Number.isFinite(proceedsUsdc) && proceedsUsdc > 0)) {
            logger.error(
              '[redeemer] redeemed expired position but could not determine proceeds — leaving open for manual review',
              {
                marketId: pos.marketId,
                preBalance,
                sharesHeld: pos.sharesHeld,
                entryPrice: pos.entryPrice,
                stakeUsd: pos.stakeUsd,
                txHash: redeemResult.tx_hash,
              },
            );
            // Prevent repeated on-chain redemption attempts — the tx already landed.
            await markRecentlyClosed(redis, pos.marketId);
            await markRecentlyResolved(redis, pos.marketId);
            results.push({ marketId: pos.marketId, side, success: false, error: 'redemption_proceeds_unknown' });
            continue;
          }

          await creditProceeds(redis, proceedsUsdc);
          await closePositionWithHedge(redis, pos.marketId, pos.direction);
          await markRecentlyClosed(redis, pos.marketId);
          await markRecentlyResolved(redis, pos.marketId);

          await recordPositionOutcome(
            redis,
            { ...pos, question: q, direction: pmDirection },
            {
              result: 'won',
              returnPct: pos.stakeUsd > 0 ? ((proceedsUsdc - pos.stakeUsd) / pos.stakeUsd) * 100 : 0,
              executionVenueOverride: 'clob',
              exitReason: 'expired_unresolvable_redeemed',
            },
          );
          await notifyRedemptionExecuted({
            marketId: pos.marketId,
            question: q,
            side,
            valueUsdc: proceedsUsdc,
            stakeUsd: pos.stakeUsd,
            displayDirection: displayDir,
            ...(redeemResult.tx_hash ? { txHash: redeemResult.tx_hash } : {}),
          });
          results.push({
            marketId: pos.marketId,
            side,
            success: true,
            valueUsdc: proceedsUsdc,
            ...(redeemResult.tx_hash ? { txHash: redeemResult.tx_hash } : {}),
          });
        } else if (!pos.endDate) {
          // No endDate stored and Gamma can't find the market — fall back to
          // direct on-chain resolution. This handles oracle-lag and sports positions
          // entered before endDate was reliably persisted.
          logger.info('[redeemer] CLOB position missing endDate — checking on-chain directly', {
            marketId: pos.marketId,
            conditionId,
          });
          const onChainFallback = await checkOnChainResolution(conditionId);
          await new Promise((r) => setTimeout(r, 200));
          if (!onChainFallback) {
            // Not yet settled on-chain — skip and retry next cycle.
            continue;
          }

          const q = pos.question || pos.marketId;
          const displayDir =
            pos.sourcedFrom?.startsWith('oracle-lag')
              ? pos.direction === 'YES'
                ? 'UP'
                : pos.direction === 'NO'
                  ? 'DOWN'
                  : pos.direction
              : pos.direction;
          const normalizedDir = isYesSide ? 'YES' : 'NO';
          const wonFallback = onChainFallback.outcome === normalizedDir;

          logger.info('[redeemer] closing no-endDate CLOB position via on-chain fallback', {
            marketId: pos.marketId,
            direction: pos.direction,
            outcome: onChainFallback.outcome,
            wonFallback,
            isDust,
          });

          if (!wonFallback) {
            await closePositionWithHedge(redis, pos.marketId, pos.direction);
            await markRecentlyClosed(redis, pos.marketId);
            await markRecentlyResolved(redis, pos.marketId);
            await recordPositionOutcome(
              redis,
              { ...pos, question: q, direction: pmDirection },
              {
                result: 'lost',
                returnPct: -100,
                executionVenueOverride: 'clob',
                exitReason: 'no_end_date_on_chain_resolved',
              },
            );
            void notifyMarketResolved({
              question: q,
              direction: displayDir,
              result: 'lost',
              stakeUsd: pos.stakeUsd,
              reason: 'on-chain settled (no endDate stored)',
            }).catch(() => {});
            results.push({ marketId: pos.marketId, side, success: false, error: 'no_end_date_on_chain_resolved' });
            continue;
          }

          // Dust + won: zero token balance on a resolved market almost always means
          // Polymarket's auto-redeemer already paid out the win (tokens burned → USDC
          // sent). Apply the same hadRealPosition gate used in the regular expired path.
          if (isDust) {
            const stakePopulated =
              typeof pos.stakeUsd === 'number' && Number.isFinite(pos.stakeUsd) && pos.stakeUsd > 0;
            const sharesNonZero =
              typeof pos.sharesHeld === 'number' && Number.isFinite(pos.sharesHeld) && pos.sharesHeld > 0;
            const hadRealPosition = stakePopulated && sharesNonZero;

            await closePositionWithHedge(redis, pos.marketId, pos.direction);
            await markRecentlyClosed(redis, pos.marketId);
            await markRecentlyResolved(redis, pos.marketId);

            if (hadRealPosition) {
              // Auto-redeemed win: calculate return from ledger shares (same formula as regular path).
              // sharesHeld may be reconciler-healed to dust, so don't pass it as proceedsUsdc —
              // we can't verify the actual payout amount here.
              const entryPriceSafe =
                typeof pos.entryPrice === 'number' && Number.isFinite(pos.entryPrice) && pos.entryPrice > 0;
              let returnPct: number;
              if (typeof pos.sharesHeld === 'number' && Number.isFinite(pos.sharesHeld)) {
                returnPct = ((pos.sharesHeld - pos.stakeUsd) / pos.stakeUsd) * 100;
              } else if (entryPriceSafe) {
                returnPct = ((1 - pos.entryPrice) / pos.entryPrice) * 100;
              } else {
                returnPct = 0;
              }
              await recordPositionOutcome(
                redis,
                { ...pos, question: q, direction: pmDirection },
                {
                  result: 'won',
                  returnPct,
                  executionVenueOverride: 'clob',
                  exitReason: 'no_end_date_auto_redeemed_win',
                },
              );
              void notifyMarketResolved({
                question: q,
                direction: displayDir,
                result: 'won',
                stakeUsd: pos.stakeUsd,
                reason: 'auto-redeemed by Polymarket (no endDate stored)',
              }).catch(() => {});
              results.push({ marketId: pos.marketId, side, success: true });
              logger.info('[redeemer] detected auto-redeemed win via no-endDate dust path', {
                marketId: pos.marketId,
                direction: pos.direction,
                returnPct: returnPct.toFixed(2),
              });
            } else {
              // Genuine dust (never really filled): close as loss.
              await recordPositionOutcome(
                redis,
                { ...pos, question: q, direction: pmDirection },
                {
                  result: 'lost',
                  returnPct: -100,
                  executionVenueOverride: 'clob',
                  exitReason: 'no_end_date_dust_closed',
                },
              );
              void notifyMarketResolved({
                question: q,
                direction: displayDir,
                result: 'lost',
                stakeUsd: pos.stakeUsd,
                reason: 'dust position, on-chain settled (no endDate stored)',
              }).catch(() => {});
              results.push({ marketId: pos.marketId, side, success: false, error: 'no_end_date_dust_closed' });
            }
            continue;
          }

          // Won — attempt on-chain redemption.
          const redeemFallback = await redeemClobOutcome({ conditionId, direction: normalizedDir });
          if (!redeemFallback.success) {
            logger.warn('[redeemer] on-chain redemption failed for no-endDate position — will retry next cycle', {
              marketId: pos.marketId,
              error: redeemFallback.error,
            });
            results.push({ marketId: pos.marketId, side, success: false, error: 'redemption_rpc_error' });
            continue;
          }

          const entryPriceSafeFb =
            typeof pos.entryPrice === 'number' && Number.isFinite(pos.entryPrice) && pos.entryPrice > 0;
          const proceedsUsdcFb =
            typeof preBalance === 'number' && Number.isFinite(preBalance) && preBalance > 0
              ? preBalance
              : typeof pos.sharesHeld === 'number' && Number.isFinite(pos.sharesHeld) && pos.sharesHeld > 0
                ? pos.sharesHeld
                : typeof pos.stakeUsd === 'number' && Number.isFinite(pos.stakeUsd) && entryPriceSafeFb
                  ? pos.stakeUsd / pos.entryPrice
                  : null;

          if (!(typeof proceedsUsdcFb === 'number' && Number.isFinite(proceedsUsdcFb) && proceedsUsdcFb > 0)) {
            logger.error(
              '[redeemer] redeemed no-endDate position but could not determine proceeds — closing with zero return',
              {
                marketId: pos.marketId,
                preBalance,
                sharesHeld: pos.sharesHeld,
                txHash: redeemFallback.tx_hash,
              },
            );
            // Close the position now so it cannot re-fire as a false loss after
            // markRecentlyResolved's TTL expires on a future cycle.
            await closePositionWithHedge(redis, pos.marketId, pos.direction);
            await markRecentlyClosed(redis, pos.marketId);
            await markRecentlyResolved(redis, pos.marketId);
            await recordPositionOutcome(
              redis,
              { ...pos, question: q, direction: pmDirection },
              { result: 'won', returnPct: 0, executionVenueOverride: 'clob', exitReason: 'redemption_proceeds_unknown' },
            );
            results.push({ marketId: pos.marketId, side, success: false, error: 'redemption_proceeds_unknown' });
            continue;
          }

          await creditProceeds(redis, proceedsUsdcFb);
          await closePositionWithHedge(redis, pos.marketId, pos.direction);
          await markRecentlyClosed(redis, pos.marketId);
          await markRecentlyResolved(redis, pos.marketId);
          await recordPositionOutcome(
            redis,
            { ...pos, question: q, direction: pmDirection },
            {
              result: 'won',
              returnPct: pos.stakeUsd > 0 ? ((proceedsUsdcFb - pos.stakeUsd) / pos.stakeUsd) * 100 : 0,
              executionVenueOverride: 'clob',
              exitReason: 'no_end_date_on_chain_redeemed',
            },
          );
          await notifyRedemptionExecuted({
            marketId: pos.marketId,
            question: q,
            side,
            valueUsdc: proceedsUsdcFb,
            stakeUsd: pos.stakeUsd,
            displayDirection: displayDir,
            ...(redeemFallback.tx_hash ? { txHash: redeemFallback.tx_hash } : {}),
          });
          results.push({
            marketId: pos.marketId,
            side,
            success: true,
            valueUsdc: proceedsUsdcFb,
            ...(redeemFallback.tx_hash ? { txHash: redeemFallback.tx_hash } : {}),
          });
        }
        continue;
      }

      const resolvedQuestion =
        pos.question && pos.question.trim().length > 0
          ? pos.question
          : (resolved.question ?? pos.marketId);

      logger.info('[redeemer] CLOB market resolved', {
        marketId: pos.marketId,
        conditionId: conditionId,
        outcome: resolved.outcome,
        direction: pos.direction,
      });

      // checkMarketResolved() returns YES/NO; map UP→YES, DOWN→NO for comparison
      const normalizedDirection = isYesSide ? 'YES' : 'NO';
      const won = resolved.outcome === normalizedDirection;

      // Dust positions: close the zombie ledger entry without on-chain redemption.
      // The fill was negligible (sub-$0.25) so there's nothing to redeem.
      if (isDust) {
        // Partial-exit residual: `finalizeClobExit` already recorded the
        // realized outcome. Close the ledger and move on — re-recording here
        // would double-count (same root cause as the !resolved branch above).
        const alreadyRecordedViaPartialExit =
          typeof pos.reconciliationStatus === 'string' &&
          pos.reconciliationStatus.startsWith('partial_exit:');
        if (alreadyRecordedViaPartialExit) {
          logger.info(
            '[redeemer] skipping resolved-dust outcome — partial_exit already recorded a realized outcome',
            {
              marketId: pos.marketId,
              direction: pos.direction,
              reconciliationStatus: pos.reconciliationStatus,
              outcome: resolved.outcome,
              won,
              dustBalance: reportedBalance,
            },
          );
          await closePositionWithHedge(redis, pos.marketId, pos.direction);
          await markRecentlyClosed(redis, pos.marketId);
          await markRecentlyResolved(redis, pos.marketId);
          results.push({ marketId: pos.marketId, side, success: true });
          continue;
        }

        logger.info('[redeemer] closing dust CLOB position after resolution', {
          marketId: pos.marketId,
          direction: pos.direction,
          outcome: resolved.outcome,
          won,
          dustBalance: reportedBalance,
        });
        await closePositionWithHedge(redis, pos.marketId, pos.direction);
        await markRecentlyClosed(redis, pos.marketId);
        await markRecentlyResolved(redis, pos.marketId);
        await recordPositionOutcome(
          redis,
          { ...pos, question: resolvedQuestion, direction: pmDirection },
          {
            result: won ? 'won' : 'lost',
            // dust fill ≈ total loss regardless of outcome
            returnPct: -100,
            executionVenueOverride: 'clob',
            exitReason: 'resolved_dust_closed',
          },
        );
        void notifyMarketResolved({
          question: resolvedQuestion,
          direction: pos.direction,
          result: won ? 'won' : 'lost',
          stakeUsd: pos.stakeUsd,
          reason: 'dust position closed on resolution',
        }).catch(() => {});
        results.push({ marketId: pos.marketId, side, success: false, error: 'resolved_dust_closed' });
        continue;
      }

      if (!won) {
        // Market resolved against us — close ledger entry without redeeming
        logger.info('[redeemer] CLOB position resolved as loss, closing ledger', {
          marketId: pos.marketId,
          direction: pos.direction,
          outcome: resolved.outcome,
        });
        await closePositionWithHedge(redis, pos.marketId, pos.direction);
        await markRecentlyResolved(redis, pos.marketId);
        await recordPositionOutcome(
          redis,
          { ...pos, question: resolvedQuestion, direction: pmDirection },
          {
            result: 'lost',
            returnPct: -100,
            executionVenueOverride: 'clob',
            exitReason: 'resolved_as_loss',
          },
        );
        void notifyMarketResolved({
          question: resolvedQuestion,
          direction: pos.direction,
          result: 'lost',
          stakeUsd: pos.stakeUsd,
        }).catch(() => {});
        results.push({ marketId: pos.marketId, side, success: false, error: 'resolved_as_loss' });
        continue;
      }

      // On-chain redemption for CLOB positions
      logger.info('[redeemer] attempting on-chain CLOB redemption', {
        marketId: pos.marketId,
        conditionId: conditionId,
      });

      const redeemResult = await redeemClobOutcome({
        conditionId: conditionId,
        direction: normalizedDirection,
      });

      if (!redeemResult.success) {
        if (redeemResult.error === 'MAGIC_PROXY_MANUAL_REDEEM_REQUIRED') {
          logger.warn(
            '[redeemer] sigType=1: CLOB position requires manual redemption on polymarket.com',
            {
              marketId: pos.marketId,
              conditionId: conditionId,
              direction: pmDirection,
            },
          );
          if (await shouldNotifyManual(redis, conditionId)) {
            void notifyManualRedemptionRequired({
              conditionId: conditionId,
              direction: normalizedDirection,
              question: resolvedQuestion,
              ...(pos.sharesHeld != null && { estimatedUsdc: pos.sharesHeld }),
            }).catch(() => {});
          }
          // Close the ledger entry so we don't re-alert every cycle
          await closePositionWithHedge(redis, pos.marketId, pos.direction);
          await markRecentlyResolved(redis, pos.marketId);
        } else {
          logger.warn('[redeemer] on-chain CLOB redemption failed — will retry next cycle', {
            marketId: pos.marketId,
            error: redeemResult.error,
          });
          const errLower = (redeemResult.error ?? '').toLowerCase();
          if (
            errLower.includes('already redeemed') ||
            errLower.includes('position may already be redeemed') ||
            errLower.includes('balance is 0')
          ) {
            await markFallbackStale(redis, conditionId, side, cfg);
            logRedeemerSkip('stale_no_balance', conditionId, {
              marketId: pos.marketId,
              error: redeemResult.error,
            });
          }
        }
        results.push({
          marketId: pos.marketId,
          side,
          success: false,
          error: redeemResult.error ?? 'Unknown error',
        });
        continue;
      }

      // Close the position in Redis after successful redemption
      await closePositionWithHedge(redis, pos.marketId, pos.direction);
      await markRecentlyResolved(redis, pos.marketId);

      // Credit shares as USDC (each winning share = $1) — losses already handled above
      const entryPriceSafe = pos.entryPrice > 0 && Number.isFinite(pos.entryPrice);
      if (!entryPriceSafe && pos.sharesHeld == null) {
        logger.warn('[redeemer] entryPrice is zero/invalid — using 0 proceeds', {
          marketId: pos.marketId,
        });
      }
      const proceedsUsdc = pos.sharesHeld ?? (entryPriceSafe ? pos.stakeUsd / pos.entryPrice : 0);

      if (proceedsUsdc > 0) {
        await creditProceeds(redis, proceedsUsdc);
      }
      const postBalance = await refreshTokenBalance(tokenId);
      await markRedeemerSuccess(
        redis,
        conditionId,
        side,
        proceedsUsdc,
        postBalance ?? 0,
        cfg,
        redeemResult.tx_hash ?? undefined,
      );
      logRedemptionOutcome(conditionId, classifyRedemptionStatus(postBalance, cfg), {
        marketId: pos.marketId,
        postBalance,
      });

      // Record outcome (Phase 8)
      await recordPositionOutcome(
        redis,
        { ...pos, question: resolvedQuestion },
        {
          result: won ? 'won' : 'lost',
          returnPct: pos.stakeUsd ? ((proceedsUsdc - pos.stakeUsd) / pos.stakeUsd) * 100 : 0,
          executionVenueOverride: pos.executionVenue ?? 'clob',
          exitReason: 'clob_on_chain_redeemed',
        },
      );

      // Notify — derive user-facing direction label for oracle-lag positions
      const notifyDisplayDir =
        pos.sourcedFrom?.startsWith('oracle-lag')
          ? pos.direction === 'YES' ? 'UP' : pos.direction === 'NO' ? 'DOWN' : pos.direction
          : pos.direction;
      await notifyRedemptionExecuted({
        marketId: pos.marketId,
        question: resolvedQuestion,
        side,
        valueUsdc: proceedsUsdc,
        stakeUsd: pos.stakeUsd,
        displayDirection: notifyDisplayDir,
        ...(redeemResult.tx_hash ? { txHash: redeemResult.tx_hash } : {}),
      });

      logger.info('[redeemer] CLOB position redeemed', {
        marketId: pos.marketId,
        side,
        won,
        valueUsdc: proceedsUsdc,
      });

      results.push({
        marketId: pos.marketId,
        side,
        success: true,
        valueUsdc: proceedsUsdc,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('[redeemer] CLOB position resolution check failed', {
        marketId: pos.marketId,
        error: message,
      });
      results.push({ marketId: pos.marketId, side, success: false, error: message });
    }
  }
}

/**
 * Check whether a market has resolved via the Gamma API.
 *
 * Gamma's `condition_id` query parameter is unreliable (returns unrelated markets),
 * so we prefer `clob_token_ids` when a token ID is available. Falls back to
 * on-chain payout checks when Gamma returns no usable data.
 *
 * Returns null if the market is still active, or the outcome if resolved.
 */
async function checkMarketResolved(
  conditionId: string,
  clobTokenId?: string,
): Promise<{ outcome: 'YES' | 'NO'; question?: string } | null> {
  try {
    // Gamma's condition_id query parameter is broken (returns unrelated markets).
    // Only call Gamma when we have a reliable clob_token_ids lookup.
    // Otherwise skip straight to the on-chain payout check.
    if (!clobTokenId) {
      logger.debug('[redeemer] no clobTokenId — skipping Gamma, checking on-chain', { conditionId });
      return checkOnChainResolution(conditionId);
    }

    const url = `https://gamma-api.polymarket.com/markets?clob_token_ids=${encodeURIComponent(clobTokenId)}`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      logger.warn('[redeemer] Gamma API returned non-OK', { status: resp.status, conditionId });
      return null;
    }

    const data = (await resp.json()) as {
      closed?: boolean;
      resolved?: boolean;
      outcome?: string;
      outcomePrices?: string;
      outcomes?: string;
      question?: string;
      title?: string;
    }[];

    const market = data[0];
    if (!market) return null;

    if (!market.resolved && !market.closed) return null;

    const question =
      typeof market.question === 'string'
        ? market.question
        : typeof market.title === 'string'
          ? market.title
          : undefined;

    // Gamma does NOT return an `outcome` field on resolved markets.
    // The winner is determined from `outcomePrices`: the winning outcome has price "1",
    // the losing outcome has price "0". outcomes[0] = YES, outcomes[1] = NO.
    // e.g. outcomePrices: ["0", "1"] means NO won.
    if (market.outcomePrices) {
      try {
        const prices: string[] = JSON.parse(market.outcomePrices) as string[];
        const yesPrice = parseFloat(prices[0] ?? '0');
        const noPrice = parseFloat(prices[1] ?? '0');

        if (yesPrice === 1) return question ? { outcome: 'YES', question } : { outcome: 'YES' };
        if (noPrice === 1) return question ? { outcome: 'NO', question } : { outcome: 'NO' };

        // Both non-1: market closed but not yet settled on-chain.
        // Polymarket settles on-chain after the resolution window (can take hours/days).
        // This is expected — downgrade to debug to avoid log spam every 5 min.
        logger.debug('[redeemer] market closed but outcomePrices not yet settled — will retry', {
          conditionId,
          outcomePrices: market.outcomePrices,
        });
        // Gamma hasn't updated outcomePrices yet — check on-chain directly.
        // The CTF contract's payoutDenominator is set when reportPayouts() is called.
        const onChain = await checkOnChainResolution(conditionId);
        return onChain ? (question ? { ...onChain, question } : onChain) : null;
      } catch {
        logger.warn('[redeemer] failed to parse outcomePrices', {
          conditionId,
          outcomePrices: market.outcomePrices,
        });
        return null;
      }
    }

    // Legacy fallback: some older markets may still have an outcome field
    const outcomeStr = (market.outcome ?? '').toUpperCase();
    if (outcomeStr === 'YES' || outcomeStr === 'NO') {
      return question ? { outcome: outcomeStr, question } : { outcome: outcomeStr };
    }

    logger.warn('[redeemer] market resolved but outcome not determinable', { conditionId });
    return null;
  } catch (err) {
    logger.warn('[redeemer] Gamma market check failed', {
      conditionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * On-chain fallback: query the CTF contract directly for payout resolution.
 *
 * Used when Gamma API returns outcomePrices ["0","0"] for a closed market —
 * the on-chain reportPayouts() may already have been called.
 */
async function checkOnChainResolution(
  conditionId: string,
): Promise<{ outcome: 'YES' | 'NO' } | null> {
  const ctfAbi = [
    'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  ];

  // Build RPC list (same pattern as clob.ts)
  const cfg = loadConfig();
  const rpcUrls: string[] = [
    ...(cfg.POLYGON_RPC_URL ? [cfg.POLYGON_RPC_URL] : []),
    ...POLYGON_FALLBACK_RPCS.filter((r) => r !== cfg.POLYGON_RPC_URL),
  ];

  for (const rpcUrl of rpcUrls) {
    try {
      const provider = getPolygonProvider(rpcUrl);
      const ctf = new Contract(CTF_ADDRESS, ctfAbi, provider) as Contract & {
        payoutDenominator(conditionId: string): Promise<bigint>;
        payoutNumerators(conditionId: string, index: number): Promise<bigint>;
      };

      const denominator: bigint = await ctf.payoutDenominator(conditionId);
      if (denominator === 0n) {
        // Not resolved on-chain yet either
        return null;
      }

      const yesNumerator: bigint = await ctf.payoutNumerators(conditionId, 0);
      const noNumerator: bigint = await ctf.payoutNumerators(conditionId, 1);

      if (yesNumerator > 0n && noNumerator === 0n) {
        logger.info('[redeemer] on-chain resolution detected (Gamma lagging)', {
          conditionId,
          outcome: 'YES',
        });
        return { outcome: 'YES' };
      }
      if (noNumerator > 0n && yesNumerator === 0n) {
        logger.info('[redeemer] on-chain resolution detected (Gamma lagging)', {
          conditionId,
          outcome: 'NO',
        });
        return { outcome: 'NO' };
      }

      // Both non-zero or both zero after denominator > 0 — unusual, log and skip
      logger.warn('[redeemer] on-chain payouts ambiguous', {
        conditionId,
        yesNumerator: yesNumerator.toString(),
        noNumerator: noNumerator.toString(),
      });
      return null;
    } catch (err) {
      logger.warn('[redeemer] on-chain resolution check failed — trying next RPC', {
        conditionId,
        rpcUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      resetPolygonProvider();
      continue;
    }
  }

  logger.warn('[redeemer] all RPCs failed for on-chain resolution check', { conditionId });
  return null;
}

/**
 * Orphan CLOB sweep.
 *
 * Queries the CLOB trades API for all BUY trades made by this account.
 * For each unique token, checks the on-chain conditional token balance.
 * If balance > 0 and the market has resolved in our favour, redeems it.
 *
 * This catches positions that executed on-chain but were never written to Redis
 * (e.g. due to a response-parsing crash before recordPosition was called).
 */
async function redeemOrphanClobPositions(
  results: RedemptionResult[],
  alreadyRedeemed: Set<string>,
  cfg: AppConfig,
): Promise<void> {
  if (!cfg.POLYGON_WALLET_PRIVATE_KEY) return;

  const funderAddress =
    cfg.POLYMARKET_FUNDER_ADDRESS ?? new Wallet(cfg.POLYGON_WALLET_PRIVATE_KEY).address;

  let client: Awaited<ReturnType<typeof getClobClient>>;
  try {
    client = await getClobClient();
  } catch (err) {
    logger.warn('[redeemer] orphan sweep: failed to get CLOB client', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Pull all BUY trades for this account (paginated, up to 500)
  let trades: {
    asset_id: string;
    market: string;
    side: string;
    size: string;
    outcome: string;
  }[] = [];
  try {
    const raw = await client.getTrades({ maker_address: funderAddress });
    trades = (raw ?? []) as typeof trades;
  } catch (err) {
    logger.warn('[redeemer] orphan sweep: failed to fetch trades', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (trades.length === 0) return;

  // Net up token balances from trade history: BUY adds, SELL subtracts.
  // Key: asset_id (token ID) → { conditionId (market), netShares, outcome ('Yes'|'No') }
  const tokenMap = new Map<string, { conditionId: string; outcome: string; netShares: number }>();
  for (const t of trades) {
    const size = parseFloat(t.size);
    if (!isFinite(size) || size <= 0) continue;
    const existing = tokenMap.get(t.asset_id);
    const delta = t.side === 'BUY' ? size : -size;
    if (existing) {
      existing.netShares += delta;
    } else {
      tokenMap.set(t.asset_id, { conditionId: t.market, outcome: t.outcome, netShares: delta });
    }
  }

  // Load previously notified manual-claim conditionIds from Redis (TTL 30 days)
  const redis = getRedis();
  // Filter to tokens where net > 0 (still holding), and not already redeemed this cycle
  const candidates = [...tokenMap.entries()]
    .filter(([, v]) => v.netShares > 0.001)
    .filter(([, v]) => !alreadyRedeemed.has(v.conditionId));

  if (candidates.length === 0) return;

  logger.info('[redeemer] orphan sweep: checking on-chain balances', { count: candidates.length });

  for (const [tokenId, { conditionId, outcome }] of candidates) {
    try {
      // outcome from trades API is 'Yes' or 'No' (mixed case)
      const direction = outcome.toUpperCase() as 'YES' | 'NO';
      const side = direction.toLowerCase() as 'yes' | 'no';

      // Check actual on-chain balance — trade history may be stale
      const balResult = await fetchClobTokenBalance(tokenId);
      if (!balResult.ok || balResult.balance <= 0) continue;

      const skipReason = await shouldSkipRedeemer(redis, conditionId, side, balResult.balance, cfg);
      if (skipReason) {
        logRedeemerSkip(skipReason, conditionId, {
          marketId: conditionId,
          onChainBalance: balResult.balance,
        });
        continue;
      }

      // Check if market resolved and in our favour — pass tokenId for reliable Gamma lookup
      const resolved = await checkMarketResolved(conditionId, tokenId);
      await sleep(200); // rate-limit Gamma calls

      if (!resolved) continue;
      const resolvedQuestion = resolved.question ?? conditionId;
      if (resolved.outcome !== direction) {
        // Lost — tokens will expire worthless, nothing to redeem
        logger.debug('[redeemer] orphan sweep: resolved as loss', {
          conditionId,
          direction,
          outcome: resolved.outcome,
        });
        // Close matching ledger entry if one exists
        const openPositions = await getOpenPositions(redis);
        const ledgerEntry = openPositions.find((p) => p.conditionId === conditionId);
        if (ledgerEntry) {
          logger.info('[redeemer] orphan sweep: closing ledger entry for losing position', {
            conditionId,
            marketId: ledgerEntry.marketId,
            direction: ledgerEntry.direction,
          });
          await closePositionWithHedge(redis, ledgerEntry.marketId, ledgerEntry.direction);
          await markRecentlyResolved(redis, ledgerEntry.marketId);
          await recordPositionOutcome(
            redis,
            { ...ledgerEntry, question: resolvedQuestion, direction },
            {
              result: 'lost',
              returnPct: -100,
              executionVenueOverride: 'clob',
              exitReason: 'orphan_sweep_lost',
            },
          );
        }
        continue;
      }

      logger.info('[redeemer] orphan sweep: found unredeemed winning position', {
        conditionId,
        direction,
        tokenId: tokenId.slice(0, 20) + '...',
        onChainBalance: balResult.balance,
      });

      const redeemResult = await redeemClobOutcome({ conditionId, direction });

      if (redeemResult.success) {
        alreadyRedeemed.add(conditionId);
        const valueUsdc = balResult.balance; // 1 winning token = 1 USDC
        await creditProceeds(redis, valueUsdc);
        const postBalance = await refreshTokenBalance(tokenId);
        await markRedeemerSuccess(
          redis,
          conditionId,
          side,
          valueUsdc,
          postBalance ?? 0,
          cfg,
          redeemResult.tx_hash,
        );
        logRedemptionOutcome(conditionId, classifyRedemptionStatus(postBalance, cfg), {
          conditionId,
          postBalance,
        });

        const notifyOpts: Parameters<typeof notifyRedemptionExecuted>[0] = {
          marketId: conditionId,
          question: resolvedQuestion,
          side: direction.toLowerCase() as 'yes' | 'no',
          valueUsdc,
        };
        if (redeemResult.tx_hash) notifyOpts.txHash = redeemResult.tx_hash;
        await notifyRedemptionExecuted(notifyOpts);

        logger.info('[redeemer] orphan sweep: redemption successful', {
          conditionId,
          direction,
          valueUsdc,
          txHash: redeemResult.tx_hash,
        });

        results.push({
          marketId: conditionId,
          side: direction.toLowerCase() as 'yes' | 'no',
          success: true,
          valueUsdc,
          ...(redeemResult.tx_hash ? { txHash: redeemResult.tx_hash } : {}),
        });
      } else if (redeemResult.error === 'MAGIC_PROXY_MANUAL_REDEEM_REQUIRED') {
        logger.warn('[redeemer] orphan sweep: sigType=1 — manual claim required', {
          conditionId,
          direction,
          onChainBalance: balResult.balance,
        });
        if (await shouldNotifyManual(redis, conditionId)) {
          void notifyManualRedemptionRequired({
            conditionId,
            direction,
            question: resolvedQuestion,
            estimatedUsdc: balResult.balance,
          }).catch(() => {});
        }
        alreadyRedeemed.add(conditionId);
        results.push({
          marketId: conditionId,
          side: direction.toLowerCase() as 'yes' | 'no',
          success: false,
          error: redeemResult.error,
        });
      } else {
        logger.warn('[redeemer] orphan sweep: redemption failed', {
          conditionId,
          error: redeemResult.error,
        });
        results.push({
          marketId: conditionId,
          side: direction.toLowerCase() as 'yes' | 'no',
          success: false,
          error: redeemResult.error ?? 'orphan_redeem_failed',
        });
      }

      await sleep(1_000); // pace redemptions
    } catch (err) {
      logger.warn('[redeemer] orphan sweep: error processing token', {
        tokenId: tokenId.slice(0, 20),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
