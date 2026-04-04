import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runReconciliation } from '../reconciliation.js';
import * as positionLedger from '../../execution/positionLedger.js';
import * as simmer from '../../shared/simmer.js';
import * as polymarketData from '../../shared/polymarketData.js';
import * as polymarketGamma from '../../shared/polymarketGamma.js';
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

describe('Position Reconciliation Healer', () => {
  let mockRedis: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis = {
      hset: vi.fn().mockResolvedValue(1),
      incr: vi.fn().mockResolvedValue(1),
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

    // Expecting heal: shares updated to 200, entryPrice preserved at 0.40
    expect(mockRedis.hset).toHaveBeenCalledWith(
      'position:mkt-1:YES',
      'sharesHeld', '200',
      'reconciliationStatus', expect.stringContaining('healed_mismatch')
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

    // Expecting healing for the YES token (1250 shares, entryPrice preserved at 0.50)
    expect(mockRedis.hset).toHaveBeenCalledWith(
      'position:numeric-99:YES',
      'sharesHeld', '1250',
      'reconciliationStatus', expect.stringContaining('healed_mismatch')
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
    expect(mockRedis.hset).not.toHaveBeenCalled();
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
});
