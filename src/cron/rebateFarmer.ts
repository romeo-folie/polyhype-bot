/**
 * Rebate Farmer — passive maker liquidity provision.
 *
 * Places resting GTC post-only limit orders on fee-enabled markets with real
 * recent taker flow. Maker rebates are paid ONLY on filled maker liquidity,
 * daily, from each market's taker-fee pool: crypto 20%, most other fee
 * categories 25%, geopolitics fee-free → no rebate. Resting orders that never
 * fill earn nothing — selection optimizes for fill probability
 * (docs/issues/maker-rebates-not-earning-2026-06-05.md).
 *
 * Cycle (runs every 5 min via cron or Docker):
 *   1. Reconcile tracked orders — detect fills, cancel stale orders, sweep
 *      orphaned fresh legs. ALWAYS runs, even while farming is disabled, so
 *      stale state self-heals.
 *   2. Compute budget from bankroll × fraction, capped by hard limit
 *   3. Select markets by recent fee-equivalent flow/hour; quote both tokens
 *      at effective YES-mid ∓ edge (two-sided, strict pairs)
 *   4. Plan per candidate (pure pairPlanner) and execute:
 *      - fresh pairs are ATOMIC: both legs preflighted, 2 governor slots
 *        reserved up front, leg 1 rolled back if leg 2 fails
 *      - pair-completion legs close existing exposure under the pair-cost
 *        ceiling
 *   5. Once per UTC day: summary comparing fill-time rebate estimates with
 *      the public rebates API (log + Telegram)
 *
 * Filled orders enter the position ledger with sourcedFrom='rebate-farming'
 * and HOLD TO RESOLUTION (near-res gate → redeemer is the only exit).
 *
 * REBATE_SHADOW_MODE=true (with farming enabled) runs the whole pipeline but
 * logs '[rebate-shadow]' would-place plans instead of sending orders — no
 * governor consumption, no tracking writes. Go-live validation knob.
 *
 * Log marker: [rebate]
 */

import 'dotenv/config';
import { getRedis, closeRedis } from '../shared/redis.js';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getBankroll } from '../shared/bankroll.js';
import { hasOpenPosition, getPosition } from '../execution/positionLedger.js';
import { reserveGovernorSlots } from '../shared/governor.js';
import { selectRebateMarkets } from '../rebate/marketSelector.js';
import { planPairAction } from '../rebate/pairPlanner.js';
import type { PairPlan, PlannedLeg } from '../rebate/pairPlanner.js';
import {
  reconcileOrders,
  loadRestingOrders,
  findRestingOrder,
  deployedUsd,
  deployedUsdForMarket,
  placeRestingOrder,
  cancelForReprice,
  cancelRestingOrder,
} from '../rebate/orderManager.js';
import { maybeSendDailySummary } from '../rebate/rebateChecker.js';
import type { RebateQuote } from '../rebate/types.js';

/** Legs a plan wants placed (for shadow logging and slot reservation). */
function planLegs(plan: PairPlan): PlannedLeg[] {
  switch (plan.kind) {
    case 'fresh_pair': return plan.legs;
    case 'pair_completion': return plan.legs;
    case 'fresh_single': return [plan.leg];
    case 'skip': return [];
  }
}

