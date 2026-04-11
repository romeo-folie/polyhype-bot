/**
 * Unit tests for the pure entry-rule evaluator in `oracleLagScanner.ts`.
 *
 * Scope: `evaluateOracleLagEntry(market, move, config, nowMs?)` only. No
 * Redis, no executor, no feed — those are integration concerns tested
 * elsewhere. The single most load-bearing assertion is the P(YES) invariant
 * test, which guards against recreating the Apr 11 BTC Up/Down bug where
 * `consensusProbability` was stored as fair-value-of-our-side instead of
 * P(YES). See MEMORY.md → feedback_consensus_pyes_invariant.md.
 *
 * Units reminder: `move.pctMove` is in PERCENT, not a fraction.
 *   +0.08 → +8 bps (0.0008 fractional)
 *   -0.08 → -8 bps
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  evaluateOracleLagEntry,
  type OracleLagEvalConfig,
  type OracleLagMove,
} from '../oracleLagScanner.js';
import type { UpDownMarket } from '../../mapping/gamma.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Pinned wall-clock for deterministic `timeLeft` math. */
const NOW_MS = Date.UTC(2026, 3, 11, 12, 0, 0); // 2026-04-11T12:00:00Z

const defaultConfig: OracleLagEvalConfig = {
  minMovePct: 0.06, // 6 bps
  minTimeLeftMin: 5,
  maxEntryPrice: 0.62,
};

interface MarketOverrides {
  marketId?: string;
  slug?: string;
  question?: string;
  /** Minutes from `NOW_MS` until `endDate`. Default 10. */
  timeLeftMin?: number;
  /** `[UP, DOWN]` — UP is index 0, DOWN is index 1. */
  outcomePrices?: [number, number];
}

function buildMarket(overrides: MarketOverrides = {}): UpDownMarket {
  const timeLeftMin = overrides.timeLeftMin ?? 10;
  const endDate = new Date(NOW_MS + timeLeftMin * 60_000);
  const outcomePrices: [number, number] =
    overrides.outcomePrices ?? [0.52, 0.48];
  return {
    marketId: overrides.marketId ?? 'm-test',
    slug: overrides.slug ?? 'btc-updown-15m-test',
    question:
      overrides.question ?? 'Will Bitcoin go up in the next 15 minutes?',
    endDate,
    timeToResolutionMs: endDate.getTime() - NOW_MS,
    lifetime: '15m',
    asset: 'bitcoin',
    outcomePrices,
    clobTokenIds: ['token-up', 'token-down'],
    yesTokenId: 'token-up',
    noTokenId: 'token-down',
  };
}

