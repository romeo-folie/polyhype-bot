import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runReconciliation } from '../reconciliation.js';
import * as positionLedger from '../../execution/positionLedger.js';
import * as simmer from '../../shared/simmer.js';
import * as clob from '../../shared/clob.js';
import type { Redis } from 'ioredis';

vi.mock('../../execution/positionLedger.js', () => ({
  getOpenPositions: vi.fn(),
  updatePositionShares: vi.fn(),
  closePosition: vi.fn(),
}));

vi.mock('../../shared/simmer.js', () => ({
  getSimmerPositions: vi.fn(),
}));

vi.mock('../../shared/clob.js', () => ({
  fetchClobTokenBalance: vi.fn(),
}));

describe('Position Reconciliation Healer', () => {
  let mockRedis: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis = {
      hset: vi.fn().mockResolvedValue(1),
      incr: vi.fn().mockResolvedValue(1),
    } as unknown as Redis;
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
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([stalePosition]);
    (simmer.getSimmerPositions as any).mockResolvedValue([actualSimmerPosition]);

    await runReconciliation(mockRedis, { forceFix: true });

    // Expecting heal: entryPrice 0.50, shares 200
    expect(mockRedis.hset).toHaveBeenCalledWith(
      'position:mkt-1:YES',
      'sharesHeld', '200',
      'entryPrice', '0.500000',
      expect.stringContaining('reconciliationStatus'),
      expect.stringContaining('healed_mismatch')
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

  it('does nothing when ledger matches venue (within tolerance)', async () => {
    const healthyPosition = {
      marketId: 'mkt-ok',
      direction: 'YES',
      executionVenue: 'simmer',
      stakeUsd: 50,
      entryPrice: 0.50,
      sharesHeld: 100,
    };

    const actualSimmerPosition = {
      market_id: 'mkt-ok',
      side: 'yes',
      shares: 100, // Exact match
    };

    (positionLedger.getOpenPositions as any).mockResolvedValue([healthyPosition]);
    (simmer.getSimmerPositions as any).mockResolvedValue([actualSimmerPosition]);

    await runReconciliation(mockRedis, { forceFix: true });

    expect(mockRedis.hset).not.toHaveBeenCalled();
    expect(positionLedger.closePosition).not.toHaveBeenCalled();
  });

  it('handles CLOB reconciliation correctly', async () => {
    const clobPosition = {
      marketId: 'clob-1',
      direction: 'YES',
      executionVenue: 'clob',
      clobTokenIds: ['tok-yes', 'tok-no'],
      stakeUsd: 100,
      entryPrice: 0.50,
      sharesHeld: 200,
    };

    // Actual state: 180 shares on-chain
    (positionLedger.getOpenPositions as any).mockResolvedValue([clobPosition]);
    (clob.fetchClobTokenBalance as any).mockResolvedValue({ ok: true, balance: 180 });

    await runReconciliation(mockRedis, { forceFix: true });

    expect(mockRedis.hset).toHaveBeenCalledWith(
      'position:clob-1:YES',
      'sharesHeld', '180',
      'entryPrice', expect.stringContaining('0.555556'), // 100 / 180
      expect.stringContaining('reconciliationStatus'),
      expect.stringContaining('healed_mismatch')
    );
  });
});
