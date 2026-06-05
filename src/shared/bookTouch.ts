/**
 * Best bid/ask (the touch) extraction for CLOB order books — pure, no I/O.
 *
 * The REST /book endpoint returns levels with the BEST price at the END of
 * each array (bids ascending, asks descending) — `bids[0]` is the BOTTOM of
 * the book, not the touch. Reading `bids[0]+tick` is how the rebate farmer
 * ended up bidding NO at 0.02 on a market trading NO at 0.85 (worst bid 0.01
 * + 1 tick). The WS protocol uses the OPPOSITE ordering (best-first), so this
 * scans every level instead of trusting either convention.
 */

import type { OrderBookSummary } from '@polymarket/clob-client-v2';

/**
 * Order-agnostic touch. Returns 0 for an empty/unparseable side.
 */
export function getBookTouch(
  book: Pick<OrderBookSummary, 'bids' | 'asks'>,
): { bestBid: number; bestAsk: number } {
  let bestBid = 0;
  for (const level of book.bids ?? []) {
    const p = parseFloat(level.price);
    if (isFinite(p) && p > bestBid) bestBid = p;
  }
  let bestAsk = 0;
  for (const level of book.asks ?? []) {
    const p = parseFloat(level.price);
    if (isFinite(p) && p > 0 && (bestAsk === 0 || p < bestAsk)) bestAsk = p;
  }
  return { bestBid, bestAsk };
}
