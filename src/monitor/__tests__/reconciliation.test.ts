import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runReconciliation } from '../reconciliation.js';
import * as positionLedger from '../../execution/positionLedger.js';
import * as polymarketData from '../../shared/polymarketData.js';
import * as polymarketGamma from '../../shared/polymarketGamma.js';
import * as gamma from '../../mapping/gamma.js';
import * as config from '../../shared/config.js';
import * as pendingMakerOrders from '../../execution/pendingMakerOrders.js';
import * as telegram from '../../execution/telegram.js';
import * as clob from '../../shared/clob.js';
import * as writeQueue from '../../db/writeQueue.js';
import type { Redis } from 'ioredis';

vi.mock('../../execution/positionLedger.js', () => ({
  getOpenPositions: vi.fn(),
  updatePositionShares: vi.fn(),
  closePosition: vi.fn(),
  recordPosition: vi.fn(),
  sizeUpPosition: vi.fn(),
  hasOpenPosition: vi.fn().mockResolvedValue(false),
  clearPositionPendingSettlement: vi.fn(),
  // Real-ish implementation so the reconciler's weather discriminator works.
  isWeatherSourced: (s?: string | null) =>
    (s?.startsWith('weather:') || s?.startsWith('weather-oracle:') || s?.startsWith('reconciled:weather')) ?? false,
}));

vi.mock('../../mapping/gamma.js', () => ({
  getMarket: vi.fn(),
  // Real-ish parse so heldPrice extraction matches production.
  parseOutcomePrices: (op: string | string[]) => (Array.isArray(op) ? op : JSON.parse(op)),
}));

vi.mock('../../shared/clob.js', () => ({
  fetchClobTokenBalance: vi.fn().mockResolvedValue({ ok: false, error: 'not found' }),
  cancelClobOrder: vi.fn().mockResolvedValue(true),
  // Default passthrough: resolves to the posted-price arg — the resolver's
  // fallback contract when fills can't be attributed (it never throws).
  resolveOrderFillPrice: vi.fn(
    async (_orderId: string, _cond: string | undefined, _asset: string, _shares: number, posted: number) => posted,
  ),
}));

vi.mock('../../shared/polymarketData.js', () => ({
  fetchPolymarketPositions: vi.fn(),
}));

vi.mock('../../shared/polymarketGamma.js', () => ({
  fetchMarketByConditionId: vi.fn(),
  fetchMarketByQuestion: vi.fn(),
}));

vi.mock('../../execution/pendingMakerOrders.js', () => ({
  getPendingOrder: vi.fn().mockResolvedValue(null),
  deletePendingOrder: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    SIZE_UP_ENABLED: true,
    SIZE_UP_ELIGIBLE_SOURCES: 'weather',
    RECONCILE_GHOST_ALERT_THRESHOLD: 5,
    RECONCILE_MIN_HEAL_SHARES: 1,
    RECONCILE_WIPE_SUPPRESS_ALERT_RUNS: 3,
    RECONCILE_WIPE_SUPPRESS_TTL_S: 21_600,
    WEATHER_EXIT_BLOCKED_ENABLED: true,
    MONITOR_NEAR_RES_PRICE_THRESHOLD: 0.95,
    WEATHER_MAKER_LIFECYCLE_LOG_ENABLED: false,
  })),
}));

vi.mock('../../db/writeQueue.js', () => ({ enqueueWrite: vi.fn() }));

vi.mock('../../execution/telegram.js', () => ({
  notifyTradeExecuted: vi.fn().mockResolvedValue(undefined),
  notify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../shared/hyperliquid.js', () => ({
  getHyperliquid: vi.fn().mockReturnValue({
    closePosition: vi.fn().mockResolvedValue({ success: true }),
  }),
}));

