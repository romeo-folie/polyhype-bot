import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scanHlMomentum, momentumCooldownKey } from '../hlMomentumScanner.js';
import type { BinancePriceTick } from '../hlMomentumScanner.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../db/writeQueue.js', () => ({ enqueueWrite: vi.fn().mockResolvedValue(undefined) }));

// Default config — most tests override HL_MOMENTUM_ENABLED / other fields.
const baseConfig = {
  HL_MOMENTUM_ENABLED: false,
  HL_MOMENTUM_SYMBOLS: 'btcusdt,ethusdt,solusdt,xrpusdt,dogeusdt,pepeusdt,wifusdt,bonkusdt,penguusdt',
  HL_MOMENTUM_MIN_SCORE: 4,
  HL_MOMENTUM_MIN_ADX: 20,
  HL_MOMENTUM_COOLDOWN_SEC: 600,
  HL_MOMENTUM_MIN_SKIP_COOLDOWN_SEC: 60,
  HL_MOMENTUM_PRIMARY_LOOKBACK_MS: 54_000_000,
  HL_MOMENTUM_1H_LOOKBACK_MS: 180_000_000,
  HL_MOMENTUM_4H_LOOKBACK_MS: 864_000_000,
  HL_MOMENTUM_MTF_4H_GATE_ENABLED: false,
  HL_MOMENTUM_MTF_1H_GATE_ENABLED: false,
  HL_MOMENTUM_4H_EMA_FAST: 20,
  HL_MOMENTUM_4H_EMA_SLOW: 50,
  HL_MOMENTUM_STAKE_USD: 10,
  FUTURES_MAX_PER_TRADE_USD: 15,
};

const mockLoadConfig = vi.fn(() => ({ ...baseConfig }));
vi.mock('../../shared/config.js', () => ({ loadConfig: () => mockLoadConfig() }));

// Candles — mocked to return a full set by default (all 6 voters active).
const mockBuildCandles = vi.fn();
vi.mock('../../arb/candleAggregator.js', () => ({ buildCandles: (...args: unknown[]) => mockBuildCandles(...args) }));

// scoreHlTrend — controlled per test.
const mockScoreHlTrend = vi.fn();
vi.mock('../hlTrendScorer.js', () => ({ scoreHlTrend: (c: unknown) => mockScoreHlTrend(c) }));

// positionLedger — default: no open position.
const mockHasOpenPosition = vi.fn().mockResolvedValue(false);
vi.mock('../../execution/positionLedger.js', () => ({
  hasOpenPosition: (...args: unknown[]) => mockHasOpenPosition(...args),
}));

