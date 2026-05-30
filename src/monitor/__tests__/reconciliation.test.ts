import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runReconciliation } from '../reconciliation.js';
import * as positionLedger from '../../execution/positionLedger.js';
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

vi.mock('../../shared/clob.js', () => ({
  fetchClobTokenBalance: vi.fn().mockResolvedValue({ ok: false, error: 'not found' }),
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

  it('detects and closes a ghost position (in ledger but missing from CLOB venue)', async () => {
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

    await runReconciliation(mockRedis, { forceFix: true });

    // Expecting Ghost Cleanup
    expect(positionLedger.closePosition).toHaveBeenCalledWith(mockRedis, 'ghost-1', 'NO');
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
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([weatherClobPosition]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(weatherGammaMarket);
    // No pending order — external/unknown weather fill that bypassed the scanner
    (pendingMakerOrders.getPendingOrder as any).mockResolvedValue(null);

    await runReconciliation(mockRedis, { forceFix: true });

    // No pending order → block: weather market must not be imported unless placed by our scanner
    expect(positionLedger.recordPosition).not.toHaveBeenCalled();
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

  it('blocks weather CLOB import when pending order exists but token/direction mismatches the fill', async () => {
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
    (polymarketData.fetchPolymarketPositions as any).mockResolvedValue([normalClobPosition]);
    (polymarketGamma.fetchMarketByConditionId as any).mockResolvedValue(normalGammaMarket);

    await runReconciliation(mockRedis, { forceFix: true });

    expect(positionLedger.recordPosition).toHaveBeenCalledWith(mockRedis, expect.objectContaining({
      marketId: 'numeric-normal',
    }));
  });
});
