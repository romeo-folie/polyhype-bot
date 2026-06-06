/**
 * Pure pair-placement planner for the rebate farmer — no I/O, no Redis, no CLOB.
 *
 * Given a snapshot of everything the farmer knows about one candidate market
 * (held inventory, resting orders, budget, caps, quotes), decide what to do:
 *
 *   - fresh_pair:       place BOTH legs of a new YES+NO pair — atomically
 *                        preflighted (P0-1): exactly two quotes, combined cost
 *                        under the riskless ceiling, both legs ≥ the CLOB
 *                        minimum, both fit budget AND the per-market cap
 *                        TOGETHER. A fresh market is never entered one-legged
 *                        (live failure 2026-06-06: a lone LoL YES leg rested
 *                        naked for 5 minutes after the governor blocked its
 *                        partner).
 *   - pair_completion:  place ONE leg against existing opposite inventory or
 *                        a resting opposite order, share-matched and under the
 *                        pair-cost ceiling.
 *   - skip:             do nothing, with a machine-readable reason.
 *
 * The farmer executes plans (governor reservation, CLOB calls, rollback);
 * shadow mode logs them. Keeping the decision pure makes every preflight
 * combination directly unit-testable.
 */

import { CLOB_MIN_ORDER_USD } from '../shared/clob.js';
import { resolvePairTarget } from './orderManager.js';
import type { RebateMarketCandidate, RebateQuote, RestingOrder } from './types.js';

export type PlanSkipReason =
  | 'no_actionable_quotes'      // all quotes already resting/held
  | 'pair_blocked_unusable_basis' // held opposite inventory with no usable entry price
  | 'fresh_single_not_allowed'  // two-sided mode produced one fresh quote — never place it alone
  | 'combined_above_ceiling'    // fresh pair would cost ≥ 1 − minCombinedEdge
  | 'below_clob_minimum'        // a leg's notional would be under the exchange minimum
  | 'market_cap_exceeded'       // both legs together breach REBATE_MAX_PER_MARKET_USD
  | 'budget_exhausted';         // both legs together exceed remaining budget

export interface PlannedLeg {
  quote: RebateQuote;
  /** Exact share count to place (legs of a fresh pair are equal by construction). */
  shares: number;
  sizeUsd: number;
  /** Pair-cost ceiling inputs (pair-completion legs only). */
  matchShares?: number;
  partnerCost?: number;
}

export type PairPlan =
  | { kind: 'fresh_pair'; legs: [PlannedLeg, PlannedLeg]; combined: number }
  | { kind: 'pair_completion'; legs: PlannedLeg[] }
  /** One-sided mode only (REBATE_TWO_SIDED=false, documented-intentional). */
  | { kind: 'fresh_single'; leg: PlannedLeg }
  | { kind: 'skip'; reason: PlanSkipReason };

export interface PlannerSnapshot {
  candidate: RebateMarketCandidate;
  /**
   * Quotes still actionable after the farmer's reprice pass — i.e. quotes with
   * no live resting order on their own direction and no held position on
   * their own direction.
   */
  actionableQuotes: RebateQuote[];
  /** Held opposite-side inventory per actionable quote direction. */
  heldOpposite: (direction: 'YES' | 'NO') => { shares: number | null | undefined; price: number | null | undefined } | null;
  /** Resting opposite-side order per actionable quote direction. */
  restingOpposite: (direction: 'YES' | 'NO') => RestingOrder | null;
  remainingBudget: number;
  deployedForMarket: number;
  cfg: {
    REBATE_ORDER_SIZE_USD: number;
    REBATE_MAX_PER_MARKET_USD: number;
    REBATE_MIN_COMBINED_EDGE: number;
    REBATE_TWO_SIDED: boolean;
  };
}

const opposite = (d: 'YES' | 'NO'): 'YES' | 'NO' => (d === 'YES' ? 'NO' : 'YES');

/**
 * Decide the placement action for one candidate market. Pure.
 */
