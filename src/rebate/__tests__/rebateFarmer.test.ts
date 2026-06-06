/**
 * Behavioral tests for the farmer's placement wiring: reconcile-before-gate
 * (P0-4), atomic fresh-pair execution + rollback (P0-1/P0-3), governor slot
 * reservation (P0-2), and shadow mode. The preflight DECISIONS are covered by
 * the pure pairPlanner tests — these cover the glue around them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { z } from 'zod';

vi.mock('dotenv/config', () => ({}));

const mockLoadConfig = vi.fn();
vi.mock('../../shared/config.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));
vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn(() => ({})),
  closeRedis: vi.fn().mockResolvedValue(undefined),
}));
const mockGetBankroll = vi.fn();
vi.mock('../../shared/bankroll.js', () => ({
  getBankroll: (...args: unknown[]) => mockGetBankroll(...args),
}));
const mockHasOpenPosition = vi.fn();
const mockGetPosition = vi.fn();
vi.mock('../../execution/positionLedger.js', () => ({
  hasOpenPosition: (...args: unknown[]) => mockHasOpenPosition(...args),
  getPosition: (...args: unknown[]) => mockGetPosition(...args),
}));
const mockReserveGovernorSlots = vi.fn();
vi.mock('../../shared/governor.js', () => ({
  reserveGovernorSlots: (...args: unknown[]) => mockReserveGovernorSlots(...args),
}));
const mockSelectRebateMarkets = vi.fn();
vi.mock('../marketSelector.js', () => ({
  selectRebateMarkets: (...args: unknown[]) => mockSelectRebateMarkets(...args),
}));
const mockReconcileOrders = vi.fn();
const mockLoadRestingOrders = vi.fn();
const mockPlaceRestingOrder = vi.fn();
const mockCancelForReprice = vi.fn();
const mockCancelRestingOrder = vi.fn();
vi.mock('../orderManager.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual, // findRestingOrder / deployedUsd / deployedUsdForMarket stay REAL (pure map readers)
    reconcileOrders: (...args: unknown[]) => mockReconcileOrders(...args),
    loadRestingOrders: (...args: unknown[]) => mockLoadRestingOrders(...args),
    placeRestingOrder: (...args: unknown[]) => mockPlaceRestingOrder(...args),
    cancelForReprice: (...args: unknown[]) => mockCancelForReprice(...args),
    cancelRestingOrder: (...args: unknown[]) => mockCancelRestingOrder(...args),
  };
});
const mockDailySummary = vi.fn();
vi.mock('../rebateChecker.js', () => ({
  maybeSendDailySummary: (...args: unknown[]) => mockDailySummary(...args),
}));

const { envSchema } = await vi.importActual<{ envSchema: z.AnyZodObject }>(
  '../../shared/config.js',
);
function schemaDefaults(schema: z.AnyZodObject): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const parsed = field.safeParse(undefined);
    if (parsed.success && parsed.data !== undefined) defaults[key] = parsed.data;
  }
  return defaults;
}
const baseConfig = {
  ...schemaDefaults(envSchema),
  REBATE_FARMING_ENABLED: true,
  REBATE_SHADOW_MODE: false,
  REBATE_MAX_BANKROLL_FRACTION: 0.4,
  REBATE_MAX_TOTAL_USD: 50,
  REBATE_ORDER_SIZE_USD: 5,
  REBATE_MAX_PER_MARKET_USD: 10,
  REBATE_MIN_COMBINED_EDGE: 0.02,
  REBATE_TWO_SIDED: true,
  REBATE_MAX_MARKETS: 10,
};

import { main } from '../../cron/rebateFarmer.js';
import { logger } from '../../shared/logger.js';

const emptyReconcile = {
  filled: [], partialFills: [], cancelled: [], stale: [], orphanCancels: [], errors: 0,
};

function makeCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    marketId: 'mkt-1',
    conditionId: '0xcond1',
    question: 'Will it rain tomorrow?',
    clobTokenIds: ['tok-yes', 'tok-no'],
    feesEnabled: true,
    feeType: 'weather_fees',
    yesMid: 0.40,
    spreadAbs: 0.02,
    spreadBps: 500,
    quotes: [
      { direction: 'YES', tokenId: 'tok-yes', price: 0.39, bestBid: 0.39, bestAsk: 0.41 },
      { direction: 'NO', tokenId: 'tok-no', price: 0.59, bestBid: 0.58, bestAsk: 0.62 },
    ],
    volume: 100_000,
    liquidity: 20_000,
    flow: {},
    rebateShare: 0.25,
    score: 5,
    tickSize: '0.01',
    negRisk: false,
    endDate: null,
    ...overrides,
  };
}

function makeOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderId: 'order-a',
    marketId: 'mkt-1',
    conditionId: '0xcond1',
    tokenId: 'tok-yes',
    clobTokenIds: ['tok-yes', 'tok-no'],
    direction: 'YES',
    price: 0.39,
    size: 12.82,
    sizeUsd: 5,
    placedAt: new Date().toISOString(),
    tickSize: '0.01',
    negRisk: false,
    question: 'Will it rain tomorrow?',
    ...overrides,
  };
}

describe('rebateFarmer main()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ ...baseConfig });
    mockReconcileOrders.mockResolvedValue({ ...emptyReconcile });
    mockLoadRestingOrders.mockResolvedValue(new Map());
    mockGetBankroll.mockResolvedValue(100); // maxDeploy = min(40, 50) = 40
    mockHasOpenPosition.mockResolvedValue(false);
    mockGetPosition.mockResolvedValue(null);
    mockSelectRebateMarkets.mockResolvedValue([makeCandidate()]);
    mockReserveGovernorSlots.mockResolvedValue({ ok: true, elapsedMs: Infinity, minIntervalMs: 1333 });
    mockDailySummary.mockResolvedValue(undefined);
  });

  it('P0-4: reconciliation runs even when farming is disabled; placement does not', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, REBATE_FARMING_ENABLED: false });

    await main();

    expect(mockReconcileOrders).toHaveBeenCalledOnce();
    expect(mockSelectRebateMarkets).not.toHaveBeenCalled();
    expect(mockPlaceRestingOrder).not.toHaveBeenCalled();
    // The daily summary is also gated on enabled — disabled mode is
    // reconcile-only.
    expect(mockDailySummary).not.toHaveBeenCalled();
  });

  it('P0-1/P0-2: a fresh pair reserves 2 governor slots and places both legs', async () => {
    const orderA = makeOrder({ orderId: 'order-a', direction: 'YES' });
    const orderB = makeOrder({ orderId: 'order-b', direction: 'NO', tokenId: 'tok-no', price: 0.59 });
    mockPlaceRestingOrder.mockResolvedValueOnce(orderA).mockResolvedValueOnce(orderB);

    await main();

    expect(mockReserveGovernorSlots).toHaveBeenCalledWith(expect.anything(), 'polymarket', 2);
    expect(mockPlaceRestingOrder).toHaveBeenCalledTimes(2);
    // Leg B is share-matched to the ACTUALLY PLACED leg A with its cost.
    const legBSizing = mockPlaceRestingOrder.mock.calls[1]![3] as Record<string, unknown>;
    expect(legBSizing.matchShares).toBe(orderA.size);
    expect(legBSizing.partnerCost).toBe(orderA.price);
  });

  it('P0-3: rolls back leg A when leg B placement fails', async () => {
    const orderA = makeOrder({ orderId: 'order-a' });
    mockPlaceRestingOrder.mockResolvedValueOnce(orderA).mockResolvedValueOnce(null);
    mockCancelRestingOrder.mockResolvedValue('cancelled');

    await main();

    expect(mockCancelRestingOrder).toHaveBeenCalledWith(expect.anything(), orderA, 'rollback');
    // Cycle log reports the rollback and zero net placements.
    const cycleLog = vi.mocked(logger.info).mock.calls.find(
      (c) => c[0] === '[rebate] cycle complete',
    )![1]!;
    expect(cycleLog.rollbacks).toBe(1);
    expect(cycleLog.newOrdersPlaced).toBe(0);
  });

  it('P0-3: a failed rollback keeps leg A tracked and does not refund its budget', async () => {
    const orderA = makeOrder({ orderId: 'order-a', sizeUsd: 5 });
    mockPlaceRestingOrder.mockResolvedValueOnce(orderA).mockResolvedValueOnce(null);
    mockCancelRestingOrder.mockResolvedValue('cancel_failed_still_tracked');

    await main();

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringContaining('ROLLBACK FAILED'),
      expect.objectContaining({ legAOrderId: 'order-a' }),
    );
    const cycleLog = vi.mocked(logger.info).mock.calls.find(
      (c) => c[0] === '[rebate] cycle complete',
    )![1]!;
    // Budget NOT refunded: 40 − 5 = 35 remaining; the leg counts as placed
    // (it is genuinely resting until the orphan sweep clears it).
    expect(cycleLog.budgetRemaining).toBe('35.00');
    expect(cycleLog.rollbacks).toBe(0);
  });

  it('P0-2: a governor-blocked reservation places nothing for the pair', async () => {
    mockReserveGovernorSlots.mockResolvedValue({ ok: false, elapsedMs: 200, minIntervalMs: 1333 });

    await main();

    expect(mockPlaceRestingOrder).not.toHaveBeenCalled();
  });

  it('pair-completion reserves exactly 1 slot', async () => {
    // Held YES inventory → the NO quote pair-completes; YES quote is skipped
    // by hasOpenPosition.
    mockHasOpenPosition.mockImplementation((_r: unknown, _m: unknown, dir: string) =>
      Promise.resolve(dir === 'YES'),
    );
    mockGetPosition.mockImplementation((_r: unknown, _m: unknown, dir: string) =>
      Promise.resolve(dir === 'YES' ? { sharesHeld: 8.19, entryPrice: 0.5 } : null),
    );
    mockPlaceRestingOrder.mockResolvedValue(makeOrder({ orderId: 'order-no', direction: 'NO' }));

    await main();

    expect(mockReserveGovernorSlots).toHaveBeenCalledWith(expect.anything(), 'polymarket', 1);
    // Never a 2-slot reservation: this candidate must NOT plan as fresh_pair.
    expect(mockReserveGovernorSlots).not.toHaveBeenCalledWith(expect.anything(), 'polymarket', 2);
    expect(mockPlaceRestingOrder).toHaveBeenCalledTimes(1);
    const sizing = mockPlaceRestingOrder.mock.calls[0]![3] as Record<string, unknown>;
    expect(sizing.matchShares).toBe(8.19);
    expect(sizing.partnerCost).toBe(0.5);
  });

  it('shadow mode logs the would-be pair and never places, reserves, or reprices', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, REBATE_SHADOW_MODE: true });

    await main();

    expect(mockPlaceRestingOrder).not.toHaveBeenCalled();
    expect(mockReserveGovernorSlots).not.toHaveBeenCalled();
    const shadowLog = vi.mocked(logger.info).mock.calls.find(
      (c) => c[0] === '[rebate-shadow] would place',
    )![1]!;
    expect(shadowLog).toBeDefined();
    expect(shadowLog.kind).toBe('fresh_pair');
    expect((shadowLog.legs as unknown[]).length).toBe(2);
    // Reconcile still ran for real — shadow only suppresses placement.
    expect(mockReconcileOrders).toHaveBeenCalledOnce();
  });
});
