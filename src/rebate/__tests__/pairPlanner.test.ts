import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { planPairAction } from '../pairPlanner.js';
import type { PlannerSnapshot } from '../pairPlanner.js';
import type { RebateQuote, RestingOrder } from '../types.js';

// Foundation from the REAL Zod schema defaults so the planner config can't
// drift from config.ts (project convention).
const { envSchema } = await import('../../shared/config.js');
function schemaDefault(key: string): unknown {
  const field = (envSchema as z.AnyZodObject).shape[key];
  const parsed = field!.safeParse(undefined);
  return parsed.success ? parsed.data : undefined;
}

const baseCfg = {
  REBATE_ORDER_SIZE_USD: schemaDefault('REBATE_ORDER_SIZE_USD') as number,
  REBATE_MAX_PER_MARKET_USD: schemaDefault('REBATE_MAX_PER_MARKET_USD') as number,
  REBATE_MIN_COMBINED_EDGE: schemaDefault('REBATE_MIN_COMBINED_EDGE') as number,
  REBATE_TWO_SIDED: schemaDefault('REBATE_TWO_SIDED') as boolean,
};

function makeQuote(overrides: Partial<RebateQuote> = {}): RebateQuote {
  return {
    direction: 'YES',
    tokenId: 'tok-yes',
    price: 0.39,
    bestBid: 0.39,
    bestAsk: 0.41,
    ...overrides,
  };
}

