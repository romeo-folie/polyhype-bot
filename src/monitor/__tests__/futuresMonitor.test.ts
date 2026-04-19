import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock Config
const baseCfg = {
  FUTURES_ENABLED: true,
  FUTURES_STOP_LOSS_PCT: -1.5,
  FUTURES_TAKE_PROFIT_PCT: 3.0,
  FUTURES_MAX_HOLD_HOURS: 24,
  FUTURES_MAX_HOLD_BYPASS_ON_WINNER: false,
  FUTURES_TRAILING_STOP_ENABLED: false,
  FUTURES_TRAILING_STOP_PCT: 1.5,
  FUTURES_EXIT_ON_SIGNAL_FADE: false,
  FUTURES_REEVAL_INTERVAL_S: 60,
  FUTURES_REEVAL_MIN_AGE_S: 600,
  FUTURES_EXIT_CONFLUENCE_SCORE: 5,
  FUTURES_ATR_SLTP_ENABLED: false,
};
const loadConfigMock = vi.fn().mockReturnValue(baseCfg);
vi.mock('../../shared/config.js', () => ({
  loadConfig: loadConfigMock,
}));

// Mock confluence scorer (used by max-hold bypass TA check)
const mockScoreConfluence = vi.fn();
vi.mock('../../arb/confluenceScorer.js', () => ({
  scoreConfluence: mockScoreConfluence,
}));

// Mock Logger
vi.mock('../../shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock Redis
const mockRedis = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  eval: vi.fn().mockResolvedValue(1),
};

vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn().mockReturnValue(mockRedis),
  closeRedis: vi.fn(),
  refreshLock: vi.fn().mockResolvedValue('refreshed'),
  reacquireLockAfterExpiry: vi.fn().mockResolvedValue(true),
}));

// Mock Hyperliquid Client
const mockGetOpenPositions = vi.fn();
const mockClosePosition = vi.fn();
vi.mock('../../shared/hyperliquid.js', () => ({
  getHyperliquid: vi.fn().mockReturnValue({
    getOpenPositions: mockGetOpenPositions,
    closePosition: mockClosePosition,
  }),
}));

// Mock Position Ledger
const mockGetLedgerPositions = vi.fn();
const mockCloseLedgerPosition = vi.fn();
const mockHasOpenPosition = vi.fn().mockResolvedValue(true); // default: ledger row exists → no backfill
const mockRecordPosition = vi.fn().mockResolvedValue(undefined);
const mockUpdateHighWaterMark = vi.fn().mockResolvedValue(undefined);
vi.mock('../../execution/positionLedger.js', () => ({
  getOpenPositions: mockGetLedgerPositions,
  closePosition: mockCloseLedgerPosition,
  hasOpenPosition: mockHasOpenPosition,
  recordPosition: mockRecordPosition,
  updateHighWaterMark: mockUpdateHighWaterMark,
}));

// Mock Telegram
vi.mock('../../execution/telegram.js', () => ({
  notifyTradeError: vi.fn(),
  notifyTakeProfitExecuted: vi.fn(),
}));

const { runFuturesMonitorWorker } = await import('../futuresMonitor.js');

