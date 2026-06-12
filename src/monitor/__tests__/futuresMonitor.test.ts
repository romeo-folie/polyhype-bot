import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock Config
const baseCfg = {
  FUTURES_ENABLED: true,
  FUTURES_STOP_LOSS_PCT: -7.5,  // ROE % — 5× leverage means -1.5% notional ≈ -7.5% ROE
  FUTURES_TAKE_PROFIT_PCT: 3.0,
  FUTURES_MAX_HOLD_HOURS: 24,
  FUTURES_MAX_HOLD_BYPASS_ON_WINNER: false,
  FUTURES_MAX_HOLD_BLOCK_ON_LOSER: true,
  FUTURES_TRAILING_STOP_ENABLED: false,
  FUTURES_TRAILING_STOP_PCT: 1.5,
  FUTURES_EXIT_ON_SIGNAL_FADE: false,
  FUTURES_REEVAL_INTERVAL_S: 60,
  FUTURES_REEVAL_MIN_AGE_S: 600,
  FUTURES_EXIT_CONFLUENCE_SCORE: 5,
  FUTURES_ATR_SLTP_ENABLED: false,
  HL_MOMENTUM_STOP_LOSS_PCT: 5,
  HL_MOMENTUM_TAKE_PROFIT_PCT: 12,
  HL_MOMENTUM_MEME_ATR_SLTP_ENABLED: false,
  HL_MOMENTUM_MEME_SYMBOLS: 'pepeusdt,wifusdt,bonkusdt,penguusdt',
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

// Mock write queue (used by ATR + meme ATR shadow paths)
const mockEnqueueWrite = vi.fn();
vi.mock('../../db/writeQueue.js', () => ({
  enqueueWrite: mockEnqueueWrite,
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
  setex: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  eval: vi.fn().mockResolvedValue(1),
  smembers: vi.fn().mockResolvedValue([]),
  srem: vi.fn().mockResolvedValue(1),
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
const mockFetchAllMids = vi.fn();
vi.mock('../../shared/hyperliquid.js', () => ({
  getHyperliquid: vi.fn().mockReturnValue({
    getOpenPositions: mockGetOpenPositions,
    closePosition: mockClosePosition,
    fetchAllMids: mockFetchAllMids,
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
  notifyTradeError: vi.fn().mockResolvedValue(undefined),
  notifyTakeProfitExecuted: vi.fn().mockResolvedValue(undefined),
}));

// Mock outcome recorder
const mockRecordPositionOutcome = vi.fn().mockResolvedValue(undefined);
vi.mock('../../shared/positionOutcomeRecorder.js', () => ({
  recordPositionOutcome: mockRecordPositionOutcome,
}));

const { runFuturesMonitorWorker } = await import('../futuresMonitor.js');

describe('futuresMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue(baseCfg);
    mockScoreConfluence.mockResolvedValue({ direction: 'NEUTRAL', score: 0, signals: {} });
    mockRecordPositionOutcome.mockResolvedValue(undefined);
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

  it('triggers SL when ROE falls below -7.5%', async () => {
    mockGetOpenPositions.mockResolvedValue([
      {
        symbol: 'BTC',
        position: {
          szi: '0.1',
          entryPx: '50000',
          unrealizedPnl: '-100', // roePct = -100/1000 * 100 = -10% → below -7.5% SL
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

  it('does NOT trigger max-hold exit when the position is underwater', async () => {
    // pnlUsd=-50, marginUsed=1000 → roePct=-5% (loser but above the -7.5% ROE
    // SL floor, so max-hold is what would decide). Age 25h > 24h cap.
    // With FUTURES_MAX_HOLD_BLOCK_ON_LOSER=true (default), the exit is suppressed.
    const symbol = 'BTC';
    mockGetOpenPositions.mockResolvedValue([
      {
        symbol,
        position: {
          szi: '0.1',
          entryPx: '50000',
          unrealizedPnl: '-50', // -1% of 5000 notional
          marginUsed: '1000',
        },
      },
    ]);
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

    expect(mockClosePosition).not.toHaveBeenCalled();
  });

  it('STILL triggers max-hold exit when position is breakeven (priceChangePct >= 0)', async () => {
    // Entry 50000, current 50000 → 0% priceChangePct; not a loser, so exit fires.
    const symbol = 'BTC';
    mockGetOpenPositions.mockResolvedValue([
      {
        symbol,
        position: {
          szi: '0.1',
          entryPx: '50000',
          unrealizedPnl: '0',
          markPx: '50000',
          marginUsed: '1000',
        },
      },
    ]);
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

  it('max-hold exit is labeled futures_max_hold (not futures_sl) when it fires', async () => {
    const { notifyTakeProfitExecuted: mockNotify } = await import('../../execution/telegram.js');
    const symbol = 'BTC';
    mockGetOpenPositions.mockResolvedValue([
      {
        symbol,
        position: {
          szi: '0.1',
          entryPx: '50000',
          unrealizedPnl: '0',
          markPx: '50000',
          marginUsed: '1000',
        },
      },
    ]);
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
    expect(vi.mocked(mockNotify)).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'futures_max_hold' }),
    );
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
          // ROE = 9/600*100 = 1.5% — within FUTURES_TAKE_PROFIT_PCT=3.0, no exit fires
          symbol: 'ETH',
          position: { szi: '1.0', entryPx: '3000', unrealizedPnl: '9', marginUsed: '600' },
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

  describe('trailing HWM persistence (first-observation bootstrap)', () => {
    const trailingCfg = {
      ...baseCfg,
      FUTURES_TRAILING_STOP_ENABLED: true,
    };

    const makeLedgerNoHwm = (symbol: string) => ({
      marketId: symbol,
      openedAt: new Date(Date.now() - 60_000).toISOString(),
      isFutures: true,
      direction: 'LONG' as const,
      question: `News Futures: ${symbol} LONG`,
      entryPrice: 50000,
      stakeUsd: 10,
      // Intentionally no highWaterMarkPct — represents a fresh position whose
      // HWM has not yet been persisted (the bug this PR fixes).
    });

    it('persists HWM on first tick when prior HWM is missing (below TP arm)', async () => {
      loadConfigMock.mockReturnValue(trailingCfg);
      mockGetOpenPositions.mockResolvedValue([
        {
          symbol: 'BTC',
          position: {
            szi: '0.1',
            entryPx: '50000',
            unrealizedPnl: '50', // ROE = 50 / 2500 * 100 = 2% (below tp=3)
            marginUsed: '2500',
          },
        },
      ]);
      mockGetLedgerPositions.mockResolvedValue([makeLedgerNoHwm('BTC')]);

      await runTick();

      // Bug repro: under the broken condition (gatePct > hwm strict-greater),
      // priorHwm undefined → hwm = gatePct → check is false → no write.
      // Fixed: persist on first observation regardless of arming.
      expect(mockUpdateHighWaterMark).toHaveBeenCalledWith(
        expect.anything(),
        'BTC',
        'LONG',
        2,
      );
      // Below TP arm — should not fire trailing exit.
      expect(mockClosePosition).not.toHaveBeenCalled();
    });

    it('persists HWM on first tick when prior HWM is missing (above TP arm)', async () => {
      loadConfigMock.mockReturnValue(trailingCfg);
      mockGetOpenPositions.mockResolvedValue([
        {
          symbol: 'ETH',
          position: {
            szi: '1.0',
            entryPx: '3000',
            unrealizedPnl: '300', // +10% notional → at 5x ROE = 50%
            marginUsed: '600', // ROE = 300/600*100 = 50%
          },
        },
      ]);
      mockGetLedgerPositions.mockResolvedValue([makeLedgerNoHwm('ETH')]);

      await runTick();

      expect(mockUpdateHighWaterMark).toHaveBeenCalledWith(
        expect.anything(),
        'ETH',
        'LONG',
        50, // gatePct = roePct = 50%
      );
    });

    it('does NOT re-persist when current is below an already-persisted peak', async () => {
      loadConfigMock.mockReturnValue(trailingCfg);
      mockGetOpenPositions.mockResolvedValue([
        {
          symbol: 'SOL',
          position: {
            szi: '10',
            entryPx: '100',
            unrealizedPnl: '20', // +2% notional, ROE = 20/200*100 = 10%
            marginUsed: '200',
          },
        },
      ]);
      mockGetLedgerPositions.mockResolvedValue([
        { ...makeLedgerNoHwm('SOL'), highWaterMarkPct: 25 }, // peaked higher earlier
      ]);

      await runTick();

      expect(mockUpdateHighWaterMark).not.toHaveBeenCalled();
    });

    it('ratchets HWM upward when current exceeds the prior peak', async () => {
      loadConfigMock.mockReturnValue(trailingCfg);
      mockGetOpenPositions.mockResolvedValue([
        {
          symbol: 'XRP',
          position: {
            szi: '100',
            entryPx: '0.5',
            unrealizedPnl: '5', // +10% notional → ROE 50%
            marginUsed: '10',
          },
        },
      ]);
      mockGetLedgerPositions.mockResolvedValue([
        { ...makeLedgerNoHwm('XRP'), highWaterMarkPct: 30 }, // prior peak
      ]);

      await runTick();

      expect(mockUpdateHighWaterMark).toHaveBeenCalledWith(
        expect.anything(),
        'XRP',
        'LONG',
        50,
      );
    });

    it('trailing fires when current falls below floor after ratcheted peak', async () => {
      loadConfigMock.mockReturnValue(trailingCfg);
      mockGetOpenPositions.mockResolvedValue([
        {
          symbol: 'WIF',
          position: {
            szi: '100',
            entryPx: '1.0',
            unrealizedPnl: '4', // +4% notional → ROE 20%
            marginUsed: '20',
          },
        },
      ]);
      // Prior peak 30 → floor = max(tp=3, 30 - trailStop=1.5) = 28.5. Current ROE 20 ≤ 28.5 → trailing fires.
      mockGetLedgerPositions.mockResolvedValue([
        { ...makeLedgerNoHwm('WIF'), highWaterMarkPct: 30 },
      ]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('WIF');
    });
  });

  describe('meme ATR SL/TP (issue #264)', () => {
    // Meme config: ATR SL/TP active + HL momentum per-source override in place.
    const memeCfg = {
      ...baseCfg,
      HL_MOMENTUM_MEME_ATR_SLTP_ENABLED: true,
    };

    const makeLedgerMemePos = (opts: {
      symbol: string;
      memeAtrSlPct?: number;
      memeAtrTpPct?: number;
      sourcedFrom?: string;
    }) => ({
      marketId: opts.symbol,
      symbol: opts.symbol,
      direction: 'LONG' as const,
      isFutures: true,
      question: `${opts.symbol} perpetual`,
      entryPrice: 0.001,
      stakeUsd: 10,
      edgeMagnitude: 0,
      sourcedFrom: opts.sourcedFrom ?? 'hl-momentum',
      openedAt: new Date().toISOString(),
      executionVenue: 'hyperliquid' as const,
      memeAtrSlPct: opts.memeAtrSlPct,
      memeAtrTpPct: opts.memeAtrTpPct,
    });

    const makeHlPos = (symbol: string, pnlPct: number) => ({
      symbol,
      position: {
        szi: '100',
        entryPx: '1',
        unrealizedPnl: String(pnlPct), // 1 szi * entryPx=1 → margin 100, pnl === pct
        marginUsed: '100',
      },
    });

    it('meme SL does not fire at -5% when the frozen SL is -15% (avoids chop)', async () => {
      loadConfigMock.mockReturnValue(memeCfg);
      mockGetOpenPositions.mockResolvedValue([makeHlPos('kPEPE', -5)]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerMemePos({ symbol: 'kPEPE', memeAtrSlPct: 15, memeAtrTpPct: 30 }),
      ]);

      await runTick();

      expect(mockClosePosition).not.toHaveBeenCalled();
    });

    it('meme SL fires when price hits the frozen -15% SL', async () => {
      loadConfigMock.mockReturnValue(memeCfg);
      mockGetOpenPositions.mockResolvedValue([makeHlPos('kPEPE', -16)]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerMemePos({ symbol: 'kPEPE', memeAtrSlPct: 15, memeAtrTpPct: 30 }),
      ]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('kPEPE');
    });

    it('meme TP fires at the frozen TP (no trailing configured)', async () => {
      loadConfigMock.mockReturnValue(memeCfg);
      mockGetOpenPositions.mockResolvedValue([makeHlPos('WIF', 30)]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerMemePos({ symbol: 'WIF', memeAtrSlPct: 15, memeAtrTpPct: 30 }),
      ]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('WIF');
    });

    it('feature disabled: meme ledger fields are ignored, fixed HL momentum -5% SL stays active', async () => {
      // Same -10% scenario; fixed HL SL=-5% should trigger even though meme SL=-15% would not.
      loadConfigMock.mockReturnValue({
        ...baseCfg,
        HL_MOMENTUM_MEME_ATR_SLTP_ENABLED: false,
      });
      mockGetOpenPositions.mockResolvedValue([makeHlPos('kBONK', -10)]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerMemePos({ symbol: 'kBONK', memeAtrSlPct: 15, memeAtrTpPct: 30 }),
      ]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('kBONK');
    });

    it('major symbol (BTC) with HL momentum source falls through to fixed, not meme branch', async () => {
      loadConfigMock.mockReturnValue(memeCfg);
      // -10% is past fixed HL SL (-5%) but not past meme-ATR SL (-15%).
      // If the meme branch incorrectly matched BTC it would hold; correct behavior = SL fires.
      mockGetOpenPositions.mockResolvedValue([makeHlPos('BTC', -10)]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerMemePos({ symbol: 'BTC', memeAtrSlPct: 15, memeAtrTpPct: 30 }),
      ]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('BTC');
    });

    it('non-hl-momentum source falls through even on a meme symbol', async () => {
      loadConfigMock.mockReturnValue(memeCfg);
      // -10% crosses the default FUTURES_STOP_LOSS_PCT (-1.5%).
      mockGetOpenPositions.mockResolvedValue([makeHlPos('kPEPE', -10)]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerMemePos({
          symbol: 'kPEPE',
          memeAtrSlPct: 15,
          memeAtrTpPct: 30,
          sourcedFrom: 'arb-scanner',
        }),
      ]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('kPEPE');
    });

    it('meme symbol without frozen ATR snapshot falls back to fixed HL momentum SL', async () => {
      loadConfigMock.mockReturnValue(memeCfg);
      mockGetOpenPositions.mockResolvedValue([makeHlPos('kPEPE', -6)]);
      mockGetLedgerPositions.mockResolvedValue([
        // No memeAtrSlPct/TpPct — simulates ATR unavailable at entry.
        makeLedgerMemePos({ symbol: 'kPEPE' }),
      ]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('kPEPE');
    });

    it('shadow divergence emitted when verdicts disagree and feature is dark', async () => {
      loadConfigMock.mockReturnValue({
        ...baseCfg,
        HL_MOMENTUM_MEME_ATR_SLTP_ENABLED: false,
      });
      // -7%: fixed HL SL (-5%) would fire; meme SL (-15%) would not → verdict mismatch.
      mockGetOpenPositions.mockResolvedValue([makeHlPos('kPEPE', -7)]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerMemePos({ symbol: 'kPEPE', memeAtrSlPct: 15, memeAtrTpPct: 30 }),
      ]);

      await runTick();

      expect(mockEnqueueWrite).toHaveBeenCalledWith(
        'shadow_observations',
        expect.objectContaining({
          kind: 'meme_atr_sltp_shadow',
          payload: expect.objectContaining({
            fixedVerdict: 'SL',
            memeVerdict: 'hold',
          }),
        }),
      );
    });

    it('shadow does not fire when fixed and meme verdicts agree', async () => {
      loadConfigMock.mockReturnValue({
        ...baseCfg,
        HL_MOMENTUM_MEME_ATR_SLTP_ENABLED: false,
      });
      // +1%: both verdicts are hold → no divergence log.
      mockGetOpenPositions.mockResolvedValue([makeHlPos('kPEPE', 1)]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerMemePos({ symbol: 'kPEPE', memeAtrSlPct: 15, memeAtrTpPct: 30 }),
      ]);

      await runTick();

      const memeShadowCalls = mockEnqueueWrite.mock.calls.filter(
        ([kind, payload]) =>
          kind === 'shadow_observations' &&
          (payload as { kind?: string }).kind === 'meme_atr_sltp_shadow',
      );
      expect(memeShadowCalls).toHaveLength(0);
    });
  });

  describe('hl-momentum ATR geometry (2026-06-12 review)', () => {
    // Frozen ATR SL/TP active for NON-meme hl-momentum positions. Fixed HL SL in
    // baseCfg is -5 ROE; the frozen ATR SL here is 2.5 notional %.
    const hlAtrCfg = {
      ...baseCfg,
      HL_MOMENTUM_ATR_SLTP_ENABLED: true,
      HL_MOMENTUM_TRAIL_ATR_MULT: 1.0,
    };

    const makeLedgerHlPos = (opts: {
      symbol: string;
      memeAtrSlPct?: number;
      memeAtrTpPct?: number;
      entryAtrPct?: number;
      sourcedFrom?: string;
    }) => ({
      marketId: opts.symbol,
      symbol: opts.symbol,
      direction: 'LONG' as const,
      isFutures: true,
      question: `${opts.symbol} perpetual`,
      entryPrice: 1,
      stakeUsd: 30,
      edgeMagnitude: 0,
      sourcedFrom: opts.sourcedFrom ?? 'hl-momentum',
      openedAt: new Date().toISOString(),
      executionVenue: 'hyperliquid' as const,
      memeAtrSlPct: opts.memeAtrSlPct,
      memeAtrTpPct: opts.memeAtrTpPct,
      entryAtrPct: opts.entryAtrPct,
    });

    // marginUsed 10 with positionValue 100 → 10x effective leverage:
    // pnlPct param is the NOTIONAL price-change %; ROE is 10× that.
    const makeLeveredHlPos = (symbol: string, pricePct: number) => ({
      symbol,
      position: {
        szi: '100',
        entryPx: '1',
        unrealizedPnl: String(pricePct),
        marginUsed: '10',
      },
    });

    it('SL fires when price change hits the frozen ATR stop', async () => {
      loadConfigMock.mockReturnValue(hlAtrCfg);
      mockGetOpenPositions.mockResolvedValue([makeLeveredHlPos('SOL', -2.6)]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerHlPos({ symbol: 'SOL', memeAtrSlPct: 2.5, memeAtrTpPct: 4.5 }),
      ]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('SOL');
    });

    it('replaces the fixed ROE stop: ROE past -5 but price above the ATR stop → hold', async () => {
      loadConfigMock.mockReturnValue(hlAtrCfg);
      // price -1% → ROE -10% at 10x: the old fixed -5 ROE stop would have fired.
      mockGetOpenPositions.mockResolvedValue([makeLeveredHlPos('SOL', -1)]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerHlPos({ symbol: 'SOL', memeAtrSlPct: 2.5, memeAtrTpPct: 4.5 }),
      ]);

      await runTick();

      expect(mockClosePosition).not.toHaveBeenCalled();
    });

    it('knob off: fixed ROE stop behaviour unchanged', async () => {
      loadConfigMock.mockReturnValue({ ...baseCfg, HL_MOMENTUM_ATR_SLTP_ENABLED: false });
      // price -1% → ROE -10% at 10x → fixed HL SL (-5 ROE) fires despite frozen fields.
      mockGetOpenPositions.mockResolvedValue([makeLeveredHlPos('SOL', -1)]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerHlPos({ symbol: 'SOL', memeAtrSlPct: 2.5, memeAtrTpPct: 4.5 }),
      ]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('SOL');
    });

    it('meme symbols are governed by the meme knob, not this one', async () => {
      // hl-ATR on, meme knob off → kPEPE keeps fixed ROE thresholds.
      loadConfigMock.mockReturnValue(hlAtrCfg);
      mockGetOpenPositions.mockResolvedValue([makeLeveredHlPos('kPEPE', -1)]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerHlPos({ symbol: 'kPEPE', memeAtrSlPct: 15, memeAtrTpPct: 30 }),
      ]);

      await runTick();

      // ROE -10% past fixed -5 → fires (the hl-ATR block must NOT have claimed kPEPE)
      expect(mockClosePosition).toHaveBeenCalledWith('kPEPE');
    });

    it('trailing giveback scales with entry ATR (1×ATR from peak)', async () => {
      loadConfigMock.mockReturnValue({
        ...hlAtrCfg,
        FUTURES_TRAILING_STOP_ENABLED: true,
      });
      // Frozen TP (arm) = 4.5%; entryAtrPct = 1.2 → giveback 1.2%.
      // Prior HWM 6.0%; current price +4.7% → drawdown 1.3% > 1.2% → trail fires.
      mockRedis.get.mockImplementation((key: string) =>
        Promise.resolve(key.includes('hwm') ? '6' : null),
      );
      mockGetOpenPositions.mockResolvedValue([makeLeveredHlPos('SOL', 4.7)]);
      mockGetLedgerPositions.mockResolvedValue([
        {
          ...makeLedgerHlPos({
            symbol: 'SOL', memeAtrSlPct: 2.5, memeAtrTpPct: 4.5, entryAtrPct: 1.2,
          }),
          highWaterMarkPct: 6,
        },
      ]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('SOL');
    });

    it('trailing holds inside the ATR giveback', async () => {
      loadConfigMock.mockReturnValue({
        ...hlAtrCfg,
        FUTURES_TRAILING_STOP_ENABLED: true,
      });
      // HWM 6.0%, current +5.1% → drawdown 0.9% < 1.2% giveback → hold.
      mockGetOpenPositions.mockResolvedValue([makeLeveredHlPos('SOL', 5.1)]);
      mockGetLedgerPositions.mockResolvedValue([
        {
          ...makeLedgerHlPos({
            symbol: 'SOL', memeAtrSlPct: 2.5, memeAtrTpPct: 4.5, entryAtrPct: 1.2,
          }),
          highWaterMarkPct: 6,
        },
      ]);

      await runTick();

      expect(mockClosePosition).not.toHaveBeenCalled();
    });
  });

  describe('pure-time-exit shadow sweep (2026-06-12 experiment)', () => {
    const shadowCfg = {
      ...baseCfg,
      HL_TIME_EXIT_SHADOW_ENABLED: true,
      HL_TIME_EXIT_SHADOW_HOURS: 8,
    };
    const NOW = Date.now();

    it('logs the hypothetical time-exit return once an entry is due', async () => {
      loadConfigMock.mockReturnValue(shadowCfg);
      const key = `hl:time_exit_shadow:BTC:${NOW - 9 * 3_600_000}`;
      mockRedis.smembers.mockResolvedValue([key]);
      mockRedis.get.mockImplementation((k: string) =>
        Promise.resolve(
          k === key
            ? JSON.stringify({
                symbol: 'BTC',
                direction: 'SHORT',
                entryPrice: 50_000,
                entryTs: NOW - 9 * 3_600_000,
                entryOrderType: 'maker',
              })
            : null,
        ),
      );
      mockFetchAllMids.mockResolvedValue({ BTC: 49_000 });

      await runTick();

      // SHORT from 50k to 49k = +2%
      expect(mockEnqueueWrite).toHaveBeenCalledWith(
        'shadow_observations',
        expect.objectContaining({
          kind: 'hl_time_exit_shadow',
          symbol: 'BTC',
          direction: 'SHORT',
          metricValue: expect.closeTo(2, 5),
          payload: expect.objectContaining({ exitPrice: 49_000, holdHours: 8 }),
        }),
      );
      expect(mockRedis.del).toHaveBeenCalledWith(key);
      expect(mockRedis.srem).toHaveBeenCalledWith('hl:time_exit_shadow:index', key);
    });

    it('leaves entries that are not yet due untouched', async () => {
      loadConfigMock.mockReturnValue(shadowCfg);
      const key = `hl:time_exit_shadow:BTC:${NOW - 3_600_000}`;
      mockRedis.smembers.mockResolvedValue([key]);
      mockRedis.get.mockImplementation((k: string) =>
        Promise.resolve(
          k === key
            ? JSON.stringify({
                symbol: 'BTC', direction: 'LONG', entryPrice: 50_000, entryTs: NOW - 3_600_000,
              })
            : null,
        ),
      );

      await runTick();

      expect(mockEnqueueWrite).not.toHaveBeenCalledWith(
        'shadow_observations',
        expect.objectContaining({ kind: 'hl_time_exit_shadow' }),
      );
      expect(mockRedis.del).not.toHaveBeenCalledWith(key);
      expect(mockFetchAllMids).not.toHaveBeenCalled();
    });

    it('prunes dangling index members whose value TTL-expired', async () => {
      loadConfigMock.mockReturnValue(shadowCfg);
      const key = `hl:time_exit_shadow:BTC:${NOW - 20 * 3_600_000}`;
      mockRedis.smembers.mockResolvedValue([key]);
      mockRedis.get.mockResolvedValue(null);

      await runTick();

      expect(mockRedis.srem).toHaveBeenCalledWith('hl:time_exit_shadow:index', key);
      expect(mockEnqueueWrite).not.toHaveBeenCalledWith(
        'shadow_observations',
        expect.objectContaining({ kind: 'hl_time_exit_shadow' }),
      );
    });

    it('does nothing when the experiment knob is off', async () => {
      loadConfigMock.mockReturnValue({ ...shadowCfg, HL_TIME_EXIT_SHADOW_ENABLED: false });

      await runTick();

      expect(mockRedis.smembers).not.toHaveBeenCalled();
    });
  });

  describe('FUTURES_MAX_LOSS_ROE_PCT backstop', () => {
    // Leverage-invariant ROE cap that fires on top of any path-derived SL.
    // Meme path's notional clamp of 8% would let -29% ROE positions ride at
    // 5x leverage; the backstop catches them at the user-configured ROE limit.
    const makeLedgerMemePos = (opts: { symbol: string; memeAtrSlPct: number; memeAtrTpPct: number }) => ({
      marketId: opts.symbol,
      symbol: opts.symbol,
      direction: 'LONG' as const,
      isFutures: true,
      question: `${opts.symbol} perpetual`,
      entryPrice: 0.001,
      stakeUsd: 10,
      edgeMagnitude: 0,
      sourcedFrom: 'hl-momentum',
      openedAt: new Date().toISOString(),
      executionVenue: 'hyperliquid' as const,
      memeAtrSlPct: opts.memeAtrSlPct,
      memeAtrTpPct: opts.memeAtrTpPct,
    });

    // 5x leverage scenario: szi=100, entryPx=1 → notional 100, marginUsed 20.
    // pnlUsd directly equals roe% × 0.2 (since margin=20). pnlUsd=-5 → roe=-25%.
    const make5xPos = (symbol: string, pnlUsd: number) => ({
      symbol,
      position: {
        szi: '100',
        entryPx: '1',
        unrealizedPnl: String(pnlUsd),
        marginUsed: '20',
      },
    });

    it('fires at the configured ROE cap on a meme position whose notional SL is wider', async () => {
      // WIF case: meme floor=8% notional → -40% ROE at 5x. Backstop set to 25
      // should fire at -5% notional move (-25% ROE) before the meme SL.
      loadConfigMock.mockReturnValue({
        ...baseCfg,
        FUTURES_MAX_LOSS_ROE_PCT: 25,
        HL_MOMENTUM_MEME_ATR_SLTP_ENABLED: true,
      });
      // pnlUsd=-5 on margin=20 → roe=-25%, exactly at cap.
      mockGetOpenPositions.mockResolvedValue([make5xPos('WIF', -5)]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerMemePos({ symbol: 'WIF', memeAtrSlPct: 8, memeAtrTpPct: 24 }),
      ]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('WIF');
    });

    it('does NOT fire when ROE is shallower than the cap', async () => {
      loadConfigMock.mockReturnValue({
        ...baseCfg,
        FUTURES_MAX_LOSS_ROE_PCT: 25,
        HL_MOMENTUM_MEME_ATR_SLTP_ENABLED: true,
      });
      // pnlUsd=-4 → roe=-20%, above the -25% cap and below meme SL=-8% notional.
      mockGetOpenPositions.mockResolvedValue([make5xPos('WIF', -4)]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerMemePos({ symbol: 'WIF', memeAtrSlPct: 8, memeAtrTpPct: 24 }),
      ]);

      await runTick();

      expect(mockClosePosition).not.toHaveBeenCalled();
    });

    it('disabled when set to 0 — falls through to existing path-derived SL', async () => {
      loadConfigMock.mockReturnValue({
        ...baseCfg,
        FUTURES_MAX_LOSS_ROE_PCT: 0,
        HL_MOMENTUM_MEME_ATR_SLTP_ENABLED: true,
      });
      // -25% ROE (-5% notional) — meme SL=-8% notional NOT hit, backstop disabled.
      mockGetOpenPositions.mockResolvedValue([make5xPos('WIF', -5)]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerMemePos({ symbol: 'WIF', memeAtrSlPct: 8, memeAtrTpPct: 24 }),
      ]);

      await runTick();

      expect(mockClosePosition).not.toHaveBeenCalled();
    });

    it('survives leverage change — same cap value behaves identically at 10x', async () => {
      // 10x leverage: szi=100, entryPx=1 → notional 100, marginUsed 10.
      // pnlUsd=-2.5 on margin=10 → roe=-25%. Same cap, fires at half the notional move.
      loadConfigMock.mockReturnValue({
        ...baseCfg,
        FUTURES_MAX_LOSS_ROE_PCT: 25,
        HL_MOMENTUM_MEME_ATR_SLTP_ENABLED: true,
      });
      mockGetOpenPositions.mockResolvedValue([
        {
          symbol: 'WIF',
          position: {
            szi: '100',
            entryPx: '1',
            unrealizedPnl: '-2.5',
            marginUsed: '10',
          },
        },
      ]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerMemePos({ symbol: 'WIF', memeAtrSlPct: 8, memeAtrTpPct: 24 }),
      ]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('WIF');
    });

    it('does not preempt a tighter per-source SL on hl-momentum non-meme positions', async () => {
      // BTC sourced from hl-momentum → per-source HL_MOMENTUM_STOP_LOSS_PCT=5 (ROE) applies.
      // At roe=-10%, the per-source SL fires first (5 < 25); the backstop must NOT preempt it
      // and the close reason must reflect the per-source SL, not roe_max_loss.
      const { notifyTakeProfitExecuted: mockNotify } = await import('../../execution/telegram.js');
      loadConfigMock.mockReturnValue({
        ...baseCfg,
        FUTURES_MAX_LOSS_ROE_PCT: 25,
      });
      mockGetOpenPositions.mockResolvedValue([
        {
          symbol: 'BTC',
          position: {
            szi: '0.1',
            entryPx: '50000',
            unrealizedPnl: '-100',  // notional 5000, margin 1000 → roe=-10%
            marginUsed: '1000',
          },
        },
      ]);
      mockGetLedgerPositions.mockResolvedValue([
        {
          marketId: 'BTC',
          isFutures: true,
          direction: 'LONG',
          question: 'BTC perpetual',
          entryPrice: 50000,
          stakeUsd: 10,
          openedAt: new Date().toISOString(),
          executionVenue: 'hyperliquid',
          sourcedFrom: 'hl-momentum',
        },
      ]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('BTC');
      const call = (mockNotify as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | { mechanismDetail?: string }
        | undefined;
      expect(call?.mechanismDetail).toBeDefined();
      expect(call?.mechanismDetail).not.toContain('roe_max_loss');
    });
  });

  describe('global ATR bypass for hl-momentum (2026-04-22 WIF fix)', () => {
    // Global ATR path (FUTURES_ATR_SLTP_ENABLED=true) is calibrated for 1m
    // crypto-arb scalps with a 1% SL floor. hl-momentum is a 15m swing strategy
    // that needs the wider HL_MOMENTUM_STOP_LOSS_PCT. These tests lock in the
    // bypass: global ATR must NOT apply to hl-momentum positions.
    const globalAtrCfg = {
      ...baseCfg,
      FUTURES_ATR_SLTP_ENABLED: true,
      FUTURES_ATR_SL_MULT: 1.5,
      FUTURES_ATR_TP_MULT: 3.0,
      FUTURES_ATR_SL_MIN_PCT: 1.0,
      FUTURES_ATR_SL_MAX_PCT: 5.0,
      FUTURES_ATR_TP_MIN_PCT: 2.0,
      FUTURES_ATR_TP_MAX_PCT: 10.0,
      FUTURES_ATR_TRAIL_STOP_MULT: 1.0,
    };

    const makeLedgerPos = (opts: {
      symbol: string;
      sourcedFrom: string;
      entryAtrPct?: number;
    }) => ({
      marketId: opts.symbol,
      symbol: opts.symbol,
      direction: 'LONG' as const,
      isFutures: true,
      question: `${opts.symbol} perpetual`,
      entryPrice: 1,
      stakeUsd: 10,
      edgeMagnitude: 0,
      sourcedFrom: opts.sourcedFrom,
      openedAt: new Date().toISOString(),
      executionVenue: 'hyperliquid' as const,
      entryAtrPct: opts.entryAtrPct,
    });

    const makeHlPos = (symbol: string, pnlPct: number) => ({
      symbol,
      position: {
        szi: '100',
        entryPx: '1',
        unrealizedPnl: String(pnlPct),
        marginUsed: '100',
      },
    });

    it('hl-momentum position survives -2% when 15m ATR would compute 1.15% SL', async () => {
      // 0.77% entryAtr × 1.5 = 1.155 → global ATR would SL here at -2%.
      // After the bypass hl-momentum runs on fixed HL_MOMENTUM_STOP_LOSS_PCT=5%,
      // so -2% is well inside the allowed range and the position holds.
      loadConfigMock.mockReturnValue(globalAtrCfg);
      mockGetOpenPositions.mockResolvedValue([makeHlPos('WIF', -2)]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerPos({ symbol: 'WIF', sourcedFrom: 'hl-momentum', entryAtrPct: 0.77 }),
      ]);

      await runTick();

      expect(mockClosePosition).not.toHaveBeenCalled();
    });

    it('hl-momentum position SL fires at the fixed -5% floor, not the global ATR -1%', async () => {
      loadConfigMock.mockReturnValue(globalAtrCfg);
      mockGetOpenPositions.mockResolvedValue([makeHlPos('WIF', -5.5)]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerPos({ symbol: 'WIF', sourcedFrom: 'hl-momentum', entryAtrPct: 0.77 }),
      ]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('WIF');
    });

    it('non-hl-momentum (crypto-arb) still uses global ATR path', async () => {
      // Global ATR SL = clamp(0.5 × 1.5, 1.0, 5.0) = 1.0% → -1.5% should SL.
      loadConfigMock.mockReturnValue(globalAtrCfg);
      mockGetOpenPositions.mockResolvedValue([makeHlPos('BTC', -1.5)]);
      mockGetLedgerPositions.mockResolvedValue([
        makeLedgerPos({ symbol: 'BTC', sourcedFrom: 'crypto-arb', entryAtrPct: 0.5 }),
      ]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('BTC');
    });
  });

  describe('contrarian SL override (HL_MOMENTUM_CONTRARIAN_STOP_LOSS_PCT)', () => {
    // Contrarian hl-momentum positions use a wider SL than standard momentum positions.
    // The baseCfg has HL_MOMENTUM_STOP_LOSS_PCT=5; here we add CONTRARIAN_STOP_LOSS_PCT=15
    // so a position at -10% ROE is inside the contrarian SL but outside the standard SL.
    const contrarianSlCfg = {
      ...baseCfg,
      HL_MOMENTUM_STOP_LOSS_PCT: 5,
      HL_MOMENTUM_CONTRARIAN_STOP_LOSS_PCT: 15,
    };
    const makeLedgerPos = (isContrarian: boolean, memeAtrSlPct?: number) => ({
      marketId: 'ETH',
      isFutures: true,
      direction: 'LONG' as const,
      question: 'ETH perpetual',
      entryPrice: 1,
      stakeUsd: 20,
      openedAt: new Date().toISOString(),
      executionVenue: 'hyperliquid' as const,
      sourcedFrom: 'hl-momentum',
      isContrarian,
      ...(memeAtrSlPct !== undefined ? { memeAtrSlPct, memeAtrTpPct: 20 } : {}),
    });
    // szi=100, entryPx=1 → notional=100, margin=20 → leverage=5x, roe=-10%
    const posAt10PctLoss = {
      symbol: 'ETH',
      position: { szi: '100', entryPx: '1', unrealizedPnl: '-2', marginUsed: '20' },
    };
    // roe=-16% — beyond contrarian SL of 15%
    const posAt16PctLoss = {
      symbol: 'ETH',
      position: { szi: '100', entryPx: '1', unrealizedPnl: '-3.2', marginUsed: '20' },
    };

    it('does not stop out a contrarian position at -10% ROE when contrarian SL is 15%', async () => {
      loadConfigMock.mockReturnValue(contrarianSlCfg);
      mockGetOpenPositions.mockResolvedValue([posAt10PctLoss]);
      mockGetLedgerPositions.mockResolvedValue([makeLedgerPos(true)]);

      await runTick();

      expect(mockClosePosition).not.toHaveBeenCalled();
    });

    it('stops out a contrarian position at -16% ROE when contrarian SL is 15%', async () => {
      loadConfigMock.mockReturnValue(contrarianSlCfg);
      mockGetOpenPositions.mockResolvedValue([posAt16PctLoss]);
      mockGetLedgerPositions.mockResolvedValue([makeLedgerPos(true)]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('ETH');
    });

    it('stops out a non-contrarian hl-momentum position at -10% ROE (standard SL=5% applies)', async () => {
      loadConfigMock.mockReturnValue(contrarianSlCfg);
      mockGetOpenPositions.mockResolvedValue([posAt10PctLoss]);
      mockGetLedgerPositions.mockResolvedValue([makeLedgerPos(false)]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('ETH');
    });

    it('does not apply contrarian SL override to meme positions (they keep ATR-derived SL)', async () => {
      // Meme-ATR SL is 8% price change (notional). Position is down 8.5% price change
      // → should SL even though isContrarian=true, because ATR path takes precedence.
      // Note: meme ATR uses priceChangePct (notional), not roePct, so at 5x leverage
      // a -8.5% price move = -42.5% ROE but only -8.5% notional — that's what fires the meme SL.
      loadConfigMock.mockReturnValue({
        ...contrarianSlCfg,
        HL_MOMENTUM_MEME_ATR_SLTP_ENABLED: true,
        HL_MOMENTUM_MEME_SYMBOLS: 'wifusdt,pepeusdt,bonkusdt,penguusdt',
      });
      // szi=100, entryPx=1 → notional=100; unrealizedPnl=-8.5 → priceChangePct=-8.5% (> meme SL -8%)
      const posAtMemeSlBreach = {
        symbol: 'WIF',
        position: { szi: '100', entryPx: '1', unrealizedPnl: '-8.5', marginUsed: '20' },
      };
      mockGetOpenPositions.mockResolvedValue([posAtMemeSlBreach]);
      mockGetLedgerPositions.mockResolvedValue([
        { ...makeLedgerPos(true, 8), marketId: 'WIF' },
      ]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('WIF');
    });
  });

  describe('signal-fade exit gate', () => {
    const fadeCfg = { ...baseCfg, FUTURES_EXIT_ON_SIGNAL_FADE: true };
    const oldEnough = () => new Date(Date.now() - 20 * 60 * 1000).toISOString();

    it('exits a flat/losing position when confluence flips against direction', async () => {
      loadConfigMock.mockReturnValue(fadeCfg);
      // -0.5%: above SL, below TP, in the red → fade should fire
      mockGetOpenPositions.mockResolvedValue([
        { symbol: 'MATIC', position: { szi: '100', entryPx: '1', unrealizedPnl: '-0.5', marginUsed: '20' } },
      ]);
      mockGetLedgerPositions.mockResolvedValue([
        { marketId: 'MATIC', openedAt: oldEnough(), isFutures: true, direction: 'LONG', question: 'MATIC perpetual', entryPrice: 1, stakeUsd: 20 },
      ]);
      mockScoreConfluence.mockResolvedValue({ direction: 'DOWN', score: 5, signals: {} });

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('MATIC');
    });

    it('does NOT exit a winning position even when confluence flips against direction', async () => {
      loadConfigMock.mockReturnValue(fadeCfg);
      // +0.5%: priceChangePct > 0 → fade gate blocked, position held
      mockGetOpenPositions.mockResolvedValue([
        { symbol: 'DOT', position: { szi: '100', entryPx: '1', unrealizedPnl: '0.5', marginUsed: '20' } },
      ]);
      mockGetLedgerPositions.mockResolvedValue([
        { marketId: 'DOT', openedAt: oldEnough(), isFutures: true, direction: 'LONG', question: 'DOT perpetual', entryPrice: 1, stakeUsd: 20 },
      ]);
      mockScoreConfluence.mockResolvedValue({ direction: 'DOWN', score: 5, signals: {} });

      await runTick();

      expect(mockClosePosition).not.toHaveBeenCalled();
    });

    it('does NOT fire re-eval for contrarian hl-momentum position — opposing momentum is the entry condition', async () => {
      loadConfigMock.mockReturnValue(fadeCfg);
      // -2.5% ROE: flat/losing (priceChangePct < 0 satisfies re-eval guard), but above
      // HL_MOMENTUM_STOP_LOSS_PCT (-5%) so SL does NOT fire — only re-eval would.
      // szi=100, entryPx=1, positionValue=100, margin=20 → leverage=5x
      // unrealizedPnl=-0.5 → priceChangePct=-0.5%, roePct=-2.5%
      mockGetOpenPositions.mockResolvedValue([
        { symbol: 'ETH', position: { szi: '100', entryPx: '1', unrealizedPnl: '-0.5', marginUsed: '20' } },
      ]);
      mockGetLedgerPositions.mockResolvedValue([
        {
          marketId: 'ETH',
          openedAt: oldEnough(),
          isFutures: true,
          direction: 'LONG',
          question: 'ETH perpetual',
          entryPrice: 1,
          stakeUsd: 20,
          sourcedFrom: 'hl-momentum',
          isContrarian: true,
        },
      ]);
      // Confluence still DOWN — same signal that triggered the contrarian LONG entry
      mockScoreConfluence.mockResolvedValue({ direction: 'DOWN', score: 5, signals: {} });

      await runTick();

      expect(mockClosePosition).not.toHaveBeenCalled();
    });
  });

  describe('post-TP momentum cooldown', () => {
    // szi=100, entryPx=1, marginUsed=10 (10x leverage) → positionValue=100, margin=10
    // roePct = (pnlUsd / 10) * 100
    // hl-momentum TP = 12% ROE → pnlUsd=1.2 triggers TP
    // hl-momentum SL = -5% ROE → pnlUsd=-0.5 triggers SL
    const cooldownCfg = {
      ...baseCfg,
      HL_MOMENTUM_POST_TP_COOLDOWN_SEC: 1800,
    };

    const makeLedgerPos = (symbol: string, sourcedFrom = 'hl-momentum') => ({
      marketId: symbol,
      symbol,
      direction: 'LONG' as const,
      isFutures: true,
      question: `${symbol} perpetual`,
      entryPrice: 1,
      stakeUsd: 10,
      edgeMagnitude: 0,
      sourcedFrom,
      openedAt: new Date().toISOString(),
      executionVenue: 'hyperliquid' as const,
    });

    const makeTpPos = (symbol: string) => ({
      symbol,
      position: { szi: '100', entryPx: '1', unrealizedPnl: '1.2', marginUsed: '10' },
    });

    const makeSlPos = (symbol: string) => ({
      symbol,
      position: { szi: '100', entryPx: '1', unrealizedPnl: '-0.5', marginUsed: '10' },
    });

    it('sets per-side momentum cooldown after hl-momentum TP exit', async () => {
      loadConfigMock.mockReturnValue(cooldownCfg);
      mockGetOpenPositions.mockResolvedValue([makeTpPos('TAO')]);
      mockGetLedgerPositions.mockResolvedValue([makeLedgerPos('TAO')]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('TAO');
      expect(mockRedis.set).toHaveBeenCalledWith(
        'futures:momentum:cooldown:TAO:LONG',
        '1',
        'EX',
        1800,
      );
    });

    it('does NOT set momentum cooldown after hl-momentum SL exit (loss-cooldown covers it)', async () => {
      loadConfigMock.mockReturnValue(cooldownCfg);
      mockGetOpenPositions.mockResolvedValue([makeSlPos('TAO')]);
      mockGetLedgerPositions.mockResolvedValue([makeLedgerPos('TAO')]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('TAO');
      expect(mockRedis.set).not.toHaveBeenCalledWith(
        'futures:momentum:cooldown:TAO:LONG',
        '1',
        'EX',
        expect.any(Number),
      );
    });

    it('does NOT set momentum cooldown when sourcedFrom is not hl-momentum', async () => {
      loadConfigMock.mockReturnValue(cooldownCfg);
      mockGetOpenPositions.mockResolvedValue([makeTpPos('TAO')]);
      mockGetLedgerPositions.mockResolvedValue([makeLedgerPos('TAO', 'crypto-arb')]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('TAO');
      expect(mockRedis.set).not.toHaveBeenCalledWith(
        'futures:momentum:cooldown:TAO:LONG',
        '1',
        'EX',
        expect.any(Number),
      );
    });

    it('does NOT set momentum cooldown after hl-momentum loss exit via signal_reeval (pnlUsd < 0)', async () => {
      // TA-reversal exit on a losing hl-momentum position. tpReason='signal_reeval'
      // (not 'futures_sl'), but pnlUsd=-0.3 → the pnlUsd >= 0 guard prevents the
      // cooldown from being set. Loss-cooldown handles re-entry blocking for losses.
      // unrealizedPnl=-0.3 → roePct=-3% (above -5% HL momentum SL, TA reversal fires first)
      loadConfigMock.mockReturnValue({
        ...cooldownCfg,
        FUTURES_EXIT_ON_SIGNAL_FADE: true,
        FUTURES_REEVAL_INTERVAL_S: 0,
        FUTURES_REEVAL_MIN_AGE_S: 0,
      });
      // Use a distinct symbol to avoid lastRevalCheck Map collision with other tests
      mockGetOpenPositions.mockResolvedValue([
        { symbol: 'APT', position: { szi: '100', entryPx: '1', unrealizedPnl: '-0.3', marginUsed: '10' } },
      ]);
      mockGetLedgerPositions.mockResolvedValue([makeLedgerPos('APT')]);
      mockScoreConfluence.mockResolvedValue({ direction: 'DOWN', score: 5, signals: {} });

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('APT');
      expect(mockRedis.set).not.toHaveBeenCalledWith(
        'futures:momentum:cooldown:APT:LONG',
        '1',
        'EX',
        expect.any(Number),
      );
    });

    it('sets momentum cooldown after hl-momentum profitable max-hold exit', async () => {
      // tpReason='futures_max_hold', pnlUsd=0.5 (profitable) → cooldown should be set.
      // roePct=5% is above 0 but below HL_MOMENTUM_TAKE_PROFIT_PCT=12, so TP doesn't
      // fire first — max-hold fires after 25h exceeds FUTURES_MAX_HOLD_HOURS=24.
      // Distinct symbol 'LINK' avoids lastRevalCheck Map collision with other tests.
      const longAgo = () => new Date(Date.now() - 25 * 3600 * 1000).toISOString();
      loadConfigMock.mockReturnValue(cooldownCfg);
      mockGetOpenPositions.mockResolvedValue([
        { symbol: 'LINK', position: { szi: '100', entryPx: '1', unrealizedPnl: '0.5', marginUsed: '10' } },
      ]);
      mockGetLedgerPositions.mockResolvedValue([{ ...makeLedgerPos('LINK'), openedAt: longAgo() }]);

      await runTick();

      expect(mockClosePosition).toHaveBeenCalledWith('LINK');
      expect(mockRedis.set).toHaveBeenCalledWith(
        'futures:momentum:cooldown:LINK:LONG',
        '1',
        'EX',
        1800,
      );
    });
  });
});