function makeRestingOrder(overrides: Partial<RestingOrder> = {}): RestingOrder {
  return {
    orderId: 'order-1',
    marketId: 'mkt-1',
    conditionId: '0xcond1',
    tokenId: 'tok-yes',
    clobTokenIds: ['tok-yes', 'tok-no'],
    direction: 'YES',
    price: 0.39,
    size: 12.8,
    sizeUsd: 4.99,
    placedAt: new Date().toISOString(),
    tickSize: '0.01',
    negRisk: false,
    question: 'Will it rain tomorrow?',
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<PlannerSnapshot> = {}): PlannerSnapshot {
  return {
    // candidate fields are not consulted by the planner beyond quotes; a
    // minimal stub keeps the tests focused on decision inputs.
    candidate: { marketId: 'mkt-1', quotes: [] } as never,
    actionableQuotes: [
      makeQuote({ direction: 'YES', tokenId: 'tok-yes', price: 0.39 }),
      makeQuote({ direction: 'NO', tokenId: 'tok-no', price: 0.57 }),
    ],
    heldOpposite: () => null,
    restingOpposite: () => null,
    remainingBudget: 20,
    deployedForMarket: 0,
    cfg: { ...baseCfg },
    ...overrides,
  };
}

describe('planPairAction — fresh pairs (P0-1 atomic preflight)', () => {
  it('plans BOTH legs with equal shares when every gate passes', () => {
    const plan = planPairAction(makeSnapshot());

    expect(plan.kind).toBe('fresh_pair');
    if (plan.kind !== 'fresh_pair') return;
    expect(plan.combined).toBeCloseTo(0.96);
    const [a, b] = plan.legs;
    // Equal shares by construction — the riskless-pair property.
    expect(a.shares).toBeCloseTo(b.shares, 8);
    // Bounded by the per-leg order size on the pricier leg: 5/0.57 = 8.77sh.
    expect(a.shares).toBeCloseTo(5 / 0.57, 4);
    expect(a.sizeUsd + b.sizeUsd).toBeLessThanOrEqual(20);
  });

  it('never plans a single fresh leg in two-sided mode (the naked LoL failure)', () => {
    const plan = planPairAction(
      makeSnapshot({ actionableQuotes: [makeQuote({ direction: 'YES', price: 0.79 })] }),
    );

    expect(plan).toEqual({ kind: 'skip', reason: 'fresh_single_not_allowed' });
  });

  it('skips the whole market when combined cost breaches the ceiling', () => {
    const plan = planPairAction(
      makeSnapshot({
        actionableQuotes: [
          makeQuote({ direction: 'YES', price: 0.49 }),
          makeQuote({ direction: 'NO', tokenId: 'tok-no', price: 0.53 }),
        ],
      }),
    );

    expect(plan).toEqual({ kind: 'skip', reason: 'combined_above_ceiling' });
  });

  it('skips when either leg would land below the CLOB minimum', () => {
    // Budget $1.50 across a 0.96-combined pair → ~1.56 shares → legA $0.61.
    const plan = planPairAction(makeSnapshot({ remainingBudget: 1.5 }));

    expect(plan).toEqual({ kind: 'skip', reason: 'below_clob_minimum' });
  });

  it('sizes the pair down to fit the remaining budget TOGETHER', () => {
    // Budget $6 cannot fund 2 × $5 legs — shares shrink so both legs fit.
    const plan = planPairAction(makeSnapshot({ remainingBudget: 6 }));

    expect(plan.kind).toBe('fresh_pair');
    if (plan.kind !== 'fresh_pair') return;
    expect(plan.legs[0].sizeUsd + plan.legs[1].sizeUsd).toBeLessThanOrEqual(6 + 1e-9);
    expect(plan.legs[0].shares).toBeCloseTo(6 / 0.96, 4);
  });

  it('sizes the pair down to fit the per-market cap headroom TOGETHER', () => {
    // $7 already deployed against a $10 cap → $3 headroom for both legs.
    const plan = planPairAction(makeSnapshot({ deployedForMarket: 7 }));

    expect(plan.kind).toBe('fresh_pair');
    if (plan.kind !== 'fresh_pair') return;
    expect(plan.legs[0].sizeUsd + plan.legs[1].sizeUsd).toBeLessThanOrEqual(3 + 1e-9);
  });

  it('skips with budget_exhausted when no budget remains at all', () => {
    const plan = planPairAction(makeSnapshot({ remainingBudget: 0 }));

    expect(plan).toEqual({ kind: 'skip', reason: 'budget_exhausted' });
  });
});

describe('planPairAction — pair completion', () => {
  it('completes against held opposite inventory, share-matched with partner cost', () => {
    const plan = planPairAction(
      makeSnapshot({
        actionableQuotes: [makeQuote({ direction: 'NO', tokenId: 'tok-no', price: 0.44 })],
        heldOpposite: (dir) => (dir === 'YES' ? { shares: 8.19, price: 0.5 } : null),
      }),
    );

    expect(plan.kind).toBe('pair_completion');
    if (plan.kind !== 'pair_completion') return;
    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0]!.matchShares).toBe(8.19);
    expect(plan.legs[0]!.partnerCost).toBe(0.5);
    expect(plan.legs[0]!.shares).toBeCloseTo(8.19, 6); // matched, fits $5 budget
  });

  it('completes against a resting opposite order when nothing is held', () => {
    const resting = makeRestingOrder({ direction: 'YES', price: 0.39, size: 12.8 });
    const plan = planPairAction(
      makeSnapshot({
        actionableQuotes: [makeQuote({ direction: 'NO', tokenId: 'tok-no', price: 0.57 })],
        restingOpposite: (dir) => (dir === 'YES' ? resting : null),
      }),
    );

    expect(plan.kind).toBe('pair_completion');
    if (plan.kind !== 'pair_completion') return;
    expect(plan.legs[0]!.matchShares).toBe(12.8);
    expect(plan.legs[0]!.partnerCost).toBe(0.39);
    // Share-match capped by the per-leg budget: 5/0.57 = 8.77 < 12.8.
    expect(plan.legs[0]!.shares).toBeCloseTo(5 / 0.57, 4);
  });

  it('fails closed when held opposite inventory has an unusable cost basis', () => {
    const plan = planPairAction(
      makeSnapshot({
        actionableQuotes: [makeQuote({ direction: 'NO', tokenId: 'tok-no', price: 0.44 })],
        heldOpposite: (dir) => (dir === 'YES' ? { shares: 8.19, price: undefined } : null),
      }),
    );

    expect(plan).toEqual({ kind: 'skip', reason: 'pair_blocked_unusable_basis' });
  });

  it('prioritizes completion over opening a fresh pair', () => {
    // NO quote pairs against held YES; YES quote would be fresh — completion wins.
    const plan = planPairAction(
      makeSnapshot({
        actionableQuotes: [
          makeQuote({ direction: 'NO', tokenId: 'tok-no', price: 0.44 }),
        ],
        heldOpposite: (dir) => (dir === 'YES' ? { shares: 8.19, price: 0.5 } : null),
      }),
    );

    expect(plan.kind).toBe('pair_completion');
  });
});

describe('planPairAction — one-sided mode (REBATE_TWO_SIDED=false)', () => {
  it('plans a single fresh leg (documented-intentional mode)', () => {
    const plan = planPairAction(
      makeSnapshot({
        actionableQuotes: [makeQuote({ direction: 'YES', price: 0.39 })],
        cfg: { ...baseCfg, REBATE_TWO_SIDED: false },
      }),
    );

    expect(plan.kind).toBe('fresh_single');
    if (plan.kind !== 'fresh_single') return;
    expect(plan.leg.sizeUsd).toBeCloseTo(5, 6);
  });
});

describe('planPairAction — nothing to do', () => {
  it('skips when no quotes are actionable', () => {
    const plan = planPairAction(makeSnapshot({ actionableQuotes: [] }));
    expect(plan).toEqual({ kind: 'skip', reason: 'no_actionable_quotes' });
  });
});
