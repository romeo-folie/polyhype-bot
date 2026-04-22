import { describe, it, expect } from 'vitest';
import { atrTimeframeForSignalSource } from '../executor.js';

describe('atrTimeframeForSignalSource', () => {
  it('returns 15m for hl-momentum (15m swing strategy)', () => {
    expect(atrTimeframeForSignalSource('hl-momentum')).toBe('15m');
  });

  it('returns 1m for crypto-arb (1-minute confluence)', () => {
    expect(atrTimeframeForSignalSource('crypto-arb')).toBe('1m');
  });

  it('returns 1m for futures-monitor self-sourced rebalance', () => {
    expect(atrTimeframeForSignalSource('futures-monitor')).toBe('1m');
  });

  it('returns 1m for undefined / unknown sources (safe default)', () => {
    expect(atrTimeframeForSignalSource(undefined)).toBe('1m');
    expect(atrTimeframeForSignalSource('something-new')).toBe('1m');
  });
});