vi.mock('../../shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Position Reconciliation Healer', () => {
  let mockRedis: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      hset: vi.fn().mockResolvedValue(1),
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      sismember: vi.fn().mockResolvedValue(0),
      exists: vi.fn().mockResolvedValue(0),
    } as unknown as Redis;

    // Default mocks
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(null);
    (polymarketGamma.fetchMarketByQuestion as any).mockResolvedValue(null);
    // clearAllMocks() does not reset implementations set via .mockResolvedValue
    // in a prior test — restore the inconclusive default so each test's explicit
    // override is isolated.
    (clob.fetchClobTokenBalance as any).mockResolvedValue({ ok: false, error: 'not found' });
    // Default: no existing ledger row → orphan imports proceed. The double-import
    // guard test overrides this to true; reset here so it doesn't leak (see above).
    (positionLedger.hasOpenPosition as any).mockResolvedValue(false);
  });

  it('detects and heals a share mismatch for CLOB position', async () => {
    const stalePosition = {
      marketId: 'mkt-1',
      conditionId: 'cond-1',
      direction: 'YES',
      executionVenue: 'clob',
      stakeUsd: 100,
      entryPrice: 0.40,
      sharesHeld: 250,
      clobTokenIds: ['tok-yes', 'tok-no'],
    };

    const clobPositions = [
      {
        conditionId: 'cond-1',
        asset: 'tok-yes',
        size: 200,
        avgPrice: 0.50,
      },
    ];

    (positionLedger.getOpenPositions as any).mockResolvedValue([stalePosition]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(clobPositions);

    await runReconciliation(mockRedis, { forceFix: true });

    // Expecting heal: shares updated to 200, stakeUsd = 200 * 0.40 = 80
    expect(positionLedger.updatePositionShares).toHaveBeenCalledWith(
      mockRedis,
      'mkt-1',
      'YES',
      200,
      expect.stringContaining('healed_mismatch'),
      80,
    );
  });

  it('does NOT heal a live position down to dust on a suspected false-zero venue read', async () => {
    // Regression for 2026-06-13: a 9.08-share weather winner had its on-venue
    // balance momentarily read as 0.0089 sh; the reconciler healed the ledger
    // down to dust, so when it resolved a winner the +$4 was booked as +$0.00.
    // A wipe-to-dust heal of a still-meaningful position must be suppressed.
    const livePosition = {
      marketId: 'mkt-dust',
      conditionId: 'cond-dust',
      direction: 'NO',
      executionVenue: 'clob',
      stakeUsd: 4.99,
      entryPrice: 0.55,
      sharesHeld: 9.08,
      clobTokenIds: ['tok-dust-yes', 'tok-dust-no'],
    };

    // Venue snapshot reports dust for the NO token (index 1) — a transient read.
    const clobPositions = [
      { conditionId: 'cond-dust', asset: 'tok-dust-no', size: 0.0089, avgPrice: 0.55 },
    ];

    (positionLedger.getOpenPositions as any).mockResolvedValue([livePosition]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(clobPositions);

    await runReconciliation(mockRedis, { forceFix: true });

    // Ledger preserved: NOT healed down, and NOT ghost-closed.
    expect(positionLedger.updatePositionShares).not.toHaveBeenCalled();
    expect(positionLedger.closePosition).not.toHaveBeenCalled();
    // A SINGLE suppression (incr→1, below the alert threshold) stays quiet — no
    // page — because a one-off is almost always a transient venue read.
    expect(telegram.notify).not.toHaveBeenCalledWith(
      expect.stringContaining('wipe-to-dust'),
    );
  });

  it('escalates (pages once) when a wipe-to-dust suppression PERSISTS past the alert threshold', async () => {
    // Same suppression, but the streak counter has reached the alert threshold
    // (3) — a genuinely stale ledger row vs a real on-chain ~0 balance — so the
    // operator is paged exactly once on the crossing.
    const livePosition = {
      marketId: 'mkt-dust',
      conditionId: 'cond-dust',
      direction: 'NO',
      executionVenue: 'clob',
      stakeUsd: 4.99,
      entryPrice: 0.55,
      sharesHeld: 9.08,
      clobTokenIds: ['tok-dust-yes', 'tok-dust-no'],
    };
    const clobPositions = [
      { conditionId: 'cond-dust', asset: 'tok-dust-no', size: 0.0089, avgPrice: 0.55 },
    ];
    (positionLedger.getOpenPositions as any).mockResolvedValue([livePosition]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(clobPositions);
    (mockRedis.incr).mockResolvedValue(3); // streak hit the threshold

    await runReconciliation(mockRedis, { forceFix: true });

    // Still preserved, but now paged for manual review.
    expect(positionLedger.updatePositionShares).not.toHaveBeenCalled();
    expect(positionLedger.closePosition).not.toHaveBeenCalled();
    expect(telegram.notify).toHaveBeenCalledWith(
      expect.stringContaining('wipe-to-dust'),
    );
  });

  it('does NOT re-page after the escalation threshold has already been crossed', async () => {
    // Past the threshold (incr→4): the operator was already paged at the
    // crossing, so further cycles stay quiet (debug-only) to avoid per-cycle spam.
    const livePosition = {
      marketId: 'mkt-dust',
      conditionId: 'cond-dust',
      direction: 'NO',
      executionVenue: 'clob',
      stakeUsd: 4.99,
      entryPrice: 0.55,
      sharesHeld: 9.08,
      clobTokenIds: ['tok-dust-yes', 'tok-dust-no'],
    };
    const clobPositions = [
      { conditionId: 'cond-dust', asset: 'tok-dust-no', size: 0.0089, avgPrice: 0.55 },
    ];
    (positionLedger.getOpenPositions as any).mockResolvedValue([livePosition]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(clobPositions);
    (mockRedis.incr).mockResolvedValue(4); // already past the threshold

    await runReconciliation(mockRedis, { forceFix: true });

    // Still preserved, but NO page (already alerted once on the crossing).
    expect(positionLedger.updatePositionShares).not.toHaveBeenCalled();
    expect(positionLedger.closePosition).not.toHaveBeenCalled();
    expect(telegram.notify).not.toHaveBeenCalledWith(
      expect.stringContaining('wipe-to-dust'),
    );
  });

  it('still heals a downward mismatch when the venue read stays above the dust floor', async () => {
    // Guard must not block legitimate partial-exit reconciliation: 9.08 → 4.5 is
    // a real (still-meaningful) size, so the heal proceeds with recomputed stake.
    const partialPosition = {
      marketId: 'mkt-partial',
      conditionId: 'cond-partial',
      direction: 'NO',
      executionVenue: 'clob',
      stakeUsd: 4.99,
      entryPrice: 0.50,
      sharesHeld: 9.08,
      clobTokenIds: ['tok-partial-yes', 'tok-partial-no'],
    };
    const clobPositions = [
      { conditionId: 'cond-partial', asset: 'tok-partial-no', size: 4.5, avgPrice: 0.50 },
    ];

    (positionLedger.getOpenPositions as any).mockResolvedValue([partialPosition]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(clobPositions);

    await runReconciliation(mockRedis, { forceFix: true });

    // Heals to 4.5 shares, stake = 4.5 * 0.50 = 2.25.
    expect(positionLedger.updatePositionShares).toHaveBeenCalledWith(
      mockRedis,
      'mkt-partial',
      'NO',
      4.5,
      expect.stringContaining('healed_mismatch'),
      2.25,
    );
  });

  it('closes a ghost position only when the on-chain balance read CONFIRMS zero', async () => {
    const ghostPosition = {
      marketId: 'ghost-1',
      conditionId: 'cond-ghost',
      direction: 'NO',
      executionVenue: 'clob',
      sharesHeld: 100,
      clobTokenIds: ['tok-ghost-yes', 'tok-ghost-no'],
    };

    // CLOB returns a position for a different market — non-zero total prevents the abort guard.
    const clobPositions = [
      {
        conditionId: 'cond-other',
        asset: 'tok-other',
        size: 50,
        avgPrice: 0.30,
      },
    ];

    (positionLedger.getOpenPositions as any).mockResolvedValue([ghostPosition]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(clobPositions);
    // Token absent from the snapshot → on-chain confirms a genuine zero balance.
    (clob.fetchClobTokenBalance as any).mockResolvedValue({ ok: true, balance: 0 });

    await runReconciliation(mockRedis, { forceFix: true });

    // Expecting Ghost Cleanup
    expect(positionLedger.closePosition).toHaveBeenCalledWith(mockRedis, 'ghost-1', 'NO');
  });

  it('does NOT ghost-close when the on-chain balance read FAILS (inconclusive)', async () => {
    // Regression for the 2026-06 false-ghost: a position we still hold was
    // deleted from the ledger because its token fell off the (unpaginated) Data
    // API page AND every RPC failed for that token on one pass. An RPC failure
    // must read as "unknown", never as "zero balance".
    const heldButOffPage = {
      marketId: 'spurs-finals',
      conditionId: 'cond-spurs',
      direction: 'YES',
      executionVenue: 'clob',
      sharesHeld: 5.02,
      clobTokenIds: ['tok-spurs-yes', 'tok-spurs-no'],
    };

    // Snapshot lists only unrelated junk — non-zero total clears the abort guard.
    const clobPositions = [
      { conditionId: 'cond-junk', asset: 'tok-junk', size: 1, avgPrice: 0.5 },
    ];

    (positionLedger.getOpenPositions as any).mockResolvedValue([heldButOffPage]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(clobPositions);
    // All RPCs failed for this token on this pass.
    (clob.fetchClobTokenBalance as any).mockResolvedValue({ ok: false, error: 'all RPCs failed' });

    await runReconciliation(mockRedis, { forceFix: true });

    // The row must survive — no ghost close on an inconclusive check.
    expect(positionLedger.closePosition).not.toHaveBeenCalled();
  });

  it('alerts (does not block) when a cycle ghost-closes at or above the threshold', async () => {
    // Five genuinely-gone positions (confirmed zero balance) → all closed AND a
    // human-facing alert fires. The alert is observability only; closes proceed.
    const ghosts = Array.from({ length: 5 }, (_, i) => ({
      marketId: `gone-${i}`,
      conditionId: `cond-gone-${i}`,
      direction: 'YES',
      executionVenue: 'clob',
      sharesHeld: 10,
      clobTokenIds: [`tok-gone-${i}-yes`, `tok-gone-${i}-no`],
    }));

    (positionLedger.getOpenPositions as any).mockResolvedValue(ghosts);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([
      { conditionId: 'cond-real', asset: 'tok-real', size: 1, avgPrice: 0.5 },
    ]);
    (clob.fetchClobTokenBalance as any).mockResolvedValue({ ok: true, balance: 0 });

    await runReconciliation(mockRedis, { forceFix: true });

    expect(positionLedger.closePosition).toHaveBeenCalledTimes(5);
    expect(telegram.notify as any).toHaveBeenCalledWith(expect.stringContaining('ghost-closed 5'));
  });

  it('automatically re-imports an orphan position from CLOB using Data & Gamma APIs', async () => {
    const orphanClobPosition = {
      conditionId: 'cond-1',
      asset: 'tok-yes',
      avgPrice: 0.60,
      size: 1000,
    };

    const mockGammaMarket = {
      id: 'numeric-99',
      question: 'Are we there yet?',
      conditionId: 'cond-1',
      clobTokenIds: ['tok-yes', 'tok-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([]); // Ledger empty
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([orphanClobPosition]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(mockGammaMarket);

    await runReconciliation(mockRedis, { forceFix: true });

    // Expecting auto-import
    expect(positionLedger.recordPosition).toHaveBeenCalledWith(mockRedis, expect.objectContaining({
      marketId: 'numeric-99',
      direction: 'YES',
      entryPrice: 0.60,
      sharesHeld: 1000,
      stakeUsd: 600,
      executionVenue: 'clob',
    }));
  });

  it('does NOT import a CLOB orphan whose market is RESOLVED (closed=true)', async () => {
    // Pagination (PR #473) surfaces old settled-but-unredeemed positions to this
    // path; importing them as "open" is churn (imported → redeemer closes them
    // every time the recently-closed guard lapses). Resolved markets must be
    // skipped outright, independent of the time-window guards.
    const resolvedOrphan = {
      conditionId: 'cond-resolved',
      asset: 'tok-yes',
      avgPrice: 0.60,
      size: 1000,
    };

    const resolvedGammaMarket = {
      id: 'numeric-resolved',
      question: 'Did it already happen?',
      conditionId: 'cond-resolved',
      clobTokenIds: ['tok-yes', 'tok-no'],
      closed: true,
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([resolvedOrphan]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(resolvedGammaMarket);

    await runReconciliation(mockRedis, { forceFix: true });

    expect(positionLedger.recordPosition).not.toHaveBeenCalled();
  });

  it('does NOT re-import a CLOB orphan already tracked under (market, direction) — double-import guard', async () => {
    // The orphan scan matches CLOB↔ledger by tokenId, so a position already tracked
    // (e.g. a rebate-farming leg whose token/asset didn't line up) is flagged as an
    // orphan. Re-importing it would create a phantom duplicate `reconciled:clob` row
    // that double-counts the position (wipe-to-dust incident). hasOpenPosition guards it.
    const trackedOrphan = {
      conditionId: 'cond-dup',
      asset: 'tok-yes',
      avgPrice: 0.40,
      size: 500,
    };
    const dupGammaMarket = {
      id: 'numeric-dup',
      question: 'Will the underdog win?',
      conditionId: 'cond-dup',
      clobTokenIds: ['tok-yes', 'tok-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([]); // tokenId scan finds no match → flagged orphan
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([trackedOrphan]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(dupGammaMarket);
    // …but a ledger row already exists for this market+direction.
    (positionLedger.hasOpenPosition as any).mockResolvedValue(true);

    await runReconciliation(mockRedis, { forceFix: true });

    expect(positionLedger.hasOpenPosition).toHaveBeenCalledWith(mockRedis, 'numeric-dup', 'YES');
    expect(positionLedger.recordPosition).not.toHaveBeenCalled();
  });

  it('links oracle-lag UP pending order to YES reconciled fill (UP↔YES normalization)', async () => {
    const orphanClobPosition = {
      conditionId: 'cond-oracle',
      asset: 'tok-yes',
      avgPrice: 0.49,
      size: 10,
    };

    const mockGammaMarket = {
      id: 'numeric-oracle',
      question: 'Bitcoin Up or Down — 15m',
      conditionId: 'cond-oracle',
      clobTokenIds: ['tok-yes', 'tok-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([orphanClobPosition]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(mockGammaMarket);
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue({
      orderId: 'order-oracle-1',
      tokenId: 'tok-yes',
      price: 0.49,
      size: 10,
      postedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 60_000,
      consensusP: 0.55,
      direction: 'UP', // Oracle-lag stores signal direction — must normalize to YES for match
      edgeMagnitude: 0.015,
      bestAskAtPosting: 0.50,
      intendedStakeUsd: 5,
      sourcedFrom: 'oracle-lag:btc-15m',
    });

    await runReconciliation(mockRedis, { forceFix: true });

    // Enrichment proves the link succeeded — without UP↔YES normalization the
    // pendingOrder would be discarded and these fields would fall back to defaults.
    expect(positionLedger.recordPosition).toHaveBeenCalledWith(mockRedis, expect.objectContaining({
      marketId: 'numeric-oracle',
      direction: 'YES',
      sourcedFrom: 'oracle-lag:btc-15m',
      edgeMagnitude: 0.015,
      consensusProbability: 0.55,
      entryExecutionPath: 'maker_fill',
      entryOrderType: 'maker',
      counterfactualImmediateTakerPrice: 0.50,
    }));
    expect(pendingMakerOrders.deletePendingOrder).toHaveBeenCalledWith(mockRedis, 'numeric-oracle', 'YES');
    // Async maker fill confirmation → user is notified once here (not at posting time).
    expect(telegram.notifyTradeExecuted).toHaveBeenCalledWith(
      expect.objectContaining({
        marketId: 'numeric-oracle',
        direction: 'YES',
        sourcedFrom: 'oracle-lag:btc-15m',
      }),
      undefined,
      expect.objectContaining({ venue: 'clob' }),
    );
  });

  it('logs a maker-lifecycle FILLED row (reconciler path) for a weather orphan with a linked pending order when the flag is on', async () => {
    (config.loadConfig as any).mockReturnValue({
      SIZE_UP_ENABLED: true, SIZE_UP_ELIGIBLE_SOURCES: 'weather', RECONCILE_GHOST_ALERT_THRESHOLD: 5,
      RECONCILE_MIN_HEAL_SHARES: 1, RECONCILE_WIPE_SUPPRESS_ALERT_RUNS: 3, RECONCILE_WIPE_SUPPRESS_TTL_S: 21_600,
      WEATHER_EXIT_BLOCKED_ENABLED: true, MONITOR_NEAR_RES_PRICE_THRESHOLD: 0.95,
      WEATHER_MAKER_LIFECYCLE_LOG_ENABLED: true,
    });
    (positionLedger.getOpenPositions as any).mockResolvedValue([]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([
      { conditionId: 'cond-wx', asset: 'tok-no', avgPrice: 0.62, size: 12 },
    ]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue({
      id: 'wx-mkt', question: 'Will the highest temperature in Seoul be 30°C on June 30?',
      conditionId: 'cond-wx', clobTokenIds: ['tok-yes', 'tok-no'],
    });
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue({
      orderId: 'order-wx-1', tokenId: 'tok-no', price: 0.60, size: 12,
      postedAt: Date.now() - 60_000, expiresAt: Date.now() + 60_000,
      consensusP: 0.55, direction: 'NO', edgeMagnitude: 0.10, bestAskAtPosting: 0.65,
      intendedStakeUsd: 7, sourcedFrom: 'weather:seoul:2026-06-30:30°C', source: 'weather',
    });

    await runReconciliation(mockRedis, { forceFix: true });

    const lifecycle = (writeQueue.enqueueWrite as any).mock.calls.find(
      (c: any[]) => c[0] === 'shadow_observations' && c[1]?.kind === 'weather_maker_lifecycle',
    );
    expect(lifecycle).toBeDefined();
    expect(lifecycle[1].payload.eventType).toBe('filled');
    expect(lifecycle[1].payload.fillDetectionPath).toBe('reconciler');
    expect(lifecycle[1].payload.fillPrice).toBe(0.62); // basisPrice = orphan avgPrice
    expect(lifecycle[1].payload.postedPrice).toBe(0.60);
    expect(lifecycle[1].payload.clobMid).toBeNull(); // unrecoverable in the async path
  });

  it('does NOT log a maker-lifecycle row for a weather orphan fill when the flag is off', async () => {
    // Set the config explicitly (flag off) — a prior test may have left loadConfig
    // returning a flag-on override (mockReturnValue survives clearAllMocks).
    (config.loadConfig as any).mockReturnValue({
      SIZE_UP_ENABLED: true, SIZE_UP_ELIGIBLE_SOURCES: 'weather', RECONCILE_GHOST_ALERT_THRESHOLD: 5,
      RECONCILE_MIN_HEAL_SHARES: 1, RECONCILE_WIPE_SUPPRESS_ALERT_RUNS: 3, RECONCILE_WIPE_SUPPRESS_TTL_S: 21_600,
      WEATHER_EXIT_BLOCKED_ENABLED: true, MONITOR_NEAR_RES_PRICE_THRESHOLD: 0.95,
      WEATHER_MAKER_LIFECYCLE_LOG_ENABLED: false,
    });
    (positionLedger.getOpenPositions as any).mockResolvedValue([]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([
      { conditionId: 'cond-wx', asset: 'tok-no', avgPrice: 0.62, size: 12 },
    ]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue({
      id: 'wx-mkt', question: 'Will the highest temperature in Seoul be 30°C on June 30?',
      conditionId: 'cond-wx', clobTokenIds: ['tok-yes', 'tok-no'],
    });
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue({
      orderId: 'order-wx-1', tokenId: 'tok-no', price: 0.60, size: 12,
      postedAt: Date.now() - 60_000, expiresAt: Date.now() + 60_000,
      direction: 'NO', source: 'weather', sourcedFrom: 'weather:seoul:2026-06-30:30°C',
    });

    await runReconciliation(mockRedis, { forceFix: true });

    const lifecycle = (writeQueue.enqueueWrite as any).mock.calls.find(
      (c: any[]) => c[0] === 'shadow_observations' && c[1]?.kind === 'weather_maker_lifecycle',
    );
    expect(lifecycle).toBeUndefined();
  });

  it('forwards pendingOrder.reasoning to the async maker-fill Telegram notification', async () => {
    const orphanClobPosition = {
      conditionId: 'cond-reason',
      asset: 'tok-yes',
      avgPrice: 0.49,
      size: 10,
    };
    const mockGammaMarket = {
      id: 'numeric-reason',
      question: 'Will Shenzhen hit 29°C?',
      conditionId: 'cond-reason',
      clobTokenIds: ['tok-yes', 'tok-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([orphanClobPosition]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(mockGammaMarket);
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue({
      orderId: 'order-reason-1',
      tokenId: 'tok-yes',
      price: 0.49,
      size: 10,
      postedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 60_000,
      consensusP: 0.6,
      direction: 'YES',
      sourcedFrom: 'weather:shenzhen:2026-04-22:29°C',
      reasoning: 'Forecast high 29.0°, model P=0.123 vs market 0.710; NO bracket.',
    });

    await runReconciliation(mockRedis, { forceFix: true });

    expect(telegram.notifyTradeExecuted).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoning: 'Forecast high 29.0°, model P=0.123 vs market 0.710; NO bracket.',
      }),
      undefined,
      expect.anything(),
    );
  });

  it('falls back to generic reasoning string when pendingOrder has no reasoning field', async () => {
    const orphanClobPosition = {
      conditionId: 'cond-legacy',
      asset: 'tok-yes',
      avgPrice: 0.49,
      size: 10,
    };
    const mockGammaMarket = {
      id: 'numeric-legacy',
      question: 'Legacy order question?',
      conditionId: 'cond-legacy',
      clobTokenIds: ['tok-yes', 'tok-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([orphanClobPosition]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(mockGammaMarket);
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue({
      orderId: 'order-legacy-1',
      tokenId: 'tok-yes',
      price: 0.49,
      size: 10,
      postedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 60_000,
      consensusP: 0.55,
      direction: 'YES',
      sourcedFrom: 'oracle-lag:btc-15m',
      // reasoning intentionally absent — simulates an order posted before this fix
    });

    await runReconciliation(mockRedis, { forceFix: true });

    expect(telegram.notifyTradeExecuted).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoning: 'Async maker fill reconciled from CLOB position snapshot.',
      }),
      undefined,
      expect.anything(),
    );
  });

  it('reconciles a CLOB ledger position against the matching outcome token when Data API returns multiple rows for the same conditionId', async () => {
    const ledgerPosition = {
      marketId: 'numeric-99',
      conditionId: 'cond-1',
      direction: 'YES',
      sharesHeld: 1000,
      stakeUsd: 500,
      entryPrice: 0.50,
      executionVenue: 'clob',
      clobTokenIds: ['tok-yes', 'tok-no'],
    };

    const clobPositions = [
      {
        conditionId: 'cond-1',
        asset: 'tok-no',
        avgPrice: 0.41,
        size: 250,
      },
      {
        conditionId: 'cond-1',
        asset: 'tok-yes',
        avgPrice: 0.61, // Correct outcome token for YES
        size: 1250,
      },
    ];

    const mockGammaMarket = {
      id: 'numeric-99',
      question: 'Are we there yet?',
      conditionId: 'cond-1',
      clobTokenIds: ['tok-yes', 'tok-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([ledgerPosition]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(clobPositions);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(mockGammaMarket);
    // No linked maker order → a generic share-mismatch heal, not an async size-up.
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue(null);

    await runReconciliation(mockRedis, { forceFix: true });

    // Expecting healing for the YES token (1250 shares, stakeUsd = 1250 * 0.50 = 625)
    expect(positionLedger.updatePositionShares).toHaveBeenCalledWith(
      mockRedis,
      'numeric-99',
      'YES',
      1250,
      expect.stringContaining('healed_mismatch'),
      625,
    );

    // The 'NO' token (which was also on venue but not in ledger) should be imported as an orphan
    expect(positionLedger.recordPosition).toHaveBeenCalledWith(mockRedis, expect.objectContaining({
      marketId: 'numeric-99',
      direction: 'NO',
      sharesHeld: 250,
      executionVenue: 'clob',
    }));
  });

  it('reconciles an async size-up maker fill as a top-up (not a generic heal) and notifies', async () => {
    // Ledger holds 100 shares; on-chain shows 160 (a +60 share top-up) and a
    // bot-posted maker order is linked for the YES token. This must route through
    // sizeUpPosition (weighted-avg + topUpCount), delete the pending order, and
    // emit a size-up notification — NOT the silent generic share heal.
    const ledgerPosition = {
      marketId: 'numeric-su',
      conditionId: 'cond-su',
      direction: 'YES',
      sharesHeld: 100,
      stakeUsd: 50, // entryPrice 0.50
      entryPrice: 0.50,
      executionVenue: 'clob',
      clobTokenIds: ['tok-yes', 'tok-no'],
      topUpCount: 0,
    };
    const clobPositions = [
      { conditionId: 'cond-su', asset: 'tok-yes', avgPrice: 0.55, size: 160 },
    ];
    const mockGammaMarket = {
      id: 'numeric-su',
      question: 'Highest temperature in Chicago today?',
      conditionId: 'cond-su',
      clobTokenIds: ['tok-yes', 'tok-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([ledgerPosition]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(clobPositions);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(mockGammaMarket);
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue({
      orderId: 'order-su-1',
      tokenId: 'tok-yes',
      price: 0.62,
      size: 60,
      postedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 60_000,
      consensusP: 0.7,
      direction: 'YES',
      edgeMagnitude: 0.12,
      sourcedFrom: 'weather:chicago',
      reasoning: 'Resolution-day top-up.',
    });

    await runReconciliation(mockRedis, { forceFix: true });

    // Routed through size-up accounting at the maker order's posted price (0.62):
    // +60 shares, additional stake = 60 * 0.62 = 37.2.
    expect(positionLedger.sizeUpPosition).toHaveBeenCalledWith(
      mockRedis,
      'numeric-su',
      'YES',
      expect.closeTo(60, 5),
      expect.closeTo(37.2, 5),
      expect.closeTo(0.62, 5),
    );
    // The generic heal must NOT run for a recognised size-up.
    expect(positionLedger.updatePositionShares).not.toHaveBeenCalled();
    // Pending order cleared and a size-up notification emitted.
    expect(pendingMakerOrders.deletePendingOrder).toHaveBeenCalledWith(mockRedis, 'numeric-su', 'YES');
    expect(telegram.notifyTradeExecuted).toHaveBeenCalledWith(
      expect.objectContaining({ _isSizeUp: true, _sizeUpTopUpNumber: 1 }),
      undefined,
      expect.anything(),
    );
  });

  it('prices an async size-up heal at the actual fill VWAP when attributable', async () => {
    // The GTC top-up posted at 0.62 but crossed the book and actually filled at
    // 0.55 — the heal must record the ACTUAL cost (60 × 0.55 = 33), not the
    // posted-limit cost (60 × 0.62 = 37.2) that inflates the position's basis.
    const ledgerPosition = {
      marketId: 'numeric-su-vwap',
      conditionId: 'cond-su-vwap',
      direction: 'YES',
      sharesHeld: 100,
      stakeUsd: 50,
      entryPrice: 0.50,
      executionVenue: 'clob',
      clobTokenIds: ['tok-yes', 'tok-no'],
      topUpCount: 0,
    };
    (positionLedger.getOpenPositions as any).mockResolvedValue([ledgerPosition]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([
      { conditionId: 'cond-su-vwap', asset: 'tok-yes', avgPrice: 0.52, size: 160 },
    ]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue({
      id: 'numeric-su-vwap', question: 'Highest temperature in Chicago today?',
      conditionId: 'cond-su-vwap', clobTokenIds: ['tok-yes', 'tok-no'],
    });
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue({
      orderId: 'order-su-vwap', tokenId: 'tok-yes', price: 0.62, size: 60,
      postedAt: Date.now() - 60_000, expiresAt: Date.now() + 60_000,
      consensusP: 0.7, direction: 'YES', sourcedFrom: 'weather:chicago',
    });
    (clob.resolveOrderFillPrice as any).mockResolvedValueOnce(0.55);

    await runReconciliation(mockRedis, { forceFix: true });

    // Resolution scoped by the ledger position's conditionId + the order's
    // token, with the posted price as the fallback arg.
    expect(clob.resolveOrderFillPrice).toHaveBeenCalledWith(
      'order-su-vwap', 'cond-su-vwap', 'tok-yes', expect.closeTo(60, 5), 0.62,
    );
    // Top-up recorded at the ACTUAL fill price, not the posted 0.62.
    expect(positionLedger.sizeUpPosition).toHaveBeenCalledWith(
      mockRedis, 'numeric-su-vwap', 'YES',
      expect.closeTo(60, 5), expect.closeTo(33, 5), expect.closeTo(0.55, 5),
    );
    expect(positionLedger.updatePositionShares).not.toHaveBeenCalled();
  });

  it('records the posted-price basis when the fill-price resolver falls back', async () => {
    const ledgerPosition = {
      marketId: 'numeric-su-fb',
      conditionId: 'cond-su-fb',
      direction: 'YES',
      sharesHeld: 100,
      stakeUsd: 50,
      entryPrice: 0.50,
      executionVenue: 'clob',
      clobTokenIds: ['tok-yes', 'tok-no'],
      topUpCount: 0,
    };
    (positionLedger.getOpenPositions as any).mockResolvedValue([ledgerPosition]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([
      { conditionId: 'cond-su-fb', asset: 'tok-yes', avgPrice: 0.55, size: 160 },
    ]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue({
      id: 'numeric-su-fb', question: 'Highest temperature in Chicago today?',
      conditionId: 'cond-su-fb', clobTokenIds: ['tok-yes', 'tok-no'],
    });
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue({
      orderId: 'order-su-fb', tokenId: 'tok-yes', price: 0.62, size: 60,
      postedAt: Date.now() - 60_000, expiresAt: Date.now() + 60_000,
      consensusP: 0.7, direction: 'YES', sourcedFrom: 'weather:chicago',
    });
    // Default passthrough mock returns the posted price (resolver fallback
    // contract — VWAP unattributable or trades fetch failed; never throws).

    await runReconciliation(mockRedis, { forceFix: true });

    // Posted price basis (60 × 0.62 = 37.2), still a size-up heal rather than
    // a generic share heal.
    expect(positionLedger.sizeUpPosition).toHaveBeenCalledWith(
      mockRedis, 'numeric-su-fb', 'YES',
      expect.closeTo(60, 5), expect.closeTo(37.2, 5), expect.closeTo(0.62, 5),
    );
    expect(positionLedger.updatePositionShares).not.toHaveBeenCalled();
  });

  it('cancels the residual resting order when an async size-up fills only partially', async () => {
    // Posted 100-share top-up order; only 60 filled (venueShares 160 vs ledger 100).
    // The residual 40 shares are still resting → must be cancelled so they don't
    // keep filling untracked.
    const ledgerPosition = {
      marketId: 'numeric-su2',
      conditionId: 'cond-su2',
      direction: 'YES',
      sharesHeld: 100,
      stakeUsd: 50,
      entryPrice: 0.50,
      executionVenue: 'clob',
      clobTokenIds: ['tok-yes', 'tok-no'],
      topUpCount: 1,
    };
    const clobPositions = [
      { conditionId: 'cond-su2', asset: 'tok-yes', avgPrice: 0.55, size: 160 },
    ];

    (positionLedger.getOpenPositions as any).mockResolvedValue([ledgerPosition]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(clobPositions);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue({
      id: 'numeric-su2', question: 'Highest temperature in Chicago today?',
      conditionId: 'cond-su2', clobTokenIds: ['tok-yes', 'tok-no'],
    });
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue({
      orderId: 'order-su2-1',
      tokenId: 'tok-yes',
      price: 0.62,
      size: 100, // posted 100, only 60 filled
      postedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 60_000,
      consensusP: 0.7,
      direction: 'YES',
      sourcedFrom: 'weather:chicago',
    });

    await runReconciliation(mockRedis, { forceFix: true });

    expect(clob.cancelClobOrder).toHaveBeenCalledWith('order-su2-1');
    expect(positionLedger.sizeUpPosition).toHaveBeenCalledWith(
      mockRedis, 'numeric-su2', 'YES',
      expect.closeTo(60, 5), expect.closeTo(37.2, 5), expect.closeTo(0.62, 5),
    );
    // Residual cancel confirmed (mock returns true) → pending key cleared.
    expect(pendingMakerOrders.deletePendingOrder).toHaveBeenCalledWith(mockRedis, 'numeric-su2', 'YES');
    expect(telegram.notifyTradeExecuted).toHaveBeenCalledWith(
      expect.objectContaining({ _isSizeUp: true, _sizeUpTopUpNumber: 2 }),
      undefined,
      expect.anything(),
    );
  });

  it('keeps the pending order key when a partial size-up residual cancel is unconfirmed', async () => {
    // Same partial-fill setup, but cancelClobOrder fails (returns false). The
    // matched portion must still be recorded, but the pending key must be RETAINED
    // so a later fill of the still-resting residual is re-attributed as a size-up
    // rather than clobbered by the generic heal.
    const ledgerPosition = {
      marketId: 'numeric-su3',
      conditionId: 'cond-su3',
      direction: 'YES',
      sharesHeld: 100,
      stakeUsd: 50,
      entryPrice: 0.50,
      executionVenue: 'clob',
      clobTokenIds: ['tok-yes', 'tok-no'],
      topUpCount: 0,
    };
    (positionLedger.getOpenPositions as any).mockResolvedValue([ledgerPosition]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([
      { conditionId: 'cond-su3', asset: 'tok-yes', avgPrice: 0.55, size: 160 },
    ]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue({
      id: 'numeric-su3', question: 'Highest temperature in Chicago today?',
      conditionId: 'cond-su3', clobTokenIds: ['tok-yes', 'tok-no'],
    });
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue({
      orderId: 'order-su3-1', tokenId: 'tok-yes', price: 0.62, size: 100,
      postedAt: Date.now() - 60_000, expiresAt: Date.now() + 60_000,
      consensusP: 0.7, direction: 'YES', sourcedFrom: 'weather:chicago',
    });
    (clob.cancelClobOrder as any).mockResolvedValueOnce(false); // cancel unconfirmed

    await runReconciliation(mockRedis, { forceFix: true });

    // Matched portion still recorded as a top-up...
    expect(positionLedger.sizeUpPosition).toHaveBeenCalledWith(
      mockRedis, 'numeric-su3', 'YES',
      expect.closeTo(60, 5), expect.closeTo(37.2, 5), expect.closeTo(0.62, 5),
    );
    // ...but the pending key is NOT deleted, and the generic heal does not run.
    expect(pendingMakerOrders.deletePendingOrder).not.toHaveBeenCalled();
    expect(positionLedger.updatePositionShares).not.toHaveBeenCalled();
  });

  it('aborts reconciliation when CLOB returns empty but ledger has positions (API outage guard)', async () => {
    const ledgerPosition = {
      marketId: 'mkt-1',
      conditionId: 'cond-1',
      direction: 'YES',
      executionVenue: 'clob',
      stakeUsd: 100,
      entryPrice: 0.40,
      sharesHeld: 250,
      clobTokenIds: ['tok-yes', 'tok-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([ledgerPosition]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([]); // Empty!

    await runReconciliation(mockRedis, { forceFix: true });

    // Should NOT close any positions (no false ghost cleanup)
    expect(positionLedger.closePosition).not.toHaveBeenCalled();
    // Should NOT heal anything
    expect(positionLedger.updatePositionShares).not.toHaveBeenCalled();
  });

  it('heals a CLOB share mismatch correctly', async () => {
    const clobLedgerPosition = {
      marketId: 'numeric-700',
      conditionId: 'cond-clob',
      direction: 'YES',
      sharesHeld: 200,
      stakeUsd: 100,
      entryPrice: 0.50,
      executionVenue: 'clob',
      clobTokenIds: ['tok-clob-yes', 'tok-clob-no'],
    };

    const clobPositions = [
      {
        conditionId: 'cond-clob',
        asset: 'tok-clob-yes',
        size: 250, // Mismatch — will heal
        avgPrice: 0.50,
      },
    ];

    const mockGammaMarket = {
      id: 'numeric-700',
      question: 'CLOB only question',
      conditionId: 'cond-clob',
      clobTokenIds: ['tok-clob-yes', 'tok-clob-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([clobLedgerPosition]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(clobPositions);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(mockGammaMarket);

    await runReconciliation(mockRedis, { forceFix: true });

    // CLOB position should heal shares (200 → 250), stakeUsd = 250 * 0.50 = 125
    expect(positionLedger.updatePositionShares).toHaveBeenCalledWith(
      mockRedis,
      'numeric-700',
      'YES',
      250,
      expect.stringContaining('healed_mismatch'),
      125,
    );

    // Should NOT ghost-delete the CLOB position
    expect(positionLedger.closePosition).not.toHaveBeenCalled();
  });

  it('imports weather CLOB orphan without pending order as reconciled:weather and seeds market state', async () => {
    const weatherClobPosition = {
      conditionId: 'cond-weather-1',
      asset: 'tok-yes',
      avgPrice: 0.55,
      size: 100,
    };

    const weatherGammaMarket = {
      id: 'numeric-weather',
      question: 'Will the highest temperature in London be 34°C or above on May 27?',
      conditionId: 'cond-weather-1',
      clobTokenIds: ['tok-yes', 'tok-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([weatherClobPosition]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(weatherGammaMarket);
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue(null);

    await runReconciliation(mockRedis, { forceFix: true });

    // No pending order → import as reconciled:weather so monitor + size-up can track it
    expect(positionLedger.recordPosition).toHaveBeenCalledWith(mockRedis, expect.objectContaining({
      marketId: 'numeric-weather',
      direction: 'YES',
      sourcedFrom: 'reconciled:weather',
      entryPrice: 0.55,
    }));
    // Market state key must be seeded for the weather scanner's adverseMove gate
    expect(mockRedis.set).toHaveBeenCalledWith(
      'weather:market_state:numeric-weather:YES',
      expect.stringContaining('"outcomePrice":0.55'),
      'EX',
      48 * 60 * 60,
    );
  });

  it('substitutes the pending order price when an orphan import has no usable avgPrice', async () => {
    // Data API returned avgPrice=0 — writing it through would create a
    // zero-basis row (entryPrice=0, stakeUsd=0) that corrupts P&L and disables
    // the size-up drift gate (observed: Ankara 2416074). With a linked maker
    // order, its posted price is the best available basis.
    const clobPosition = {
      conditionId: 'cond-zero-basis',
      asset: 'tok-zb-yes',
      avgPrice: 0,
      size: 50,
      currentValue: 20, // current price 0.40
    };
    (positionLedger.getOpenPositions as any).mockResolvedValue([]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([clobPosition]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue({
      id: 'numeric-zb',
      question: 'Will the highest temperature in Ankara be 26°C on June 4?',
      conditionId: 'cond-zero-basis',
      clobTokenIds: ['tok-zb-yes', 'tok-zb-no'],
    });
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue({
      orderId: 'order-zb-1',
      tokenId: 'tok-zb-yes',
      price: 0.62,
      size: 50,
      postedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 60_000,
      direction: 'YES',
      sourcedFrom: 'weather:ankara:2026-06-04:26°C',
    });

    await runReconciliation(mockRedis, { forceFix: true });

    expect(positionLedger.recordPosition).toHaveBeenCalledWith(mockRedis, expect.objectContaining({
      marketId: 'numeric-zb',
      direction: 'YES',
      entryPrice: 0.62,
      stakeUsd: expect.closeTo(50 * 0.62, 5),
    }));
  });

  it('substitutes the current market price for a zero-avgPrice orphan with no linked order', async () => {
    const clobPosition = {
      conditionId: 'cond-zero-basis-2',
      asset: 'tok-zb2-yes',
      avgPrice: 0,
      size: 50,
      currentValue: 20, // current price 0.40 — last-resort basis proxy
    };
    (positionLedger.getOpenPositions as any).mockResolvedValue([]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([clobPosition]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue({
      id: 'numeric-zb2',
      question: 'Will the highest temperature in Ankara be 27°C on June 4?',
      conditionId: 'cond-zero-basis-2',
      clobTokenIds: ['tok-zb2-yes', 'tok-zb2-no'],
    });
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue(null);

    await runReconciliation(mockRedis, { forceFix: true });

    expect(positionLedger.recordPosition).toHaveBeenCalledWith(mockRedis, expect.objectContaining({
      marketId: 'numeric-zb2',
      direction: 'YES',
      entryPrice: expect.closeTo(0.40, 6),
      stakeUsd: expect.closeTo(20, 5),
    }));
  });

  it('allows CLOB import of weather markets when a bot-posted pending maker order exists', async () => {
    const weatherClobPosition = {
      conditionId: 'cond-weather-2',
      asset: 'tok-w-yes',
      avgPrice: 0.62,
      size: 50,
    };

    const weatherGammaMarket = {
      id: 'numeric-weather-2',
      question: 'Will the highest temperature in Chicago exceed 85°F on May 28?',
      conditionId: 'cond-weather-2',
      clobTokenIds: ['tok-w-yes', 'tok-w-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([weatherClobPosition]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(weatherGammaMarket);
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue({
      orderId: 'order-weather-1',
      tokenId: 'tok-w-yes',
      price: 0.62,
      size: 50,
      postedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 60_000,
      direction: 'YES',
      edgeMagnitude: 0.10,
      bestAskAtPosting: 0.63,
      intendedStakeUsd: 5,
      sourcedFrom: 'weather:chicago:2026-05-28:85°F',
    });

    await runReconciliation(mockRedis, { forceFix: true });

    expect(positionLedger.recordPosition).toHaveBeenCalledWith(mockRedis, expect.objectContaining({
      marketId: 'numeric-weather-2',
      sourcedFrom: 'weather:chicago:2026-05-28:85°F',
    }));
  });

  it('imports weather CLOB fill as reconciled:weather when pending order token/direction mismatches', async () => {
    const weatherClobPosition = {
      conditionId: 'cond-weather-mismatch',
      asset: 'tok-w-no',   // NO fill
      avgPrice: 0.38,
      size: 50,
    };

    const weatherGammaMarket = {
      id: 'numeric-weather-mismatch',
      question: 'Will the highest temperature in London be 34°C or above on May 30?',
      conditionId: 'cond-weather-mismatch',
      clobTokenIds: ['tok-w-yes', 'tok-w-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([weatherClobPosition]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(weatherGammaMarket);
    // Pending order is for YES token — does not match the NO fill → pendingOrder = null
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue({
      orderId: 'order-weather-mismatch',
      tokenId: 'tok-w-yes',
      price: 0.62,
      size: 50,
      postedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 60_000,
      direction: 'YES',
      edgeMagnitude: 0.10,
      bestAskAtPosting: 0.63,
      intendedStakeUsd: 5,
      sourcedFrom: 'weather:london:2026-05-30:34°C',
    });

    await runReconciliation(mockRedis, { forceFix: true });

    // Mismatch → pendingOrder is null → still imported as reconciled:weather for monitor/size-up tracking
    expect(positionLedger.recordPosition).toHaveBeenCalledWith(mockRedis, expect.objectContaining({
      marketId: 'numeric-weather-mismatch',
      direction: 'NO',
      sourcedFrom: 'reconciled:weather',
      entryPrice: 0.38,
    }));
    expect(mockRedis.set).toHaveBeenCalledWith(
      'weather:market_state:numeric-weather-mismatch:NO',
      expect.stringContaining('"outcomePrice":0.38'),
      'EX',
      48 * 60 * 60,
    );
  });

  it('still imports non-weather CLOB orphans normally', async () => {
    const normalClobPosition = {
      conditionId: 'cond-normal',
      asset: 'tok-yes',
      avgPrice: 0.45,
      size: 50,
    };

    const normalGammaMarket = {
      id: 'numeric-normal',
      question: 'Will Bitcoin exceed $100k by end of 2026?',
      conditionId: 'cond-normal',
      clobTokenIds: ['tok-yes', 'tok-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([normalClobPosition]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(normalGammaMarket);

    await runReconciliation(mockRedis, { forceFix: true });

    expect(positionLedger.recordPosition).toHaveBeenCalledWith(mockRedis, expect.objectContaining({
      marketId: 'numeric-normal',
    }));
  });

  // ── Change 6: heal stuck pendingSettlement on live weather positions ─────────

  function stuckWeatherPending(overrides: Record<string, unknown> = {}) {
    return {
      marketId: 'mkt-1',
      conditionId: 'cond-1',
      direction: 'NO',
      executionVenue: 'clob',
      stakeUsd: 3,
      entryPrice: 0.62,
      sharesHeld: 4.8387,
      pendingSettlement: true,
      sourcedFrom: 'weather:paris:2026-06-27:31C',
      clobTokenIds: ['tok-yes', 'tok-no'],
      ...overrides,
    };
  }

  // The on-venue snapshot for the held NO token (tok-no). A non-empty snapshot is
  // also required to pass the reconciler's "CLOB empty → abort" outage guard.
  const venueSnapshot = (size: number) => [
    { conditionId: 'cond-1', asset: 'tok-no', size, avgPrice: 0.62 },
  ];

  it('clears stuck pendingSettlement on a live, unresolved weather position (collapsed bid)', async () => {
    (positionLedger.getOpenPositions as any).mockResolvedValue([stuckWeatherPending()]);
    // Venue still holds the full balance (Paris pattern: healed back to full shares).
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(venueSnapshot(4.8387));
    // Unresolved market; held side (NO = index 1) is cheap (collapsed), not a winner.
    (gamma.getMarket as any).mockResolvedValue({ closed: false, outcomePrices: '["0.79","0.21"]' });

    await runReconciliation(mockRedis, { forceFix: true });

    expect(positionLedger.clearPositionPendingSettlement).toHaveBeenCalledWith(
      mockRedis, 'mkt-1', 'NO', 'min_notional',
    );
  });

  it('does NOT clear pending for a near-resolution winner (held side ≥ threshold)', async () => {
    (positionLedger.getOpenPositions as any).mockResolvedValue([stuckWeatherPending()]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(venueSnapshot(4.8387));
    // Held side (NO) is winning at 0.98 ≥ near-res threshold → leave it for the redeemer.
    (gamma.getMarket as any).mockResolvedValue({ closed: false, outcomePrices: '["0.02","0.98"]' });

    await runReconciliation(mockRedis, { forceFix: true });

    expect(positionLedger.clearPositionPendingSettlement).not.toHaveBeenCalled();
  });

  it('does NOT clear pending on a resolved (closed) market', async () => {
    (positionLedger.getOpenPositions as any).mockResolvedValue([stuckWeatherPending()]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(venueSnapshot(4.8387));
    (gamma.getMarket as any).mockResolvedValue({ closed: true, outcomePrices: '["0.79","0.21"]' });

    await runReconciliation(mockRedis, { forceFix: true });

    expect(positionLedger.clearPositionPendingSettlement).not.toHaveBeenCalled();
  });

  it('does NOT clear pending for a genuine dust residual (venue balance < min heal shares)', async () => {
    (positionLedger.getOpenPositions as any).mockResolvedValue([
      stuckWeatherPending({ sharesHeld: 0.0089 }),
    ]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(venueSnapshot(0.0089));
    (gamma.getMarket as any).mockResolvedValue({ closed: false, outcomePrices: '["0.79","0.21"]' });

    await runReconciliation(mockRedis, { forceFix: true });

    expect(positionLedger.clearPositionPendingSettlement).not.toHaveBeenCalled();
    expect(gamma.getMarket).not.toHaveBeenCalled(); // short-circuits before the market fetch
  });

  it('does NOT clear pending for a NON-weather pending position', async () => {
    (positionLedger.getOpenPositions as any).mockResolvedValue([
      stuckWeatherPending({ sourcedFrom: 'headline' }),
    ]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(venueSnapshot(4.8387));
    (gamma.getMarket as any).mockResolvedValue({ closed: false, outcomePrices: '["0.79","0.21"]' });

    await runReconciliation(mockRedis, { forceFix: true });

    expect(positionLedger.clearPositionPendingSettlement).not.toHaveBeenCalled();
  });

  it('does NOT clear pending when WEATHER_EXIT_BLOCKED_ENABLED is off', async () => {
    (config.loadConfig as any).mockReturnValueOnce({
      SIZE_UP_ENABLED: true,
      SIZE_UP_ELIGIBLE_SOURCES: 'weather',
      RECONCILE_GHOST_ALERT_THRESHOLD: 5,
      RECONCILE_MIN_HEAL_SHARES: 1,
      RECONCILE_WIPE_SUPPRESS_ALERT_RUNS: 3,
      RECONCILE_WIPE_SUPPRESS_TTL_S: 21_600,
      WEATHER_EXIT_BLOCKED_ENABLED: false,
      MONITOR_NEAR_RES_PRICE_THRESHOLD: 0.95,
    });
    (positionLedger.getOpenPositions as any).mockResolvedValue([stuckWeatherPending()]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(venueSnapshot(4.8387));
    (gamma.getMarket as any).mockResolvedValue({ closed: false, outcomePrices: '["0.79","0.21"]' });

    await runReconciliation(mockRedis, { forceFix: true });

    expect(positionLedger.clearPositionPendingSettlement).not.toHaveBeenCalled();
  });
});
