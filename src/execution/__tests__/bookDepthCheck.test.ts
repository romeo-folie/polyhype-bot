import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrderBookSummary } from '@polymarket/clob-client';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetClobOrderBook = vi.fn<() => Promise<OrderBookSummary | null>>();
vi.mock('../../shared/clob.js', () => ({
  getClobOrderBook: (...args: unknown[]) => mockGetClobOrderBook(...(args as [])),
}));

// Dynamic import after mock setup
const { simulateFill, checkBookDepthForStake } = await import('../bookDepthCheck.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBook(asks: { price: string; size: string }[]): OrderBookSummary {
  return { bids: [], asks } as unknown as OrderBookSummary;
}

// ---------------------------------------------------------------------------
// simulateFill — pure unit tests (no CLOB mock needed)
// ---------------------------------------------------------------------------

describe('simulateFill', () => {
  it('returns no_book for null orderbook', () => {
    const result = simulateFill(null, 5, 200);
    expect(result).toEqual({ ok: false, reason: 'no_book' });
  });

  it('returns no_book for empty asks', () => {
    const result = simulateFill(makeBook([]), 5, 200);
    expect(result).toEqual({ ok: false, reason: 'no_book' });
  });

  it('passes when stake fits within best ask level with zero slippage', () => {
    // Single level at 0.07, size=1000 shares → $70 depth > $5 stake
    const result = simulateFill(makeBook([{ price: '0.07', size: '1000' }]), 5, 200);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expectedFillPrice).toBeCloseTo(0.07);
      expect(result.expectedSlippageBps).toBe(0);
    }
  });

  it('returns insufficient_depth when book is too shallow', () => {
    // Only $0.70 depth at 0.07 × 10 shares — cannot fill $5
    const result = simulateFill(makeBook([{ price: '0.07', size: '10' }]), 5, 200);
    expect(result).toEqual({ ok: false, reason: 'insufficient_depth' });
  });

  it('returns slippage_too_high when fill spans into expensive levels', () => {
    // Level 1: 0.07 × 10 shares = $0.70
    // Level 2: 0.14 × 1000 shares = $140 (100% jump in price)
    // Weighted avg ≈ 0.13+ → slippage >> 200 bps
    const book = makeBook([
      { price: '0.07', size: '10' },
      { price: '0.14', size: '1000' },
    ]);
    const result = simulateFill(book, 5, 200);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('slippage_too_high');
      expect(result.expectedSlippageBps).toBeGreaterThan(200);
    }
  });

  it('passes when multi-level fill stays within maxSlippageBps', () => {
    // Level 1: 0.0700 × 20 shares = $1.40 (consumed fully)
    // Level 2: 0.0701 × 500 shares = $35.05 (remainder ~$3.60 filled here)
    // Weighted avg ≈ 0.07007 → slippage ≈ 1 bps, well within 200 bps
    const book = makeBook([
      { price: '0.0700', size: '20' },
      { price: '0.0701', size: '500' },
    ]);
    const result = simulateFill(book, 5, 200);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Weighted avg must be between the two ask levels
      expect(result.expectedFillPrice).toBeGreaterThan(0.0700);
      expect(result.expectedFillPrice).toBeLessThan(0.0702);
      expect(result.expectedSlippageBps).toBeLessThanOrEqual(200);
    }
  });

  it('skips ask levels with invalid price/size', () => {
    // One valid level with enough depth, one invalid
    const book = makeBook([
      { price: 'NaN', size: '1000' },
      { price: '0.07', size: '1000' },
    ]);
    const result = simulateFill(book, 5, 200);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkBookDepthForStake — integration (mocked CLOB)
// ---------------------------------------------------------------------------

describe('checkBookDepthForStake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns no_book when getClobOrderBook fails (network error)', async () => {
    mockGetClobOrderBook.mockResolvedValue(null);
    const result = await checkBookDepthForStake({
      tokenId: 'tok-1',
      side: 'BUY',
      stakeUsd: 5,
      maxSlippageBps: 200,
    });
    expect(result).toEqual({ ok: false, reason: 'no_book' });
  });

  it('passes through simulateFill result for a deep book', async () => {
    mockGetClobOrderBook.mockResolvedValue(
      makeBook([{ price: '0.07', size: '10000' }]),
    );
    const result = await checkBookDepthForStake({
      tokenId: 'tok-2',
      side: 'BUY',
      stakeUsd: 5,
      maxSlippageBps: 200,
    });
    expect(result.ok).toBe(true);
  });
});
