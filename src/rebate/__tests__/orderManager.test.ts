import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { z } from 'zod';

// Mock external dependencies before imports.
vi.mock('../../shared/clob.js', () => ({
  submitClobLimitBuy: vi.fn(),
  getClobOrder: vi.fn(),
  cancelClobOrder: vi.fn(),
  CLOB_MIN_ORDER_USD: 1.0,
}));

const mockGetPosition = vi.fn();
vi.mock('../../execution/positionLedger.js', () => ({
  recordPosition: vi.fn(),
  getPosition: (...args: unknown[]) => mockGetPosition(...args),
}));

// Foundation from the REAL Zod schema defaults so the mock can't drift from
// config.ts (see feedback: hand-written literals crash on new cfg.X reads).
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

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    ...schemaDefaults(envSchema),
    // Pinned: rebate-estimate assertions below are computed from these.
    REBATE_ORDER_TTL_S: 300,
    REBATE_FEE_RATE_BPS: 1000,
    CLOB_FALLBACK_ENABLED: true,
  })),
}));

vi.mock('../../shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  reconcileOrders,
  placeRestingOrder,
  cancelForReprice,
  hasRestingOrderForMarket,
  findRestingOrder,
  deployedUsd,
  deployedUsdForMarket,
  getDeployedUsd,
  loadRestingOrders,
  resolvePairTarget,
  cancelRestingOrder,
} from '../orderManager.js';
import { getClobOrder, cancelClobOrder, submitClobLimitBuy } from '../../shared/clob.js';
import { recordPosition } from '../../execution/positionLedger.js';
import type { RestingOrder, RebateMarketCandidate, RebateQuote } from '../types.js';
import type { MarketFlowStats } from '../flowAnalyzer.js';

const mockGetOrder = vi.mocked(getClobOrder);
const mockCancelOrder = vi.mocked(cancelClobOrder);
const mockSubmitLimit = vi.mocked(submitClobLimitBuy);
const mockRecordPosition = vi.mocked(recordPosition);

interface PipelineMock {
  hincrby: ReturnType<typeof vi.fn>;
  hincrbyfloat: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  sadd: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
}

function makeRedis(): Record<string, ReturnType<typeof vi.fn>> & { pipelines: PipelineMock[] } {
  const pipelines: PipelineMock[] = [];
  const redis = {
    pipelines,
    hgetall: vi.fn().mockResolvedValue({}),
    hset: vi.fn().mockResolvedValue(1),
    hdel: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    scard: vi.fn().mockResolvedValue(0),
    hincrby: vi.fn().mockResolvedValue(1),
    multi: vi.fn(() => {
      const pipeline: PipelineMock = {
        hincrby: vi.fn(),
        hincrbyfloat: vi.fn(),
        expire: vi.fn(),
        del: vi.fn(),
        sadd: vi.fn(),
        exec: vi.fn().mockResolvedValue([]),
      };
      pipeline.hincrby.mockReturnValue(pipeline);
      pipeline.hincrbyfloat.mockReturnValue(pipeline);
      pipeline.expire.mockReturnValue(pipeline);
      pipeline.del.mockReturnValue(pipeline);
      pipeline.sadd.mockReturnValue(pipeline);
      pipelines.push(pipeline);
      return pipeline;
    }),
  };
  return redis;
}

/** All hincrby/hincrbyfloat calls across every pipeline the code opened. */
function statCalls(redis: ReturnType<typeof makeRedis>): { field: string; key: string; by: number | string }[] {
  const calls: { field: string; key: string; by: number | string }[] = [];
  for (const p of redis.pipelines) {
    for (const c of p.hincrby.mock.calls) {
      calls.push({ key: c[0] as string, field: c[1] as string, by: c[2] as number });
    }
    for (const c of p.hincrbyfloat.mock.calls) {
      calls.push({ key: c[0] as string, field: c[1] as string, by: c[2] as number });
    }
  }
  return calls;
}