export function planPairAction(snap: PlannerSnapshot): PairPlan {
  const { actionableQuotes, cfg } = snap;
  if (actionableQuotes.length === 0) return { kind: 'skip', reason: 'no_actionable_quotes' };

  // Classify each actionable quote: pair-completion (opposite exists) or fresh.
  const completions: PlannedLeg[] = [];
  const fresh: RebateQuote[] = [];
  let blocked = false;

  for (const quote of actionableQuotes) {
    const oppDir = opposite(quote.direction);
    const held = snap.heldOpposite(oppDir);
    const resting = snap.restingOpposite(oppDir);
    const pair = resolvePairTarget(
      held,
      resting ? { shares: resting.size, price: resting.price } : null,
      null,
    );

    if (pair === null) {
      // Held opposite inventory with an unusable cost basis — the pair-cost
      // ceiling cannot be evaluated. Fail closed for this quote.
      blocked = true;
      continue;
    }

    if (pair === undefined) {
      fresh.push(quote);
      continue;
    }

    // Pair-completion sizing: share-match the partner, cap by per-leg budget.
    const maxUsd = Math.min(cfg.REBATE_ORDER_SIZE_USD, snap.remainingBudget);
    const shares = Math.min(pair.matchShares, maxUsd / quote.price);
    const sizeUsd = shares * quote.price;
    completions.push({
      quote,
      shares,
      sizeUsd,
      matchShares: pair.matchShares,
      partnerCost: pair.partnerCost,
    });
  }

  // Pair-completion takes priority: closing existing exposure beats opening new.
  // (placeRestingOrder re-enforces the pair-cost ceiling and CLOB minimum —
  // legs that would breach them are dropped at execution with stats.)
  if (completions.length > 0) {
    return { kind: 'pair_completion', legs: completions };
  }
  if (blocked) return { kind: 'skip', reason: 'pair_blocked_unusable_basis' };
  if (fresh.length === 0) return { kind: 'skip', reason: 'no_actionable_quotes' };

  // ── Fresh legs: atomic pair preflight (P0-1) ──────────────────────────────
  // In two-sided mode a fresh market is entered as a PAIR or not at all.
  if (cfg.REBATE_TWO_SIDED && fresh.length !== 2) {
    return { kind: 'skip', reason: 'fresh_single_not_allowed' };
  }
  if (!cfg.REBATE_TWO_SIDED) {
    // Documented-intentional one-sided mode: single fresh leg, plain sizing.
    const quote = fresh[0]!;
    const maxUsd = Math.min(cfg.REBATE_ORDER_SIZE_USD, snap.remainingBudget);
    const shares = maxUsd / quote.price;
    const sizeUsd = shares * quote.price;
    if (sizeUsd < CLOB_MIN_ORDER_USD) return { kind: 'skip', reason: 'below_clob_minimum' };
    if (snap.deployedForMarket + sizeUsd > cfg.REBATE_MAX_PER_MARKET_USD) {
      return { kind: 'skip', reason: 'market_cap_exceeded' };
    }
    if (sizeUsd > snap.remainingBudget) return { kind: 'skip', reason: 'budget_exhausted' };
    return { kind: 'fresh_single', leg: { quote, shares, sizeUsd } };
  }

  const [legA, legB] = fresh as [RebateQuote, RebateQuote];
  const combined = legA.price + legB.price;
  if (combined > 1 - cfg.REBATE_MIN_COMBINED_EDGE + 1e-9) {
    return { kind: 'skip', reason: 'combined_above_ceiling' };
  }

  // Equal shares by construction: s is bounded by the per-leg order size on
  // EACH leg, the remaining budget across BOTH legs, and the per-market cap
  // headroom across BOTH legs.
  const marketHeadroom = cfg.REBATE_MAX_PER_MARKET_USD - snap.deployedForMarket;
  const shares = Math.min(
    cfg.REBATE_ORDER_SIZE_USD / legA.price,
    cfg.REBATE_ORDER_SIZE_USD / legB.price,
    snap.remainingBudget / combined,
    marketHeadroom / combined,
  );
  if (!isFinite(shares) || shares <= 0) return { kind: 'skip', reason: 'budget_exhausted' };

  const sizeUsdA = shares * legA.price;
  const sizeUsdB = shares * legB.price;

  // Both legs must clear the exchange minimum — a pair that can only afford
  // one valid leg is not a pair.
  if (sizeUsdA < CLOB_MIN_ORDER_USD || sizeUsdB < CLOB_MIN_ORDER_USD) {
    return { kind: 'skip', reason: 'below_clob_minimum' };
  }
  // Redundant with the share bound above, kept as explicit invariants so a
  // future sizing change cannot silently violate them.
  if (sizeUsdA + sizeUsdB > snap.remainingBudget + 1e-9) {
    return { kind: 'skip', reason: 'budget_exhausted' };
  }
  if (snap.deployedForMarket + sizeUsdA + sizeUsdB > cfg.REBATE_MAX_PER_MARKET_USD + 1e-9) {
    return { kind: 'skip', reason: 'market_cap_exceeded' };
  }

  return {
    kind: 'fresh_pair',
    combined,
    legs: [
      { quote: legA, shares, sizeUsd: sizeUsdA },
      { quote: legB, shares, sizeUsd: sizeUsdB },
    ],
  };
}
