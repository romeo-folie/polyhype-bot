import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock external dependencies before imports.
vi.mock('../../shared/clob.js', () => ({
  submitClobLimitBuy: vi.fn(),
  getClobOrder: vi.fn(),
  cancelClobOrder: vi.fn(),
}));

vi.mock('../../execution/positionLedger.js', () => ({
  recordPosition: vi.fn(),
}));

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    REBATE_ORDER_TTL_S: 300,
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
  hasRestingOrderForMarket,
  getDeployedUsd,
} from '../orderManager.js';
import { getClobOrder, cancelClobOrder, submitClobLimitBuy } from '../../shared/clob.js';
import { recordPosition } from '../../execution/positionLedger.js';
import type { RebateMarketCandidate } from '../types.js';

const mockGetOrder = vi.mocked(getClobOrder);
const mockCancelOrder = vi.mocked(cancelClobOrder);
const mockSubmitLimit = vi.mocked(submitClobLimitBuy);
const mockRecordPosition = vi.mocked(recordPosition);

function makeRedis(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    hgetall: vi.fn().mockResolvedValue({}),
    hset: vi.fn().mockResolvedValue(1),
    hdel: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    scard: vi.fn().mockResolvedValue(0),
    hincrby: vi.fn().mockResolvedValue(1),
  };
}

function makeCandidate(overrides: Partial<RebateMarketCandidate> = {}): RebateMarketCandidate {
  return {
    marketId: 'mkt-1',
    conditionId: 'cond-1',
    question: 'Will X happen?',
    clobTokenIds: ['tok-yes', 'tok-no'],
    direction: 'YES',
    tokenId: 'tok-yes',
    bestBid: 0.50,
    bestAsk: 0.52,
    spreadBps: 385,
    midPrice: 0.51,
    volume: 100000,
    liquidity: 20000,
    score: 100000 * (10000 / 385),
    tickSize: '0.01',
    negRisk: false,
    endDate: null,
    ...overrides,
  };
}