describe('futuresMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue(baseCfg);
    mockScoreConfluence.mockResolvedValue({ direction: 'NEUTRAL', score: 0, signals: {} });
    // Break the while(true) loop after one tick.
    // We throw WITHOUT calling fn() so the Promise constructor rejects (uncaught resolve
    // would swallow the throw). The rejection propagates past the inner try/catch
    // (which only wraps the work, not the bottom sleep) and bubbles up to runTick.
    vi.spyOn(global, 'setTimeout').mockImplementation((_fn: any) => {
      throw new Error('TEST_COMPLETE');
    });

    // Default mock behavior
    mockGetOpenPositions.mockResolvedValue([]);
    mockGetLedgerPositions.mockResolvedValue([]);
    mockClosePosition.mockResolvedValue({ success: true });
    mockCloseLedgerPosition.mockResolvedValue(undefined);
  });

  async function runTick() {
    try {
      await runFuturesMonitorWorker();
    } catch (e: any) {
      if (e.message !== 'TEST_COMPLETE') throw e;
    }
  }

  it('triggers SL when price falls below -1.5%', async () => {
    mockGetOpenPositions.mockResolvedValue([
      {
        symbol: 'BTC',
        position: {
          szi: '0.1',
          entryPx: '50000',
          unrealizedPnl: '-100', // -2.0% (100 / 5000)
          marginUsed: '1000',
        },
      },
    ]);

    await runTick();

    expect(mockClosePosition).toHaveBeenCalledWith('BTC');
  });

  it('triggers TP when price rises above +3.0%', async () => {
    mockGetOpenPositions.mockResolvedValue([
      {
        symbol: 'ETH',
        position: {
          szi: '1.0',
          entryPx: '3000',
          unrealizedPnl: '100', // +3.33%
          marginUsed: '600',
        },
      },
    ]);

    await runTick();

    expect(mockClosePosition).toHaveBeenCalledWith('ETH');
  });

  it('does NOT trigger exit when price move is within neutral bounds', async () => {
    mockGetOpenPositions.mockResolvedValue([
      {
        symbol: 'SOL',
        position: {
          szi: '10',
          entryPx: '140',
          unrealizedPnl: '7', // +0.5%
          marginUsed: '280',
        },
      },
    ]);

    await runTick();

    expect(mockClosePosition).not.toHaveBeenCalled();
  });

  it('triggers exit when Max Hold Hours is exceeded', async () => {
    const symbol = 'BTC';
    mockGetOpenPositions.mockResolvedValue([
      {
        symbol,
        position: {
          szi: '0.1',
          entryPx: '50000',
          unrealizedPnl: '0',
          marginUsed: '1000',
        },
      },
    ]);

    // Provide ledger entry with openedAt 25 hours ago
    const longAgo = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    mockGetLedgerPositions.mockResolvedValue([
      {
        marketId: symbol,
        openedAt: longAgo,
        isFutures: true,
        direction: 'LONG',
        question: `News Futures: ${symbol} LONG`,
        entryPrice: 50000,
        stakeUsd: 10,
      },
    ]);

    await runTick();

    expect(mockClosePosition).toHaveBeenCalledWith(symbol);
  });

  describe('orphan prune — zero HL positions', () => {
    it('closes all futures ledger entries when HL has no open positions', async () => {
      mockGetOpenPositions.mockResolvedValue([]);
      mockGetLedgerPositions.mockResolvedValue([
        {
          marketId: 'SOL',
          symbol: 'SOL',
          direction: 'LONG',
          isFutures: true,
          question: 'SOL perpetual',
          entryPrice: 140,
          stakeUsd: 700,
          edgeMagnitude: 0,
          sourcedFrom: 'backfill:futures-monitor',
          openedAt: new Date().toISOString(),
          executionVenue: 'hyperliquid',
        },
        {
          marketId: 'XRP',
          symbol: 'XRP',
          direction: 'LONG',
          isFutures: true,
          question: 'XRP perpetual',
          entryPrice: 2.1,
          stakeUsd: 21,
          edgeMagnitude: 0,
          sourcedFrom: 'backfill:futures-monitor',
          openedAt: new Date().toISOString(),
          executionVenue: 'hyperliquid',
        },
      ]);

      await runTick();

      expect(mockCloseLedgerPosition).toHaveBeenCalledTimes(2);
      expect(mockCloseLedgerPosition).toHaveBeenCalledWith(expect.anything(), 'SOL', 'LONG');
      expect(mockCloseLedgerPosition).toHaveBeenCalledWith(expect.anything(), 'XRP', 'LONG');
    });
  });

  describe('orphan prune — partial HL positions', () => {
    it('closes only the ledger entries missing from HL, leaves live ones intact', async () => {
      // HL has ETH open, but not SOL
      mockGetOpenPositions.mockResolvedValue([
        {
          symbol: 'ETH',
          position: { szi: '1.0', entryPx: '3000', unrealizedPnl: '30', marginUsed: '600' },
        },
      ]);
      mockGetLedgerPositions.mockResolvedValue([
        {
          marketId: 'ETH',
          symbol: 'ETH',
          direction: 'LONG',
          isFutures: true,
          question: 'ETH perpetual',
          entryPrice: 3000,
          stakeUsd: 3000,
          edgeMagnitude: 0,
          sourcedFrom: 'futures-executor',
          openedAt: new Date().toISOString(),
          executionVenue: 'hyperliquid',
        },
        {
          marketId: 'SOL',
          symbol: 'SOL',
          direction: 'SHORT',
          isFutures: true,
          question: 'SOL perpetual',
          entryPrice: 140,
          stakeUsd: 700,
          edgeMagnitude: 0,
          sourcedFrom: 'futures-executor',
          openedAt: new Date().toISOString(),
          executionVenue: 'hyperliquid',
        },
      ]);
      // Mark both as already tracked so backfill is a no-op
      mockHasOpenPosition.mockResolvedValue(true);

      await runTick();

      expect(mockCloseLedgerPosition).toHaveBeenCalledTimes(1);
      expect(mockCloseLedgerPosition).toHaveBeenCalledWith(expect.anything(), 'SOL', 'SHORT');
      expect(mockCloseLedgerPosition).not.toHaveBeenCalledWith(expect.anything(), 'ETH', 'LONG');
    });
  });

  describe('max-hold bypass on winner', () => {
    const longAgo = () => new Date(Date.now() - 25 * 3600 * 1000).toISOString();

    // Each test uses a distinct symbol to avoid collisions in the module-level
    // `lastRevalCheck` Map (persists across tests within this file). With
    // FUTURES_REEVAL_INTERVAL_S=60, a prior test setting the cache would make
    // the next test skip its TA re-check and silently drift to the default.
    const makeWinningPosition = (symbol: string) => ({
      symbol,
      position: {
        szi: '0.1',
        entryPx: '50000',
        unrealizedPnl: '250', // +5.0% (above 3% TP line → trailing armed)
        marginUsed: '1000',
      },
    });

    const makeLedgerWinner = (symbol: string) => ({
      marketId: symbol,
      openedAt: longAgo(),
      isFutures: true,
      direction: 'LONG' as const,
      question: `News Futures: ${symbol} LONG`,
      entryPrice: 50000,
      stakeUsd: 10,
      highWaterMarkPct: 5.0, // has breached TP line → trailingArmed = true
    });

    const winnerCfg = {
      ...baseCfg,
      FUTURES_MAX_HOLD_BYPASS_ON_WINNER: true,
      FUTURES_TRAILING_STOP_ENABLED: true,
    };

    it('bypasses max-hold when trailing is armed and TA still agrees', async () => {
      loadConfigMock.mockReturnValue(winnerCfg);
      mockGetOpenPositions.mockResolvedValue([makeWinningPosition('BTC')]);
      mockGetLedgerPositions.mockResolvedValue([makeLedgerWinner('BTC')]);
      // TA neutral → not a reversal → bypass
      mockScoreConfluence.mockResolvedValue({ direction: 'UP', score: 3, signals: {} });

      await runTick();

      expect(mockClosePosition).not.toHaveBeenCalled();
    });

    it('does NOT bypass when TA signals reversal above exit threshold', async () => {
      loadConfigMock.mockReturnValue(winnerCfg);
      mockGetOpenPositions.mockResolvedValue([makeWinningPosition('ETH')]);
      mockGetLedgerPositions.mockResolvedValue([makeLedgerWinner('ETH')]);
      // Opposite direction + score >= EXIT_CONFLUENCE_SCORE (5)
      mockScoreConfluence.mockResolvedValue({ direction: 'DOWN', score: 5, signals: {} });

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('ETH');
    });

    it('does NOT bypass when trailing is not armed (zombie)', async () => {
      loadConfigMock.mockReturnValue(winnerCfg);
      // Sideways drifter: +0.5% PnL, nowhere near TP → trailing not armed
      mockGetOpenPositions.mockResolvedValue([
        {
          symbol: 'SOL',
          position: {
            szi: '0.1',
            entryPx: '50000',
            unrealizedPnl: '25', // +0.5%
            marginUsed: '1000',
          },
        },
      ]);
      mockGetLedgerPositions.mockResolvedValue([
        { ...makeLedgerWinner('SOL'), highWaterMarkPct: 0.5 },
      ]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('SOL');
    });

    it('does NOT bypass when the flag is disabled even if winning', async () => {
      loadConfigMock.mockReturnValue({
        ...baseCfg,
        FUTURES_MAX_HOLD_BYPASS_ON_WINNER: false,
        FUTURES_TRAILING_STOP_ENABLED: true,
      });
      mockGetOpenPositions.mockResolvedValue([makeWinningPosition('DOGE')]);
      mockGetLedgerPositions.mockResolvedValue([makeLedgerWinner('DOGE')]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('DOGE');
    });

    it('fails open when TA check throws — infra blip should not force-exit a winner', async () => {
      loadConfigMock.mockReturnValue(winnerCfg);
      mockGetOpenPositions.mockResolvedValue([makeWinningPosition('AVAX')]);
      mockGetLedgerPositions.mockResolvedValue([makeLedgerWinner('AVAX')]);
      mockScoreConfluence.mockRejectedValue(new Error('redis blip'));

      await runTick();

      expect(mockClosePosition).not.toHaveBeenCalled();
    });
  });
});
