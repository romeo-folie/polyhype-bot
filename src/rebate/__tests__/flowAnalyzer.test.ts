import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockFetchWithTimeout = vi.fn();
vi.mock('../../mapping/gamma.js', () => ({
  fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args),
}));

import {
  fetchRecentMarketFlow,
  makerRebateShare,
  estimateFillRebateUsd,
} from '../flowAnalyzer.js';

const NOW_MS = 1_780_000_000_000; // fixed clock
const NOW_S = NOW_MS / 1000;

interface TradeRow {
  side: string;
  size: number;
  price: number;
  timestamp: number;
  outcomeIndex: number;
}

function tradesResponse(rows: TradeRow[]): { ok: boolean; status: number; json: () => Promise<TradeRow[]> } {
  return { ok: true, status: 200, json: () => Promise.resolve(rows) };
}

describe('fetchRecentMarketFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('computes notional, fee-equivalent, and YES-frame VWAP over the lookback window', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      tradesResponse([
        // 100 YES shares at 0.40, 1h ago → notional $40
        { side: 'BUY', size: 100, price: 0.4, timestamp: NOW_S - 3600, outcomeIndex: 0 },
        // 50 NO shares at 0.55, 2h ago → notional $27.50, YES frame = 0.45
        { side: 'SELL', size: 50, price: 0.55, timestamp: NOW_S - 7200, outcomeIndex: 1 },
        // outside the 6h window — ignored entirely
        { side: 'BUY', size: 1000, price: 0.5, timestamp: NOW_S - 7 * 3600, outcomeIndex: 0 },
      ]),
    );

    const flow = await fetchRecentMarketFlow('0xcond', {
      lookbackHours: 6,
      feeRateBps: 1000,
      nowMs: NOW_MS,
    });

    expect(flow).not.toBeNull();
    expect(flow!.tradeCount).toBe(2);
    expect(flow!.takerNotionalUsd).toBeCloseTo(40 + 27.5);
    // fee_equivalent = size × 0.10 × p × (1−p):
    //   100 × 0.10 × 0.40 × 0.60 = 2.40
    //   50  × 0.10 × 0.55 × 0.45 = 1.2375
    expect(flow!.feeEquivalentUsd).toBeCloseTo(2.4 + 1.2375);
    expect(flow!.effectiveWindowHours).toBe(6);
    expect(flow!.takerNotionalUsdPerHour).toBeCloseTo(67.5 / 6);
    // VWAP in YES frame: (0.40×40 + 0.45×27.5) / 67.5
    expect(flow!.vwapYes).toBeCloseTo((0.4 * 40 + 0.45 * 27.5) / 67.5);
  });

  it('shrinks the per-hour window when a full tape does not span the lookback', async () => {
    // 500 rows (= fetch limit) all within the last hour → effective window 1h, not 6h.
    const rows = Array.from({ length: 500 }, (_, i) => ({
      side: 'BUY',
      size: 10,
      price: 0.5,
      timestamp: NOW_S - 3600 + i, // oldest exactly 1h ago
      outcomeIndex: 0,
    }));
    mockFetchWithTimeout.mockResolvedValue(tradesResponse(rows));

    const flow = await fetchRecentMarketFlow('0xcond', {
      lookbackHours: 6,
      feeRateBps: 1000,
      nowMs: NOW_MS,
    });

    expect(flow!.effectiveWindowHours).toBeCloseTo(1, 2);
    // 500 trades × $5 = $2500 over ~1h
    expect(flow!.takerNotionalUsdPerHour).toBeCloseTo(2500, 0);
  });

  it('returns zeroed stats (not null) for a market with no recent trades', async () => {
    mockFetchWithTimeout.mockResolvedValue(tradesResponse([]));

    const flow = await fetchRecentMarketFlow('0xcond', {
      lookbackHours: 6,
      feeRateBps: 1000,
      nowMs: NOW_MS,
    });

    expect(flow).not.toBeNull();
    expect(flow!.tradeCount).toBe(0);
    expect(flow!.takerNotionalUsdPerHour).toBe(0);
    expect(flow!.feeEquivalentUsdPerHour).toBe(0);
    expect(flow!.vwapYes).toBeNull();
  });

  it('returns null on fetch failure so callers do not assume flow exists', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve([]) });
    expect(
      await fetchRecentMarketFlow('0xcond', { lookbackHours: 6, feeRateBps: 1000, nowMs: NOW_MS }),
    ).toBeNull();

    mockFetchWithTimeout.mockRejectedValue(new Error('timeout'));
    expect(
      await fetchRecentMarketFlow('0xcond', { lookbackHours: 6, feeRateBps: 1000, nowMs: NOW_MS }),
    ).toBeNull();
  });

  it('skips malformed rows instead of poisoning the aggregates', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      tradesResponse([
        { side: 'BUY', size: 100, price: 0.4, timestamp: NOW_S - 60, outcomeIndex: 0 },
        // garbage rows
        { side: 'BUY', size: NaN, price: 0.4, timestamp: NOW_S - 60, outcomeIndex: 0 },
        { side: 'BUY', size: 10, price: 1.5, timestamp: NOW_S - 60, outcomeIndex: 0 },
        { side: 'BUY', size: 10, price: 0.4, timestamp: NaN, outcomeIndex: 0 },
      ]),
    );

    const flow = await fetchRecentMarketFlow('0xcond', {
      lookbackHours: 6,
      feeRateBps: 1000,
      nowMs: NOW_MS,
    });

    expect(flow!.tradeCount).toBe(1);
    expect(flow!.takerNotionalUsd).toBeCloseTo(40);
  });
});

describe('makerRebateShare', () => {
  it('returns 20% for crypto fee categories and 25% otherwise', () => {
    expect(makerRebateShare('crypto_fees')).toBe(0.2);
    expect(makerRebateShare('sports_fees_v2')).toBe(0.25);
    expect(makerRebateShare('politics_fees')).toBe(0.25);
    expect(makerRebateShare('weather_fees')).toBe(0.25);
    expect(makerRebateShare(null)).toBe(0.25);
    expect(makerRebateShare(undefined)).toBe(0.25);
  });
});

describe('estimateFillRebateUsd', () => {
  it('applies shares × feeRate × p(1−p) × share', () => {
    // 100 shares at 0.40, 1000bps fee, 25% share:
    // 100 × 0.10 × 0.40 × 0.60 × 0.25 = 0.60
    expect(estimateFillRebateUsd(100, 0.4, 1000, 0.25)).toBeCloseTo(0.6);
  });

  it('returns 0 for degenerate inputs', () => {
    expect(estimateFillRebateUsd(0, 0.4, 1000, 0.25)).toBe(0);
    expect(estimateFillRebateUsd(100, 0, 1000, 0.25)).toBe(0);
    expect(estimateFillRebateUsd(100, 1, 1000, 0.25)).toBe(0);
    expect(estimateFillRebateUsd(NaN, 0.4, 1000, 0.25)).toBe(0);
  });
});