// indicators — controlled per test for MTF gates.
const mockComputeEMA = vi.fn();
const mockComputeMACDFromCandles = vi.fn();
vi.mock('../../arb/indicators.js', () => ({
  computeEMA: (...args: unknown[]) => mockComputeEMA(...args),
  computeMACDFromCandles: (...args: unknown[]) => mockComputeMACDFromCandles(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTick(symbol = 'btcusdt', price = 70_000): BinancePriceTick {
  return { symbol, price, ts: Date.now() };
}

function makeRedis(overrides: Record<string, string | null> = {}): {
  get: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn((key: string) => Promise.resolve(overrides[key] ?? null)),
  };
}

// Full 6-voter bullish result.
const bullishResult = {
  score: 5,
  adx: 35,
  voters: {
    vwap: 'UP', emaFastVsSlow: 'UP', macdLine: 'UP',
    obv: 'UP', cmf: 'UP', adxDI: 'neutral',
  },
};

// Full 6-voter bearish result.
const bearishResult = {
  score: -5,
  adx: 30,
  voters: {
    vwap: 'DOWN', emaFastVsSlow: 'DOWN', macdLine: 'DOWN',
    obv: 'DOWN', cmf: 'DOWN', adxDI: 'neutral',
  },
};

// ---------------------------------------------------------------------------
// Symbol filtering
// ---------------------------------------------------------------------------

describe('scanHlMomentum — symbol filtering', () => {
  beforeEach(() => {
    mockBuildCandles.mockResolvedValue([]);
    mockScoreHlTrend.mockReturnValue(null);
  });

  it('returns null for a symbol not in the configured watch list', async () => {
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick('hypeusdt'), redis as never);
    expect(result).toBeNull();
  });

  it('returns null for a Binance symbol with no HL perp mapping', async () => {
    mockLoadConfig.mockReturnValueOnce({ ...baseConfig, HL_MOMENTUM_SYMBOLS: 'adausdt' });
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick('adausdt'), redis as never);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Insufficient / neutral candle data
// ---------------------------------------------------------------------------

describe('scanHlMomentum — candle data gates', () => {
  it('returns null when scoreHlTrend returns null (< 2 candles)', async () => {
    mockBuildCandles.mockResolvedValue([]);
    mockScoreHlTrend.mockReturnValue(null);
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).toBeNull();
  });

  it('returns null when score is 0 (balanced voters)', async () => {
    mockBuildCandles.mockResolvedValue([{}]);
    mockScoreHlTrend.mockReturnValue({ score: 0, adx: 40, voters: {} });
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).toBeNull();
  });

  it('returns null when |score| is below HL_MOMENTUM_MIN_SCORE', async () => {
    mockBuildCandles.mockResolvedValue([{}]);
    mockScoreHlTrend.mockReturnValue({ score: 2, adx: 40, voters: {} });
    const redis = makeRedis(); // min=4
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).toBeNull();
  });

  it('returns null when ADX is null', async () => {
    mockBuildCandles.mockResolvedValue([{}]);
    mockScoreHlTrend.mockReturnValue({ score: 5, adx: null, voters: {} });
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).toBeNull();
  });

  it('returns null when ADX is below HL_MOMENTUM_MIN_ADX', async () => {
    mockBuildCandles.mockResolvedValue([{}]);
    mockScoreHlTrend.mockReturnValue({ score: 5, adx: 10, voters: {} });
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).toBeNull();
  });

  it('passes the 15m timeframe to buildCandles for primary scoring', async () => {
    mockBuildCandles.mockResolvedValue([]);
    mockScoreHlTrend.mockReturnValue(null);
    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);
    // First buildCandles call should request 15m (primary scorer)
    expect(mockBuildCandles).toHaveBeenCalledWith(
      expect.any(String),
      redis,
      expect.objectContaining({ timeframe: '15m' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 4h bias gate
// ---------------------------------------------------------------------------

describe('scanHlMomentum — 4h bias gate', () => {
  beforeEach(() => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_MOMENTUM_MTF_4H_GATE_ENABLED: true,
      HL_MOMENTUM_MTF_1H_GATE_ENABLED: false,
    });
    // Primary 15m call → bullish
    mockBuildCandles.mockResolvedValue([{}]);
    mockScoreHlTrend.mockReturnValue(bullishResult);
    mockComputeMACDFromCandles.mockReturnValue(null);
  });

  it('blocks a LONG signal when 4h EMA_FAST < EMA_SLOW (bearish macro)', async () => {
    // EMA20=90, EMA50=100 → bearish bias → should block LONG
    mockComputeEMA
      .mockReturnValueOnce([90])   // EMA_FAST
      .mockReturnValueOnce([100]); // EMA_SLOW
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).toBeNull();
  });

  it('blocks a SHORT signal when 4h EMA_FAST > EMA_SLOW (bullish macro)', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_MOMENTUM_MTF_4H_GATE_ENABLED: true,
      HL_MOMENTUM_MTF_1H_GATE_ENABLED: false,
    });
    mockScoreHlTrend.mockReturnValue(bearishResult);
    // EMA20=110, EMA50=100 → bullish bias → should block SHORT
    mockComputeEMA
      .mockReturnValueOnce([110])  // EMA_FAST
      .mockReturnValueOnce([100]); // EMA_SLOW
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).toBeNull();
  });

  it('allows a LONG signal when 4h EMA_FAST > EMA_SLOW (bullish macro)', async () => {
    mockHasOpenPosition.mockResolvedValue(false);
    // EMA20=110, EMA50=100 → bullish → allows LONG (dark mode → null but not from bias)
    mockComputeEMA
      .mockReturnValueOnce([110])  // EMA_FAST
      .mockReturnValueOnce([100]); // EMA_SLOW
    const redis = makeRedis();
    // HL_MOMENTUM_ENABLED=false → dark mode, but gates passed
    const result = await scanHlMomentum(makeTick(), redis as never);
    // Dark mode returns null, but no bias mismatch log — verify by checking that
    // the 4h gate did NOT block (if it had, we'd never reach the shadow-log path).
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ kind: 'hl_momentum_signal' }),
    );
    expect(result).toBeNull(); // dark mode
  });

  it('skips the gate (passes through) when 4h candles insufficient for EMA', async () => {
    // computeEMA returns null when insufficient data — gate should not block
    mockComputeEMA.mockReturnValue(null);
    mockHasOpenPosition.mockResolvedValue(false);
    const redis = makeRedis();
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    await scanHlMomentum(makeTick(), redis as never);
    // Shadow-log reached (gate did not block)
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ kind: 'hl_momentum_signal' }),
    );
  });

  it('does not call computeEMA when HL_MOMENTUM_MTF_4H_GATE_ENABLED=false', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_MOMENTUM_MTF_4H_GATE_ENABLED: false,
      HL_MOMENTUM_MTF_1H_GATE_ENABLED: false,
    });
    mockComputeEMA.mockClear();
    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);
    expect(mockComputeEMA).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 1h MACD gate
