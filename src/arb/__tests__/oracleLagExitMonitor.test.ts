/**
 * Tests for the oracle-lag gap-compression exit monitor.
 *
 * Scope:
 *   • Pure `evaluateOracleLagExit` trigger priority + math (no Redis, no feed).
 *   • `writeOracleLagExitState` / `readOracleLagExitState` round-trip (mocked Redis).
 *
 * The monitor class itself (tick loop, lock mgmt, SCAN) is NOT unit-tested
 * here — it follows the same lock/heartbeat pattern as `futuresMonitor` and
 * is verified end-to-end in shadow mode after deploy.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  evaluateOracleLagExit,
  writeOracleLagExitState,
  readOracleLagExitState,
  oracleLagExitStateKey,
  type OracleLagExitState,
  type OracleLagExitEvalInput,
} from '../oracleLagExitMonitor.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW_MS = Date.UTC(2026, 3, 14, 12, 0, 0);

function buildState(overrides: Partial<OracleLagExitState> = {}): OracleLagExitState {
  return {
    marketId: 'm-test',
    direction: 'UP',
    chainlinkSymbol: 'btc/usd',
    entryPmYesPrice: 0.52,
    entryPmNoPrice: 0.48,
    entryChainlinkPrice: 65000,
    entryChainlinkMovePct: 0.08, // +8 bps
    entryFairPyes: 0.5 + 0.08 / 100, // 0.5008
    entryTsMs: NOW_MS,
    scannerVersion: 'oracle-lag-v1',
    ...overrides,
  };
}

function buildInput(
  overrides: Partial<OracleLagExitEvalInput> = {},
): OracleLagExitEvalInput {
  return {
    state: buildState(),
    currentYesPrice: 0.52,
    currentNoPrice: 0.48,
    currentChainlinkPrice: 65000,
    chainlinkStale: false,
    nowMs: NOW_MS + 10_000,
    compressionThreshold: 0.7,
    reversalBps: 5,
    maxHoldSec: 180,
    ...overrides,
  };
}

// ── evaluateOracleLagExit ───────────────────────────────────────────────────

describe('evaluateOracleLagExit', () => {
  describe('no trigger', () => {
    it('returns null when entry conditions still hold', () => {
      const res = evaluateOracleLagExit(buildInput());
      expect(res).toBeNull();
    });
  });

  describe('compression trigger', () => {
    // Scenario: UP entry at YES=0.52, fair=0.58 (so entryGap = 0.06).
    // PM YES rises to 0.57 → currentGap = 0.01 → compressionPct ≈ 0.833.
    const stateUp = buildState({
      entryPmYesPrice: 0.52,
      entryChainlinkMovePct: 8, // pctMove in PERCENT; fair = 0.5 + 8/100 = 0.58
      entryFairPyes: 0.58,
      entryChainlinkPrice: 65000,
    });

    it('does NOT fire when compression is below the threshold', () => {
      // PM YES at 0.56 → currentGap = 0.02 → compressionPct ≈ 0.667
      const res = evaluateOracleLagExit(
        buildInput({
          state: stateUp,
          currentYesPrice: 0.56,
          currentNoPrice: 0.44,
          compressionThreshold: 0.7,
        }),
      );
      expect(res).toBeNull();
    });

    it('fires oracle_lag_compressed once threshold is crossed', () => {
      const res = evaluateOracleLagExit(
        buildInput({
          state: stateUp,
          currentYesPrice: 0.57,
          currentNoPrice: 0.43,
          compressionThreshold: 0.7,
        }),
      );
      expect(res).not.toBeNull();
      expect(res?.trigger).toBe('oracle_lag_compressed');
      expect(res?.compressionPct).toBeCloseTo(0.833, 2);
      // returnPct on YES side: (0.57 - 0.52)/0.52 ≈ +9.6%
      expect(res?.returnPct).toBeCloseTo(9.615, 2);
    });

    it('clamps compressionPct to 1.0 when PM overshoots the fair value', () => {
      // PM YES = 0.60 → currentGap = -0.02 → raw compression > 1
      const res = evaluateOracleLagExit(
        buildInput({
          state: stateUp,
          currentYesPrice: 0.6,
          currentNoPrice: 0.4,
          compressionThreshold: 0.7,
        }),
      );
      expect(res?.trigger).toBe('oracle_lag_compressed');
      expect(res?.compressionPct).toBe(1);
    });

    it('handles DOWN side compression symmetrically', () => {
      // DOWN entry: we bet PM YES drops toward fair. Entry YES=0.55, fair=0.45.
      // entryGap = 0.55 - 0.45 = 0.10. Current YES=0.48 → currentGap=0.03
      // → compressionPct = 1 - 0.03/0.10 = 0.70 → fires.
      const stateDown = buildState({
        direction: 'DOWN',
        entryPmYesPrice: 0.55,
        entryPmNoPrice: 0.45,
        entryChainlinkMovePct: -5, // fair = 0.45
        entryFairPyes: 0.45,
      });
      const res = evaluateOracleLagExit(
        buildInput({
          state: stateDown,
          currentYesPrice: 0.48,
          currentNoPrice: 0.52,
          compressionThreshold: 0.7,
        }),
      );
      expect(res?.trigger).toBe('oracle_lag_compressed');
      expect(res?.compressionPct).toBeCloseTo(0.7, 3);
      // returnPct on NO side: (0.52 - 0.45)/0.45 ≈ +15.56%
      expect(res?.returnPct).toBeCloseTo(15.556, 2);
    });

    it('returns null (no compression fire) when entryGap <= 0', () => {
      // Defensive guard — scanner should not allow this, but the evaluator
      // must not divide-by-zero or fire spuriously.
      const degenerate = buildState({
        entryPmYesPrice: 0.58,
        entryFairPyes: 0.58,
      });
      const res = evaluateOracleLagExit(
        buildInput({
          state: degenerate,
          currentYesPrice: 0.58,
          currentNoPrice: 0.42,
        }),
      );
      expect(res).toBeNull();
    });
  });

  describe('reversal trigger', () => {
    const stateUp = buildState({
      entryPmYesPrice: 0.52,
      entryChainlinkMovePct: 8,
      entryFairPyes: 0.58,
      entryChainlinkPrice: 65000,
    });

    it('fires oracle_lag_reversed when Chainlink drops past buffer on UP entry', () => {
      // 6 bps adverse = 65000 * (1 - 0.0006) = 64961
      const res = evaluateOracleLagExit(
        buildInput({
          state: stateUp,
          currentYesPrice: 0.52, // no compression change
          currentNoPrice: 0.48,
          currentChainlinkPrice: 64961,
          reversalBps: 5,
        }),
      );
      expect(res?.trigger).toBe('oracle_lag_reversed');
      expect(res?.reversalBps).toBeCloseTo(6, 0);
    });

    it('does NOT fire reversal when within buffer', () => {
      // 3 bps adverse — below the 5 bps threshold
      const res = evaluateOracleLagExit(
        buildInput({
          state: stateUp,
          currentChainlinkPrice: 64980.5, // -3 bps exactly
          reversalBps: 5,
        }),
      );
      expect(res).toBeNull();
    });

    it('fires reversal on DOWN entry when Chainlink rises past buffer', () => {
      const stateDown = buildState({
        direction: 'DOWN',
        entryPmYesPrice: 0.55,
        entryChainlinkMovePct: -8,
        entryFairPyes: 0.42,
        entryChainlinkPrice: 65000,
      });
      const res = evaluateOracleLagExit(
        buildInput({
          state: stateDown,
          currentYesPrice: 0.55,
          currentNoPrice: 0.45,
          currentChainlinkPrice: 65065, // +10 bps
          reversalBps: 5,
        }),
      );
      expect(res?.trigger).toBe('oracle_lag_reversed');
    });

    it('suppresses reversal when Chainlink is stale (does not exit on missing data)', () => {
      const res = evaluateOracleLagExit(
        buildInput({
          state: stateUp,
          currentChainlinkPrice: 64000, // massive adverse move
          chainlinkStale: true,
          reversalBps: 5,
        }),
      );
      expect(res).toBeNull();
    });

    it('fires reversal ahead of compression when both would trigger', () => {
      // Compression at 1.0 AND Chainlink adverse 10 bps — reversal wins priority.
      const res = evaluateOracleLagExit(
        buildInput({
          state: stateUp,
          currentYesPrice: 0.6, // compression = 1.0
          currentNoPrice: 0.4,
          currentChainlinkPrice: 64935, // -10 bps
          reversalBps: 5,
        }),
      );
      expect(res?.trigger).toBe('oracle_lag_reversed');
    });
  });

  describe('timeout trigger', () => {
    it('fires oracle_lag_timeout when age exceeds maxHoldSec', () => {
      const state = buildState({ entryTsMs: NOW_MS });
      const res = evaluateOracleLagExit(
        buildInput({
          state,
          nowMs: NOW_MS + 200_000, // 200 seconds
          maxHoldSec: 180,
          currentYesPrice: 0.52, // no compression, no reversal
          currentNoPrice: 0.48,
          currentChainlinkPrice: 65000,
        }),
      );
      expect(res?.trigger).toBe('oracle_lag_timeout');
      expect(res?.ageSec).toBeCloseTo(200, 0);
    });

    it('does NOT fire timeout before maxHoldSec is exceeded', () => {
      const state = buildState({ entryTsMs: NOW_MS });
      const res = evaluateOracleLagExit(
        buildInput({
          state,
          nowMs: NOW_MS + 179_000,
          maxHoldSec: 180,
        }),
      );
      expect(res).toBeNull();
    });
  });
});

// ── writeOracleLagExitState / readOracleLagExitState ────────────────────────

describe('writeOracleLagExitState ↔ readOracleLagExitState', () => {
  /** Minimal in-memory hash store that mimics the ioredis surface used. */
  function buildFakeRedis(): {
    redis: Parameters<typeof writeOracleLagExitState>[0];
    store: Map<string, Record<string, string>>;
    ttls: Map<string, number>;
  } {
    const store = new Map<string, Record<string, string>>();
    const ttls = new Map<string, number>();
    const multi = {
      ops: [] as (() => void)[],
      hset(key: string, obj: Record<string, string>) {
        this.ops.push(() => store.set(key, { ...(store.get(key) ?? {}), ...obj }));
        return this;
      },
      expire(key: string, ttl: number) {
        this.ops.push(() => ttls.set(key, ttl));
        return this;
      },
      async exec() {
        for (const op of this.ops) op();
        this.ops = [];
        return [];
      },
    };
    const redis = {
      multi: () => ({
        hset: multi.hset.bind(multi),
        expire: multi.expire.bind(multi),
        exec: multi.exec.bind(multi),
      }),
      hgetall: vi.fn(async (key: string) => store.get(key) ?? {}),
      del: vi.fn(async (key: string) => {
        const existed = store.has(key);
        store.delete(key);
        ttls.delete(key);
        return existed ? 1 : 0;
      }),
    } as unknown as Parameters<typeof writeOracleLagExitState>[0];
    return { redis, store, ttls };
  }

  it('writes fields with clamped entryFairPyes and 30-minute TTL, reads round-trip', async () => {
    const { redis, store, ttls } = buildFakeRedis();
    await writeOracleLagExitState(redis, {
      marketId: 'm-123',
      direction: 'UP',
      chainlinkSymbol: 'btc/usd',
      entryPmYesPrice: 0.52,
      entryPmNoPrice: 0.48,
      entryChainlinkPrice: 65_123.45,
      entryChainlinkMovePct: 0.08,
      entryTsMs: NOW_MS,
    });

    const key = oracleLagExitStateKey('m-123', 'UP');
    expect(store.get(key)).toBeDefined();
    expect(ttls.get(key)).toBe(30 * 60);

    const state = await readOracleLagExitState(redis, 'm-123', 'UP');
    expect(state).not.toBeNull();
    expect(state?.direction).toBe('UP');
    expect(state?.chainlinkSymbol).toBe('btc/usd');
    expect(state?.entryPmYesPrice).toBeCloseTo(0.52, 5);
    expect(state?.entryChainlinkPrice).toBeCloseTo(65_123.45, 1);
    expect(state?.entryChainlinkMovePct).toBeCloseTo(0.08, 5);
    expect(state?.entryFairPyes).toBeCloseTo(0.5008, 4);
    expect(state?.entryTsMs).toBe(NOW_MS);
  });

  it('clamps entryFairPyes to [0.02, 0.98] on extreme move magnitudes', async () => {
    const { redis } = buildFakeRedis();
    await writeOracleLagExitState(redis, {
      marketId: 'm-extreme',
      direction: 'UP',
      chainlinkSymbol: 'btc/usd',
      entryPmYesPrice: 0.9,
      entryPmNoPrice: 0.1,
      entryChainlinkPrice: 65000,
      entryChainlinkMovePct: 60, // fair would be 1.1 without clamp
      entryTsMs: NOW_MS,
    });
    const state = await readOracleLagExitState(redis, 'm-extreme', 'UP');
    expect(state?.entryFairPyes).toBeCloseTo(0.98, 5);
  });

  it('readOracleLagExitState returns null when the key is missing', async () => {
    const { redis } = buildFakeRedis();
    const state = await readOracleLagExitState(redis, 'missing', 'UP');
    expect(state).toBeNull();
  });
});