function makeMove(pctMove: number, overrides: Partial<OracleLagMove> = {}): OracleLagMove {
  // Fractional move = pctMove / 100. Anchor around 72800 for realism.
  const oldPrice = overrides.oldPrice ?? 72800;
  const newPrice = overrides.newPrice ?? oldPrice * (1 + pctMove / 100);
  return {
    oldPrice,
    newPrice,
    pctMove,
    ticks: overrides.ticks ?? 5,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('evaluateOracleLagEntry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('happy paths', () => {
    const happyCases: {
      name: string;
      pctMove: number;
      prices: [number, number];
      expectedSide: 'UP' | 'DOWN';
      expectedEntryPrice: number;
    }[] = [
      {
        name: 'UP: +0.08% move, UP side at 0.52',
        pctMove: 0.08,
        prices: [0.52, 0.48],
        expectedSide: 'UP',
        expectedEntryPrice: 0.52,
      },
      {
        name: 'DOWN: -0.08% move, DOWN side cheaper at 0.48',
        pctMove: -0.08,
        prices: [0.52, 0.48],
        expectedSide: 'DOWN',
        expectedEntryPrice: 0.48,
      },
    ];

    for (const tc of happyCases) {
      it(tc.name, () => {
        const market = buildMarket({
          outcomePrices: tc.prices,
          timeLeftMin: 10,
        });
        const move = makeMove(tc.pctMove);

        const result = evaluateOracleLagEntry(market, move, defaultConfig);

        expect(result.shouldEnter).toBe(true);
        expect(result.side).toBe(tc.expectedSide);
        expect(result.entryPrice).toBe(tc.expectedEntryPrice);
        expect(result.blockReason).toBeUndefined();
        expect(result.timeLeftMin).toBeCloseTo(10, 5);
      });
    }
  });

  describe('block reasons', () => {
    const blockCases: {
      name: string;
      buildOverrides: MarketOverrides;
      move: OracleLagMove | null;
      expectedBlock:
        | 'no_move_data'
        | 'move_below_threshold'
        | 'time_left_below_threshold'
        | 'price_above_threshold';
    }[] = [
      {
        name: 'move too small (+0.05%) → move_below_threshold',
        buildOverrides: { outcomePrices: [0.52, 0.48], timeLeftMin: 10 },
        move: makeMove(0.05),
        expectedBlock: 'move_below_threshold',
      },
      {
        name: 'time left 4min < 5min floor → time_left_below_threshold',
        buildOverrides: { outcomePrices: [0.52, 0.48], timeLeftMin: 4 },
        move: makeMove(0.08),
        expectedBlock: 'time_left_below_threshold',
      },
      {
        name: 'UP entry price 0.65 > 0.62 ceiling → price_above_threshold',
        buildOverrides: { outcomePrices: [0.65, 0.35], timeLeftMin: 10 },
        move: makeMove(0.08),
        expectedBlock: 'price_above_threshold',
      },
      {
        name: 'move is null → no_move_data',
        buildOverrides: { outcomePrices: [0.52, 0.48], timeLeftMin: 10 },
        move: null,
        expectedBlock: 'no_move_data',
      },
    ];

    for (const tc of blockCases) {
      it(tc.name, () => {
        const market = buildMarket(tc.buildOverrides);
        const result = evaluateOracleLagEntry(market, tc.move, defaultConfig);
        expect(result.shouldEnter).toBe(false);
        expect(result.blockReason).toBe(tc.expectedBlock);
      });
    }
  });

  describe('block reason priority', () => {
    it('move_below_threshold wins when both move and time-left fail', () => {
      // Move is 0.03 (below 0.06 floor) AND timeLeft 3min (below 5min floor).
      // Priority order: no_move_data → move_below_threshold → time_left → price.
      // Expected winner: move_below_threshold.
      const market = buildMarket({
        outcomePrices: [0.52, 0.48],
        timeLeftMin: 3,
      });
      const move = makeMove(0.03);

      const result = evaluateOracleLagEntry(market, move, defaultConfig);

      expect(result.shouldEnter).toBe(false);
      expect(result.blockReason).toBe('move_below_threshold');
    });

    it('no_move_data wins when move is null even if other gates would fail', () => {
      // Time-left and price-ceiling would also both fail, but null-move is
      // rule 1 and short-circuits before any of them run.
      const market = buildMarket({
        outcomePrices: [0.9, 0.1],
        timeLeftMin: 1,
      });

      const result = evaluateOracleLagEntry(market, null, defaultConfig);

      expect(result.shouldEnter).toBe(false);
      expect(result.blockReason).toBe('no_move_data');
    });

    it('time_left_below_threshold wins over price_above_threshold', () => {
      // Move is valid, time-left is 2min (fails), entry price is 0.9 (would
      // also fail). Rule 3 runs before rule 4, so time-left wins.
      const market = buildMarket({
        outcomePrices: [0.9, 0.1],
        timeLeftMin: 2,
      });
      const move = makeMove(0.08);

      const result = evaluateOracleLagEntry(market, move, defaultConfig);

      expect(result.shouldEnter).toBe(false);
      expect(result.blockReason).toBe('time_left_below_threshold');
    });
  });

  describe('P(YES) invariant (Apr 11 BTC Up/Down bug guard)', () => {
    it('DOWN entry with pctMove=-0.08 yields consensusProbability ≈ 0.4992', () => {
      // This is the single most important assertion in the epic. If it fails,
      // evaluateOracleLagEntry is storing fair-value-of-our-side instead of
      // P(YES) and will trigger the same divergence_closed instant-exit bug
      // that burned us on 2026-04-11.
      const market = buildMarket({
        outcomePrices: [0.52, 0.48], // DOWN side cheaper
        timeLeftMin: 10,
      });
      const move = makeMove(-0.08, {
        oldPrice: 72800,
        newPrice: 72741.76,
      });

      const result = evaluateOracleLagEntry(market, move, defaultConfig);

      expect(result.shouldEnter).toBe(true);
      expect(result.side).toBe('DOWN');
      // P(YES) = 0.5 + (-0.08 / 100) = 0.4992. NOT 0.5008 (which would be
      // fair-value-of-DOWN-side, the exact bug this guards against).
      expect(result.consensusProbability).toBeCloseTo(0.4992, 4);
    });

    it('UP entry with pctMove=+0.08 yields consensusProbability ≈ 0.5008', () => {
      const market = buildMarket({
        outcomePrices: [0.52, 0.48],
        timeLeftMin: 10,
      });
      const move = makeMove(0.08);

      const result = evaluateOracleLagEntry(market, move, defaultConfig);

      expect(result.shouldEnter).toBe(true);
      expect(result.side).toBe('UP');
      // For UP, P(YES) = fair-value-of-our-side, so both the correct and the
      // buggy formula collide on the same number. Still assert it to lock in
      // the stored-as-P(YES) invariant symmetrically.
      expect(result.consensusProbability).toBeCloseTo(0.5008, 4);
    });
  });

  describe('nowMs injection', () => {
    it('uses explicit nowMs param over Date.now()', () => {
      // Pin system clock far in the future so any reliance on Date.now() would
      // make timeLeft negative and trip time_left_below_threshold.
      vi.setSystemTime(new Date(NOW_MS + 24 * 60 * 60 * 1000));
      const market = buildMarket({
        outcomePrices: [0.52, 0.48],
        timeLeftMin: 10,
      });
      const move = makeMove(0.08);

      // Pass the original NOW_MS explicitly — evaluator should honor it.
      const result = evaluateOracleLagEntry(
        market,
        move,
        defaultConfig,
        NOW_MS,
      );

      expect(result.shouldEnter).toBe(true);
      expect(result.timeLeftMin).toBeCloseTo(10, 5);
    });
  });
});
