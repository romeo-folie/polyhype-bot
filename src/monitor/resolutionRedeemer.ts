/**
 * Resolution redeemer.
 *
 * Checks Simmer for any resolved (won) positions and redeems them for USDC.e.
 * Also checks CLOB positions tracked in Redis that are not visible to Simmer.
 *
 * Flow:
 *   1. GET /api/sdk/positions?status=resolved&venue=polymarket (Simmer)
 *   2. Filter to redeemable=true
 *   3. POST /api/sdk/redeem for each — Simmer signs + broadcasts for managed wallets
 *   4. Remove redeemed positions from Redis ledger
 *   5. Credit proceeds to bankroll and notify Telegram
 *   6. Check Redis for CLOB-venue positions and resolve independently
 *
 * Rate limit: Simmer redeem is 10/minute. We process sequentially to stay within limits.
 */

import { Contract } from 'ethers';
import { logger } from '../shared/logger.js';
import {
  getSimmerPositions,
  submitRedeem,
  resolveSimmerMarketId,
  SimmerError,
} from '../shared/simmer.js';
import { closePosition, getOpenPositions, getPosition } from '../execution/positionLedger.js';
import type { Position } from '../execution/positionLedger.js';
import {
  redeemClobOutcome,
  getPolygonProvider,
  resetPolygonProvider,
  getClobClient,
  fetchClobTokenBalance,
} from '../shared/clob.js';
import { creditProceeds } from '../shared/bankroll.js';
import { notifyRedemptionExecuted, notifyManualRedemptionRequired } from '../execution/telegram.js';
import { recordOutcome, inferCategory, inferSource } from '../shared/outcomeRecorder.js';
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

const REDEEM_DELAY_MS = 6_500; // ~9/min, safely under Simmer's 10/min limit

const REDEEMER_SUCCESS_PREFIX = 'redeemer:recent-success:';
const REDEEMER_FALLBACK_STALE_PREFIX = 'redeemer:stale-fallback:';
const REDEEMER_MANUAL_NOTIFY_KEY = 'redeemer:manual-notified';
const REDEEMER_MANUAL_NOTIFY_TTL_S = 30 * 24 * 3600;

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
 * Find and redeem all resolved winning positions on Simmer,
 * then check CLOB positions for resolution.
 *
 * Never throws — errors are logged and captured per-position.
 * Returns an array of results (one per redeemable position attempted).
 */