// ---------------------------------------------------------------------------

describe('scanHlMomentum — 1h MACD gate', () => {
  beforeEach(() => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_MOMENTUM_MTF_4H_GATE_ENABLED: false,
      HL_MOMENTUM_MTF_1H_GATE_ENABLED: true,
    });
    mockBuildCandles.mockResolvedValue([{}]);
    mockScoreHlTrend.mockReturnValue(bullishResult);
    mockComputeEMA.mockReturnValue(null);
  });

  it('blocks a LONG signal when 1h MACD line < signal line', async () => {
    // macdLine=−0.5, signalLine=0.3 → bearish momentum → blocks LONG
    mockComputeMACDFromCandles.mockReturnValue({ macdLine: -0.5, signalLine: 0.3, histogram: -0.8 });
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).toBeNull();
  });

  it('blocks a SHORT signal when 1h MACD line > signal line', async () => {
    mockScoreHlTrend.mockReturnValue(bearishResult);
    // macdLine=0.5, signalLine=0.2 → bullish momentum → blocks SHORT
    mockComputeMACDFromCandles.mockReturnValue({ macdLine: 0.5, signalLine: 0.2, histogram: 0.3 });
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).toBeNull();
  });

  it('allows a LONG signal when 1h MACD line > signal line', async () => {
    mockHasOpenPosition.mockResolvedValue(false);
    // macdLine=0.5, signalLine=0.2 → bullish → allows LONG (dark mode)
    mockComputeMACDFromCandles.mockReturnValue({ macdLine: 0.5, signalLine: 0.2, histogram: 0.3 });
    const redis = makeRedis();
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    await scanHlMomentum(makeTick(), redis as never);
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ kind: 'hl_momentum_signal' }),
    );
  });

  it('skips the gate when 1h MACD returns null (insufficient data)', async () => {
    mockComputeMACDFromCandles.mockReturnValue(null);
    mockHasOpenPosition.mockResolvedValue(false);
    const redis = makeRedis();
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    await scanHlMomentum(makeTick(), redis as never);
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ kind: 'hl_momentum_signal' }),
    );
  });

  it('does not call computeMACDFromCandles when HL_MOMENTUM_MTF_1H_GATE_ENABLED=false', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_MOMENTUM_MTF_4H_GATE_ENABLED: false,
      HL_MOMENTUM_MTF_1H_GATE_ENABLED: false,
    });
    mockComputeMACDFromCandles.mockClear();
    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);
    expect(mockComputeMACDFromCandles).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cooldown + position gates
// ---------------------------------------------------------------------------

describe('scanHlMomentum — cooldown and position gates', () => {
  beforeEach(() => {
    mockBuildCandles.mockResolvedValue([{}]);
    mockScoreHlTrend.mockReturnValue(bullishResult);
    mockComputeEMA.mockReturnValue(null);
    mockComputeMACDFromCandles.mockReturnValue(null);
  });

  it('returns null when loss cooldown is active', async () => {
    const redis = makeRedis({ 'futures:loss-cooldown:BTC': '1' });
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).toBeNull();
  });

  it('returns null when per-side momentum cooldown is active', async () => {
    const key = momentumCooldownKey('BTC', 'LONG');
    const redis = makeRedis({ [key]: '1' });
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).toBeNull();
  });

  it('returns null when a LONG position is already open (same side)', async () => {
    mockHasOpenPosition.mockResolvedValueOnce(true);
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).toBeNull();
  });

  it('returns null when a SHORT position is already open (opposite side of LONG signal)', async () => {
    mockScoreHlTrend.mockReturnValue(bullishResult); // score > 0 → LONG
    mockHasOpenPosition
      .mockResolvedValueOnce(false) // LONG side — none open
      .mockResolvedValueOnce(true); // SHORT side — existing position
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).toBeNull();
  });

  it('does NOT block when SHORT cooldown is set but signal is LONG (side-aware)', async () => {
    const shortKey = momentumCooldownKey('BTC', 'SHORT');
    const redis = makeRedis({ [shortKey]: '1' });
    // Dark mode returns null, but gates all passed.
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).toBeNull();
    const getCalls = redis.get.mock.calls.map(
      (c: unknown[]) => String(c[0]),
    );
    expect(getCalls).toContain('futures:momentum:cooldown:BTC:LONG');
    expect(getCalls).not.toContain('futures:momentum:cooldown:BTC:SHORT');
  });
});

