import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockGetSimmerPositions = jest.fn<(...args: any[]) => Promise<any>>();
const mockSubmitRedeem = jest.fn<(...args: any[]) => Promise<any>>();
const mockClosePosition = jest.fn<(...args: any[]) => Promise<void>>();
const mockGetOpenPositions = jest.fn<(...args: any[]) => Promise<any[]>>();
const mockRedeemClobOutcome = jest.fn<(...args: any[]) => Promise<any>>();
const mockCreditProceeds = jest.fn<(...args: any[]) => Promise<void>>();
const mockNotifyRedemptionExecuted = jest.fn<(...args: any[]) => Promise<void>>();

jest.unstable_mockModule('../../shared/simmer.js', () => ({
  getSimmerPositions: mockGetSimmerPositions,
  submitRedeem: mockSubmitRedeem,
  SimmerError: class extends Error {
    statusCode = 500;
  },
}));

jest.unstable_mockModule('../../execution/positionLedger.js', () => ({
  closePosition: mockClosePosition,
  getOpenPositions: mockGetOpenPositions,
}));

jest.unstable_mockModule('../../shared/clob.js', () => ({
  redeemClobOutcome: mockRedeemClobOutcome,
}));

jest.unstable_mockModule('../../shared/bankroll.js', () => ({
  creditProceeds: mockCreditProceeds,
}));

jest.unstable_mockModule('../../execution/telegram.js', () => ({
  notifyRedemptionExecuted: mockNotifyRedemptionExecuted,
}));

jest.unstable_mockModule('../../shared/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { redeemResolvedPositions } = await import('../resolutionRedeemer.js');

describe('redeemResolvedPositions', () => {
  const mockRedis = {} as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSimmerPositions.mockResolvedValue([]);
    mockGetOpenPositions.mockResolvedValue([]);
    // Mock global fetch for Gamma API check
    global.fetch = jest.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{ resolved: true, outcome: 'YES' }]),
      } as any)
    );
  });

  it('redeems resolved positions from Simmer', async () => {
    mockGetSimmerPositions.mockResolvedValue([
      {
        market_id: 'm1',
        side: 'yes',
        redeemable: true,
        question: 'Q1',
        value_usdc: 10,
      },
    ]);
    mockSubmitRedeem.mockResolvedValue({ success: true, tx_hash: '0xhash1' });

    const results = await redeemResolvedPositions(mockRedis);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(mockSubmitRedeem).toHaveBeenCalledWith({ market_id: 'm1', side: 'yes' });
    expect(mockClosePosition).toHaveBeenCalledWith(mockRedis, 'm1', 'YES');
    expect(mockCreditProceeds).toHaveBeenCalledWith(mockRedis, 10);
    expect(mockNotifyRedemptionExecuted).toHaveBeenCalled();
  });

  it('handles CLOB positions independently', async () => {
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'clob1',
        conditionId: 'cond1',
        direction: 'YES',
        executionVenue: 'clob',
        question: 'QC1',
        sharesHeld: 100,
        entryPrice: 0.5,
      },
    ]);
    mockRedeemClobOutcome.mockResolvedValue({ success: true, tx_hash: '0xclobhash' });

    const results = await redeemResolvedPositions(mockRedis);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(mockRedeemClobOutcome).toHaveBeenCalledWith({
      conditionId: 'cond1',
      direction: 'YES',
    });
    expect(mockClosePosition).toHaveBeenCalledWith(mockRedis, 'clob1', 'YES');
    expect(mockNotifyRedemptionExecuted).toHaveBeenCalled();
  });

  it('handles mixed AMM and CLOB positions', async () => {
    mockGetSimmerPositions.mockResolvedValue([
      { market_id: 'amm1', side: 'no', redeemable: true, value_usdc: 5 },
    ]);
    mockSubmitRedeem.mockResolvedValue({ success: true });
    
    mockGetOpenPositions.mockResolvedValue([
      { marketId: 'clob1', conditionId: 'cond1', direction: 'YES', executionVenue: 'clob' },
    ]);
    mockRedeemClobOutcome.mockResolvedValue({ success: true });

    const results = await redeemResolvedPositions(mockRedis);

    expect(results).toHaveLength(2);
    expect(results.every(r => r.success)).toBe(true);
  });
});
