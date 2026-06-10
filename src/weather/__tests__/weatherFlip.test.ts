/**
 * Tests for weatherFlip.ts — Phase 6 flip strategy helpers.
 *
 * Covers:
 *  1. classifyFlipCandidate — all four return classes + null
 *  2. tryWeatherFlip — eligibility gates, edge gate, notional caps, exit-then-buy sequencing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../db/writeQueue.js', () => ({ enqueueWrite: vi.fn() }));

const mockGetClobOrderBook = vi.fn().mockResolvedValue(null);
const mockSubmitClobBuy = vi.fn().mockResolvedValue({ success: false, error: 'mock' });
vi.mock('../../shared/clob.js', () => ({
  getClobOrderBook: mockGetClobOrderBook,
  submitClobBuy: mockSubmitClobBuy,
  CLOB_MIN_ORDER_USD: 5,
}));

const mockGetBookTouchLevels = vi.fn().mockReturnValue({ bestBid: null, bestAsk: null });
vi.mock('../../shared/bookTouch.js', () => ({
  getBookTouchLevels: mockGetBookTouchLevels,
}));

const mockTryWeatherExit = vi.fn().mockResolvedValue(false);
vi.mock('../weatherExit.js', () => ({
  tryWeatherExit: mockTryWeatherExit,
}));

const { classifyFlipCandidate, tryWeatherFlip, FLIP_EXECUTED_KEY_PREFIX, FLIP_COOLDOWN_KEY_PREFIX } =
  await import('../weatherFlip.js');

const { enqueueWrite } = await import('../../db/writeQueue.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRedis(store = new Map<string, string>()) {
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
    _store: store,
  };
}

function makePos(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pos-1',
    marketId: 'mkt-1',
    direction: 'NO' as const,
    entryPrice: 0.65,
    sharesHeld: 10,
    consensusProbability: 0.30,
    sourcedFrom: 'weather:chicago:2026-06-01:39°F or below',
    question: null,
    ...overrides,
  };
}

function makeFlipOpts(overrides: Record<string, unknown> = {}) {
  return {
    redis: makeRedis() as any,
    pos: makePos(),
    city: 'chicago',
    targetDate: '2026-06-01',
    bracketLabel: '39°F or below',
    heldTokenId: 'tok-no',
    oppositeTokenId: 'tok-yes',
    oppositeDirection: 'YES' as const,
    currentHeldProb: 0.30,
    oppositeModelFairValue: 0.70,
    flipCandidateClass: 'confirmed_flip' as const,
    isResolutionDay: true,
    confirmedOnly: true,
    minEdgeBps: 500,
    maxOppositePrice: 0.95,
    remainingScanNotional: 50,
    remainingCityNotional: 25,
    exitCooldownKey: 'drift_exit_cooldown:pos-1',
    exitCooldownS: 1800,
    exitedKey: 'forecast_exited:pos-1',
    exitedTtlS: 14 * 24 * 3600,
    flipCooldownS: 1800,
    ...overrides,
  };
}

// ── 1. classifyFlipCandidate ──────────────────────────────────────────────────

describe('classifyFlipCandidate', () => {
  const base = {
    state: 'stable' as const,
    oracleState: null as 'oracle_impossible' | 'oracle_confirmed' | null,
    oracleConfidence: 'none' as const,
    contradictionClass: null as any,
    marketAgainstTier: null as 1 | 2 | null,
    currentHeldBid: 0.60,
    marketDeadBid: 0.05,
    currentHeldProb: 0.65,
    modalStreak: 0,
    modalMinRunsForFlip: 2,
  };

  it('returns null when no signal', () => {
    expect(classifyFlipCandidate(base)).toBeNull();
  });

  it('returns confirmed_flip when oracle is settlement_aligned and oracle_impossible', () => {
    expect(classifyFlipCandidate({
      ...base,
      oracleState: 'oracle_impossible',
      oracleConfidence: 'settlement_aligned',
    })).toBe('confirmed_flip');
  });

  it('returns NULL for oracle_confirmed even when settlement_aligned (held side is the WINNER)', () => {
    // oracle_confirmed = our held side wins; flipping would exit the winning position.
    expect(classifyFlipCandidate({
      ...base,
      oracleState: 'oracle_confirmed',
      oracleConfidence: 'settlement_aligned',
    })).toBeNull();
  });

  it('does NOT return confirmed_flip when oracleConfidence is proxy (not settlement_aligned)', () => {
    expect(classifyFlipCandidate({
      ...base,
      oracleState: 'oracle_impossible',
      oracleConfidence: 'proxy',
    })).toBeNull();
  });

  it('returns audit_only when market is dead and contradiction is market_contradicts_model', () => {
    expect(classifyFlipCandidate({
      ...base,
      currentHeldBid: 0.02,  // <= marketDeadBid=0.05
      contradictionClass: 'market_contradicts_model',
    })).toBe('audit_only');
  });

  it('does NOT return audit_only when market_contradicts_model but bid is above dead threshold', () => {
    expect(classifyFlipCandidate({
      ...base,
      currentHeldBid: 0.10,  // > marketDeadBid=0.05
      contradictionClass: 'market_contradicts_model',
    })).toBeNull();
  });

  it('returns market_oracle_flip when market_confirms_oracle AND Tier 1', () => {
    expect(classifyFlipCandidate({
      ...base,
      contradictionClass: 'market_confirms_oracle',
      marketAgainstTier: 1,
    })).toBe('market_oracle_flip');
  });

  it('does NOT return market_oracle_flip when market_confirms_oracle but Tier 2 only', () => {
    expect(classifyFlipCandidate({
      ...base,
      contradictionClass: 'market_confirms_oracle',
      marketAgainstTier: 2,
    })).toBeNull();
  });

  it('returns forecast_flip when modal_against, streak >= min, and currentHeldProb < 0.5', () => {
    expect(classifyFlipCandidate({
      ...base,
      state: 'modal_against',
      modalStreak: 3,
      currentHeldProb: 0.35,
    })).toBe('forecast_flip');
  });

  it('does NOT return forecast_flip when currentHeldProb >= 0.5', () => {
    // Position is still above 50% likely to win — flip would be premature
    expect(classifyFlipCandidate({
      ...base,
      state: 'modal_against',
      modalStreak: 3,
      currentHeldProb: 0.55,
    })).toBeNull();
  });

  it('does NOT return forecast_flip when streak is below threshold', () => {
    expect(classifyFlipCandidate({
      ...base,
      state: 'modal_against',
      modalStreak: 1,
      modalMinRunsForFlip: 2,
      currentHeldProb: 0.30,
    })).toBeNull();
  });

  it('confirmed_flip takes priority over audit_only when oracle is settlement clear', () => {
    // Both conditions could apply; confirmed_flip should win.
    expect(classifyFlipCandidate({
      ...base,
      oracleState: 'oracle_impossible',
      oracleConfidence: 'settlement_aligned',
      currentHeldBid: 0.02,
      contradictionClass: 'market_contradicts_model',
    })).toBe('confirmed_flip');
  });
});

// ── 2. tryWeatherFlip ─────────────────────────────────────────────────────────

describe('tryWeatherFlip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTryWeatherExit.mockResolvedValue(false);
    mockSubmitClobBuy.mockResolvedValue({ success: false, error: 'mock' });
    mockGetBookTouchLevels.mockReturnValue({ bestBid: null, bestAsk: null });
  });

  it('returns flip_class_not_eligible for forecast_flip', async () => {
    const result = await tryWeatherFlip(makeFlipOpts({ flipCandidateClass: 'forecast_flip' }) as any);
    expect(result.executed).toBe(false);
    expect(result.reason).toBe('flip_class_not_eligible');
  });

  it('returns flip_class_not_eligible for audit_only', async () => {
    const result = await tryWeatherFlip(makeFlipOpts({ flipCandidateClass: 'audit_only' }) as any);
    expect(result.executed).toBe(false);
    expect(result.reason).toBe('flip_class_not_eligible');
  });

  it('returns confirmed_only_gate when confirmedOnly=true and class is market_oracle_flip', async () => {
    const result = await tryWeatherFlip(makeFlipOpts({
      flipCandidateClass: 'market_oracle_flip',
      confirmedOnly: true,
    }) as any);
    expect(result.reason).toBe('confirmed_only_gate');
  });

  it('allows market_oracle_flip when confirmedOnly=false', async () => {
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.30', size: '20' }], bids: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestAsk: { price: 0.30 }, bestBid: null });
    mockTryWeatherExit.mockResolvedValue(true);
    mockSubmitClobBuy.mockResolvedValue({ success: true, shares_bought: 10 });
    const result = await tryWeatherFlip(makeFlipOpts({
      flipCandidateClass: 'market_oracle_flip',
      confirmedOnly: false,
      oppositeModelFairValue: 0.80,
    }) as any);
    // edge = (0.80 - 0.30) * 10000 = 5000 bps ≥ 500 ✓
    expect(result.executed).toBe(true);
  });

  it('returns already_flipped when flip executed key exists in Redis', async () => {
    const store = new Map([[ `${FLIP_EXECUTED_KEY_PREFIX}pos-1`, '1' ]]);
    const redis = makeRedis(store);
    const result = await tryWeatherFlip(makeFlipOpts({ redis }) as any);
    expect(result.reason).toBe('already_flipped');
  });

  it('returns flip_on_cooldown when cooldown key exists', async () => {
    const store = new Map([[ `${FLIP_COOLDOWN_KEY_PREFIX}pos-1`, '1' ]]);
    const redis = makeRedis(store);
    const result = await tryWeatherFlip(makeFlipOpts({ redis }) as any);
    expect(result.reason).toBe('flip_on_cooldown');
  });

  it('returns no_opposite_ask when order book is empty', async () => {
    mockGetClobOrderBook.mockResolvedValue({ asks: [], bids: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestAsk: null, bestBid: null });
    const result = await tryWeatherFlip(makeFlipOpts() as any);
    expect(result.reason).toBe('no_opposite_ask');
  });

  it('returns opposite_ask_too_high when ask exceeds maxOppositePrice', async () => {
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.99', size: '10' }], bids: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestAsk: { price: 0.99 }, bestBid: null });
    const result = await tryWeatherFlip(makeFlipOpts({ maxOppositePrice: 0.95 }) as any);
    expect(result.reason).toBe('opposite_ask_too_high');
  });

  it('returns edge_below_min when edge in bps is below threshold', async () => {
    // oppositeModelFairValue=0.70, ask=0.67 → edge = (0.70 - 0.67) * 10000 = 300 bps < 500
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.67', size: '10' }], bids: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestAsk: { price: 0.67 }, bestBid: null });
    const result = await tryWeatherFlip(makeFlipOpts({
      oppositeModelFairValue: 0.70,
      minEdgeBps: 500,
    }) as any);
    expect(result.reason).toBe('edge_below_min');
  });

  it('returns scan_notional_cap when effective notional exceeds remaining scan cap', async () => {
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.30', size: '50' }], bids: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestAsk: { price: 0.30 }, bestBid: null });
    // sharesHeld=10, ask=0.30 → intendedUsd=3.0; effective=max(3,5)=5. remainingScan=4 < 5.
    const result = await tryWeatherFlip(makeFlipOpts({ remainingScanNotional: 4 }) as any);
    expect(result.reason).toBe('scan_notional_cap');
  });

  it('returns city_notional_cap when effective notional exceeds remaining city cap', async () => {
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.30', size: '50' }], bids: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestAsk: { price: 0.30 }, bestBid: null });
    const result = await tryWeatherFlip(makeFlipOpts({
      remainingScanNotional: 50,
      remainingCityNotional: 4,
    }) as any);
    expect(result.reason).toBe('city_notional_cap');
  });

  it('returns exit_failed and sets cooldown when tryWeatherExit returns false', async () => {
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.30', size: '50' }], bids: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestAsk: { price: 0.30 }, bestBid: null });
    mockTryWeatherExit.mockResolvedValue(false);
    const redis = makeRedis();
    const result = await tryWeatherFlip(makeFlipOpts({ redis }) as any);
    expect(result.reason).toBe('exit_failed');
    // Cooldown key should have been set
    expect(redis._store.has(`${FLIP_COOLDOWN_KEY_PREFIX}pos-1`)).toBe(true);
    // submitClobBuy should NOT have been called
    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
  });

  it('returns buy_failed and sets cooldown when submitClobBuy fails after successful exit', async () => {
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.30', size: '50' }], bids: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestAsk: { price: 0.30 }, bestBid: null });
    mockTryWeatherExit.mockResolvedValue(true);
    mockSubmitClobBuy.mockResolvedValue({ success: false, error: 'order rejected' });
    const redis = makeRedis();
    const result = await tryWeatherFlip(makeFlipOpts({ redis }) as any);
    expect(result.reason).toBe('buy_failed');
    expect(redis._store.has(`${FLIP_COOLDOWN_KEY_PREFIX}pos-1`)).toBe(true);
  });

  it('returns executed=true and writes shadow row on full success', async () => {
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.30', size: '50' }], bids: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestAsk: { price: 0.30 }, bestBid: null });
    mockTryWeatherExit.mockResolvedValue(true);
    mockSubmitClobBuy.mockResolvedValue({ success: true, shares_bought: 10 });
    const redis = makeRedis();
    const result = await tryWeatherFlip(makeFlipOpts({ redis }) as any);

    expect(result.executed).toBe(true);
    expect(result.amountUsd).toBeGreaterThan(0);
    // Idempotency marker should be set
    expect(redis._store.has(`${FLIP_EXECUTED_KEY_PREFIX}pos-1`)).toBe(true);
    // Shadow row written
    const writeCall = vi.mocked(enqueueWrite).mock.calls.find(
      (c) => (c[1] as any).kind === 'weather_drift_flip',
    );
    expect(writeCall).toBeDefined();
    expect((writeCall![1] as any).payload.flipCandidateClass).toBe('confirmed_flip');
    expect((writeCall![1] as any).payload.sharesBought).toBe(10);
  });

  it('skips when intendedUsd is below the CLOB minimum bump floor', async () => {
    // sharesHeld=2, ask=0.50 → intendedUsd=1.0 < CLOB_MIN_ORDER_USD*0.6=3.0 → notional_below_clob_min
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.50', size: '50' }], bids: [] });
    mockGetBookTouchLevels.mockReturnValue({ bestAsk: { price: 0.50 }, bestBid: null });
    const result = await tryWeatherFlip(makeFlipOpts({
      pos: makePos({ sharesHeld: 2 }),
      oppositeModelFairValue: 0.70,
    }) as any);
    expect(result.reason).toBe('notional_below_clob_min');
  });
});
