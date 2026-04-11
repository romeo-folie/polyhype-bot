import { describe, it, expect } from 'vitest';
import { evaluateTrailingStop } from '../trailingStopExit.js';
import type { Position } from '../../execution/positionLedger.js';
import type { AppConfig } from '../../shared/config.js';

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    marketId: 'mkt-1',
    conditionId: 'cond-1',
    clobTokenIds: ['tok-yes', 'tok-no'],
    question: 'Will X happen?',
    direction: 'YES',
    entryPrice: 0.5,
    stakeUsd: 10,
    consensusProbability: 0.7,
    edgeMagnitude: 0.2,
    sourcedFrom: 'headline',
    openedAt: new Date().toISOString(),
    executionVenue: 'clob',
    ...overrides,
  };
}

const cfg = {
  TRAILING_GIVEBACK_PCT: 10,
  TRAILING_MIN_EXIT_BID: 0.05,
} as unknown as AppConfig;

const ACTIVATION_PCT = 20; // matches TAKE_PROFIT_THRESHOLD=0.20

describe('evaluateTrailingStop', () => {
  it('is source-agnostic — copytrade positions are evaluated the same as OSINT', () => {
    // Peak +50%, pulled back to +35%, floor = max(20, 50-10) = 40 → should exit.
    const copytrade = makePosition({
      sourcedFrom: 'copytrade:0xwhale',
      highWaterMarkPct: 50,
    });
    const osint = makePosition({
      sourcedFrom: 'headline',
      highWaterMarkPct: 50,
    });

    const cResult = evaluateTrailingStop({
      position: copytrade,
      currentPnlPct: 35,
      currentBid: 0.7,
      activationPct: ACTIVATION_PCT,
      cfg,
    });
    const oResult = evaluateTrailingStop({
      position: osint,
      currentPnlPct: 35,
      currentBid: 0.7,
      activationPct: ACTIVATION_PCT,
      cfg,
    });

    expect(cResult.shouldExit).toBe(true);
    expect(oResult.shouldExit).toBe(true);
    expect(cResult.floorPct).toBe(oResult.floorPct);
    expect(cResult.peakPct).toBe(oResult.peakPct);
  });

  it('does not arm below activation threshold', () => {
    // PnL at +15%, below 20% activation — never arms regardless of source.
    const result = evaluateTrailingStop({
      position: makePosition({ sourcedFrom: 'copytrade:0xwhale' }),
      currentPnlPct: 15,
      currentBid: 0.6,
      activationPct: ACTIVATION_PCT,
      cfg,
    });
    expect(result.shouldExit).toBe(false);
  });

  it('floor clamps to TP line — immediate reversal at TP exits same as fixed-TP', () => {
    // Peak == activation (+20%), reversal below → floor is clamped to 20.
    const result = evaluateTrailingStop({
      position: makePosition({
        sourcedFrom: 'copytrade:0xwhale',
        highWaterMarkPct: 20,
      }),
      currentPnlPct: 19.5,
      currentBid: 0.6,
      activationPct: ACTIVATION_PCT,
      cfg,
    });
    expect(result.floorPct).toBe(20);
    expect(result.shouldExit).toBe(true);
  });

  it('lets winners run when pullback is shallower than giveback', () => {
    // Peak +50%, now +42%, floor = max(20, 50-10) = 40 → hold.
    const result = evaluateTrailingStop({
      position: makePosition({
        sourcedFrom: 'copytrade:0xwhale',
        highWaterMarkPct: 50,
      }),
      currentPnlPct: 42,
      currentBid: 0.7,
      activationPct: ACTIVATION_PCT,
      cfg,
    });
    expect(result.shouldExit).toBe(false);
    expect(result.floorPct).toBe(40);
  });

  it('ratchets HWM monotonically when new PnL exceeds prior peak', () => {
    const result = evaluateTrailingStop({
      position: makePosition({
        sourcedFrom: 'copytrade:0xwhale',
        highWaterMarkPct: 30,
      }),
      currentPnlPct: 45,
      currentBid: 0.7,
      activationPct: ACTIVATION_PCT,
      cfg,
    });
    expect(result.newHwmPct).toBe(45);
    expect(result.shouldExit).toBe(false);
  });

  it('skips exit when current bid is below min-exit-bid (illiquid book)', () => {
    // Would otherwise exit (peak 50, now 35, floor 40), but bid is too low.
    const result = evaluateTrailingStop({
      position: makePosition({
        sourcedFrom: 'copytrade:0xwhale',
        highWaterMarkPct: 50,
      }),
      currentPnlPct: 35,
      currentBid: 0.02,
      activationPct: ACTIVATION_PCT,
      cfg,
    });
    expect(result.shouldExit).toBe(false);
  });

  it('uses caller-supplied activationPct so divergent TP thresholds do not strand positions', () => {
    // Scenario: COPYTRADE_TAKE_PROFIT=0.15 while TAKE_PROFIT_THRESHOLD=0.25.
    // A copytrade at +16% has already crossed its fixed-TP line. With the
    // old hard-coded `cfg.TAKE_PROFIT_THRESHOLD * 100` activation the trailing
    // path would have sat below activation and held forever, losing the TP.
    // Now activation is supplied by the caller (=15), so trailing arms and the
    // floor-clamp invariant fires an immediate exit at the copytrade TP line.
    const result = evaluateTrailingStop({
      position: makePosition({
        sourcedFrom: 'copytrade:0xwhale',
        highWaterMarkPct: 16,
      }),
      currentPnlPct: 14.9,
      currentBid: 0.6,
      activationPct: 15, // COPYTRADE_TAKE_PROFIT * 100
      cfg,
    });
    expect(result.floorPct).toBe(15);
    expect(result.shouldExit).toBe(true);
  });

  it('respects higher activationPct when caller uses a stricter threshold', () => {
    // Peak +22%, activation 25% — below activation, hold.
    const result = evaluateTrailingStop({
      position: makePosition({
        sourcedFrom: 'headline',
        highWaterMarkPct: 22,
      }),
      currentPnlPct: 22,
      currentBid: 0.6,
      activationPct: 25,
      cfg,
    });
    expect(result.shouldExit).toBe(false);
  });
});