export async function redeemResolvedPositions(redis: Redis): Promise<RedemptionResult[]> {
  const results: RedemptionResult[] = [];
  const cfg = loadConfig();

  // ── Simmer redemptions (unchanged) ────────────────────────────────────────
  let resolvedPositions;
  try {
    resolvedPositions = await getSimmerPositions({
      status: 'resolved',
      venue: 'polymarket',
      // REMOVED: source filter. We want to redeem any winning position for this wallet regardless of tagging.
    });
  } catch (err) {
    logger.warn('[redeemer] failed to fetch resolved positions — skipping redemption cycle', {
      error: err instanceof Error ? err.message : String(err),
    });
    return results;
  }

  const redeemable = resolvedPositions.filter((p) => p.redeemable);

  if (redeemable.length === 0) {
    logger.debug('[redeemer] no redeemable positions found');
  } else {
    logger.info('[redeemer] found redeemable positions', { count: redeemable.length });

    for (const pos of redeemable) {
      if (results.length > 0) await sleep(REDEEM_DELAY_MS);
      const side = pos.side;
      const reportedBalance = pos.value_usdc ?? pos.shares ?? null;
      const posAny = pos as Record<string, unknown>;
      const dedupeConditionId =
        typeof posAny.condition_id === 'string' && posAny.condition_id.length > 0
          ? (posAny.condition_id)
          : pos.market_id;
      const skipReason = await shouldSkipRedeemer(
        redis,
        dedupeConditionId,
        side,
        reportedBalance,
        cfg,
      );
      if (skipReason) {
        logRedeemerSkip(skipReason, dedupeConditionId, {
          marketId: pos.market_id,
          reportedBalance,
        });
        continue;
      }
      try {
        let redeemResult;
        let throwErr: unknown = null;
        try {
          redeemResult = await submitRedeem({ market_id: pos.market_id, side });
        } catch (e) {
          throwErr = e;
        }

        if (throwErr instanceof SimmerError && throwErr.statusCode === 400) {
          logger.warn(
            '[redeemer] Simmer 400 — position likely already auto-redeemed, mocking success',
            {
              marketId: pos.market_id,
              side,
              simmerBody: throwErr.body,
            },
          );
          // Auto-redeemed counts as successful hit from Simmer API perspective
          redeemResult = { success: true };
          // Note: we can't get tx_hash because it was redeemed externally, leaving it undefined is fine.
        } else if (throwErr) {
          throw throwErr instanceof Error ? throwErr : new Error(String(throwErr));
        }

        if (redeemResult?.success) {
          // Remove from Redis ledger — treat direction as uppercase to match ledger keys
          const direction = side.toUpperCase() as 'YES' | 'NO';
          // Cross-reference ledger BEFORE closing to preserve sourcedFrom.
          const ledgerPos = await getPosition(redis, pos.market_id, direction);
          await closePosition(redis, pos.market_id, direction);

          // Credit face value (resolved = $1/share) to bankroll
          const proceedsUsdc = pos.value_usdc ?? pos.shares ?? 0;
          if (proceedsUsdc > 0) {
            await creditProceeds(redis, proceedsUsdc);
          }
          await markRedeemerSuccess(
            redis,
            dedupeConditionId,
            side,
            proceedsUsdc,
            reportedBalance ?? proceedsUsdc ?? 0,
            cfg,
            redeemResult.tx_hash ?? undefined,
          );

          // Record outcome (Phase 8).
          // redeemable === true means Polymarket confirmed our direction won.
          const simmerWon = pos.redeemable;
          const posAny = pos as Record<string, unknown>;
          const stakeUsd =
            ledgerPos?.stakeUsd ??
            (typeof posAny.stakeUsd === 'number' ? posAny.stakeUsd : null);
          const openedAt =
            ledgerPos?.openedAt ??
            (typeof posAny.openedAt === 'string' ? posAny.openedAt : null);
          if (!stakeUsd) {
            logger.warn('[redeemer] Simmer position missing stakeUsd for outcome calibration', {
              market_id: pos.market_id,
            });
          }
          const question = pos.question ?? pos.market_id;
          await recordOutcome(redis, {
            source: inferSource(ledgerPos?.sourcedFrom ?? ''),
            category: inferCategory(question),
            question: question.slice(0, 200),
            direction: direction,
            consensusProbability:
              ledgerPos?.consensusProbability ??
              (typeof posAny.consensusProbability === 'number'
                ? posAny.consensusProbability
                : 0.5),
            divergence:
              ledgerPos?.edgeMagnitude ??
              (typeof posAny.edgeMagnitude === 'number' ? posAny.edgeMagnitude : 0),
            result: simmerWon ? 'won' : 'lost',
            returnPct:
              proceedsUsdc > 0 && stakeUsd ? ((proceedsUsdc - stakeUsd) / stakeUsd) * 100 : 0,
            holdingHours: openedAt ? (Date.now() - new Date(openedAt).getTime()) / 3600000 : 0,
            executionVenue:
              ledgerPos?.executionVenue ??
              (typeof posAny.executionVenue === 'string' ? posAny.executionVenue : 'simmer'),
          });

          // Notify
          const notifyOpts: Parameters<typeof notifyRedemptionExecuted>[0] = {
            marketId: pos.market_id,
            question: pos.question ?? pos.market_id,
            side,
            valueUsdc: proceedsUsdc,
          };
          if (redeemResult.tx_hash) notifyOpts.txHash = redeemResult.tx_hash;
          await notifyRedemptionExecuted(notifyOpts);

          logger.info('[redeemer] redemption successful', {
            marketId: pos.market_id,
            side,
            txHash: redeemResult.tx_hash,
            valueUsdc: proceedsUsdc,
          });

          const r: RedemptionResult = {
            marketId: pos.market_id,
            side,
            success: true,
            valueUsdc: proceedsUsdc,
          };
          if (redeemResult.tx_hash) r.txHash = redeemResult.tx_hash;
          results.push(r);
        } else {
          const error = redeemResult?.error ?? 'unknown error from Simmer';
          logger.warn('[redeemer] redemption returned success=false', {
            marketId: pos.market_id,
            error,
          });
          results.push({ marketId: pos.market_id, side, success: false, error });
        }
      } catch (err) {
        const message =
          err instanceof SimmerError
            ? `HTTP ${err.statusCode.toString()}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        
        logger.error('[redeemer] redemption failed', {
          marketId: pos.market_id,
          side,
          error: message,
        });
        results.push({ marketId: pos.market_id, side, success: false, error: message });
      }
    }
  }

  // ── CLOB position redemptions ─────────────────────────────────────────────
  try {
    await redeemClobPositions(redis, results, cfg);
  } catch (err) {
    logger.warn('[redeemer] CLOB position redemption scan failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Simmer ledger fallback ─────────────────────────────────────────────────
  // Polymarket may settle a market before Simmer marks it redeemable in their API.
  // This fallback scans Redis ledger Simmer positions against Gamma directly and
  // force-calls submitRedeem for any that Gamma confirms as resolved+won — regardless
  // of whether Simmer's /positions?status=resolved returned them above.
  // Deduplicates against positions already redeemed in this cycle.
  const alreadyRedeemed = new Set(results.filter((r) => r.success).map((r) => r.marketId));
  try {
    await redeemSimmerLedgerFallback(redis, results, alreadyRedeemed, cfg);
  } catch (err) {
    logger.warn('[redeemer] Simmer ledger fallback scan failed', {
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
 * CLOB positions are not visible to Simmer. We check each one against the
 * Gamma API for resolution status and close accordingly.
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
    const conditionId = pos.conditionId;
    if (!conditionId) {
      logger.warn('[redeemer] CLOB position missing conditionId — skipping', {
        marketId: pos.marketId,
      });
      continue;
    }

    const pmDirection = pos.direction;
    const side = pmDirection.toLowerCase() as 'yes' | 'no';

    const tokenId = pickClobTokenId(pos);
    const preBalance = await refreshTokenBalance(tokenId);
    const reportedBalance =
      preBalance ?? pos.sharesHeld ?? (pos.entryPrice > 0 ? pos.stakeUsd / pos.entryPrice : null);
    const skipReason = await shouldSkipRedeemer(redis, conditionId, side, reportedBalance, cfg);
    if (skipReason) {
      logRedeemerSkip(skipReason, conditionId, { marketId: pos.marketId, reportedBalance });
      continue;
    }

    try {
      // Check resolution via Gamma API
      const resolved = await checkMarketResolved(conditionId);
      // Rate limit Gamma calls (200ms inter-call delay)
      await new Promise((r) => setTimeout(r, 200));

      if (!resolved) continue;

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

      const won = resolved.outcome === pmDirection;
      if (!won) {
        // Market resolved against us — close ledger entry without redeeming
        logger.info('[redeemer] CLOB position resolved as loss, closing ledger', {
          marketId: pos.marketId,
          direction: pos.direction,
          outcome: resolved.outcome,
        });
        await closePosition(redis, pos.marketId, pos.direction);
        await recordOutcome(redis, {
          source: inferSource(pos.sourcedFrom ?? ''),
          category: inferCategory(resolvedQuestion),
          question: resolvedQuestion.slice(0, 200),
          direction: pmDirection,
          consensusProbability: pos.consensusProbability ?? 0.5,
          divergence: pos.edgeMagnitude ?? 0,
          result: 'lost',
          returnPct: -100,
          holdingHours: pos.openedAt
            ? (Date.now() - new Date(pos.openedAt).getTime()) / 3600000
            : 0,
          executionVenue: 'clob',
        });
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
        direction: pmDirection,
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
              direction: pmDirection,
              question: resolvedQuestion,
              ...(pos.sharesHeld != null && { estimatedUsdc: pos.sharesHeld }),
            }).catch(() => {});
          }
          // Close the ledger entry so we don't re-alert every cycle
          await closePosition(redis, pos.marketId, pos.direction);
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
      await closePosition(redis, pos.marketId, pos.direction);

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
      await recordOutcome(redis, {
        source: inferSource(pos.sourcedFrom ?? ''),
        category: inferCategory(resolvedQuestion),
        question: resolvedQuestion.slice(0, 200),
        direction: pos.direction,
        consensusProbability: pos.consensusProbability ?? 0.5,
        divergence: pos.edgeMagnitude ?? 0,
        result: won ? 'won' : 'lost',
        returnPct: pos.stakeUsd ? ((proceedsUsdc - pos.stakeUsd) / pos.stakeUsd) * 100 : 0,
        holdingHours: pos.openedAt ? (Date.now() - new Date(pos.openedAt).getTime()) / 3600000 : 0,
        executionVenue: pos.executionVenue ?? 'clob',
      });

      // Notify
      await notifyRedemptionExecuted({
        marketId: pos.marketId,
        question: resolvedQuestion,
        side,
        valueUsdc: proceedsUsdc,
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
 * Returns null if the market is still active, or the outcome if resolved.
 */
async function checkMarketResolved(
  conditionId: string,
): Promise<{ outcome: 'YES' | 'NO'; question?: string } | null> {
  try {
    const url = `https://gamma-api.polymarket.com/markets?condition_id=${encodeURIComponent(conditionId)}`;
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
 * Fallback redemption scan for Simmer-venue positions in the Redis ledger.
 *
 * Simmer's API may lag behind Polymarket's on-chain settlement — a market can show
 * "Claim" on the Polymarket UI for hours before Simmer marks it redeemable. This
 * function cross-references all open Simmer positions in Redis against the Gamma API
 * directly and force-calls submitRedeem for any that Gamma confirms as resolved+won.
 *
 * Deduplicates against the alreadyRedeemed set to avoid double-redemption.
 */
async function redeemSimmerLedgerFallback(
  redis: Redis,
  results: RedemptionResult[],
  alreadyRedeemed: Set<string>,
  cfg: AppConfig,
): Promise<void> {
  const allPositions = await getOpenPositions(redis);
  const simmerPositions = allPositions.filter(
    (p: Position) =>
      (p.executionVenue === 'simmer' || !p.executionVenue) &&
      (p.direction === 'YES' || p.direction === 'NO' ||
       p.direction === 'UP' || p.direction === 'DOWN'),
  );

  if (simmerPositions.length === 0) return;

  logger.info('[redeemer] Simmer ledger fallback: checking for unredeemed wins', {
    count: simmerPositions.length,
  });

  for (const pos of simmerPositions) {
    const conditionId = pos.conditionId;
    if (alreadyRedeemed.has(pos.marketId) || (conditionId && alreadyRedeemed.has(conditionId)))
      continue;
    if (!conditionId) {
      logger.debug('[redeemer] Simmer fallback: skipping position without conditionId', {
        marketId: pos.marketId,
      });
      continue;
    }

    const pmDirection = pos.direction as 'YES' | 'NO';
    const side = pmDirection.toLowerCase() as 'yes' | 'no';

    const reportedBalance =
      pos.sharesHeld ?? (pos.entryPrice > 0 ? pos.stakeUsd / pos.entryPrice : null);
    const skipReason = await shouldSkipRedeemer(redis, conditionId, side, reportedBalance, cfg);
    if (skipReason) {
      logRedeemerSkip(skipReason, conditionId, { marketId: pos.marketId, reportedBalance });
      continue;
    }

    try {
      const resolved = await checkMarketResolved(conditionId);
      // Rate limit Gamma calls (200ms inter-call delay)
      await new Promise((r) => setTimeout(r, 200));
      if (!resolved) continue;

      const resolvedQuestion =
        pos.question && pos.question.trim().length > 0
          ? pos.question
          : (resolved.question ?? pos.marketId);

      const won = resolved.outcome === pmDirection;
      if (!won) {
        // Market resolved against us — close ledger entry without redeeming
        logger.info('[redeemer] Simmer fallback: position resolved as loss, closing ledger', {
          marketId: pos.marketId,
          direction: pos.direction,
          outcome: resolved.outcome,
        });
        await closePosition(redis, pos.marketId, pos.direction);
        await recordOutcome(redis, {
          source: inferSource(pos.sourcedFrom ?? ''),
          category: inferCategory(resolvedQuestion),
          question: resolvedQuestion.slice(0, 200),
          direction: pmDirection,
          consensusProbability: pos.consensusProbability ?? 0.5,
          divergence: pos.edgeMagnitude ?? 0,
          result: 'lost',
          returnPct: -100,
          holdingHours: pos.openedAt
            ? (Date.now() - new Date(pos.openedAt).getTime()) / 3600000
            : 0,
          executionVenue: pos.executionVenue ?? 'simmer',
        });
        results.push({ marketId: pos.marketId, side, success: false, error: 'resolved_as_loss' });
        continue;
      }

      logger.info(
        '[redeemer] Simmer fallback: won position detected via Gamma — attempting Simmer redeem',
        {
          marketId: pos.marketId,
          direction: pos.direction,
          outcome: resolved.outcome,
        },
      );

      // Resolve Simmer's internal UUID (required for submitRedeem)
      const simmerId = await resolveSimmerMarketId(resolvedQuestion);
      if (!simmerId) {
        logger.warn(
          '[redeemer] Simmer fallback: cannot resolve Simmer UUID — attempting on-chain redemption',
          {
            marketId: pos.marketId,
            question: resolvedQuestion.slice(0, 80),
            conditionId: conditionId,
          },
        );

        // Fall back to direct on-chain redemption via ProxyWalletFactory.
        // This handles old/resolved markets that no longer appear in Simmer search results.
        const onChainResult = await redeemClobOutcome({
          conditionId: conditionId,
          direction: pmDirection,
        });

        if (onChainResult.success) {
          alreadyRedeemed.add(pos.marketId);
          alreadyRedeemed.add(conditionId);
          await closePosition(redis, pos.marketId, pos.direction);
          const proceedsUsdc =
            pos.sharesHeld ?? (pos.entryPrice > 0 ? pos.stakeUsd / pos.entryPrice : 0);
          if (proceedsUsdc > 0) await creditProceeds(redis, proceedsUsdc);
          const tokenId = pickClobTokenId(pos);
          const postBalance = await refreshTokenBalance(tokenId);
          await markRedeemerSuccess(
            redis,
            conditionId,
            side,
            proceedsUsdc,
            postBalance ?? 0,
            cfg,
            onChainResult.tx_hash,
          );
          logRedemptionOutcome(conditionId, classifyRedemptionStatus(postBalance, cfg), {
            marketId: pos.marketId,
            postBalance,
          });
          await recordOutcome(redis, {
            source: inferSource(pos.sourcedFrom ?? ''),
            category: inferCategory(resolvedQuestion),
            question: resolvedQuestion.slice(0, 200),
            direction: pmDirection,
            consensusProbability: pos.consensusProbability ?? 0.5,
            divergence: pos.edgeMagnitude ?? 0,
            result: 'won',
            returnPct: pos.stakeUsd > 0 ? ((proceedsUsdc - pos.stakeUsd) / pos.stakeUsd) * 100 : 0,
            holdingHours: pos.openedAt
              ? (Date.now() - new Date(pos.openedAt).getTime()) / 3600000
              : 0,
            executionVenue: pos.executionVenue ?? 'simmer',
          });
          const notifyOpts: Parameters<typeof notifyRedemptionExecuted>[0] = {
            marketId: pos.marketId,
            question: resolvedQuestion,
            side,
            valueUsdc: proceedsUsdc,
            stakeUsd: pos.stakeUsd,
          };
          if (onChainResult.tx_hash) notifyOpts.txHash = onChainResult.tx_hash;
          await notifyRedemptionExecuted(notifyOpts);
          logger.info('[redeemer] Simmer fallback: on-chain redemption successful', {
            marketId: pos.marketId,
            conditionId: conditionId,
            valueUsdc: proceedsUsdc,
          });
          results.push({
            marketId: pos.marketId,
            side,
            success: true,
            valueUsdc: proceedsUsdc,
            ...(onChainResult.tx_hash ? { txHash: onChainResult.tx_hash } : {}),
          });
        } else if (onChainResult.error === 'MAGIC_PROXY_MANUAL_REDEEM_REQUIRED') {
          logger.warn('[redeemer] Simmer fallback: sigType=1 requires manual redemption', {
            marketId: pos.marketId,
            conditionId: conditionId,
          });
          if (await shouldNotifyManual(redis, conditionId)) {
            void notifyManualRedemptionRequired({
              conditionId: conditionId,
              direction: pmDirection,
              question: resolvedQuestion,
              ...(pos.sharesHeld != null && { estimatedUsdc: pos.sharesHeld }),
            }).catch(() => {});
          }
          await closePosition(redis, pos.marketId, pos.direction);
          results.push({
            marketId: pos.marketId,
            side,
            success: false,
            error: onChainResult.error,
          });
        } else {
          logger.warn('[redeemer] Simmer fallback: on-chain redemption also failed', {
            marketId: pos.marketId,
            conditionId: conditionId,
            error: onChainResult.error,
          });
          const errLower = (onChainResult.error ?? '').toLowerCase();
          if (
            errLower.includes('already redeemed') ||
            errLower.includes('position may already be redeemed') ||
            errLower.includes('balance is 0')
          ) {
            await markFallbackStale(redis, conditionId, side, cfg);
            logRedeemerSkip('stale_no_balance', conditionId, {
              marketId: pos.marketId,
              error: onChainResult.error,
            });
          }
          results.push({
            marketId: pos.marketId,
            side,
            success: false,
            error: onChainResult.error ?? 'on-chain redemption failed',
          });
        }
        continue;
      }

      let redeemResult;
      let throwErr: unknown = null;
      try {
        redeemResult = await submitRedeem({ market_id: simmerId, side });
      } catch (e) {
        throwErr = e;
      }

      if (throwErr instanceof SimmerError && throwErr.statusCode === 400) {
        logger.warn(
          '[redeemer] Simmer fallback 400 — position likely already auto-redeemed, mocking success',
          {
            marketId: pos.marketId,
            side,
            simmerBody: throwErr.body,
          },
        );
        redeemResult = { success: true };
      } else if (throwErr) {
        throw throwErr instanceof Error ? throwErr : new Error(String(throwErr));
      }

      if (redeemResult?.success) {
        alreadyRedeemed.add(pos.marketId);
        alreadyRedeemed.add(conditionId);
        await closePosition(redis, pos.marketId, pos.direction);

        const entryPriceSafe = pos.entryPrice > 0 && Number.isFinite(pos.entryPrice);
        if (!entryPriceSafe && pos.sharesHeld == null) {
          logger.warn('[redeemer] Simmer fallback: entryPrice is zero/invalid — using 0 proceeds', {
            marketId: pos.marketId,
          });
        }
        const proceedsUsdc = pos.sharesHeld ?? (entryPriceSafe ? pos.stakeUsd / pos.entryPrice : 0);
        if (proceedsUsdc > 0) await creditProceeds(redis, proceedsUsdc);
        const tokenId = pickClobTokenId(pos);
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

        await recordOutcome(redis, {
          source: inferSource(pos.sourcedFrom ?? ''),
          category: inferCategory(resolvedQuestion),
          question: resolvedQuestion.slice(0, 200),
          direction: pmDirection,
          consensusProbability: pos.consensusProbability ?? 0.5,
          divergence: pos.edgeMagnitude ?? 0,
          result: 'won',
          returnPct: pos.stakeUsd > 0 ? ((proceedsUsdc - pos.stakeUsd) / pos.stakeUsd) * 100 : 0,
          holdingHours: pos.openedAt
            ? (Date.now() - new Date(pos.openedAt).getTime()) / 3600000
            : 0,
          executionVenue: pos.executionVenue ?? 'simmer',
        });

        const notifyOpts: Parameters<typeof notifyRedemptionExecuted>[0] = {
          marketId: pos.marketId,
          question: resolvedQuestion,
          side,
          valueUsdc: proceedsUsdc,
        };
        if (redeemResult.tx_hash) notifyOpts.txHash = redeemResult.tx_hash;
        await notifyRedemptionExecuted(notifyOpts);

        logger.info('[redeemer] Simmer fallback: redemption successful', {
          marketId: pos.marketId,
          side,
          valueUsdc: proceedsUsdc,
          txHash: redeemResult.tx_hash,
        });

        results.push({
          marketId: pos.marketId,
          side,
          success: true,
          valueUsdc: proceedsUsdc,
          ...(redeemResult.tx_hash ? { txHash: redeemResult.tx_hash } : {}),
        });
      } else {
        const error = redeemResult?.error ?? 'simmer_redeem_failed';
        logger.warn('[redeemer] Simmer fallback: submitRedeem returned success=false', {
          marketId: pos.marketId,
          error,
        });
        const errLower = error.toLowerCase();
        if (
          errLower.includes('already redeemed') ||
          errLower.includes('position may already be redeemed') ||
          errLower.includes('balance is 0')
        ) {
          await markFallbackStale(redis, conditionId, side, cfg);
          logRedeemerSkip('stale_no_balance', conditionId, {
            marketId: pos.marketId,
            error,
          });
        }
        results.push({
          marketId: pos.marketId,
          side,
          success: false,
          error,
        });
      }
    } catch (err) {
      logger.warn('[redeemer] Simmer fallback: error processing position', {
        marketId: pos.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
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

      // Check if market resolved and in our favour
      const resolved = await checkMarketResolved(conditionId);
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
          await closePosition(redis, ledgerEntry.marketId, ledgerEntry.direction);
          await recordOutcome(redis, {
            source: inferSource(ledgerEntry.sourcedFrom ?? ''),
            category: inferCategory(resolvedQuestion),
            question: resolvedQuestion.slice(0, 200),
            direction,
            consensusProbability: ledgerEntry.consensusProbability ?? 0.5,
            divergence: ledgerEntry.edgeMagnitude ?? 0,
            result: 'lost',
            returnPct: -100,
            holdingHours: ledgerEntry.openedAt
              ? (Date.now() - new Date(ledgerEntry.openedAt).getTime()) / 3600000
              : 0,
            executionVenue: 'clob',
          });
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
