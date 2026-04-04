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

    // Expecting heal: entryPrice 0.50, shares 200
    expect(mockRedis.hset).toHaveBeenCalledWith(
      'position:mkt-1:YES',
      'sharesHeld', '200',
      'entryPrice', '0.500000',
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

    (positionLedger.getOpenPositions as any).mockResolvedValue([ghostPosition]);
    (simmer.getSimmerPositions as any).mockResolvedValue([]); // Venue empty

    await runReconciliation(mockRedis, { forceFix: true });

    // Expecting Ghost Cleanup
    expect(positionLedger.closePosition).toHaveBeenCalledWith(mockRedis, 'ghost-1', 'NO');
  });

  it('automatically re-imports an orphan position from Simmer', async () => {
    const orphanSimmerPosition = {
      market_id: 'orphan-1',
      side: 'yes',
      shares: 500,
      average_price: 0.20,
      question: 'Will it rain?',
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([]); // Ledger empty
    (simmer.getSimmerPositions as any).mockResolvedValue([orphanSimmerPosition]);

    await runReconciliation(mockRedis, { forceFix: true });

    // Expecting auto-import
    expect(positionLedger.recordPosition).toHaveBeenCalledWith(mockRedis, expect.objectContaining({
      marketId: 'orphan-1',
      direction: 'YES',
      entryPrice: 0.20,
      sharesHeld: 500,
      stakeUsd: 100, // 500 * 0.20
      executionVenue: 'simmer'
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
});