export async function main(): Promise<void> {
  const redis = getRedis();
  try {
    const cfg = loadConfig();

    // Phase 1: Reconcile + orphan sweep — ALWAYS, even while farming is
    // disabled (P0-4: a paused farmer must still clean its own stale orders;
    // a stale tracked leg sat in Redis for hours after the 2026-06-06 pause).
    const reconciled = await reconcileOrders(redis);

    if (!cfg.REBATE_FARMING_ENABLED) {
      logger.info('[rebate] rebate farming disabled', {
        filled: reconciled.filled.length,
        staleCancelled: reconciled.stale.length,
        orphanCancels: reconciled.orphanCancels.length,
      });
      return;
    }

    const isShadow = cfg.REBATE_SHADOW_MODE;

    // Phase 2: Compute budget. Reload after reconcile — fills/cancels free budget.
    const orders = await loadRestingOrders(redis);
    const bankroll = await getBankroll(redis);
    const maxDeploy = Math.min(
      bankroll * cfg.REBATE_MAX_BANKROLL_FRACTION,
      cfg.REBATE_MAX_TOTAL_USD,
    );
    const currentlyDeployed = deployedUsd(orders);
    let remaining = maxDeploy - currentlyDeployed;

    let placed = 0;
    let repriced = 0;
    let rollbacks = 0;

    if (remaining < cfg.REBATE_ORDER_SIZE_USD) {
      logger.info('[rebate] budget exhausted', {
        maxDeploy: maxDeploy.toFixed(2),
        currentlyDeployed: currentlyDeployed.toFixed(2),
      });
    } else {
      // Phase 3: Select markets by recent fee-equivalent taker flow.
      const candidates = await selectRebateMarkets(redis, cfg.REBATE_MAX_MARKETS);

      if (candidates.length === 0) {
        logger.info('[rebate] no eligible markets found');
      }

      // Phase 4: Plan and execute per candidate.
      outer: for (const candidate of candidates) {
        // ── Step A: reprice pass — cancel drifted resting legs so the planner
        // sees an accurate book of what actually rests. Within-threshold legs
        // keep their queue priority and stay out of planning.
        for (const quote of candidate.quotes) {
          const existing = findRestingOrder(orders, candidate.marketId, quote.direction);
          if (!existing) continue;
          if (Math.abs(existing.price - quote.price) <= cfg.REBATE_REPRICE_THRESHOLD) continue;
          if (isShadow) {
            // Shadow never mutates real resting state.
            logger.info('[rebate-shadow] would reprice', {
              marketId: candidate.marketId,
              direction: quote.direction,
              oldPrice: existing.price,
              newPrice: quote.price,
            });
            continue;
          }
          const cancelledOk = await cancelForReprice(redis, existing);
          if (!cancelledOk) continue;
          orders.delete(existing.orderId);
          remaining += existing.sizeUsd;
          repriced++;
          logger.info('[rebate] repricing drifted order', {
            marketId: candidate.marketId,
            direction: quote.direction,
            oldPrice: existing.price,
            newPrice: quote.price,
          });
        }

        // ── Step B: actionable quotes — no live resting order and no held
        // position on the quote's own direction.
        const actionableQuotes: RebateQuote[] = [];
        for (const quote of candidate.quotes) {
          if (findRestingOrder(orders, candidate.marketId, quote.direction)) continue;
          if (await hasOpenPosition(redis, candidate.marketId, quote.direction)) continue;
          actionableQuotes.push(quote);
        }

        // ── Step C: plan (pure). Pre-fetch held inventory for both sides so
        // the planner stays synchronous.
        const [heldYes, heldNo] = await Promise.all([
          getPosition(redis, candidate.marketId, 'YES'),
          getPosition(redis, candidate.marketId, 'NO'),
        ]);
        const held = {
          YES: heldYes ? { shares: heldYes.sharesHeld, price: heldYes.entryPrice } : null,
          NO: heldNo ? { shares: heldNo.sharesHeld, price: heldNo.entryPrice } : null,
        };
        const plan = planPairAction({
          candidate,
          actionableQuotes,
          heldOpposite: (dir) => held[dir],
          restingOpposite: (dir) => findRestingOrder(orders, candidate.marketId, dir),
          remainingBudget: remaining,
          deployedForMarket: deployedUsdForMarket(orders, candidate.marketId),
          cfg: {
            REBATE_ORDER_SIZE_USD: cfg.REBATE_ORDER_SIZE_USD,
            REBATE_MAX_PER_MARKET_USD: cfg.REBATE_MAX_PER_MARKET_USD,
            REBATE_MIN_COMBINED_EDGE: cfg.REBATE_MIN_COMBINED_EDGE,
            REBATE_TWO_SIDED: cfg.REBATE_TWO_SIDED,
          },
        });

        if (plan.kind === 'skip') {
          if (plan.reason !== 'no_actionable_quotes') {
            logger.info('[rebate] candidate skipped by planner', {
              marketId: candidate.marketId,
              reason: plan.reason,
            });
          }
          continue;
        }

        const legs = planLegs(plan);

        // ── Shadow: log the would-be placements; simulate budget so multi-
        // market shadow cycles reflect realistic ordering; place nothing.
        if (isShadow) {
          logger.info('[rebate-shadow] would place', {
            marketId: candidate.marketId,
            question: candidate.question.slice(0, 60),
            kind: plan.kind,
            legs: legs.map((l) => ({
              direction: l.quote.direction,
              price: l.quote.price,
              shares: +l.shares.toFixed(4),
              sizeUsd: +l.sizeUsd.toFixed(2),
            })),
            ...(plan.kind === 'fresh_pair' && { combined: +plan.combined.toFixed(4) }),
            budgetAfter: (remaining - legs.reduce((s, l) => s + l.sizeUsd, 0)).toFixed(2),
          });
          remaining -= legs.reduce((s, l) => s + l.sizeUsd, 0);
          placed += legs.length;
          continue;
        }

        // ── Governor: atomically reserve a slot per leg BEFORE the first
        // order goes out (P0-2). A fresh pair reserves 2 — it can never be
        // half-blocked into a naked leg. The reservation pre-stamps the
        // governor, so no recordGlobalTrade calls here (double-charge).
        const gov = await reserveGovernorSlots(redis, 'polymarket', legs.length);
        if (!gov.ok) {
          logger.info('[rebate] governor rate limit — pausing placement', {
            elapsedMs: gov.elapsedMs,
            minIntervalMs: gov.minIntervalMs,
            slotsRequested: legs.length,
          });
          break outer;
        }

        // ── Execute.
        if (plan.kind === 'fresh_pair') {
          const [legA, legB] = plan.legs;

          const orderA = await placeRestingOrder(redis, candidate, legA.quote, {
            maxUsd: legA.sizeUsd,
          });
          if (!orderA) continue; // nothing placed — reserved slots burn (conservative)
          orders.set(orderA.orderId, orderA);
          remaining -= orderA.sizeUsd;
          placed++;

          const orderB = await placeRestingOrder(redis, candidate, legB.quote, {
            maxUsd: legB.sizeUsd,
            matchShares: orderA.size,
            partnerCost: orderA.price,
          });
          if (!orderB) {
            // P0-3 rollback: leg B failed after leg A placed — cancel leg A
            // immediately rather than leaving a naked fresh leg resting.
            logger.warn('[rebate] leg B failed after leg A placed — rolling back leg A', {
              marketId: candidate.marketId,
              legAOrderId: orderA.orderId,
              legADirection: orderA.direction,
            });
            const rollback = await cancelRestingOrder(redis, orderA, 'rollback');
            if (rollback === 'cancelled') {
              orders.delete(orderA.orderId);
              remaining += orderA.sizeUsd;
              placed--;
              rollbacks++;
            } else if (rollback === 'filled') {
              // Leg A filled during the rollback — its fill is recorded and
              // the capital became held inventory (no budget refund). Future
              // cycles attempt pair completion against it under the ceiling.
              orders.delete(orderA.orderId);
              placed--;
              logger.warn('[rebate] leg A filled during rollback — now held inventory awaiting pair completion', {
                marketId: candidate.marketId,
                legAOrderId: orderA.orderId,
                legADirection: orderA.direction,
              });
            } else {
              // kept_tracked: order may still be live or its state is
              // unverifiable — tracking retained; reconcile/orphan sweep
              // resolves next cycle. Do NOT refund budget for it.
              logger.error('[rebate] ROLLBACK UNCONFIRMED — leg A remains tracked for next reconcile', {
                marketId: candidate.marketId,
                legAOrderId: orderA.orderId,
              });
            }
            continue;
          }
          orders.set(orderB.orderId, orderB);
          remaining -= orderB.sizeUsd;
          placed++;
        } else {
          // pair_completion / fresh_single: independent single legs.
          // CompletionLeg carries required ceiling inputs; FreshLeg has none.
          for (const leg of legs) {
            const order = await placeRestingOrder(redis, candidate, leg.quote, {
              maxUsd: Math.min(cfg.REBATE_ORDER_SIZE_USD, remaining),
              matchShares: 'matchShares' in leg ? leg.matchShares : undefined,
              partnerCost: 'partnerCost' in leg ? leg.partnerCost : undefined,
            });
            if (order) {
              orders.set(order.orderId, order);
              remaining -= order.sizeUsd;
              placed++;
            }
          }
        }
      }
    }

    logger.info('[rebate] cycle complete', {
      shadow: isShadow,
      filled: reconciled.filled.length,
      partialFills: reconciled.partialFills.length,
      staleCancelled: reconciled.stale.length,
      externalCancelled: reconciled.cancelled.length,
      orphanCancels: reconciled.orphanCancels.length,
      repriced,
      rollbacks,
      newOrdersPlaced: placed,
      budgetRemaining: remaining.toFixed(2),
      totalDeployed: (maxDeploy - remaining).toFixed(2),
    });

    // Phase 5: Daily est-vs-API rebate summary (best-effort, never fails the cycle).
    await maybeSendDailySummary(redis).catch((err: unknown) => {
      logger.warn('[rebate] daily summary failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  } finally {
    await closeRedis();
  }
}

// Entrypoint when run directly (npx tsx src/cron/rebateFarmer.ts) — same
// pattern as monitor/index.ts so tests can import main() without running it.
const isMain = process.argv[1]?.endsWith('rebateFarmer.ts') ?? false;
if (isMain) {
  void main().catch((err: unknown) => {
    logger.error('[rebate] fatal error', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
