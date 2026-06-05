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

/** One side level as it appears in REST books (strings) or WS events (string | number). */
interface RawLevel {
  price?: string | number;
  size?: string | number;
}

export interface TouchLevel {
  price: number;
  /** 0 when the source level had no parseable size. */
  size: number;
}

function parseLevelNumber(v: string | number | undefined): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return isFinite(n) ? n : NaN;
}

/**
 * Order-agnostic touch with level sizes. Accepts REST-shaped books (string
 * fields) and WS-event sides (string or number fields). Returns null for an
 * empty/unparseable side.
 */
export function getBookTouchLevels(book: {
  bids?: RawLevel[] | null;
  asks?: RawLevel[] | null;
}): { bestBid: TouchLevel | null; bestAsk: TouchLevel | null } {
  let bestBid: TouchLevel | null = null;
  for (const level of book.bids ?? []) {
    if (!level || typeof level !== 'object') continue;
    const p = parseLevelNumber(level.price);
    if (!isFinite(p) || p <= 0) continue;
    if (bestBid === null || p > bestBid.price) {
      const s = parseLevelNumber(level.size);
      bestBid = { price: p, size: isFinite(s) ? s : 0 };
    }
  }
  let bestAsk: TouchLevel | null = null;
  for (const level of book.asks ?? []) {
    if (!level || typeof level !== 'object') continue;
    const p = parseLevelNumber(level.price);
    if (!isFinite(p) || p <= 0) continue;
    if (bestAsk === null || p < bestAsk.price) {
      const s = parseLevelNumber(level.size);
      bestAsk = { price: p, size: isFinite(s) ? s : 0 };
    }
  }
  return { bestBid, bestAsk };
}

/**
 * Order-agnostic touch, prices only. Returns 0 for an empty/unparseable side.
 * Accepts any structurally book-shaped object (OrderBookSummary included).
 */
export function getBookTouch(book: {
  bids?: RawLevel[] | null;
  asks?: RawLevel[] | null;
}): { bestBid: number; bestAsk: number } {
  const { bestBid, bestAsk } = getBookTouchLevels(book);
  return { bestBid: bestBid?.price ?? 0, bestAsk: bestAsk?.price ?? 0 };
}
