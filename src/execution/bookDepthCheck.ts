/**
 * Book-depth slippage gate for near-zero entry scanner.
 *
 * Simulates filling `stakeUsd` against live CLOB asks to compute expected
 * weighted-average fill price and price impact before committing to a trade.
 *
 * `simulateFill` is a pure function exported separately so unit tests can
 * drive it without mocking the CLOB network call.
 */

import type { OrderBookSummary } from '@polymarket/clob-client';
import { getClobOrderBook } from '../shared/clob.js';

export interface BookDepthCheckInput {
  tokenId: string;
  side: 'BUY';
  stakeUsd: number;
  maxSlippageBps: number;
}

export type BookDepthCheckResult =
  | { ok: true; expectedFillPrice: number; expectedSlippageBps: number }
  | {
      ok: false;
      reason: 'insufficient_depth' | 'slippage_too_high' | 'no_book';
      expectedFillPrice?: number;
      expectedSlippageBps?: number;
    };

/**
 * Simulate consuming asks top-down against a USD budget.
 * Returns the weighted-average fill price and slippage in bps vs best ask.
 * Exported for unit testing without a live CLOB connection.
 */
export function simulateFill(
  book: OrderBookSummary | null,
  stakeUsd: number,
  maxSlippageBps: number,
): BookDepthCheckResult {
  if (!book || book.asks.length === 0) {
    return { ok: false, reason: 'no_book' };
  }

  const asks = [...book.asks]
    .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .filter((a) => isFinite(a.price) && isFinite(a.size) && a.price > 0 && a.size > 0)
    .sort((a, b) => a.price - b.price);

  if (asks.length === 0 || asks[0] === undefined) return { ok: false, reason: 'no_book' };

  const bestAsk = asks[0].price;
  let remainingUsd = stakeUsd;
  let totalShares = 0;
  let totalUsd = 0;

  for (const level of asks) {
    if (remainingUsd <= 0) break;
    const levelCostUsd = level.price * level.size;
    const usdHere = Math.min(remainingUsd, levelCostUsd);
    const sharesHere = usdHere / level.price;
    totalShares += sharesHere;
    totalUsd += usdHere;
    remainingUsd -= usdHere;
  }

  if (remainingUsd > 0.01) {
    return { ok: false, reason: 'insufficient_depth' };
  }

  const expectedFillPrice = totalShares > 0 ? totalUsd / totalShares : bestAsk;
  const expectedSlippageBps = Math.round(((expectedFillPrice - bestAsk) / bestAsk) * 10_000);

  if (expectedSlippageBps > maxSlippageBps) {
    return { ok: false, reason: 'slippage_too_high', expectedFillPrice, expectedSlippageBps };
  }

  return { ok: true, expectedFillPrice, expectedSlippageBps };
}

/**
 * Fetch the live order book for `tokenId` and check whether `stakeUsd`
 * can be filled within `maxSlippageBps` of the best ask.
 *
 * Returns `{ ok: false, reason: 'no_book' }` on any CLOB network failure
 * so the caller skips the trade rather than proceeding blind.
 */
export async function checkBookDepthForStake(
  input: BookDepthCheckInput,
): Promise<BookDepthCheckResult> {
  const book = await getClobOrderBook(input.tokenId);
  return simulateFill(book, input.stakeUsd, input.maxSlippageBps);
}