// ---------------------------------------------------------------------------
// Dark mode (HL_MOMENTUM_ENABLED=false)
// ---------------------------------------------------------------------------

describe('scanHlMomentum — dark mode', () => {
  beforeEach(() => {
    mockBuildCandles.mockResolvedValue([{}]);
    mockScoreHlTrend.mockReturnValue(bullishResult);
    mockHasOpenPosition.mockResolvedValue(false);
    mockComputeEMA.mockReturnValue(null);
    mockComputeMACDFromCandles.mockReturnValue(null);
  });

  it('returns null in dark mode even when all gates pass', async () => {
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).toBeNull();
  });

  it('shadow-logs a row with wouldBlock=true in dark mode', async () => {
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ kind: 'hl_momentum_signal', wouldBlock: true }),
    );
  });

  it('shadow payload includes primaryTimeframe=15m', async () => {
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        payload: expect.objectContaining({ primaryTimeframe: '15m' }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Live mode signal shape
// ---------------------------------------------------------------------------

describe('scanHlMomentum — live mode', () => {
  beforeEach(() => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_MOMENTUM_ENABLED: true,
      HL_MOMENTUM_MTF_4H_GATE_ENABLED: false,
      HL_MOMENTUM_MTF_1H_GATE_ENABLED: false,
    });
    mockBuildCandles.mockResolvedValue([{}]);
    mockHasOpenPosition.mockResolvedValue(false);
    mockComputeEMA.mockReturnValue(null);
    mockComputeMACDFromCandles.mockReturnValue(null);
  });

  it('returns a LONG signal for a bullish score when live', async () => {
    mockScoreHlTrend.mockReturnValue(bullishResult);
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG');
    expect(result!.isFutures).toBe(true);
    expect(result!.source).toBe('hl-momentum');
    expect(result!.marketId).toBe('BTC');
  });

  it('returns a SHORT signal for a bearish score when live', async () => {
    mockScoreHlTrend.mockReturnValue(bearishResult);
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('SHORT');
    expect(result!.marketId).toBe('BTC');
  });

  it('caps stakeUsd to FUTURES_MAX_PER_TRADE_USD', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_MOMENTUM_ENABLED: true,
      HL_MOMENTUM_MTF_4H_GATE_ENABLED: false,
      HL_MOMENTUM_MTF_1H_GATE_ENABLED: false,
      HL_MOMENTUM_STAKE_USD: 50,
      FUTURES_MAX_PER_TRADE_USD: 15,
    });
    mockScoreHlTrend.mockReturnValue(bullishResult);
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result!.stakeUsd).toBe(15);
  });

  it('shadow-logs a row with wouldBlock=false in live mode', async () => {
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    mockScoreHlTrend.mockReturnValue(bullishResult);
    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ kind: 'hl_momentum_signal', wouldBlock: false }),
    );
  });

  it('edgeMagnitude is absScore/6', async () => {
    mockScoreHlTrend.mockReturnValue(bullishResult); // score=5
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result!.edgeMagnitude).toBeCloseTo(5 / 6, 5);
  });

  it('ETH tick maps to ETH marketId', async () => {
    mockScoreHlTrend.mockReturnValue(bullishResult);
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick('ethusdt', 3000), redis as never);
    expect(result!.marketId).toBe('ETH');
  });

  it('reasoning mentions 15m timeframe', async () => {
    mockScoreHlTrend.mockReturnValue(bullishResult);
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result!.reasoning).toContain('15m');
  });
});

// ---------------------------------------------------------------------------
// momentumCooldownKey helper
// ---------------------------------------------------------------------------

describe('momentumCooldownKey', () => {
  it('encodes symbol and direction', () => {
    expect(momentumCooldownKey('BTC', 'LONG')).toBe('futures:momentum:cooldown:BTC:LONG');
    expect(momentumCooldownKey('ETH', 'SHORT')).toBe('futures:momentum:cooldown:ETH:SHORT');
  });
});
