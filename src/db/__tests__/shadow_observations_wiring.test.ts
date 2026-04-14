import { describe, it, expect } from 'vitest';
import { shadowObservationRowSchema } from '../schemas/shadow_observations.js';

// Asserts the shadow payloads emitted by each shadow-logged feature parse
// cleanly against the shadow_observations Zod schema. Guards against enum
// drift (source), required-field omissions, and direction typos. Payload
// shapes mirror the production call sites one-for-one.

describe('shadow_observations wiring', () => {
  it('accepts trend_exit payload (src/monitor/index.ts)', () => {
    const parsed = shadowObservationRowSchema.safeParse({
      kind: 'trend_exit',
      source: 'osint',
      marketId: '0xabc',
      direction: 'YES',
      wouldBlock: true,
      metricValue: -0.012,
      threshold: -0.005,
      payload: {
        category: 'us-politics',
        r2: 0.42,
        samples: 36,
        currentPnlPct: -8.2,
        ageH: 4.5,
        blockedReason: 'pnl_not_deep_enough',
        wouldExit: false,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts near_zero payload (src/cron/nearZeroScanner.ts)', () => {
    const parsed = shadowObservationRowSchema.safeParse({
      kind: 'near_zero',
      source: 'osint',
      marketId: '0xbeef',
      direction: 'YES',
      wouldBlock: false,
      metricValue: 0.62,
      threshold: 0.5,
      payload: {
        question: 'Will X happen?',
        marketPrice: 0.04,
        consensusPYes: 0.70,
        pOurSide: 0.70,
        stddev: 0.05,
        meetsEdge: true,
        payoutRatio: 24,
        minConsensus: 0.65,
        hasOsint: true,
        wouldTrade: true,
        scannerEnabled: false,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts weather_event payload (src/weather/weatherScanner.ts)', () => {
    const parsed = shadowObservationRowSchema.safeParse({
      kind: 'weather_event',
      source: 'arb',
      wouldBlock: false,
      metricValue: 0.18,
      threshold: 0.04,
      payload: {
        eventId: 'evt-1',
        slug: 'nyc-weather-2026-04-20',
        city: 'New York',
        targetDate: '2026-04-20',
        daysOut: 6,
        unit: 'F',
        brackets: 5,
        forecastHigh: 72.5,
        forecastStdDev: 2.1,
        forecastSource: 'openmeteo-ensemble',
        ensembleMembers: 10,
        overround: 1.04,
        opportunitiesFound: 1,
        enabled: false,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts weather_bracket payload (src/weather/weatherScanner.ts)', () => {
    const parsed = shadowObservationRowSchema.safeParse({
      kind: 'weather_bracket',
      source: 'arb',
      marketId: '0xw1',
      direction: 'YES',
      wouldBlock: true,
      metricValue: 0.12,
      threshold: 0.04,
      payload: {
        eventSlug: 'nyc-weather-2026-04-20',
        city: 'New York',
        targetDate: '2026-04-20',
        bracket: '70-75',
        tradeSide: 'YES',
        modelProb: 0.40,
        marketPrice: 0.28,
        adjustedMarketProb: 0.27,
        outcomePrice: 0.28,
        forecastHigh: 72.5,
        daysOut: 6,
        wouldTrade: false,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts longshot payload (src/cron/longshotScanner.ts)', () => {
    const parsed = shadowObservationRowSchema.safeParse({
      kind: 'longshot',
      source: 'arb',
      marketId: '0xls1',
      direction: 'NO',
      wouldBlock: true,
      metricValue: 0.05,
      threshold: 0.03,
      payload: {
        question: 'Will Candidate X win?',
        yesPrice: 0.12,
        noPrice: 0.88,
        category: 'us-politics',
        optimismGap: 0.08,
        liquidity: 4200,
        stakeUsd: 10,
        wouldExecute: false,
        shadow: true,
        scannerEnabled: false,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts correlation payload (src/cron/correlationScanner.ts)', () => {
    const parsed = shadowObservationRowSchema.safeParse({
      kind: 'correlation',
      source: 'arb',
      marketId: '0xc1',
      direction: 'YES',
      wouldBlock: true,
      metricValue: 0.07,
      threshold: 0.05,
      payload: {
        constraintType: 'implication',
        constraintId: 'edge-1',
        targetQuestion: 'Will B happen?',
        otherMarketId: '0xc2',
        otherQuestion: 'Will A happen?',
        priceA: 0.70,
        priceB: 0.40,
        stakeUsd: 10,
        wouldExecute: false,
        shadow: true,
        scannerEnabled: false,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts negrisk_arb payload (src/arb/negRiskScanner.ts)', () => {
    const parsed = shadowObservationRowSchema.safeParse({
      kind: 'negrisk_arb',
      source: 'arb',
      wouldBlock: true,
      metricValue: 0.02,
      threshold: 0.01,
      payload: {
        eventId: 'evt-x',
        title: '2026 Best Picture',
        legs: 10,
        sumAsks: 0.96,
        grossEdge: 0.04,
        totalFeesPerShare: 0.02,
        coverage: 1.1,
        minDepthShares: 50,
        wouldExecute: false,
        scannerEnabled: false,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts calibration_bias payload (src/mapping/divergenceCalculator.ts)', () => {
    const parsed = shadowObservationRowSchema.safeParse({
      kind: 'calibration_bias',
      source: 'osint',
      wouldBlock: true,
      metricValue: 0.03,
      threshold: 0,
      payload: {
        category: 'us-politics',
        theta: 1.83,
        rawPrice: 0.70,
        adjustedPrice: 0.73,
        hoursToResolution: 120,
        consensusProbability: 0.78,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects invalid source (guards Zod↔DB enum drift)', () => {
    const parsed = shadowObservationRowSchema.safeParse({
      kind: 'calibration_bias',
      source: 'osint-v2', // not in enum
      wouldBlock: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects invalid direction (guards Zod↔DB enum drift)', () => {
    const parsed = shadowObservationRowSchema.safeParse({
      kind: 'trend_exit',
      source: 'osint',
      direction: 'BUY', // not in enum
      wouldBlock: true,
    });
    expect(parsed.success).toBe(false);
  });
});