function makeFlow(overrides: Partial<MarketFlowStats> = {}): MarketFlowStats {
  return {
    tradeCount: 40,
    takerNotionalUsd: 1200,
    takerNotionalUsdPerHour: 200,
    feeEquivalentUsd: 30,
    feeEquivalentUsdPerHour: 5,
    vwapYes: 0.40,
    effectiveWindowHours: 6,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<RebateMarketCandidate> = {}): RebateMarketCandidate {
  return {
    marketId: 'mkt-1',
    conditionId: 'cond-1',
    question: 'Will X happen?',
    clobTokenIds: ['tok-yes', 'tok-no'],
    feesEnabled: true,
    feeType: 'weather_fees',
    yesMid: 0.40,
    spreadAbs: 0.02,
    spreadBps: 500,
    quotes: [],
    volume: 100000,
    liquidity: 20000,
    flow: makeFlow(),
    rebateShare: 0.25,
    score: 5,
    tickSize: '0.01',
    negRisk: false,
    endDate: null,
    ...overrides,
  };
}

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

function makeOrder(overrides: Partial<RestingOrder> = {}): RestingOrder {
  return {
    orderId: 'order-1',
    marketId: 'mkt-1',
    conditionId: 'cond-1',
    tokenId: 'tok-yes',
    clobTokenIds: ['tok-yes', 'tok-no'],
    direction: 'YES',
    price: 0.51,
    size: 10,
    sizeUsd: 5.1,
    placedAt: new Date().toISOString(),
    tickSize: '0.01',
    negRisk: false,
    question: 'Will X?',
    feeRateBps: 1000,
    rebateShare: 0.25,
    ...overrides,
  };
}

describe('orderManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Sweep-neutral default: a held opposite position exists, so the orphan
    // sweep leaves tracked orders alone. Sweep-specific tests override to null.
    mockGetPosition.mockResolvedValue({ sharesHeld: 5, entryPrice: 0.5 });
  });

  describe('reconcileOrders', () => {
    it('detects fully filled orders, records positions, and accrues the estimated rebate', async () => {
      const redis = makeRedis();
      // 10 shares at 0.51, 1000bps, 25% share:
      // 10 × 0.10 × 0.51 × 0.49 × 0.25 = 0.062475
      const order = makeOrder({ price: 0.51, size: 10 });
      redis.hgetall.mockResolvedValue({ 'order-1': JSON.stringify(order) });

      mockGetOrder.mockResolvedValue({
        id: 'order-1',
        status: 'MATCHED',
        owner: '0x1',
        maker_address: '0x1',
        market: 'mkt-1',
        asset_id: 'tok-yes',
        side: 'BUY',
        original_size: '10',
        size_matched: '10',
        price: '0.51',
        associate_trades: [],
        outcome: 'YES',
        created_at: Date.now(),
        expiration: '',
        order_type: 'GTC',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await reconcileOrders(redis as any);

      expect(result.filled).toHaveLength(1);
      expect(result.filled[0]!.orderId).toBe('order-1');
      expect(mockRecordPosition).toHaveBeenCalledOnce();
      expect(redis.hdel).toHaveBeenCalledWith('rebate:orders', 'order-1');

      const stats = statCalls(redis);
      const todayKey = `rebate:stats:date:${new Date().toISOString().slice(0, 10)}`;
      // Cumulative + per-market + per-day fill counters (the date bucket feeds
      // the daily summary's same-period est-vs-API comparison).
      expect(stats).toContainEqual({ key: 'rebate:stats', field: 'fills', by: 1 });
      expect(stats).toContainEqual({ key: 'rebate:stats:market:mkt-1', field: 'fills', by: 1 });
      expect(stats).toContainEqual({ key: todayKey, field: 'fills', by: 1 });
      // Estimated rebate accrual on all three hashes.
      const rebateBumps = stats.filter((s) => s.field === 'est_rebate_usd');
      expect(rebateBumps).toHaveLength(3);
      expect(rebateBumps[0]!.by).toBeCloseTo(0.062475, 5);
      expect(rebateBumps.map((b) => b.key)).toContain(todayKey);
      // Lifetime recorded on terminal event, including the date bucket.
      expect(stats.some((s) => s.field === 'lifetime_ms_total' && s.key === todayKey)).toBe(true);
    });

    it('HOLDS a still-live order past the old 300s TTL — no cancel, queue priority preserved', async () => {
      // The core queue-priority fix (PR #465 analogue): an order 10 min old
      // (well past the old 300s TTL) but under the 24h backstop and not yet at
      // resolution must be HELD, not recycled. The old code cancelled here
      // EVERY cycle, forfeiting CLOB time-priority — ~99% of placements died
      // this way as stale_cancels and almost never filled.
      const redis = makeRedis();
      const order = makeOrder({
        orderId: 'order-held',
        placedAt: new Date(Date.now() - 600_000).toISOString(), // 10 min ago (> old 300s TTL)
        endDate: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), // resolves tomorrow
      });
      redis.hgetall.mockResolvedValue({ 'order-held': JSON.stringify(order) });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockGetOrder.mockResolvedValue({ status: 'LIVE', size_matched: '0', original_size: '10' } as any);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await reconcileOrders(redis as any);

      expect(result.stale).toHaveLength(0);
      expect(mockCancelOrder).not.toHaveBeenCalled();
      expect(redis.hdel).not.toHaveBeenCalledWith('rebate:orders', 'order-held');
      const stats = statCalls(redis);
      // No cancel counter of any kind fires for a held, still-valid order.
      expect(stats.some((s) => s.field === 'stale_cancels')).toBe(false);
      expect(stats.some((s) => s.field === 'lifetime_cap_cancels')).toBe(false);
      expect(stats.some((s) => s.field === 'post_resolution_cancels')).toBe(false);
    });

    it('cancels a held order once PAST its market resolution and bumps post_resolution_cancels', async () => {
      const redis = makeRedis();
      const order = makeOrder({
        orderId: 'order-resolved',
        placedAt: new Date(Date.now() - 600_000).toISOString(), // young — only resolution triggers it
        endDate: new Date(Date.now() - 3600_000).toISOString(), // resolved 1h ago
      });
      redis.hgetall.mockResolvedValue({ 'order-resolved': JSON.stringify(order) });
      // Top-of-loop: live unfilled → hold-cancel; recheck: confirmed dead, zero fill.
      mockGetOrder
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce({ status: 'LIVE', size_matched: '0', original_size: '10' } as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce({ status: 'CANCELED', size_matched: '0', original_size: '10' } as any);
      mockCancelOrder.mockResolvedValue(true);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await reconcileOrders(redis as any);

      expect(result.stale).toHaveLength(1);
      expect(mockCancelOrder).toHaveBeenCalledWith('order-resolved');
      expect(redis.hdel).toHaveBeenCalledWith('rebate:orders', 'order-resolved');
      const stats = statCalls(redis);
      const todayKey = `rebate:stats:date:${new Date().toISOString().slice(0, 10)}`;
      expect(stats).toContainEqual({ key: 'rebate:stats', field: 'post_resolution_cancels', by: 1 });
      expect(stats).toContainEqual({ key: 'rebate:stats:market:mkt-1', field: 'post_resolution_cancels', by: 1 });
      expect(stats).toContainEqual({ key: todayKey, field: 'post_resolution_cancels', by: 1 });
      // The old per-cycle staleness counter is retired — never bumped now.
      expect(stats.some((s) => s.field === 'stale_cancels')).toBe(false);
    });

    it('cancels a held order older than REBATE_MAX_ORDER_LIFETIME_S (backstop) and bumps lifetime_cap_cancels', async () => {
      const redis = makeRedis();
      const order = makeOrder({
        orderId: 'order-ancient-live',
        // 25h old > 24h (86400s) backstop; no/future resolution so only the cap fires.
        placedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
        endDate: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      });
      redis.hgetall.mockResolvedValue({ 'order-ancient-live': JSON.stringify(order) });
      // Top-of-loop: live unfilled → hold-cancel; recheck: confirmed dead, zero fill.
      mockGetOrder
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce({ status: 'LIVE', size_matched: '0', original_size: '10' } as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce({ status: 'CANCELED', size_matched: '0', original_size: '10' } as any);
      mockCancelOrder.mockResolvedValue(true);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await reconcileOrders(redis as any);

      expect(result.stale).toHaveLength(1);
      expect(mockCancelOrder).toHaveBeenCalledWith('order-ancient-live');
      expect(redis.hdel).toHaveBeenCalledWith('rebate:orders', 'order-ancient-live');
      const stats = statCalls(redis);
      expect(stats).toContainEqual({ key: 'rebate:stats', field: 'lifetime_cap_cancels', by: 1 });
      expect(stats.some((s) => s.field === 'stale_cancels')).toBe(false);
      expect(stats.some((s) => s.field === 'post_resolution_cancels')).toBe(false);
    });

    it('still records a fill on an order HELD well past the old 300s TTL', async () => {
      // Fill detection must not regress now that orders are held past 300s: an
      // aged order that fills next cycle still records its position + rebate.
      const redis = makeRedis();
      const order = makeOrder({
        orderId: 'order-held-fill',
        price: 0.51,
        size: 10,
        placedAt: new Date(Date.now() - 600_000).toISOString(), // 10 min ago
        endDate: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      });
      redis.hgetall.mockResolvedValue({ 'order-held-fill': JSON.stringify(order) });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockGetOrder.mockResolvedValue({ status: 'MATCHED', size_matched: '10', original_size: '10' } as any);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await reconcileOrders(redis as any);

      expect(result.filled).toHaveLength(1);
      expect(mockRecordPosition).toHaveBeenCalledOnce();
      expect(redis.hdel).toHaveBeenCalledWith('rebate:orders', 'order-held-fill');
      const stats = statCalls(redis);
      expect(stats).toContainEqual({ key: 'rebate:stats', field: 'fills', by: 1 });
    });

    it('PR-459 review: a held order that FILLED during its backstop cancel stays tracked for fill detection', async () => {
      const redis = makeRedis();
      const order = makeOrder({
        orderId: 'order-stale-filled',
        placedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(), // past 24h backstop
      });
      redis.hgetall.mockResolvedValue({ 'order-stale-filled': JSON.stringify(order) });
      // Top-of-loop fetch: still live, no fill yet → proceeds to hold-cancel.
      // Recheck after the failed cancel: it MATCHED in the race.
      mockGetOrder
        .mockResolvedValueOnce({ status: 'LIVE', size_matched: '0', original_size: '12.8' })
        .mockResolvedValueOnce({ status: 'MATCHED', size_matched: '12.8', original_size: '12.8' });
      mockCancelOrder.mockResolvedValue(false);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await reconcileOrders(redis as any);

      // NOT removed as stale — next cycle's fill detection records the
      // position; removing here would drop the fill from the ledger.
      expect(result.stale).toHaveLength(0);
      expect(redis.hdel).not.toHaveBeenCalledWith('rebate:orders', 'order-stale-filled');
      expect(mockRecordPosition).not.toHaveBeenCalled();
    });

    it('PR-459 review r2: a SUCCESSFUL backstop cancel that raced a partial fill also stays tracked', async () => {
      // The cancel accepted the REMAINDER — the partial fill before it must
      // not be dropped by the removal path.
      const redis = makeRedis();
      const order = makeOrder({
        orderId: 'order-stale-partial',
        placedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(), // past 24h backstop
      });
      redis.hgetall.mockResolvedValue({ 'order-stale-partial': JSON.stringify(order) });
      mockGetOrder
        .mockResolvedValueOnce({ status: 'LIVE', size_matched: '0', original_size: '12.8' })
        .mockResolvedValueOnce({ status: 'CANCELED', size_matched: '4.0', original_size: '12.8' });
      mockCancelOrder.mockResolvedValue(true); // cancel SUCCEEDED

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await reconcileOrders(redis as any);

      expect(result.stale).toHaveLength(0);
      expect(redis.hdel).not.toHaveBeenCalledWith('rebate:orders', 'order-stale-partial');
    });

    it('skips recently-placed orders when CLOB returns null (transient error)', async () => {
      const redis = makeRedis();
      const order = makeOrder({ orderId: 'order-gone' }); // fresh — within 2×TTL
      redis.hgetall.mockResolvedValue({ 'order-gone': JSON.stringify(order) });
      mockGetOrder.mockResolvedValue(null);
      // Held opposite inventory keeps the orphan sweep away from this order —
      // the test isolates the transient-null handling.
      mockGetPosition.mockResolvedValue({ sharesHeld: 5, entryPrice: 0.5 });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await reconcileOrders(redis as any);

      // Treated as transient — not removed, counted as error.
      expect(result.cancelled).toHaveLength(0);
      expect(result.errors).toBe(1);
      expect(redis.hdel).not.toHaveBeenCalledWith('rebate:orders', 'order-gone');
    });

    it('removes order when CLOB returns null and order is well past TTL', async () => {
      const redis = makeRedis();
      const order = makeOrder({
        orderId: 'order-ancient',
        placedAt: new Date(Date.now() - 700_000).toISOString(), // > 2×300s TTL
      });
      redis.hgetall.mockResolvedValue({ 'order-ancient': JSON.stringify(order) });
      mockGetOrder.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await reconcileOrders(redis as any);

      expect(result.cancelled).toHaveLength(1);
      expect(redis.hdel).toHaveBeenCalledWith('rebate:orders', 'order-ancient');
      // Own-disposal decision is now counted (not silently dropped).
      const stats = statCalls(redis);
      expect(stats).toContainEqual({ key: 'rebate:stats', field: 'assumed_gone', by: 1 });
    });
  });

  describe('placeRestingOrder', () => {
    it('places a GTC post-only buy at the quote price and persists fee params for fill-time estimates', async () => {
      const redis = makeRedis();
      mockSubmitLimit.mockResolvedValue({
        success: true,
        order_id: 'order-new',
      });

      const candidate = makeCandidate();
      const quote = makeQuote({ direction: 'NO', tokenId: 'tok-no', price: 0.59 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order = await placeRestingOrder(redis as any, candidate, quote, { maxUsd: 5 });

      expect(order).not.toBeNull();
      expect(order!.orderId).toBe('order-new');
      expect(order!.direction).toBe('NO');
      expect(order!.tokenId).toBe('tok-no');
      expect(order!.price).toBe(0.59); // quote price used verbatim — selector owns pricing
      expect(order!.feeRateBps).toBe(1000);
      expect(order!.rebateShare).toBe(0.25);
      expect(mockSubmitLimit).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenId: 'tok-no',
          price: 0.59,
          orderType: 'GTC',
          postOnly: true,
        }),
      );
      expect(redis.hset).toHaveBeenCalled();
      const stats = statCalls(redis);
      const todayKey = `rebate:stats:date:${new Date().toISOString().slice(0, 10)}`;
      expect(stats).toContainEqual({ key: 'rebate:stats', field: 'orders_placed', by: 1 });
      expect(stats).toContainEqual({ key: 'rebate:stats:market:mkt-1', field: 'orders_placed', by: 1 });
      expect(stats).toContainEqual({ key: todayKey, field: 'orders_placed', by: 1 });
    });

    it('captures the candidate endDate on the persisted order (drives the post-resolution cancel)', async () => {
      const redis = makeRedis();
      mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'order-end' });
      const resolvesAt = new Date(Date.now() + 12 * 3600 * 1000).toISOString();

      const candidate = makeCandidate({ endDate: resolvesAt });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order = await placeRestingOrder(redis as any, candidate, makeQuote(), { maxUsd: 5 });

      expect(order).not.toBeNull();
      expect(order!.endDate).toBe(resolvesAt);
      // The persisted JSON also carries it (reconcile reads endDate off the hash).
      const persisted = JSON.parse(redis.hset.mock.calls[0]![2] as string) as RestingOrder;
      expect(persisted.endDate).toBe(resolvesAt);
    });

    it('returns null and counts a place-failure when order submission fails', async () => {
      const redis = makeRedis();
      mockSubmitLimit.mockResolvedValue({ success: false, error: 'order crosses book' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order = await placeRestingOrder(redis as any, makeCandidate(), makeQuote(), { maxUsd: 5 });
      expect(order).toBeNull();
      const stats = statCalls(redis);
      expect(stats).toContainEqual({ key: 'rebate:stats', field: 'place_failures', by: 1 });
    });

    it('rejects degenerate quote prices', async () => {
      const redis = makeRedis();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = redis as any;
      expect(await placeRestingOrder(r, makeCandidate(), makeQuote({ price: 0 }), { maxUsd: 5 })).toBeNull();
      expect(await placeRestingOrder(r, makeCandidate(), makeQuote({ price: 1 }), { maxUsd: 5 })).toBeNull();
      expect(mockSubmitLimit).not.toHaveBeenCalled();
    });

    it('share-matches a pairing leg: size = matchShares, sizeUsd = shares × price', async () => {
      const redis = makeRedis();
      mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'order-pair' });

      // First leg was 8.4746 YES shares; this NO leg at 0.38 must match the
      // SHARE count (8.4746 → $3.22), not size fresh at $5 (13.16 shares,
      // leaving ~4.7 shares directional if both fill).
      const quote = makeQuote({ direction: 'NO', tokenId: 'tok-no', price: 0.38 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order = await placeRestingOrder(redis as any, makeCandidate(), quote, {
        maxUsd: 5,
        matchShares: 8.4746,
      });

      expect(order).not.toBeNull();
      expect(order!.size).toBeCloseTo(8.4746, 4);
      expect(order!.sizeUsd).toBeCloseTo(8.4746 * 0.38, 4);
      expect(mockSubmitLimit).toHaveBeenCalledWith(
        expect.objectContaining({ size: expect.closeTo(8.4746, 4) as number, price: 0.38 }),
      );
    });

    it('caps a pairing leg at the budget ceiling when matchShares is larger', async () => {
      const redis = makeRedis();
      mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'order-capped' });

      // Held inventory 30 shares but only $5 budget at 0.50 → 10 shares.
      const quote = makeQuote({ price: 0.5 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order = await placeRestingOrder(redis as any, makeCandidate(), quote, {
        maxUsd: 5,
        matchShares: 30,
      });

      expect(order!.size).toBeCloseTo(10, 6);
      expect(order!.sizeUsd).toBeCloseTo(5, 6);
    });

    it('skips a pairing leg below the CLOB minimum instead of falling back to fresh sizing', async () => {
      const redis = makeRedis();

      // 1.2 held shares at 0.38 = $0.456 < $1 CLOB minimum — placing fresh
      // $5 here would recreate the oversized pair this sizing prevents.
      const quote = makeQuote({ direction: 'NO', tokenId: 'tok-no', price: 0.38 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order = await placeRestingOrder(redis as any, makeCandidate(), quote, {
        maxUsd: 5,
        matchShares: 1.2,
      });

      expect(order).toBeNull();
      expect(mockSubmitLimit).not.toHaveBeenCalled();
      // Not an API failure — no place_failures bump.
      const stats = statCalls(redis);
      expect(stats.some((s) => s.field === 'place_failures')).toBe(false);
    });
  });

  describe('resolvePairTarget', () => {
    it('prioritizes held inventory > resting opposite', () => {
      expect(
        resolvePairTarget(
          { shares: 8.5, price: 0.61 },
          { shares: 13.5, price: 0.37 },
        ),
      ).toEqual({ matchShares: 8.5, partnerCost: 0.61 });
      expect(
        resolvePairTarget(null, { shares: 13.5, price: 0.37 }),
      ).toEqual({ matchShares: 13.5, partnerCost: 0.37 });
      expect(resolvePairTarget(null, null)).toBeUndefined();
    });

    it('skips candidates with zero/negative/non-finite shares or price', () => {
      expect(
        resolvePairTarget(
          { shares: 0, price: 0.5 },
          { shares: 13.5, price: -1 },
        ),
      ).toBeUndefined();
      expect(
        resolvePairTarget({ shares: NaN, price: 0.5 }, { shares: 7, price: 0.4 }),
      ).toEqual({ matchShares: 7, partnerCost: 0.4 });
    });

    it('BLOCKS pairing (null) when held inventory exists with an unusable cost basis', () => {
      // The ceiling can't be evaluated without the held entry price. Falling
      // through to the resting order would size against the WRONG inventory
      // (13.5 resting vs 8.5 held = 5 directional shares); placing fresh
      // would recreate the oversized pair. Fail closed.
      expect(
        resolvePairTarget(
          { shares: 8.5, price: undefined },
          { shares: 13.5, price: 0.37 },
        ),
      ).toBeNull();
      expect(resolvePairTarget({ shares: 8.5, price: 0 }, null)).toBeNull();
      expect(resolvePairTarget({ shares: 8.5, price: NaN }, null)).toBeNull();
    });
  });

  describe('pair-cost ceiling', () => {
    it('rejects a pair-completing leg whose combined cost locks a loss (live CS replay)', async () => {
      const redis = makeRedis();

      // 2026-06-06 live failure: held YES@0.61, market moved, NO repriced to
      // 0.65 → combined 1.26 → guaranteed −$2 if both redeem. The leg must be
      // SKIPPED (no submit, no place_failures bump), not placed.
      const quote = makeQuote({ direction: 'NO', tokenId: 'tok-no', price: 0.65 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order = await placeRestingOrder(redis as any, makeCandidate(), quote, {
        maxUsd: 5,
        matchShares: 8.19,
        partnerCost: 0.61,
      });

      expect(order).toBeNull();
      expect(mockSubmitLimit).not.toHaveBeenCalled();
      const stats = statCalls(redis);
      expect(stats).toContainEqual({ key: 'rebate:stats', field: 'pair_cost_skips', by: 1 });
      expect(stats.some((s) => s.field === 'place_failures')).toBe(false);
    });

    it('places a pair-completing leg when combined cost is at or under 1 − minCombinedEdge', async () => {
      const redis = makeRedis();
      mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'order-pair-ok' });

      // 0.33 + 0.63 = 0.96 ≤ 0.98 ceiling → riskless pair, place it.
      const quote = makeQuote({ direction: 'NO', tokenId: 'tok-no', price: 0.63 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order = await placeRestingOrder(redis as any, makeCandidate(), quote, {
        maxUsd: 5,
        matchShares: 7.93,
        partnerCost: 0.33,
      });

      expect(order).not.toBeNull();
      expect(order!.size).toBeCloseTo(7.93, 4);
    });

    it('rejects exactly at the boundary (combined just above the ceiling)', async () => {
      const redis = makeRedis();

      // ceiling = 0.98; 0.50 + 0.485 = 0.985 > 0.98 → reject.
      const quote = makeQuote({ price: 0.485 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order = await placeRestingOrder(redis as any, makeCandidate(), quote, {
        maxUsd: 5,
        matchShares: 10,
        partnerCost: 0.50,
      });

      expect(order).toBeNull();
      expect(mockSubmitLimit).not.toHaveBeenCalled();
    });

    it('does not apply the ceiling to fresh legs (no partnerCost)', async () => {
      const redis = makeRedis();
      mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'order-fresh' });

      // A fresh 0.65 leg with no partner is just a one-sided quote — allowed.
      const quote = makeQuote({ direction: 'NO', tokenId: 'tok-no', price: 0.65 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order = await placeRestingOrder(redis as any, makeCandidate(), quote, { maxUsd: 5 });

      expect(order).not.toBeNull();
    });
  });

  describe('cancelForReprice', () => {
    it('cancels, removes tracking, and counts a reprice on confirmed zero-fill cancel', async () => {
      const redis = makeRedis();
      mockCancelOrder.mockResolvedValue(true);
      // Post-cancel recheck (always performed): dead, nothing filled.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockGetOrder.mockResolvedValue({ status: 'CANCELED', size_matched: '0' } as any);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ok = await cancelForReprice(redis as any, makeOrder());

      expect(ok).toBe(true);
      expect(redis.hdel).toHaveBeenCalledWith('rebate:orders', 'order-1');
      const stats = statCalls(redis);
      const todayKey = `rebate:stats:date:${new Date().toISOString().slice(0, 10)}`;
      expect(stats).toContainEqual({ key: 'rebate:stats', field: 'reprice_cancels', by: 1 });
      expect(stats).toContainEqual({ key: todayKey, field: 'reprice_cancels', by: 1 });
    });

    it('PR-459 review: records a fill that raced the reprice cancel and skips the re-post', async () => {
      const redis = makeRedis();
      mockCancelOrder.mockResolvedValue(true); // remainder cancelled
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockGetOrder.mockResolvedValue({ status: 'CANCELED', size_matched: '5.0', original_size: '12.8' } as any);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ok = await cancelForReprice(redis as any, makeOrder({ direction: 'YES' }));

      // No re-post: the capital became held inventory.
      expect(ok).toBe(false);
      expect(mockRecordPosition).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sharesHeld: 5.0, sourcedFrom: 'rebate-farming' }),
      );
      expect(redis.hdel).toHaveBeenCalledWith('rebate:orders', 'order-1');
      const stats = statCalls(redis);
      expect(stats).toContainEqual({ key: 'rebate:stats', field: 'partial_fills', by: 1 });
      expect(stats.some((s) => s.field === 'reprice_cancels')).toBe(false);
    });

    it('PR-459 review: keeps the original tracked when the post-cancel recheck is unavailable', async () => {
      const redis = makeRedis();
      mockCancelOrder.mockResolvedValue(true);
      mockGetOrder.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ok = await cancelForReprice(redis as any, makeOrder());

      expect(ok).toBe(false);
      expect(redis.hdel).not.toHaveBeenCalled();
    });

    it('keeps the original order when cancel fails and the order is still live', async () => {
      const redis = makeRedis();
      mockCancelOrder.mockResolvedValue(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockGetOrder.mockResolvedValue({ status: 'LIVE' } as any);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ok = await cancelForReprice(redis as any, makeOrder());

      expect(ok).toBe(false);
      expect(redis.hdel).not.toHaveBeenCalled();
    });

    it('treats a cancel-failure with confirmed-cancelled recheck as success', async () => {
      const redis = makeRedis();
      mockCancelOrder.mockResolvedValue(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockGetOrder.mockResolvedValue({ status: 'CANCELED' } as any);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ok = await cancelForReprice(redis as any, makeOrder());

      expect(ok).toBe(true);
      expect(redis.hdel).toHaveBeenCalledWith('rebate:orders', 'order-1');
    });
  });

  describe('order map helpers', () => {
    it('findRestingOrder matches on market AND direction (two-sided quoting)', async () => {
      const redis = makeRedis();
      const yes = makeOrder({ orderId: 'o-yes', direction: 'YES' });
      const no = makeOrder({ orderId: 'o-no', direction: 'NO' });
      redis.hgetall.mockResolvedValue({
        'o-yes': JSON.stringify(yes),
        'o-no': JSON.stringify(no),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const orders = await loadRestingOrders(redis as any);

      expect(findRestingOrder(orders, 'mkt-1', 'YES')?.orderId).toBe('o-yes');
      expect(findRestingOrder(orders, 'mkt-1', 'NO')?.orderId).toBe('o-no');
      expect(findRestingOrder(orders, 'mkt-other', 'YES')).toBeNull();
    });

    it('deployedUsd and deployedUsdForMarket sum the loaded map', () => {
      const orders = new Map<string, RestingOrder>([
        ['a', makeOrder({ orderId: 'a', marketId: 'mkt-1', sizeUsd: 5 })],
        ['b', makeOrder({ orderId: 'b', marketId: 'mkt-1', sizeUsd: 5, direction: 'NO' })],
        ['c', makeOrder({ orderId: 'c', marketId: 'mkt-2', sizeUsd: 10 })],
      ]);

      expect(deployedUsd(orders)).toBe(20);
      expect(deployedUsdForMarket(orders, 'mkt-1')).toBe(10);
      expect(deployedUsdForMarket(orders, 'mkt-2')).toBe(10);
    });

    it('getDeployedUsd sums sizeUsd from all tracked orders (Redis-backed)', async () => {
      const redis = makeRedis();
      redis.hgetall.mockResolvedValue({
        'order-1': JSON.stringify({ sizeUsd: 5 }),
        'order-2': JSON.stringify({ sizeUsd: 10 }),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const deployed = await getDeployedUsd(redis as any);
      expect(deployed).toBe(15);
    });
  });

  describe('hasRestingOrderForMarket', () => {
    it('returns true when orders exist for market', async () => {
      const redis = makeRedis();
      redis.scard.mockResolvedValue(2);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const has = await hasRestingOrderForMarket(redis as any, 'mkt-1');
      expect(has).toBe(true);
    });

    it('returns false when no orders exist', async () => {
      const redis = makeRedis();
      redis.scard.mockResolvedValue(0);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const has = await hasRestingOrderForMarket(redis as any, 'mkt-1');
      expect(has).toBe(false);
    });
  });

  describe('orphan-leg sweep (via reconcileOrders)', () => {
    function liveClobOrder(): Record<string, unknown> {
      return { status: 'LIVE', size_matched: '0', original_size: '12.8' };
    }

    it('cancels a naked fresh leg: no held opposite, no resting opposite', async () => {
      const redis = makeRedis();
      const order = makeOrder({ orderId: 'order-naked', direction: 'YES' });
      redis.hgetall.mockResolvedValue({ 'order-naked': JSON.stringify(order) });
      mockGetOrder.mockResolvedValue(liveClobOrder());
      mockGetPosition.mockResolvedValue(null); // nothing held
      mockCancelOrder.mockResolvedValue(true);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await reconcileOrders(redis as any);

      expect(result.orphanCancels).toHaveLength(1);
      expect(mockCancelOrder).toHaveBeenCalledWith('order-naked');
      expect(redis.hdel).toHaveBeenCalledWith('rebate:orders', 'order-naked');
      // Three-bucket stat convention: cumulative + per-market + per-day.
      const todayKey = `rebate:stats:date:${new Date().toISOString().slice(0, 10)}`;
      const stats = statCalls(redis);
      expect(stats).toContainEqual({ key: 'rebate:stats', field: 'orphan_leg_cancels', by: 1 });
      expect(stats).toContainEqual({ key: 'rebate:stats:market:mkt-1', field: 'orphan_leg_cancels', by: 1 });
      expect(stats).toContainEqual({ key: todayKey, field: 'orphan_leg_cancels', by: 1 });
    });

    it('spares a pair-completion state: held opposite position exists', async () => {
      const redis = makeRedis();
      const order = makeOrder({ orderId: 'order-completion', direction: 'NO' });
      redis.hgetall.mockResolvedValue({ 'order-completion': JSON.stringify(order) });
      mockGetOrder.mockResolvedValue(liveClobOrder());
      mockGetPosition.mockResolvedValue({ sharesHeld: 8.19, entryPrice: 0.5 }); // held YES

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await reconcileOrders(redis as any);

      expect(result.orphanCancels).toHaveLength(0);
      expect(mockCancelOrder).not.toHaveBeenCalled();
    });

    it('spares an intact two-sided resting pair', async () => {
      const redis = makeRedis();
      const yes = makeOrder({ orderId: 'order-yes', direction: 'YES', tokenId: 'tok-yes' });
      const no = makeOrder({ orderId: 'order-no', direction: 'NO', tokenId: 'tok-no' });
      redis.hgetall.mockResolvedValue({
        'order-yes': JSON.stringify(yes),
        'order-no': JSON.stringify(no),
      });
      mockGetOrder.mockResolvedValue(liveClobOrder());
      mockGetPosition.mockResolvedValue(null); // nothing held — the legs save each other

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await reconcileOrders(redis as any);

      expect(result.orphanCancels).toHaveLength(0);
      expect(mockCancelOrder).not.toHaveBeenCalled();
    });

    it('keeps a naked leg TRACKED when the cancel cannot be confirmed', async () => {
      const redis = makeRedis();
      const order = makeOrder({ orderId: 'order-stuck', direction: 'YES' });
      redis.hgetall.mockResolvedValue({ 'order-stuck': JSON.stringify(order) });
      mockGetOrder.mockResolvedValue(liveClobOrder()); // still live on recheck too
      mockGetPosition.mockResolvedValue(null);
      mockCancelOrder.mockResolvedValue(false); // cancel fails

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await reconcileOrders(redis as any);

      expect(result.orphanCancels).toHaveLength(0);
      expect(result.errors).toBeGreaterThanOrEqual(1);
      // Never drop tracking for an order that may still be live.
      expect(redis.hdel).not.toHaveBeenCalledWith('rebate:orders', 'order-stuck');
    });
  });

  describe('cancelRestingOrder', () => {
    it("reason='rollback' cancels cleanly (zero fill), untracks and bumps pair_rollbacks", async () => {
      const redis = makeRedis();
      const order = makeOrder({ orderId: 'order-rb' });
      mockCancelOrder.mockResolvedValue(true);
      mockGetOrder.mockResolvedValue({ status: 'CANCELED', size_matched: '0', original_size: '12.8' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outcome = await cancelRestingOrder(redis as any, order, 'rollback');

      expect(outcome).toBe('cancelled');
      expect(redis.hdel).toHaveBeenCalledWith('rebate:orders', 'order-rb');
      // Three-bucket stat convention: cumulative + per-market + per-day.
      const todayKey = `rebate:stats:date:${new Date().toISOString().slice(0, 10)}`;
      const stats = statCalls(redis);
      expect(stats).toContainEqual({ key: 'rebate:stats', field: 'pair_rollbacks', by: 1 });
      expect(stats).toContainEqual({ key: 'rebate:stats:market:mkt-1', field: 'pair_rollbacks', by: 1 });
      expect(stats).toContainEqual({ key: todayKey, field: 'pair_rollbacks', by: 1 });
    });

    it('treats a failed cancel whose recheck shows the order gone (zero fill) as cancelled', async () => {
      const redis = makeRedis();
      const order = makeOrder({ orderId: 'order-already-gone' });
      mockCancelOrder.mockResolvedValue(false);
      mockGetOrder.mockResolvedValue({ status: 'CANCELED', size_matched: '0', original_size: '12.8' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outcome = await cancelRestingOrder(redis as any, order, 'rollback');

      expect(outcome).toBe('cancelled');
      expect(redis.hdel).toHaveBeenCalledWith('rebate:orders', 'order-already-gone');
    });

    it('keeps tracking when the order is verifiably still live', async () => {
      const redis = makeRedis();
      const order = makeOrder({ orderId: 'order-live' });
      mockCancelOrder.mockResolvedValue(false);
      mockGetOrder.mockResolvedValue({ status: 'LIVE', size_matched: '0', original_size: '12.8' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outcome = await cancelRestingOrder(redis as any, order, 'rollback');

      expect(outcome).toBe('kept_tracked');
      expect(redis.hdel).not.toHaveBeenCalled();
    });

    it('PR-459 review: keeps tracking on cancel-fail + recheck-null (transient, NOT genuinely gone)', async () => {
      // getClobOrder returns null for transient fetch failures too — dropping
      // tracking here could lose visibility of a LIVE order.
      const redis = makeRedis();
      const order = makeOrder({ orderId: 'order-blip' });
      mockCancelOrder.mockResolvedValue(false);
      mockGetOrder.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outcome = await cancelRestingOrder(redis as any, order, 'rollback');

      expect(outcome).toBe('kept_tracked');
      expect(redis.hdel).not.toHaveBeenCalled();
      expect(mockRecordPosition).not.toHaveBeenCalled();
    });

    it('PR-459 review: keeps tracking when cancel SUCCEEDED but the recheck is unavailable', async () => {
      // The order is dead, but whether it partially filled first is unknown —
      // reconcile resolves it next cycle with full fill accounting.
      const redis = makeRedis();
      const order = makeOrder({ orderId: 'order-cancelled-blind' });
      mockCancelOrder.mockResolvedValue(true);
      mockGetOrder.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outcome = await cancelRestingOrder(redis as any, order, 'orphan');

      expect(outcome).toBe('kept_tracked');
      expect(redis.hdel).not.toHaveBeenCalled();
    });

    it('PR-459 review: records the fill when the order MATCHED before the cancel took hold', async () => {
      const redis = makeRedis();
      const order = makeOrder({ orderId: 'order-raced-fill', direction: 'YES' });
      mockCancelOrder.mockResolvedValue(false);
      mockGetOrder.mockResolvedValue({ status: 'MATCHED', size_matched: '12.8', original_size: '12.8' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outcome = await cancelRestingOrder(redis as any, order, 'rollback');

      expect(outcome).toBe('filled');
      // The fill reaches the position ledger BEFORE tracking is dropped —
      // losing it would create invisible naked inventory.
      expect(mockRecordPosition).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          marketId: 'mkt-1',
          direction: 'YES',
          sharesHeld: 12.8,
          sourcedFrom: 'rebate-farming',
        }),
      );
      expect(redis.hdel).toHaveBeenCalledWith('rebate:orders', 'order-raced-fill');
      const stats = statCalls(redis);
      expect(stats).toContainEqual({ key: 'rebate:stats', field: 'fills', by: 1 });
      // No rollback stat — this was a fill, not a cancel.
      expect(stats.some((s) => s.field === 'pair_rollbacks')).toBe(false);
    });

    it('PR-459 review: records a PARTIAL fill after a successful cancel', async () => {
      const redis = makeRedis();
      const order = makeOrder({ orderId: 'order-partial', direction: 'YES' });
      mockCancelOrder.mockResolvedValue(true); // remainder cancelled fine
      mockGetOrder.mockResolvedValue({ status: 'CANCELED', size_matched: '4.0', original_size: '12.8' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outcome = await cancelRestingOrder(redis as any, order, 'rollback');

      expect(outcome).toBe('filled');
      expect(mockRecordPosition).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sharesHeld: 4.0 }),
      );
      const stats = statCalls(redis);
      expect(stats).toContainEqual({ key: 'rebate:stats', field: 'partial_fills', by: 1 });
    });
  });

  describe('config defaults (schema-derived)', () => {
    it('REBATE_MAX_ORDER_LIFETIME_S defaults to 86400 (24h backstop)', () => {
      // Derived from the REAL Zod schema so the new knob can't silently drift
      // from config.ts (see feedback: hand-written mocks crash on new reads).
      expect(schemaDefaults(envSchema).REBATE_MAX_ORDER_LIFETIME_S).toBe(86_400);
    });
  });
});
