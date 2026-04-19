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

import { loadConfig } from '../../shared/config.js';
import {
  buildOracleLagExecutorShadowRow,
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
  maxTimeLeftMin: 999,
  maxEntryPrice: 0.62,
  minEntryPrice: 0.35,
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
        | 'price_above_threshold'
        | 'price_below_threshold';
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
        name: 'DOWN entry NO price 0.10 < 0.35 floor → price_below_threshold',
        // YES=0.90, NO=0.10 — market already priced in the UP direction strongly.
        // A DOWN Chainlink tick would want to buy NO at 0.10, but the oracle-lag
        // thesis doesn't hold when the market has already moved this far.
        buildOverrides: { outcomePrices: [0.90, 0.10], timeLeftMin: 10 },
        move: makeMove(-0.08),
        expectedBlock: 'price_below_threshold',
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

    it('time_left_below_threshold wins over price_below_threshold', () => {
      // Move is valid (-0.08%), time-left is 2min (fails rule 3), DOWN entry
      // price is 0.10 (would fail rule 5). Rule 3 runs before rule 5.
      const market = buildMarket({
        outcomePrices: [0.90, 0.10],
        timeLeftMin: 2,
      });
      const move = makeMove(-0.08);

      const result = evaluateOracleLagEntry(market, move, defaultConfig);

      expect(result.shouldEnter).toBe(false);
      expect(result.blockReason).toBe('time_left_below_threshold');
    });

    it('time_left_above_threshold blocks when timeLeft exceeds maxTimeLeftMin', () => {
      const cfg: OracleLagEvalConfig = { ...defaultConfig, maxTimeLeftMin: 15 };
      const market = buildMarket({ outcomePrices: [0.50, 0.50], timeLeftMin: 20 });
      const move = makeMove(0.08);

      const result = evaluateOracleLagEntry(market, move, cfg);

      expect(result.shouldEnter).toBe(false);
      expect(result.blockReason).toBe('time_left_above_threshold');
    });

    it('time_left_above_threshold does not fire when timeLeft equals maxTimeLeftMin', () => {
      const cfg: OracleLagEvalConfig = { ...defaultConfig, maxTimeLeftMin: 15 };
      const market = buildMarket({ outcomePrices: [0.50, 0.50], timeLeftMin: 15 });
      const move = makeMove(0.08);

      const result = evaluateOracleLagEntry(market, move, cfg);

      expect(result.shouldEnter).toBe(true);
    });

    it('time_left_above_threshold wins over price_above_threshold (rule 3a before rule 4)', () => {
      const cfg: OracleLagEvalConfig = { ...defaultConfig, maxTimeLeftMin: 15, maxEntryPrice: 0.30 };
      const market = buildMarket({ outcomePrices: [0.50, 0.50], timeLeftMin: 20 });
      const move = makeMove(0.08);

      const result = evaluateOracleLagEntry(market, move, cfg);

      expect(result.shouldEnter).toBe(false);
      expect(result.blockReason).toBe('time_left_above_threshold');
    });

    it('price_above_threshold wins over price_below_threshold (mutually exclusive by design)', () => {
      // Sanity check: a config where min > max is misconfigured, but the
      // evaluator should still return rule-4 (price_above) before it reaches
      // rule-5 (price_below), since rule 4 runs first.
      const badConfig: OracleLagEvalConfig = {
        ...defaultConfig,
        maxEntryPrice: 0.30,
        minEntryPrice: 0.60, // inverted (bad config)
      };
      const market = buildMarket({ outcomePrices: [0.50, 0.50], timeLeftMin: 10 });
      const move = makeMove(0.08); // UP → entryPrice = 0.50, above maxEntryPrice 0.30

      const result = evaluateOracleLagEntry(market, move, badConfig);

      expect(result.shouldEnter).toBe(false);
      expect(result.blockReason).toBe('price_above_threshold');
    });
  });

  describe('price gate symmetry', () => {
    it('DOWN entry at 0.45 passes both price gates (within 0.35–0.62 band)', () => {
      // The motivating case for the min-price gate: an entry near the midpoint
      // (0.45) should still clear both the floor (0.35) and the ceiling (0.62).
      const market = buildMarket({ outcomePrices: [0.55, 0.45], timeLeftMin: 10 });
      const move = makeMove(-0.08);

      const result = evaluateOracleLagEntry(market, move, defaultConfig);

      expect(result.shouldEnter).toBe(true);
      expect(result.entryPrice).toBe(0.45);
      expect(result.blockReason).toBeUndefined();
    });

    it('DOWN entry at 0.35 (exactly at floor) passes', () => {
      const market = buildMarket({ outcomePrices: [0.65, 0.35], timeLeftMin: 10 });
      const move = makeMove(-0.08);
      // Note: UP price is 0.65 which exceeds ceiling, but we're going DOWN
      // so entryPrice = outcomePrices[1] = 0.35, which is exactly at floor.
      // The price_above gate checks the DOWN side (0.35), not the UP side (0.65).
      const result = evaluateOracleLagEntry(market, move, defaultConfig);

      expect(result.shouldEnter).toBe(true);
      expect(result.entryPrice).toBe(0.35);
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

  describe('buildOracleLagExecutorShadowRow', () => {
    const baseMove = makeMove(-0.12);
    const baseMarket = { marketId: 'm-btc', slug: 'btc-updown-15m-1776' };

    it('encodes a successful execution as wouldBlock=false with venue + stake', () => {
      const row = buildOracleLagExecutorShadowRow({
        outcome: 'success',
        asset: 'bitcoin',
        venue: 'clob',
        stakeUsd: 5,
        entryPrice: 0.495,
        shadowEntryPrice: 0.495,
        timeLeftMin: 10,
        consensusProbability: 0.4988,
        move: baseMove,
        market: baseMarket,
        side: 'DOWN',
        threshold: 0.12,
      });

      expect(row.kind).toBe('oracle_lag_executor');
      expect(row.source).toBe('arb');
      expect(row.symbol).toBe('BTC');
      expect(row.wouldBlock).toBe(false);
      expect(row.direction).toBe('DOWN');
      expect(row.metricValue).toBe(-0.12);
      expect(row.threshold).toBe(0.12);
      expect(row.payload.outcome).toBe('success');
      expect(row.payload.venue).toBe('clob');
      expect(row.payload.stakeUsd).toBe(5);
      expect(row.payload.skipReason).toBeUndefined();
      expect(row.payload.error).toBeUndefined();
    });

    it('encodes a skip with skipReason and wouldBlock=true', () => {
      const row = buildOracleLagExecutorShadowRow({
        outcome: 'skipped',
        asset: 'bitcoin',
        skipReason: 'global_governor',
        shadowEntryPrice: 0.495,
        timeLeftMin: 10,
        consensusProbability: 0.4988,
        move: baseMove,
        market: baseMarket,
        side: 'DOWN',
        threshold: 0.12,
      });

      expect(row.wouldBlock).toBe(true);
      expect(row.payload.outcome).toBe('skipped');
      expect(row.payload.skipReason).toBe('global_governor');
      expect(row.payload.venue).toBeUndefined();
      expect(row.payload.stakeUsd).toBeUndefined();
    });

    it('encodes a pending maker post with venue + posted price and wouldBlock=true', () => {
      // Empty-book maker submitted a post-only GTC that is live but unfilled.
      // Distinct from 'error' (genuine failure) and 'success' (filled). The
      // row must capture venue + posted price so analytics can separate
      // "posted but never filled" from "never posted".
      const row = buildOracleLagExecutorShadowRow({
        outcome: 'pending',
        asset: 'bitcoin',
        venue: 'clob',
        stakeUsd: 5,
        entryPrice: 0.49,
        shadowEntryPrice: 0.495,
        timeLeftMin: 10,
        consensusProbability: 0.4988,
        move: baseMove,
        market: baseMarket,
        side: 'DOWN',
        threshold: 0.12,
      });

      expect(row.wouldBlock).toBe(true);
      expect(row.payload.outcome).toBe('pending');
      expect(row.payload.venue).toBe('clob');
      expect(row.payload.entryPrice).toBe(0.49);
      expect(row.payload.skipReason).toBeUndefined();
      expect(row.payload.error).toBeUndefined();
    });

    it('encodes an error with error message and wouldBlock=true', () => {
      const row = buildOracleLagExecutorShadowRow({
        outcome: 'error',
        asset: 'bitcoin',
        error: 'CLOB 500 internal server error',
        shadowEntryPrice: 0.495,
        timeLeftMin: 10,
        consensusProbability: 0.4988,
        move: baseMove,
        market: baseMarket,
        side: 'DOWN',
        threshold: 0.12,
      });

      expect(row.wouldBlock).toBe(true);
      expect(row.payload.outcome).toBe('error');
      expect(row.payload.error).toBe('CLOB 500 internal server error');
      expect(row.payload.skipReason).toBeUndefined();
    });

    it('includes slug + movePct in payload so analytics can bucket by market cohort', () => {
      const row = buildOracleLagExecutorShadowRow({
        outcome: 'skipped',
        asset: 'bitcoin',
        skipReason: 'spread_too_wide',
        shadowEntryPrice: 0.495,
        move: baseMove,
        market: baseMarket,
        side: 'DOWN',
        threshold: 0.12,
      });

      expect(row.payload.slug).toBe('btc-updown-15m-1776');
      expect(row.payload.movePct).toBe(-0.12);
    });

    it('uses ETH symbol for ethereum asset', () => {
      const ethMove = makeMove(0.10, { oldPrice: 3200, newPrice: 3203.2 });
      const ethMarket = { marketId: 'm-eth', slug: 'eth-updown-15m-1776' };

      const row = buildOracleLagExecutorShadowRow({
        outcome: 'success',
        asset: 'ethereum',
        venue: 'clob',
        stakeUsd: 5,
        entryPrice: 0.52,
        shadowEntryPrice: 0.52,
        timeLeftMin: 8,
        consensusProbability: 0.501,
        move: ethMove,
        market: ethMarket,
        side: 'UP',
        threshold: 0.07,
      });

      expect(row.symbol).toBe('ETH');
      expect(row.wouldBlock).toBe(false);
      expect(row.direction).toBe('UP');
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

describe('loadConfig cross-validation: oracle-lag time window', () => {
  const REQUIRED_ENV: Record<string, string> = {
    REDIS_URL: 'redis://localhost:6379',
    POLYGON_RPC_URL: 'https://mock.rpc',
    PRIVATE_KEY: '0x' + 'a'.repeat(64),
    POLYMARKET_API_KEY: 'test-key',
    POLYMARKET_API_SECRET: 'test-secret',
    POLYMARKET_API_PASSPHRASE: 'test-pass',
  };

  beforeEach(() => {
    Object.entries(REQUIRED_ENV).forEach(([k, v]) => vi.stubEnv(k, v));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws when MAX_TIME_LEFT_MIN < MIN_TIME_LEFT_MIN', () => {
    vi.stubEnv('ORACLE_LAG_MIN_TIME_LEFT_MIN', '10');
    vi.stubEnv('ORACLE_LAG_MAX_TIME_LEFT_MIN', '5');
    expect(() => loadConfig(true)).toThrow(
      'ORACLE_LAG_MAX_TIME_LEFT_MIN must be >= ORACLE_LAG_MIN_TIME_LEFT_MIN',
    );
  });

  it('accepts MAX_TIME_LEFT_MIN equal to MIN_TIME_LEFT_MIN', () => {
    vi.stubEnv('ORACLE_LAG_MIN_TIME_LEFT_MIN', '10');
    vi.stubEnv('ORACLE_LAG_MAX_TIME_LEFT_MIN', '10');
    expect(() => loadConfig(true)).not.toThrow();
  });

  it('accepts MAX_TIME_LEFT_MIN greater than MIN_TIME_LEFT_MIN', () => {
    vi.stubEnv('ORACLE_LAG_MIN_TIME_LEFT_MIN', '5');
    vi.stubEnv('ORACLE_LAG_MAX_TIME_LEFT_MIN', '15');
    expect(() => loadConfig(true)).not.toThrow();
  });
});
