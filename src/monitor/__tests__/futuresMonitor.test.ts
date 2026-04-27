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
  });
});
