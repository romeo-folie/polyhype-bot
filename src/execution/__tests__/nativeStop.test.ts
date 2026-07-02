import { describe, it, expect } from 'vitest';
import { computeNativeStop } from '../nativeStop.js';

describe('computeNativeStop', () => {
  const base = {
    entryPrice: 100,
    direction: 'LONG' as const,
    leverage: 10,
    fixedSlRoePct: 8.5,
    maxLossRoePct: 25,
    bufferMult: 1,
  };

  it('uses the ATR design stop when it is tighter than the ROE backstop', () => {
    // design 1.5% price < backstop 25/10 = 2.5% price
    const r = computeNativeStop({ ...base, designSlPricePct: 1.5 });
    expect(r).not.toBeNull();
    expect(r?.effectiveSlPricePct).toBeCloseTo(1.5);
    expect(r?.triggerPx).toBeCloseTo(98.5);
  });

  it('binds to the ROE backstop when the design stop is wider (meme floor case)', () => {
    // The 2026-07-02 review case: meme SL floor clamps the design stop to 8%
    // price while the −25% ROE backstop sits at 2.5% price at 10x — the
    // backstop is where the software monitor will actually exit.
    const r = computeNativeStop({ ...base, designSlPricePct: 8 });
    expect(r?.effectiveSlPricePct).toBeCloseTo(2.5);
    expect(r?.triggerPx).toBeCloseTo(97.5);
  });

  it('falls back to the fixed ROE stop converted to price terms when no ATR stop exists', () => {
    // 8.5% ROE at 10x = 0.85% price, tighter than the 2.5% backstop
    const r = computeNativeStop({ ...base });
    expect(r?.effectiveSlPricePct).toBeCloseTo(0.85);
    expect(r?.triggerPx).toBeCloseTo(99.15);
  });

  it('scales the backstop with leverage (WIF-at-4.7x case)', () => {
    // At 4.7x the backstop is 25/4.7 ≈ 5.32% price — wider than a 3% design
    // stop, so the design stop binds.
    const r = computeNativeStop({ ...base, leverage: 4.7, designSlPricePct: 3 });
    expect(r?.effectiveSlPricePct).toBeCloseTo(3);
  });

  it('treats maxLossRoePct=0 as backstop-disabled', () => {
    const r = computeNativeStop({ ...base, maxLossRoePct: 0, designSlPricePct: 8 });
    expect(r?.effectiveSlPricePct).toBeCloseTo(8);
  });

  it('places SHORT triggers above entry', () => {
    const r = computeNativeStop({ ...base, direction: 'SHORT', designSlPricePct: 2 });
    expect(r?.triggerPx).toBeCloseTo(102);
  });

  it('applies the buffer multiplier to the trigger distance only', () => {
    const r = computeNativeStop({ ...base, designSlPricePct: 2, bufferMult: 1.15 });
    expect(r?.effectiveSlPricePct).toBeCloseTo(2);
    expect(r?.triggerDistancePct).toBeCloseTo(2.3);
    expect(r?.triggerPx).toBeCloseTo(97.7);
  });

  it('clamps buffer multipliers below 1 up to 1', () => {
    const r = computeNativeStop({ ...base, designSlPricePct: 2, bufferMult: 0.5 });
    expect(r?.triggerDistancePct).toBeCloseTo(2);
  });

  it('ignores non-finite or non-positive design stops', () => {
    expect(computeNativeStop({ ...base, designSlPricePct: NaN })?.effectiveSlPricePct).toBeCloseTo(0.85);
    expect(computeNativeStop({ ...base, designSlPricePct: 0 })?.effectiveSlPricePct).toBeCloseTo(0.85);
    expect(computeNativeStop({ ...base, designSlPricePct: -3 })?.effectiveSlPricePct).toBeCloseTo(0.85);
  });

  it('returns null on unusable inputs', () => {
    expect(computeNativeStop({ ...base, entryPrice: 0 })).toBeNull();
    expect(computeNativeStop({ ...base, entryPrice: NaN })).toBeNull();
    expect(computeNativeStop({ ...base, leverage: 0 })).toBeNull();
    // no design stop, no valid fixed stop, backstop disabled → nothing to anchor
    expect(
      computeNativeStop({ ...base, fixedSlRoePct: 0, maxLossRoePct: 0 }),
    ).toBeNull();
    // distance ≥ 100% price is a config error
    expect(
      computeNativeStop({ ...base, leverage: 0.2, maxLossRoePct: 25, fixedSlRoePct: 8.5, designSlPricePct: 120 }),
    ).toBeNull();
  });
});
