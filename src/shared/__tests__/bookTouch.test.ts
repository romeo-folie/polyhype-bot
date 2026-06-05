import { describe, it, expect } from 'vitest';
import { getBookTouch } from '../bookTouch.js';

describe('getBookTouch', () => {
  it('extracts the touch from raw REST ordering (best price at the END of each array)', () => {
    // Real /book shape: bids ascending, asks descending — bids[0]/asks[0] are
    // the WORST levels. Reading them is how the farmer bid NO at 0.02 on a
    // market trading NO at 0.85.
    const book = {
      bids: [
        { price: '0.01', size: '26941' },
        { price: '0.19', size: '66185' },
        { price: '0.21', size: '234414' },
      ],
      asks: [
        { price: '0.99', size: '359445' },
        { price: '0.24', size: '35383' },
        { price: '0.22', size: '48152' },
      ],
    };

    const { bestBid, bestAsk } = getBookTouch(book);

    expect(bestBid).toBeCloseTo(0.21);
    expect(bestAsk).toBeCloseTo(0.22);
  });

  it('is order-agnostic: best-first arrays (WS convention) give the same touch', () => {
    const book = {
      bids: [
        { price: '0.21', size: '1' },
        { price: '0.19', size: '1' },
      ],
      asks: [
        { price: '0.22', size: '1' },
        { price: '0.99', size: '1' },
      ],
    };

    const { bestBid, bestAsk } = getBookTouch(book);

    expect(bestBid).toBeCloseTo(0.21);
    expect(bestAsk).toBeCloseTo(0.22);
  });

  it('returns 0 for empty or unparseable sides', () => {
    expect(getBookTouch({ bids: [], asks: [] })).toEqual({ bestBid: 0, bestAsk: 0 });
    expect(
      getBookTouch({
        bids: [{ price: 'garbage', size: '1' }],
        asks: [{ price: '0.5', size: '1' }],
      }),
    ).toEqual({ bestBid: 0, bestAsk: 0.5 });
  });
});
