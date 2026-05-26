import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runReconciliation } from '../reconciliation.js';
import * as positionLedger from '../../execution/positionLedger.js';
import * as simmer from '../../shared/simmer.js';
import * as polymarketData from '../../shared/polymarketData.js';
import * as polymarketGamma from '../../shared/polymarketGamma.js';
import * as pendingMakerOrders from '../../execution/pendingMakerOrders.js';
import * as telegram from '../../execution/telegram.js';
import type { Redis } from 'ioredis';

vi.mock('../../execution/positionLedger.js', () => ({
  getOpenPositions: vi.fn(),
  updatePositionShares: vi.fn(),
  closePosition: vi.fn(),
  recordPosition: vi.fn(),
}));

vi.mock('../../shared/simmer.js', () => ({
  getSimmerPositions: vi.fn(),
}));

vi.mock('../../shared/clob.js', () => ({
  fetchClobTokenBalance: vi.fn(),
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

vi.mock('../../execution/telegram.js', () => ({
  notifyTradeExecuted: vi.fn().mockResolvedValue(undefined),
}));

describe('Position Reconciliation Healer', () => {
  let mockRedis: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis = {
      hset: vi.fn().mockResolvedValue(1),
      incr: vi.fn().mockResolvedValue(1),
      sismember: vi.fn().mockResolvedValue(0),
      exists: vi.fn().mockResolvedValue(0),
    } as unknown as Redis;

    // Default mocks
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(null);
    (polymarketGamma.fetchMarketByQuestion as any).mockResolvedValue(null);
  });

  it('detects and heals a cost-basis/share mismatch for Simmer', async () => {
    const stalePosition = {
      marketId: 'mkt-1',
      direction: 'YES',
      executionVenue: 'simmer',
      stakeUsd: 100,
      entryPrice: 0.40, // Stale price
      sharesHeld: 250,   // Stale shares (100 / 0.40)
    };

    // Actual state on Simmer: 200 shares (true price 100/200 = 0.50)
    const actualSimmerPosition = {
      market_id: 'mkt-1',
      side: 'yes',
      shares: 200,
      average_price: 0.50,
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([stalePosition]);
    (simmer.getSimmerPositions as any).mockResolvedValue([actualSimmerPosition]);

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

  it('detects and closes a ghost position (in ledger but missing from venue)', async () => {
    const ghostPosition = {
      marketId: 'ghost-1',
      direction: 'NO',
      executionVenue: 'simmer',
      sharesHeld: 100,
    };

    // Simmer returns a position for a different market (so the empty-venue guard
    // doesn't abort), but nothing for ghost-1 — making it a true ghost.
    const otherSimmerPosition = {
      market_id: 'other-mkt',
      side: 'yes',
      shares: 50,
      average_price: 0.30,
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([ghostPosition]);
    (simmer.getSimmerPositions as any).mockResolvedValue([otherSimmerPosition]);

    await runReconciliation(mockRedis, { forceFix: true });

    // Expecting Ghost Cleanup
    expect(positionLedger.closePosition).toHaveBeenCalledWith(mockRedis, 'ghost-1', 'NO');
  });

  it('automatically re-imports an orphan position from Simmer with metadata resolution', async () => {
    const orphanSimmerPosition = {
      market_id: 'orphan-uuid-1',
      side: 'yes',
      shares: 500,
      average_price: 0.20,
      question: 'Will it rain?',
    };

    const mockGammaMarket = {
      id: 'numeric-123',
      question: 'Will it rain?',
      conditionId: 'cond-123',
      clobTokenIds: ['tok-yes', 'tok-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([]);
    (simmer.getSimmerPositions as any).mockResolvedValue([orphanSimmerPosition]);
    (polymarketGamma.fetchMarketByQuestion as any).mockResolvedValue(mockGammaMarket);

    await runReconciliation(mockRedis, { forceFix: true });

    // Expecting auto-import with RESOLVED numeric ID, not the UUID
    expect(positionLedger.recordPosition).toHaveBeenCalledWith(mockRedis, expect.objectContaining({
      marketId: 'numeric-123',
      direction: 'YES',
      entryPrice: 0.20,
      sharesHeld: 500,
      executionVenue: 'simmer'
    }));
  });

  it('skips Simmer orphan import if metadata resolution fails (prevents 422 errors)', async () => {
    const orphanSimmerPosition = {
      market_id: 'orphan-uuid-2',
      side: 'no',
      shares: 100,
      question: 'Unknown Question',
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([]);
    (simmer.getSimmerPositions as any).mockResolvedValue([orphanSimmerPosition]);
    (polymarketGamma.fetchMarketByQuestion as any).mockResolvedValue(null); // Resolution fails

    await runReconciliation(mockRedis, { forceFix: true });

    // Should NOT record any position (would cause 422 later)
    expect(positionLedger.recordPosition).not.toHaveBeenCalled();
  });

  it('uses authoritative CLOB price for Simmer orphans when available to avoid 0% PnL bug', async () => {
    const orphanSimmerPosition = {
      market_id: 'orphan-uuid-3',
      side: 'yes',
      shares: 100,
      question: 'Will BTC hit 100k?',
      average_price: 0.50, // This might be current price (0% PnL bug)
    };

    const mockGammaMarket = {
      id: 'numeric-btc',
      question: 'Will BTC hit 100k?',
      conditionId: 'cond-btc',
      clobTokenIds: ['tok-btc-yes', 'tok-btc-no'],
    };

    const clobPositions = [
      {
        conditionId: 'cond-btc',
        asset: 'tok-btc-yes',
        avgPrice: 0.35, // Authoritative entry price from Data API
        size: 100,
      }
    ];

    (positionLedger.getOpenPositions as any).mockResolvedValue([]);
    (simmer.getSimmerPositions as any).mockResolvedValue([orphanSimmerPosition]);
    (polymarketGamma.fetchMarketByQuestion as any).mockResolvedValue(mockGammaMarket);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(clobPositions);

    await runReconciliation(mockRedis, { forceFix: true });

    // Should use 0.35 from clobPositions instead of 0.50 from Simmer
    expect(positionLedger.recordPosition).toHaveBeenCalledWith(mockRedis, expect.objectContaining({
      marketId: 'numeric-btc',
      entryPrice: 0.35,
      stakeUsd: 35, // 100 * 0.35
    }));
  });

  it('imports a sub-$1 Simmer orphan (dust guard was removed — small positions are legitimate)', async () => {
    const subDollarOrphan = {
      market_id: 'orphan-tiny',
      side: 'yes',
      shares: 0.77,
      average_price: 0.45,
      value_usdc: 0.35,
      question: 'Will something small happen?',
    };

    const mockGammaMarket = {
      id: 'numeric-tiny',
      question: 'Will something small happen?',
      conditionId: 'cond-tiny',
      clobTokenIds: ['tok-tiny-yes', 'tok-tiny-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([]);
    (simmer.getSimmerPositions as any).mockResolvedValue([subDollarOrphan]);
    (polymarketGamma.fetchMarketByQuestion as any).mockResolvedValue(mockGammaMarket);

    await runReconciliation(mockRedis, { forceFix: true });

    // Before the dust-guard removal this would have been silently skipped (shares*avgPrice = 0.35 < $1).
    expect(positionLedger.recordPosition).toHaveBeenCalledWith(mockRedis, expect.objectContaining({
      marketId: 'numeric-tiny',
      direction: 'YES',
      entryPrice: 0.45,
      sharesHeld: 0.77,
    }));
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
    (simmer.getSimmerPositions as any).mockResolvedValue([]);
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
      executionVenue: 'clob'
    }));
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
    (simmer.getSimmerPositions as any).mockResolvedValue([]);
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
    expect(pendingMakerOrders.deletePendingOrder).toHaveBeenCalledWith(mockRedis, 'numeric-oracle');
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
    (simmer.getSimmerPositions as any).mockResolvedValue([]);
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
    (simmer.getSimmerPositions as any).mockResolvedValue([]);
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
    (simmer.getSimmerPositions as any).mockResolvedValue([]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(clobPositions);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(mockGammaMarket);

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
      executionVenue: 'clob'
    }));
  });

  it('aborts reconciliation when both venues return empty but ledger has positions (API outage guard)', async () => {
    const ledgerPosition = {
      marketId: 'mkt-1',
      direction: 'YES',
      executionVenue: 'simmer',
      stakeUsd: 100,
      entryPrice: 0.40,
      sharesHeld: 250,
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([ledgerPosition]);
    (simmer.getSimmerPositions as any).mockResolvedValue([]); // Empty!
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([]); // Empty!

    await runReconciliation(mockRedis, { forceFix: true });

    // Should NOT close any positions (no false ghost cleanup)
    expect(positionLedger.closePosition).not.toHaveBeenCalled();
    // Should NOT heal anything
    expect(positionLedger.updatePositionShares).not.toHaveBeenCalled();
  });

  it('upgrades a legacy Simmer UUID marketId back to a numeric Polymarket ID using the Correlation Matrix', async () => {
    const legacyPosition = {
      marketId: 'cb0e1515-16ba-4f74-858b-cfd2d1988ccf', // REAL UUID
      question: 'Will it rain?',
      direction: 'YES',
      sharesHeld: 100,
      stakeUsd: 50,
      entryPrice: 0.50,
      executionVenue: 'simmer',
    };

    // Venue state matches exactly, but marketId is different
    const simmerPositions = [
      {
        market_id: 'cb0e1515-16ba-4f74-858b-cfd2d1988ccf',
        side: 'yes',
        shares: 100,
        average_price: 0.50,
        question: 'Will it rain?',
      },
    ];

    // Data API + Gamma matrix provides the bridge
    const clobPositions = [
      {
        conditionId: 'cond-abc',
        asset: 'tok-yes',
        size: 1000,
        avgPrice: 0.5,
      }
    ];

    const mockGammaMarket = {
      id: 'numeric-777', // The correct numeric ID
      question: 'Will it rain?',
      conditionId: 'cond-abc',
      clobTokenIds: ['tok-yes', 'tok-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([legacyPosition]);
    (simmer.getSimmerPositions as any).mockResolvedValue(simmerPositions);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue(clobPositions);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(mockGammaMarket);

    await runReconciliation(mockRedis, { forceFix: true });

    // Expecting legacy entry to be closed
    expect(positionLedger.closePosition).toHaveBeenCalledWith(mockRedis, 'cb0e1515-16ba-4f74-858b-cfd2d1988ccf', 'YES');

    // Expecting new numeric entry to be recorded
    expect(positionLedger.recordPosition).toHaveBeenCalledWith(mockRedis, expect.objectContaining({
      marketId: 'numeric-777',
      conditionId: 'cond-abc',
      clobTokenIds: ['tok-yes', 'tok-no'],
      reconciliationStatus: expect.stringContaining('upgraded')
    }));
  });

  it('bridges Simmer UUID to numeric ID via condition_id and matches ledger correctly (no ghost, no orphan)', async () => {
    // Ledger has numeric ID; Simmer returns a completely different UUID
    const ledgerPosition = {
      marketId: 'numeric-500',
      conditionId: 'cond-bridge',
      direction: 'YES',
      sharesHeld: 100,
      stakeUsd: 50,
      entryPrice: 0.50,
      executionVenue: 'simmer',
      clobTokenIds: ['tok-bridge-yes', 'tok-bridge-no'],
      question: 'Will the bridge work?',
    };

    // Simmer returns its own UUID, NOT the numeric ID
    const simmerPositions = [
      {
        market_id: 'simmer-uuid-999',
        side: 'yes',
        shares: 120, // Different from ledger (will heal)
        average_price: 0.50,
        condition_id: 'cond-bridge',
        question: 'Will the bridge work?',
      },
    ];

    const mockGammaMarket = {
      id: 'numeric-500',
      question: 'Will the bridge work?',
      conditionId: 'cond-bridge',
      clobTokenIds: ['tok-bridge-yes', 'tok-bridge-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([ledgerPosition]);
    (simmer.getSimmerPositions as any).mockResolvedValue(simmerPositions);
    // Re-indexing resolves via fetchMarketByConditionId API fallback (step 3)
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(mockGammaMarket);

    await runReconciliation(mockRedis, { forceFix: true });

    // Should NOT ghost-delete (position was found on venue after bridging)
    expect(positionLedger.closePosition).not.toHaveBeenCalled();

    // Should heal the share mismatch (100 → 120), stakeUsd = 120 * 0.50 = 60
    expect(positionLedger.updatePositionShares).toHaveBeenCalledWith(
      mockRedis,
      'numeric-500',
      'YES',
      120,
      expect.stringContaining('healed_mismatch'),
      60,
    );

    // Should NOT import as orphan
    expect(positionLedger.recordPosition).not.toHaveBeenCalled();
  });

  it('bridges Simmer UUID to numeric ID via question when condition_id is missing', async () => {
    const ledgerPosition = {
      marketId: 'numeric-600',
      direction: 'NO',
      sharesHeld: 50,
      stakeUsd: 25,
      entryPrice: 0.50,
      executionVenue: 'simmer',
      question: 'Will it snow tomorrow?',
    };

    // Simmer returns UUID, NO condition_id
    const simmerPositions = [
      {
        market_id: 'simmer-uuid-abc',
        side: 'no',
        shares: 50,
        average_price: 0.50,
        question: 'Will it snow tomorrow?',
      },
    ];

    const mockGammaMarket = {
      id: 'numeric-600',
      question: 'Will it snow tomorrow?',
      conditionId: 'cond-snow',
      clobTokenIds: ['tok-snow-yes', 'tok-snow-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([ledgerPosition]);
    (simmer.getSimmerPositions as any).mockResolvedValue(simmerPositions);
    // Re-indexing resolves via fetchMarketByQuestion API fallback (step 5)
    (polymarketGamma.fetchMarketByQuestion as any).mockResolvedValue(mockGammaMarket);

    await runReconciliation(mockRedis, { forceFix: true });

    // Should NOT ghost-delete
    expect(positionLedger.closePosition).not.toHaveBeenCalled();
    // Should NOT import as orphan (shares match exactly)
    expect(positionLedger.recordPosition).not.toHaveBeenCalled();
  });

  it('CLOB reconciliation is unaffected by Simmer re-indexing', async () => {
    // CLOB position in ledger + matching CLOB Data API + unrelated Simmer position
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

    // Unrelated Simmer position that shouldn't interfere
    const simmerPositions = [
      {
        market_id: 'simmer-unrelated',
        side: 'yes',
        shares: 10,
        average_price: 0.30,
      },
    ];

    const mockGammaMarket = {
      id: 'numeric-700',
      question: 'CLOB only question',
      conditionId: 'cond-clob',
      clobTokenIds: ['tok-clob-yes', 'tok-clob-no'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([clobLedgerPosition]);
    (simmer.getSimmerPositions as any).mockResolvedValue(simmerPositions);
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

  it('upgrades a legacy Simmer UUID marketId via fuzzy question match when Data API matrix is empty', async () => {
    const legacyPosition = {
      marketId: 'cb0e1515-16ba-4f74-858b-cfd2d1988ccf',
      question: 'Will it rain?',
      direction: 'YES',
      sharesHeld: 100,
      stakeUsd: 50,
      entryPrice: 0.50,
      executionVenue: 'simmer',
    };

    const simmerPositions = [
      {
        market_id: 'cb0e1515-16ba-4f74-858b-cfd2d1988ccf',
        side: 'yes',
        shares: 100,
        average_price: 0.50,
        question: 'Will it rain?',
      },
    ];

    const mockGammaMarket = {
      id: 'numeric-888',
      question: 'Will it rain?',
      conditionId: 'cond-xyz',
      clobTokenIds: ['tok-y', 'tok-n'],
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([legacyPosition]);
    (simmer.getSimmerPositions as any).mockResolvedValue(simmerPositions);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([]); // Data API is empty!
    (polymarketGamma.fetchMarketByQuestion as any).mockResolvedValue(mockGammaMarket);

    await runReconciliation(mockRedis, { forceFix: true });

    // Expecting fuzzy match to have been called
    expect(polymarketGamma.fetchMarketByQuestion).toHaveBeenCalledWith('Will it rain?');

    // Expecting new numeric entry to be recorded
    expect(positionLedger.recordPosition).toHaveBeenCalledWith(mockRedis, expect.objectContaining({
      marketId: 'numeric-888'
    }));
  });

  it('blocks CLOB import of weather temperature bracket markets when no pending order exists', async () => {
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
    (simmer.getSimmerPositions as any).mockResolvedValue([]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([weatherClobPosition]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(weatherGammaMarket);
    // No pending order — external/unknown weather fill that bypassed the scanner
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue(null);

    await runReconciliation(mockRedis, { forceFix: true });

    // No pending order → block: weather market must not be imported unless placed by our scanner
    expect(positionLedger.recordPosition).not.toHaveBeenCalled();
  });

  it('allows CLOB import of weather markets when a bot-posted pending maker order exists', async () => {
    // Scanner placed a GTC maker order on a weather bracket; it filled on CLOB.
    // The pending order in Redis proves our scanner placed it — allow the import.
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
    (simmer.getSimmerPositions as any).mockResolvedValue([]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([weatherClobPosition]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(weatherGammaMarket);
    // Scanner-placed pending order — this fill came from our own system
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

    // Pending order present → scanner-placed fill → allow import and enrich with metadata
    expect(positionLedger.recordPosition).toHaveBeenCalledWith(mockRedis, expect.objectContaining({
      marketId: 'numeric-weather-2',
      sourcedFrom: 'weather:chicago:2026-05-28:85°F',
    }));
  });

  it('blocks weather CLOB import when pending order exists but token/direction mismatches the fill', async () => {
    // A stale pending YES key exists but the fill landed on the NO token —
    // pendingOrder is null after validation; the guard must still block the import.
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
    (simmer.getSimmerPositions as any).mockResolvedValue([]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([weatherClobPosition]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(weatherGammaMarket);
    // Pending order is for YES token — does not match the NO fill
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue({
      orderId: 'order-weather-mismatch',
      tokenId: 'tok-w-yes',   // wrong token for this fill
      price: 0.62,
      size: 50,
      postedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 60_000,
      direction: 'YES',       // wrong direction
      edgeMagnitude: 0.10,
      bestAskAtPosting: 0.63,
      intendedStakeUsd: 5,
      sourcedFrom: 'weather:london:2026-05-30:34°C',
    });

    await runReconciliation(mockRedis, { forceFix: true });

    // Mismatch → pendingOrder is null → weather guard blocks import
    expect(positionLedger.recordPosition).not.toHaveBeenCalled();
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
    (simmer.getSimmerPositions as any).mockResolvedValue([]);
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([normalClobPosition]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(normalGammaMarket);

    await runReconciliation(mockRedis, { forceFix: true });

    expect(positionLedger.recordPosition).toHaveBeenCalledWith(mockRedis, expect.objectContaining({
      marketId: 'numeric-normal',
    }));
  });
});
