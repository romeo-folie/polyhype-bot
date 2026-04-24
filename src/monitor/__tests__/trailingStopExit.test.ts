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
  MONITOR_NEAR_RES_PRICE_THRESHOLD: 0.95,
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

  describe('near-resolution guard (MONITOR_NEAR_RES_PRICE_THRESHOLD)', () => {
    // Reproduces the 2026-04-24 Feldbausch/Tabur incident:
    // WS cache showed YES bid = 0.01 → NO price = 0.99 → HWM poisoned to +60.98%.
    // WS TTL expired → Gamma REST returned stale 0.575 → drawdown fired trailing stop.
    // The guard must prevent HWM from being updated and must not fire an exit.

    it('does not update HWM or fire when currentBid is at the near-res threshold', () => {
      // Entry 0.615, WS cache shows NO = 0.99 (+60.98%).
      // Prior HWM was 0 (position entered at 0.615, never reached TP).
      const position = makePosition({
        sourcedFrom: 'copytrade:0xwhale',
        entryPrice: 0.615,
        direction: 'NO',
        highWaterMarkPct: 0,
      });
      const result = evaluateTrailingStop({
        position,
        currentPnlPct: 60.98,
        currentBid: 0.99, // near-res
        activationPct: 50, // COPYTRADE_TAKE_PROFIT * 100
        cfg,
      });
      expect(result.shouldExit).toBe(false);
      // HWM must NOT be updated to the spike value — preserve prior 0%.
      expect(result.newHwmPct).toBe(0);
    });

    it('does not fire trailing stop on the reversion tick after a near-res spike', () => {
      // Simulates the tick AFTER the near-res spike: WS TTL expired, Gamma REST
      // returned stale 0.575 price.  HWM was correctly preserved at 0 (not poisoned).
      const position = makePosition({
        sourcedFrom: 'copytrade:0xwhale',
        entryPrice: 0.615,
        direction: 'NO',
        highWaterMarkPct: 0, // preserved by near-res guard on prior tick
      });
      const result = evaluateTrailingStop({
        position,
        currentPnlPct: -6.5, // (0.575/0.615 - 1) × 100
        currentBid: 0.575,
        activationPct: 50,
        cfg,
      });
      // HWM (0) < activationPct (50) → trailing never armed → no exit.
      expect(result.shouldExit).toBe(false);
    });

    it('preserves a legitimately built HWM when price hits near-res threshold', () => {
      // A position that genuinely rose to 0.90 (HWM = +46.3%) before the price
      // hit 0.99.  The near-res guard must preserve the real HWM, not reset it.
      const position = makePosition({
        sourcedFrom: 'headline',
        entryPrice: 0.615,
        direction: 'NO',
        highWaterMarkPct: 46.3,
      });
      const result = evaluateTrailingStop({
        position,
        currentPnlPct: 60.98,
        currentBid: 0.99,
        activationPct: 50,
        cfg,
      });
      expect(result.shouldExit).toBe(false);
      expect(result.newHwmPct).toBe(46.3); // real HWM preserved, not 60.98
    });

    it('normal trailing stop still works on non-near-res prices', () => {
      // Ensure the guard does not interfere with ordinary trailing stop operation.
      const result = evaluateTrailingStop({
        position: makePosition({ highWaterMarkPct: 50 }),
        currentPnlPct: 35,
        currentBid: 0.7, // well below near-res threshold
        activationPct: ACTIVATION_PCT,
        cfg,
      });
      expect(result.shouldExit).toBe(true);
      expect(result.newHwmPct).toBe(50);
    });

    it('treats exactly 0.95 as near-res (boundary)', () => {
      const position = makePosition({
        sourcedFrom: 'copytrade:0xwhale',
        highWaterMarkPct: 0,
      });
      const result = evaluateTrailingStop({
        position,
        currentPnlPct: 55,
        currentBid: 0.95, // exactly at threshold
        activationPct: 50,
        cfg,
      });
      expect(result.shouldExit).toBe(false);
      expect(result.newHwmPct).toBe(0); // HWM not updated
    });

    it('treats 0.94 as normal (just below threshold)', () => {
      const position = makePosition({
        sourcedFrom: 'copytrade:0xwhale',
        highWaterMarkPct: 55,
      });
      const result = evaluateTrailingStop({
        position,
        currentPnlPct: 35,
        currentBid: 0.94, // just below threshold
        activationPct: 50,
        cfg,
      });
      // Floor = max(50, 55-10) = 50; currentPnlPct (35) ≤ 50 → should exit.
      expect(result.shouldExit).toBe(true);
    });
  });
});
