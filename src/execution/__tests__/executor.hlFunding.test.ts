import { describe, it, expect, vi } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../db/writeQueue.js', () => ({
  enqueueWrite: vi.fn(),
}));

import { buildHlFundingObservation } from '../executor.js';

describe('buildHlFundingObservation', () => {
  it('LONG with positive funding (paying funding) → wouldBlock=true when above threshold', () => {
    // fundingRate = 0.0002 → hourlyBps = 2.0
    // direction LONG → signedBps = +2.0
    // threshold = 1 → 2.0 > 1 → blocked
    const obs = buildHlFundingObservation(
      { marketId: 'BTC', direction: 'LONG' },
      0.0002,
      1,
      false,
    );
    expect(obs.hourlyBps).toBeCloseTo(2, 6);
    expect(obs.signedBps).toBeCloseTo(2, 6);
    expect(obs.wouldBlock).toBe(true);
    expect(obs.shadowRow.kind).toBe('hl_funding');
    expect(obs.shadowRow.source).toBe('futures');
    expect(obs.shadowRow.symbol).toBe('BTC');
    expect(obs.shadowRow.direction).toBe('LONG');
    expect(obs.shadowRow.metricValue).toBeCloseTo(2, 6);
    expect(obs.shadowRow.threshold).toBe(1);
    expect(obs.shadowRow.payload.gateEnabled).toBe(false);
    expect(obs.shadowRow.payload.absSignedBps).toBeCloseTo(2, 6);
  });

  it('LONG with negative funding (receiving funding) → wouldBlock=false', () => {
    // fundingRate = -0.0005 → hourlyBps = -5.0
    // direction LONG → signedBps = -5.0 (favorable)
    // threshold = 1 → -5 > 1 is false → not blocked
    const obs = buildHlFundingObservation(
      { marketId: 'ETH', direction: 'LONG' },
      -0.0005,
      1,
      false,
    );
    expect(obs.signedBps).toBeCloseTo(-5, 6);
    expect(obs.wouldBlock).toBe(false);
    expect(obs.shadowRow.metricValue).toBeCloseTo(-5, 6);
    // metricValue and wouldBlock must be aligned: metricValue > threshold ⇔ wouldBlock
    expect(obs.shadowRow.metricValue > obs.shadowRow.threshold).toBe(obs.wouldBlock);
  });

  it('SHORT with positive funding (receiving funding) → wouldBlock=false', () => {
    // fundingRate = 0.0003 → hourlyBps = 3.0
    // direction SHORT → signedBps = -3.0 (favorable for SHORT)
    const obs = buildHlFundingObservation(
      { marketId: 'BTC', direction: 'SHORT' },
      0.0003,
      1,
      false,
    );
    expect(obs.signedBps).toBeCloseTo(-3, 6);
    expect(obs.wouldBlock).toBe(false);
    expect(obs.shadowRow.metricValue > obs.shadowRow.threshold).toBe(obs.wouldBlock);
  });

  it('SHORT with negative funding (paying funding) → wouldBlock=true', () => {
    // fundingRate = -0.0004 → hourlyBps = -4.0
    // direction SHORT → signedBps = +4.0 (adverse for SHORT)
    const obs = buildHlFundingObservation(
      { marketId: 'BTC', direction: 'SHORT' },
      -0.0004,
      1,
      false,
    );
    expect(obs.signedBps).toBeCloseTo(4, 6);
    expect(obs.wouldBlock).toBe(true);
    expect(obs.shadowRow.metricValue > obs.shadowRow.threshold).toBe(obs.wouldBlock);
  });

  it('boundary: signedBps == threshold → not blocked (strict >)', () => {
    const obs = buildHlFundingObservation(
      { marketId: 'BTC', direction: 'LONG' },
      0.0001, // hourlyBps = 1, signedBps = 1, threshold = 1
      1,
      false,
    );
    expect(obs.signedBps).toBeCloseTo(1, 6);
    expect(obs.wouldBlock).toBe(false);
  });

  it('payload carries gateEnabled flag for downstream filtering', () => {
    const enabled = buildHlFundingObservation(
      { marketId: 'BTC', direction: 'LONG' }, 0.0002, 1, true,
    );
    const disabled = buildHlFundingObservation(
      { marketId: 'BTC', direction: 'LONG' }, 0.0002, 1, false,
    );
    expect(enabled.shadowRow.payload.gateEnabled).toBe(true);
    expect(disabled.shadowRow.payload.gateEnabled).toBe(false);
  });
});
