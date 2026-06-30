import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEnqueueWrite } = vi.hoisted(() => ({ mockEnqueueWrite: vi.fn() }));
vi.mock('../../db/writeQueue.js', () => ({ enqueueWrite: mockEnqueueWrite }));

import { makerToxicityBps, enqueueWeatherMakerLifecycle } from '../makerLifecycle.js';

describe('makerToxicityBps', () => {
  it('is positive when the mid sits ABOVE our posted price (favorable)', () => {
    // posted 0.50, mid 0.55 → (0.05/0.50)*1e4 = 1000 bps
    expect(makerToxicityBps(0.55, 0.50)).toBe(1000);
  });
  it('is negative when the mid sits BELOW our posted price (adverse / toxic)', () => {
    expect(makerToxicityBps(0.45, 0.50)).toBe(-1000);
  });
  it('is 0 when mid equals posted', () => {
    expect(makerToxicityBps(0.50, 0.50)).toBe(0);
  });
  it('returns null on missing / non-finite / non-positive inputs', () => {
    expect(makerToxicityBps(null, 0.5)).toBeNull();
    expect(makerToxicityBps(0.5, null)).toBeNull();
    expect(makerToxicityBps(NaN, 0.5)).toBeNull();
    expect(makerToxicityBps(0.5, 0)).toBeNull();
  });
});

describe('enqueueWeatherMakerLifecycle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes a weather_maker_lifecycle shadow row with the input as payload + toxicity in the envelope', () => {
    enqueueWeatherMakerLifecycle({
      eventType: 'filled',
      fillDetectionPath: 'reconciler',
      marketId: 'm1',
      direction: 'NO',
      city: 'seoul',
      postedPrice: 0.6,
      fillPrice: 0.6,
      fillShares: 10,
      toxicityBps: -250,
    });
    expect(mockEnqueueWrite).toHaveBeenCalledTimes(1);
    const [table, row] = mockEnqueueWrite.mock.calls[0]!;
    expect(table).toBe('shadow_observations');
    expect(row.kind).toBe('weather_maker_lifecycle');
    expect(row.marketId).toBe('m1');
    expect(row.direction).toBe('NO');
    expect(row.wouldBlock).toBe(false);
    expect(row.metricValue).toBe(-250); // toxicity proxy at the envelope level
    expect(row.payload.eventType).toBe('filled');
    expect(row.payload.fillDetectionPath).toBe('reconciler');
    expect(row.payload.city).toBe('seoul');
    expect(row.payload.fillPrice).toBe(0.6);
  });

  it('defaults envelope metricValue to 0 when toxicity is null (reconciler fills with no mid)', () => {
    enqueueWeatherMakerLifecycle({
      eventType: 'filled', fillDetectionPath: 'reconciler', marketId: 'm2', direction: 'YES', toxicityBps: null,
    });
    const [, row] = mockEnqueueWrite.mock.calls[0]!;
    expect(row.metricValue).toBe(0);
    expect(row.payload.toxicityBps).toBeNull();
  });

  it('a posted row carries cohort context + null fill fields', () => {
    enqueueWeatherMakerLifecycle({
      eventType: 'posted', fillDetectionPath: null, marketId: 'm3', direction: 'NO',
      strategyFamily: 'native_no', city: 'paris', bracket: '24°C', postedPrice: 0.55, clobMid: 0.55, modelProb: 0.7, edge: 0.12,
    });
    const [, row] = mockEnqueueWrite.mock.calls[0]!;
    expect(row.payload.eventType).toBe('posted');
    expect(row.payload.fillDetectionPath).toBeNull();
    expect(row.payload.strategyFamily).toBe('native_no');
    expect(row.payload.fillPrice).toBeUndefined();
  });
});