describe('orderManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('reconcileOrders', () => {
    it('detects fully filled orders and records positions', async () => {
      const redis = makeRedis();
      const order = {
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
      };
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
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await reconcileOrders(redis as any);

      expect(result.filled).toHaveLength(1);
      expect(result.filled[0]!.orderId).toBe('order-1');
      expect(mockRecordPosition).toHaveBeenCalledOnce();
      expect(redis.hdel).toHaveBeenCalledWith('rebate:orders', 'order-1');
    });

    it('cancels stale orders past TTL', async () => {
      const redis = makeRedis();
      const order = {
        orderId: 'order-stale',
        marketId: 'mkt-1',
        conditionId: 'cond-1',
        tokenId: 'tok-yes',
        clobTokenIds: ['tok-yes', 'tok-no'],
        direction: 'YES',
        price: 0.51,
        size: 10,
        sizeUsd: 5.1,
        placedAt: new Date(Date.now() - 600_000).toISOString(), // 10 min ago (> 300s TTL)
        tickSize: '0.01',
        negRisk: false,
        question: 'Will X?',
      };
      redis.hgetall.mockResolvedValue({ 'order-stale': JSON.stringify(order) });

      mockGetOrder.mockResolvedValue({
        id: 'order-stale',
        status: 'LIVE',
        owner: '0x1',
        maker_address: '0x1',
        market: 'mkt-1',
        asset_id: 'tok-yes',
        side: 'BUY',
        original_size: '10',
        size_matched: '0',
        price: '0.51',
        associate_trades: [],
        outcome: 'YES',
        created_at: Date.now() - 600_000,
        expiration: '',
        order_type: 'GTC',
      });

      mockCancelOrder.mockResolvedValue(true);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await reconcileOrders(redis as any);

      expect(result.stale).toHaveLength(1);
      expect(mockCancelOrder).toHaveBeenCalledWith('order-stale');
      expect(redis.hdel).toHaveBeenCalledWith('rebate:orders', 'order-stale');
    });

    it('skips recently-placed orders when CLOB returns null (transient error)', async () => {
      const redis = makeRedis();
      const order = {
        orderId: 'order-gone',
        marketId: 'mkt-1',
        conditionId: 'cond-1',
        tokenId: 'tok-yes',
        clobTokenIds: ['tok-yes', 'tok-no'],
        direction: 'YES',
        price: 0.51,
        size: 10,
        sizeUsd: 5.1,
        placedAt: new Date().toISOString(), // fresh — within 2×TTL
        tickSize: '0.01',
        negRisk: false,
        question: 'Will X?',
      };
      redis.hgetall.mockResolvedValue({ 'order-gone': JSON.stringify(order) });
      mockGetOrder.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await reconcileOrders(redis as any);

      // Treated as transient — not removed, counted as error.
      expect(result.cancelled).toHaveLength(0);
      expect(result.errors).toBe(1);
      expect(redis.hdel).not.toHaveBeenCalledWith('rebate:orders', 'order-gone');
    });

    it('removes order when CLOB returns null and order is well past TTL', async () => {
      const redis = makeRedis();
      const order = {
        orderId: 'order-ancient',
        marketId: 'mkt-1',
        conditionId: 'cond-1',
        tokenId: 'tok-yes',
        clobTokenIds: ['tok-yes', 'tok-no'],
        direction: 'YES',
        price: 0.51,
        size: 10,
        sizeUsd: 5.1,
        placedAt: new Date(Date.now() - 700_000).toISOString(), // 11.7 min ago (> 2×300s TTL)
        tickSize: '0.01',
        negRisk: false,
        question: 'Will X?',
      };
      redis.hgetall.mockResolvedValue({ 'order-ancient': JSON.stringify(order) });
      mockGetOrder.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await reconcileOrders(redis as any);

      expect(result.cancelled).toHaveLength(1);
      expect(redis.hdel).toHaveBeenCalledWith('rebate:orders', 'order-ancient');
    });
  });

  describe('placeRestingOrder', () => {
    it('places a GTC post-only limit buy inside the spread', async () => {
      const redis = makeRedis();
      mockSubmitLimit.mockResolvedValue({
        success: true,
        order_id: 'order-new',
      });

      const candidate = makeCandidate();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order = await placeRestingOrder(redis as any, candidate, 5);

      expect(order).not.toBeNull();
      expect(order!.orderId).toBe('order-new');
      expect(order!.price).toBe(0.51); // bestBid(0.50) + tick(0.01) = 0.51
      expect(mockSubmitLimit).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenId: 'tok-yes',
          price: 0.51,
          orderType: 'GTC',
          postOnly: true,
        }),
      );
      expect(redis.hset).toHaveBeenCalled();
    });

    it('returns null when order submission fails', async () => {
      const redis = makeRedis();
      mockSubmitLimit.mockResolvedValue({ success: false, error: 'insufficient_balance' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order = await placeRestingOrder(redis as any, makeCandidate(), 5);
      expect(order).toBeNull();
    });

    it('caps price below bestAsk to ensure post-only', async () => {
      const redis = makeRedis();
      mockSubmitLimit.mockResolvedValue({ success: true, order_id: 'order-tight' });

      // Very tight spread: bid=0.50, ask=0.51, tick=0.01
      // bestBid + tick = 0.51 = bestAsk → must be capped to bestAsk - tick = 0.50
      const candidate = makeCandidate({ bestBid: 0.50, bestAsk: 0.51 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order = await placeRestingOrder(redis as any, candidate, 5);

      expect(order).not.toBeNull();
      expect(order!.price).toBe(0.50); // capped: min(0.51, 0.51-0.01) = 0.50
    });
  });

  describe('getDeployedUsd', () => {
    it('sums sizeUsd from all tracked orders', async () => {
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
});
