import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scanHlMomentum, momentumCooldownKey, isMemeSymbol } from '../hlMomentumScanner.js';
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
  HL_MOMENTUM_LONG_REQUIRE_HL_CONFIRMATION: false,
  HL_MOMENTUM_MTF_SCORING_MODE: 'hard' as 'hard' | 'weighted',
  HL_MOMENTUM_4H_NEUTRAL_BAND_PCT: 0.5,
  HL_MOMENTUM_MIN_TOTAL_SCORE: 5,
  HL_FUNDING_CONTRA_ENABLED: false,
  HL_FUNDING_CONTRA_APR_THRESHOLD: 100,
  HL_FUNDING_CONTRA_CACHE_TTL_SEC: 60,
  HL_OI_DIVERGENCE_ENABLED: false,
  HL_OI_DIVERGENCE_THRESHOLD_PCT: 5,
  HL_OI_BASELINE_TTL_SEC: 900,
};

const mockLoadConfig = vi.fn(() => ({ ...baseConfig }));
vi.mock('../../shared/config.js', () => ({ loadConfig: () => mockLoadConfig() }));

// Candles — mocked to return a full set by default (all 6 voters active).
const mockBuildCandles = vi.fn();
vi.mock('../../arb/candleAggregator.js', () => ({ buildCandles: (...args: unknown[]) => mockBuildCandles(...args) }));

// scoreHlTrend — controlled per test.
const mockScoreHlTrend = vi.fn();
vi.mock('../hlTrendScorer.js', () => ({
  scoreHlTrend: (c: unknown, opts?: unknown) => mockScoreHlTrend(c, opts),
}));

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

// HL asset-ctx cache — controlled per test for both HL-native voters.
const mockGetCachedAssetCtx = vi.fn();
const mockGetOrSetOiBaseline = vi.fn();
vi.mock('../hlAssetCtxCache.js', async () => {
  const actual = await vi.importActual('../hlAssetCtxCache.js');
  return {
    ...(actual as Record<string, unknown>),
    getCachedAssetCtx: (...args: unknown[]) => mockGetCachedAssetCtx(...args),
    getOrSetOiBaseline: (...args: unknown[]) => mockGetOrSetOiBaseline(...args),
  };
});

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
  voterCount: 6,
};

// Full 6-voter bearish result.
const bearishResult = {
  score: -5,
  adx: 30,
  voters: {
    vwap: 'DOWN', emaFastVsSlow: 'DOWN', macdLine: 'DOWN',
    obv: 'DOWN', cmf: 'DOWN', adxDI: 'neutral',
  },
  voterCount: 6,
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

describe('scanHlMomentum — long HL confirmation gate', () => {
  beforeEach(() => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_MOMENTUM_ENABLED: true,
      HL_MOMENTUM_LONG_REQUIRE_HL_CONFIRMATION: true,
      HL_FUNDING_CONTRA_ENABLED: true,
      HL_OI_DIVERGENCE_ENABLED: true,
    });
    mockBuildCandles.mockResolvedValue([{}]);
    mockHasOpenPosition.mockResolvedValue(false);
    mockComputeEMA.mockReturnValue(null);
    mockComputeMACDFromCandles.mockReturnValue(null);
  });

  it('blocks a LONG when present HL-native votes are neutral', async () => {
    mockScoreHlTrend.mockReturnValue({
      ...bullishResult,
      voters: {
        ...bullishResult.voters,
        fundingContra: 'neutral',
        oiDivergence: 'neutral',
      },
      voterCount: 8,
    });
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).toBeNull();
  });

  it('allows a LONG when OI divergence actively confirms UP', async () => {
    mockScoreHlTrend.mockReturnValue({
      ...bullishResult,
      voters: {
        ...bullishResult.voters,
        fundingContra: 'neutral',
        oiDivergence: 'UP',
      },
      voterCount: 8,
    });
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG');
  });

  it('does not apply the confirmation gate to SHORT signals', async () => {
    mockScoreHlTrend.mockReturnValue({
      ...bearishResult,
      voters: {
        ...bearishResult.voters,
        fundingContra: 'neutral',
        oiDivergence: 'neutral',
      },
      voterCount: 8,
    });
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('SHORT');
  });
});

// ---------------------------------------------------------------------------
// Dark mode (HL_MOMENTUM_ENABLED=false)
// ---------------------------------------------------------------------------

describe('scanHlMomentum — dark mode', () => {
  beforeEach(() => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_MOMENTUM_ENABLED: false,
      HL_MOMENTUM_LONG_REQUIRE_HL_CONFIRMATION: false,
    });
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
// Weighted MTF scoring mode
// ---------------------------------------------------------------------------

describe('scanHlMomentum — weighted MTF scoring', () => {
  const weightedConfig = {
    ...baseConfig,
    HL_MOMENTUM_MTF_SCORING_MODE: 'weighted' as const,
    // Gate flags become no-ops in weighted mode but set them on to mirror prod.
    HL_MOMENTUM_MTF_4H_GATE_ENABLED: true,
    HL_MOMENTUM_MTF_1H_GATE_ENABLED: true,
    HL_MOMENTUM_MIN_TOTAL_SCORE: 5,
    HL_MOMENTUM_4H_NEUTRAL_BAND_PCT: 0.5,
  };

  function bullishResultWithScore(score: number) {
    return {
      score,
      adx: 35,
      voters: {
        vwap: 'UP', emaFastVsSlow: 'UP', macdLine: 'UP',
        obv: 'UP', cmf: 'UP', adxDI: 'neutral',
      },
      voterCount: 6,
    };
  }

  beforeEach(() => {
    mockLoadConfig.mockReturnValue({ ...weightedConfig });
    mockBuildCandles.mockResolvedValue([{ close: 100 }]);
    mockHasOpenPosition.mockResolvedValue(false);
  });

  it('passes when score=3 + 4h aligned (+2) + 1h aligned (+1) = 6 ≥ 5', async () => {
    mockScoreHlTrend.mockReturnValue(bullishResultWithScore(3));
    // 4h fast > slow, spread 10% > 0.5% band → +2 (LONG)
    mockComputeEMA
      .mockReturnValueOnce([110])
      .mockReturnValueOnce([100]);
    // 1h MACD aligned (LONG: macdLine > signalLine) → +1
    mockComputeMACDFromCandles.mockReturnValue({ macdLine: 0.5, signalLine: 0.2, histogram: 0.3 });

    const { enqueueWrite } = await import('../../db/writeQueue.js');
    vi.mocked(enqueueWrite).mockClear();

    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);

    expect(result).toBeNull(); // dark mode
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        kind: 'hl_momentum_signal',
        wouldBlock: true,
        metricValue: 6,
        payload: expect.objectContaining({
          scoringMode: 'weighted',
          mtfBonus: 3,
          totalScore: 6,
          fourHBiasOk: true,
          oneHMacdOk: true,
        }),
      }),
    );
  });

  it('passes at threshold when score=4 + 4h neutral (0) + 1h aligned (+1) = 5', async () => {
    mockScoreHlTrend.mockReturnValue(bullishResultWithScore(4));
    // 4h spread 0.2% < 0.5% band → 0 (neutral)
    mockComputeEMA
      .mockReturnValueOnce([100.2])
      .mockReturnValueOnce([100]);
    mockComputeMACDFromCandles.mockReturnValue({ macdLine: 0.5, signalLine: 0.2, histogram: 0.3 });

    const { enqueueWrite } = await import('../../db/writeQueue.js');
    vi.mocked(enqueueWrite).mockClear();

    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        payload: expect.objectContaining({ mtfBonus: 1, totalScore: 5 }),
      }),
    );
  });

  it('blocks when score=4 + 4h opposed (-2) + 1h aligned (+1) = 3 < 5', async () => {
    mockScoreHlTrend.mockReturnValue(bullishResultWithScore(4));
    // 4h fast < slow, spread 10% > band → -2 (LONG against bearish 4h)
    mockComputeEMA
      .mockReturnValueOnce([90])
      .mockReturnValueOnce([100]);
    mockComputeMACDFromCandles.mockReturnValue({ macdLine: 0.5, signalLine: 0.2, histogram: 0.3 });

    const { enqueueWrite } = await import('../../db/writeQueue.js');
    vi.mocked(enqueueWrite).mockClear();

    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);

    expect(result).toBeNull();
    // Blocked before shadow log (matches existing MIN_SCORE/ADX/hard-MTF pattern).
    expect(enqueueWrite).not.toHaveBeenCalled();
  });

  it('blocks when score=4 + 4h null + 1h null = 4 (no MTF data) < 5', async () => {
    mockScoreHlTrend.mockReturnValue(bullishResultWithScore(4));
    mockComputeEMA.mockReturnValue(null);              // insufficient 4h data
    mockComputeMACDFromCandles.mockReturnValue(null);  // insufficient 1h data

    const { enqueueWrite } = await import('../../db/writeQueue.js');
    vi.mocked(enqueueWrite).mockClear();

    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);

    expect(result).toBeNull();
    expect(enqueueWrite).not.toHaveBeenCalled();
  });

  it('passes when score=5 + neutral (0) + neutral (0) = 5 (strong 15m alone)', async () => {
    mockScoreHlTrend.mockReturnValue(bullishResultWithScore(5));
    mockComputeEMA
      .mockReturnValueOnce([100.1])  // 0.1% spread → neutral
      .mockReturnValueOnce([100]);
    // 1h MACD opposed → 0 (no penalty)
    mockComputeMACDFromCandles.mockReturnValue({ macdLine: -0.1, signalLine: 0.1, histogram: -0.2 });

    const { enqueueWrite } = await import('../../db/writeQueue.js');
    vi.mocked(enqueueWrite).mockClear();

    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        payload: expect.objectContaining({ mtfBonus: 0, totalScore: 5 }),
      }),
    );
  });

  it('treats spread just inside the neutral band as neutral (0 pts), not aligned', async () => {
    mockScoreHlTrend.mockReturnValue(bullishResultWithScore(4));
    // Boundary is strict (`absSpread < neutralBand`): 0.5% is NOT neutral (would be +2).
    // Use 0.499% — just inside the band — to verify the strict-boundary neutral case.
    mockComputeEMA
      .mockReturnValueOnce([100.499])
      .mockReturnValueOnce([100]);
    mockComputeMACDFromCandles.mockReturnValue({ macdLine: 0.5, signalLine: 0.2, histogram: 0.3 });

    const { enqueueWrite } = await import('../../db/writeQueue.js');
    vi.mocked(enqueueWrite).mockClear();

    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        payload: expect.objectContaining({ mtfBonus: 1 }), // 0 + 1 = 1 (4h neutral, 1h aligned)
      }),
    );
  });

  it('does NOT apply MIN_SCORE veto in weighted mode (allows score=2 to reach total gate)', async () => {
    mockScoreHlTrend.mockReturnValue(bullishResultWithScore(2));
    mockComputeEMA
      .mockReturnValueOnce([110])
      .mockReturnValueOnce([100]); // +2
    mockComputeMACDFromCandles.mockReturnValue({ macdLine: 0.5, signalLine: 0.2, histogram: 0.3 }); // +1

    const { enqueueWrite } = await import('../../db/writeQueue.js');
    vi.mocked(enqueueWrite).mockClear();

    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);

    // Total = 2 + 2 + 1 = 5 → passes MIN_TOTAL_SCORE gate, shadow logs
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        payload: expect.objectContaining({ totalScore: 5 }),
      }),
    );
  });

  it('returns a live signal in weighted mode with edgeMagnitude = totalScore / 9', async () => {
    mockLoadConfig.mockReturnValue({ ...weightedConfig, HL_MOMENTUM_ENABLED: true });
    mockScoreHlTrend.mockReturnValue(bullishResultWithScore(4));
    mockComputeEMA
      .mockReturnValueOnce([110])
      .mockReturnValueOnce([100]); // +2
    mockComputeMACDFromCandles.mockReturnValue({ macdLine: 0.5, signalLine: 0.2, histogram: 0.3 }); // +1

    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG');
    // totalScore = 4 + 2 + 1 = 7; edgeMagnitude = 7/9
    expect(result!.edgeMagnitude).toBeCloseTo(7 / 9, 5);
    expect(result!.reasoning).toContain('totalScore=7');
    expect(result!.reasoning).toContain('mtfBonus=3');
  });

  it('emits shadow signal (weighted dark) marker in dark mode', async () => {
    const { logger } = await import('../../shared/logger.js');
    vi.mocked(logger.info).mockClear();
    mockScoreHlTrend.mockReturnValue(bullishResultWithScore(5));
    mockComputeEMA
      .mockReturnValueOnce([110])
      .mockReturnValueOnce([100]);
    mockComputeMACDFromCandles.mockReturnValue({ macdLine: 0.5, signalLine: 0.2, histogram: 0.3 });

    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);

    expect(logger.info).toHaveBeenCalledWith(
      '[hl-momentum] shadow signal (weighted dark)',
      expect.objectContaining({
        symbol: 'BTC',
        direction: 'LONG',
        mtfBonus: 3,
        totalScore: 8,
      }),
    );
  });

  it('SHORT signal: 4h aligned means fast < slow', async () => {
    mockScoreHlTrend.mockReturnValue({
      score: -4,
      adx: 35,
      voters: {
        vwap: 'DOWN', emaFastVsSlow: 'DOWN', macdLine: 'DOWN',
        obv: 'DOWN', cmf: 'DOWN', adxDI: 'neutral',
      },
      voterCount: 6,
    });
    // 4h fast < slow, spread 10% (negative) → for SHORT, this is aligned → +2
    mockComputeEMA
      .mockReturnValueOnce([90])
      .mockReturnValueOnce([100]);
    // 1h MACD: macdLine < signalLine → SHORT aligned → +1
    mockComputeMACDFromCandles.mockReturnValue({ macdLine: -0.5, signalLine: -0.2, histogram: -0.3 });

    const { enqueueWrite } = await import('../../db/writeQueue.js');
    vi.mocked(enqueueWrite).mockClear();

    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        direction: 'SHORT',
        payload: expect.objectContaining({ mtfBonus: 3, totalScore: 7 }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Funding-contra voter wiring (issue #265 Sub-PR 1)
// ---------------------------------------------------------------------------

describe('scanHlMomentum — funding contra voter wiring', () => {
  beforeEach(() => {
    mockBuildCandles.mockResolvedValue([{}]);
    mockScoreHlTrend.mockReturnValue(bullishResult);
    mockHasOpenPosition.mockResolvedValue(false);
    mockComputeEMA.mockReturnValue(null);
    mockComputeMACDFromCandles.mockReturnValue(null);
    mockGetCachedAssetCtx.mockReset();
    mockGetOrSetOiBaseline.mockReset();
  });

  it('does not fetch asset ctx when HL_FUNDING_CONTRA_ENABLED=false', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_FUNDING_CONTRA_ENABLED: false,
    });
    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);
    expect(mockGetCachedAssetCtx).not.toHaveBeenCalled();
    // scoreHlTrend still called, but with fundingApr=null.
    expect(mockScoreHlTrend).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ fundingApr: null }),
    );
  });

  it('fetches asset ctx and passes fundingApr to the scorer when enabled', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_FUNDING_CONTRA_ENABLED: true,
      HL_FUNDING_CONTRA_APR_THRESHOLD: 100,
    });
    // hourly 0.0001 → APR = 0.0001 * 8760 * 100 = 87.6%
    mockGetCachedAssetCtx.mockResolvedValue({
      fundingRate: 0.0001, openInterest: 1_000_000, markPrice: 70_000,
    });
    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);
    expect(mockGetCachedAssetCtx).toHaveBeenCalledWith('BTC', redis, 60);
    expect(mockScoreHlTrend).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        fundingApr: expect.closeTo(87.6, 1) as unknown as number,
        fundingAprThreshold: 100,
      }),
    );
  });

  it('passes fundingApr=null when the HL fetch fails (voter absent, signal continues)', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_FUNDING_CONTRA_ENABLED: true,
    });
    mockGetCachedAssetCtx.mockResolvedValue(null);
    const redis = makeRedis();
    // Should still reach shadow log (other voters carry the signal).
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    vi.mocked(enqueueWrite).mockClear();
    await scanHlMomentum(makeTick(), redis as never);
    expect(mockScoreHlTrend).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ fundingApr: null }),
    );
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ kind: 'hl_momentum_signal' }),
    );
  });

  it('includes fundingApr and fundingContraVote in the shadow payload', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_FUNDING_CONTRA_ENABLED: true,
    });
    mockGetCachedAssetCtx.mockResolvedValue({
      fundingRate: 0.0002, openInterest: 1_000_000, markPrice: 70_000,
    });
    // Score comes back with 7 voters; fundingContra=neutral so the veto gate does not fire.
    // score=6 ensures the MIN_SCORE gate passes regardless of the baseConfig default.
    mockScoreHlTrend.mockReturnValue({
      score: 6,
      adx: 35,
      voters: {
        vwap: 'UP', emaFastVsSlow: 'UP', macdLine: 'UP',
        obv: 'UP', cmf: 'UP', adxDI: 'neutral', fundingContra: 'neutral',
      },
      voterCount: 7,
    });
    const redis = makeRedis();
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    vi.mocked(enqueueWrite).mockClear();
    await scanHlMomentum(makeTick(), redis as never);
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        payload: expect.objectContaining({
          fundingApr: expect.closeTo(175.2, 1) as unknown as number,
          fundingContraVote: 'neutral',
          voterCount: 7,
        }),
      }),
    );
  });

  it('edgeMagnitude uses voterCount (hard mode, 7 voters) → absScore/7', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_MOMENTUM_ENABLED: true,
      HL_FUNDING_CONTRA_ENABLED: true,
    });
    mockGetCachedAssetCtx.mockResolvedValue({
      fundingRate: 0, openInterest: 1_000_000, markPrice: 70_000,
    });
    // 7 voters, score=5 → edgeMagnitude = 5/7
    mockScoreHlTrend.mockReturnValue({
      score: 5,
      adx: 35,
      voters: {
        vwap: 'UP', emaFastVsSlow: 'UP', macdLine: 'UP',
        obv: 'UP', cmf: 'UP', adxDI: 'neutral', fundingContra: 'neutral',
      },
      voterCount: 7,
    });
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).not.toBeNull();
    expect(result!.edgeMagnitude).toBeCloseTo(5 / 7, 5);
  });

  it('shadow payload includes voterCount=6 and fundingContraVote=null when voter disabled', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_FUNDING_CONTRA_ENABLED: false,
    });
    const redis = makeRedis();
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    vi.mocked(enqueueWrite).mockClear();
    await scanHlMomentum(makeTick(), redis as never);
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        payload: expect.objectContaining({
          voterCount: 6,
          fundingContraVote: null,
          fundingApr: null,
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// OI divergence voter wiring (issue #265 Sub-PR 2)
// ---------------------------------------------------------------------------

describe('scanHlMomentum — OI divergence voter wiring', () => {
  beforeEach(() => {
    mockBuildCandles.mockResolvedValue([{}]);
    mockScoreHlTrend.mockReturnValue(bullishResult);
    mockHasOpenPosition.mockResolvedValue(false);
    mockComputeEMA.mockReturnValue(null);
    mockComputeMACDFromCandles.mockReturnValue(null);
    mockGetCachedAssetCtx.mockReset();
    mockGetOrSetOiBaseline.mockReset();
  });

  it('does not fetch asset ctx or baseline when both HL-native voters disabled', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_FUNDING_CONTRA_ENABLED: false,
      HL_OI_DIVERGENCE_ENABLED: false,
    });
    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);
    expect(mockGetCachedAssetCtx).not.toHaveBeenCalled();
    expect(mockGetOrSetOiBaseline).not.toHaveBeenCalled();
  });

  it('fetches ctx once even when both voters are enabled (shared fetch)', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_FUNDING_CONTRA_ENABLED: true,
      HL_OI_DIVERGENCE_ENABLED: true,
    });
    mockGetCachedAssetCtx.mockResolvedValue({
      fundingRate: 0, openInterest: 1_000_000, markPrice: 70_000,
    });
    mockGetOrSetOiBaseline.mockResolvedValue(null); // no baseline this tick
    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);
    expect(mockGetCachedAssetCtx).toHaveBeenCalledTimes(1);
  });

  it('calls getOrSetOiBaseline with current OI + markPrice when enabled', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_OI_DIVERGENCE_ENABLED: true,
      HL_OI_BASELINE_TTL_SEC: 900,
    });
    const ctx = { fundingRate: 0, openInterest: 1_200_000, markPrice: 72_000 };
    mockGetCachedAssetCtx.mockResolvedValue(ctx);
    mockGetOrSetOiBaseline.mockResolvedValue(null);
    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);
    expect(mockGetOrSetOiBaseline).toHaveBeenCalledWith('BTC', redis, 1_200_000, 72_000, 900);
  });

  it('passes oiPctChange + pricePctChange to scorer when baseline available', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_OI_DIVERGENCE_ENABLED: true,
      HL_OI_DIVERGENCE_THRESHOLD_PCT: 5,
    });
    mockGetCachedAssetCtx.mockResolvedValue({
      fundingRate: 0, openInterest: 1_100_000, markPrice: 71_000,
    });
    // Baseline: oi=1_000_000, markPrice=70_000
    mockGetOrSetOiBaseline.mockResolvedValue({
      oi: 1_000_000, markPrice: 70_000, ts: Date.now() - 60_000,
    });
    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);
    // oiPctChange = (1_100_000 - 1_000_000) / 1_000_000 * 100 = 10%
    // pricePctChange = (71_000 - 70_000) / 70_000 * 100 ≈ 1.43%
    expect(mockScoreHlTrend).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        oiPctChange: expect.closeTo(10, 1) as unknown as number,
        pricePctChange: expect.closeTo(1.43, 1) as unknown as number,
        oiDivergenceThreshold: 5,
      }),
    );
  });

  it('passes null OI args when no baseline (voter absent, signal continues)', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_OI_DIVERGENCE_ENABLED: true,
    });
    mockGetCachedAssetCtx.mockResolvedValue({
      fundingRate: 0, openInterest: 1_000_000, markPrice: 70_000,
    });
    mockGetOrSetOiBaseline.mockResolvedValue(null); // first tick, no baseline
    const redis = makeRedis();
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    vi.mocked(enqueueWrite).mockClear();
    await scanHlMomentum(makeTick(), redis as never);
    // Signal still shadow-logs (voter absent = neutral)
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ kind: 'hl_momentum_signal' }),
    );
    expect(mockScoreHlTrend).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ oiPctChange: null, pricePctChange: null }),
    );
  });

  it('shadow payload includes oiPctChange, pricePctChange, oiDivergenceVote', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_OI_DIVERGENCE_ENABLED: true,
    });
    mockGetCachedAssetCtx.mockResolvedValue({
      fundingRate: 0, openInterest: 1_100_000, markPrice: 71_000,
    });
    mockGetOrSetOiBaseline.mockResolvedValue({
      oi: 1_000_000, markPrice: 70_000, ts: Date.now() - 60_000,
    });
    mockScoreHlTrend.mockReturnValue({
      score: 5,
      adx: 35,
      voters: {
        vwap: 'UP', emaFastVsSlow: 'UP', macdLine: 'UP',
        obv: 'UP', cmf: 'UP', adxDI: 'neutral', oiDivergence: 'UP',
      },
      voterCount: 7,
    });
    const redis = makeRedis();
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    vi.mocked(enqueueWrite).mockClear();
    await scanHlMomentum(makeTick(), redis as never);
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        payload: expect.objectContaining({
          oiPctChange: expect.closeTo(10, 1) as unknown as number,
          pricePctChange: expect.closeTo(1.43, 1) as unknown as number,
          oiDivergenceVote: 'UP',
        }),
      }),
    );
  });

  it('does not call getOrSetOiBaseline when ctx fetch fails', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_OI_DIVERGENCE_ENABLED: true,
    });
    mockGetCachedAssetCtx.mockResolvedValue(null); // HL fetch failed
    const redis = makeRedis();
    await scanHlMomentum(makeTick(), redis as never);
    expect(mockGetOrSetOiBaseline).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HL-native voter veto gates
// ---------------------------------------------------------------------------

describe('scanHlMomentum — HL-native voter veto gates', () => {
  beforeEach(() => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_FUNDING_CONTRA_ENABLED: true,
      HL_OI_DIVERGENCE_ENABLED: true,
    });
    mockBuildCandles.mockResolvedValue([{}]);
    mockHasOpenPosition.mockResolvedValue(false);
    mockComputeEMA.mockReturnValue(null);
    mockComputeMACDFromCandles.mockReturnValue(null);
    mockGetCachedAssetCtx.mockResolvedValue({
      fundingRate: 0, openInterest: 1_000_000, markPrice: 70_000,
    });
    mockGetOrSetOiBaseline.mockResolvedValue(null);
  });

  it('blocks a LONG when fundingContra=DOWN (crowded longs — mean-reversion risk)', async () => {
    mockScoreHlTrend.mockReturnValue({
      score: 6, adx: 30,
      voters: { vwap: 'UP', emaFastVsSlow: 'UP', macdLine: 'UP', obv: 'UP', cmf: 'UP', adxDI: 'neutral', fundingContra: 'DOWN' },
      voterCount: 7,
    });
    const result = await scanHlMomentum(makeTick(), makeRedis() as never);
    expect(result).toBeNull();
  });

  it('blocks a SHORT when fundingContra=UP (crowded shorts)', async () => {
    mockScoreHlTrend.mockReturnValue({
      score: -6, adx: 30,
      voters: { vwap: 'DOWN', emaFastVsSlow: 'DOWN', macdLine: 'DOWN', obv: 'DOWN', cmf: 'DOWN', adxDI: 'neutral', fundingContra: 'UP' },
      voterCount: 7,
    });
    const result = await scanHlMomentum(makeTick(), makeRedis() as never);
    expect(result).toBeNull();
  });

  it('allows a LONG when fundingContra=neutral', async () => {
    mockScoreHlTrend.mockReturnValue({
      score: 6, adx: 30,
      voters: { vwap: 'UP', emaFastVsSlow: 'UP', macdLine: 'UP', obv: 'UP', cmf: 'UP', adxDI: 'neutral', fundingContra: 'neutral' },
      voterCount: 7,
    });
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    vi.mocked(enqueueWrite).mockClear();
    await scanHlMomentum(makeTick(), makeRedis() as never);
    expect(enqueueWrite).toHaveBeenCalledWith('shadow_observations', expect.objectContaining({ kind: 'hl_momentum_signal' }));
  });

  it('blocks a LONG when oiDivergence=DOWN (short covering — fake breakout)', async () => {
    mockScoreHlTrend.mockReturnValue({
      score: 6, adx: 30,
      voters: { vwap: 'UP', emaFastVsSlow: 'UP', macdLine: 'UP', obv: 'UP', cmf: 'UP', adxDI: 'neutral', oiDivergence: 'DOWN' },
      voterCount: 7,
    });
    const result = await scanHlMomentum(makeTick(), makeRedis() as never);
    expect(result).toBeNull();
  });

  it('blocks a SHORT when oiDivergence=UP (forced liquidation — fake breakdown)', async () => {
    mockScoreHlTrend.mockReturnValue({
      score: -6, adx: 30,
      voters: { vwap: 'DOWN', emaFastVsSlow: 'DOWN', macdLine: 'DOWN', obv: 'DOWN', cmf: 'DOWN', adxDI: 'neutral', oiDivergence: 'UP' },
      voterCount: 7,
    });
    const result = await scanHlMomentum(makeTick(), makeRedis() as never);
    expect(result).toBeNull();
  });

  it('allows a LONG when oiDivergence=UP (OI expanding with price — real buying)', async () => {
    mockScoreHlTrend.mockReturnValue({
      score: 6, adx: 30,
      voters: { vwap: 'UP', emaFastVsSlow: 'UP', macdLine: 'UP', obv: 'UP', cmf: 'UP', adxDI: 'neutral', oiDivergence: 'UP' },
      voterCount: 7,
    });
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    vi.mocked(enqueueWrite).mockClear();
    await scanHlMomentum(makeTick(), makeRedis() as never);
    expect(enqueueWrite).toHaveBeenCalledWith('shadow_observations', expect.objectContaining({ kind: 'hl_momentum_signal' }));
  });

  it('does not shadow-log when the veto fires (signal never reached shadow write)', async () => {
    mockScoreHlTrend.mockReturnValue({
      score: 6, adx: 30,
      voters: { vwap: 'UP', emaFastVsSlow: 'UP', macdLine: 'UP', obv: 'UP', cmf: 'UP', adxDI: 'neutral', fundingContra: 'DOWN' },
      voterCount: 7,
    });
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    vi.mocked(enqueueWrite).mockClear();
    await scanHlMomentum(makeTick(), makeRedis() as never);
    expect(enqueueWrite).not.toHaveBeenCalled();
  });

  it('is a no-op when both HL-native voters are disabled (voters absent from result)', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_FUNDING_CONTRA_ENABLED: false,
      HL_OI_DIVERGENCE_ENABLED: false,
    });
    mockScoreHlTrend.mockReturnValue(bullishResult); // no HL-native voter keys
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    vi.mocked(enqueueWrite).mockClear();
    await scanHlMomentum(makeTick(), makeRedis() as never);
    expect(enqueueWrite).toHaveBeenCalledWith('shadow_observations', expect.objectContaining({ kind: 'hl_momentum_signal' }));
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

describe('isMemeSymbol', () => {
  const memeList = 'pepeusdt,wifusdt,bonkusdt,penguusdt';

  it('matches Binance lower-case form exactly', () => {
    expect(isMemeSymbol('pepeusdt', memeList)).toBe(true);
    expect(isMemeSymbol('bonkusdt', memeList)).toBe(true);
  });

  it('matches HL 1000× unit tickers (kPEPE, kBONK — the real Hyperliquid form)', () => {
    // Hyperliquid lists PEPE and BONK as 1000× unit perps named `kPEPE` / `kBONK`.
    // The executor receives these tickers from positionLedger / scanner, so this
    // is the production-relevant case — without `k` stripping the meme branch
    // would never trigger live for PEPE/BONK.
    expect(isMemeSymbol('kPEPE', memeList)).toBe(true);
    expect(isMemeSymbol('kBONK', memeList)).toBe(true);
  });

  it('matches HL upper-case base form for non-1000× perps (WIF, PENGU)', () => {
    // WIF and PENGU are listed on HL as plain `WIF` / `PENGU` (no k prefix).
    expect(isMemeSymbol('WIF', memeList)).toBe(true);
    expect(isMemeSymbol('PENGU', memeList)).toBe(true);
  });

  it('rejects non-meme symbols even when HL form', () => {
    expect(isMemeSymbol('BTC', memeList)).toBe(false);
    expect(isMemeSymbol('ETH', memeList)).toBe(false);
    expect(isMemeSymbol('DOGE', memeList)).toBe(false); // DOGE classified as major per PR #268
    expect(isMemeSymbol('btcusdt', memeList)).toBe(false);
  });

  it('does not strip the leading K of non-1000× symbols that happen to start with k (e.g. KAVA)', () => {
    // Regression: early `normaliseMemeBase` lowercased before stripping `^k`,
    // which would turn `KAVA` → `ava`. With an `ava`-like entry in the meme
    // list that caused a false positive. The HL 1000× form is specifically
    // literal lowercase `k` + uppercase base asset letter (e.g. `kPEPE`),
    // so `KAVA` (uppercase `K`) must not be treated as `AVA`.
    expect(isMemeSymbol('KAVA', 'avausdt,pepeusdt')).toBe(false);
    expect(isMemeSymbol('KSM', 'smusdt,pepeusdt')).toBe(false);
  });

  it('tolerates whitespace and empty entries in the csv', () => {
    expect(isMemeSymbol('kPEPE', ' pepeusdt , ,wifusdt ')).toBe(true);
    expect(isMemeSymbol('BTC', '')).toBe(false);
  });

  it('is case-insensitive on the Binance pair form', () => {
    // HL 1000× tickers are always literal `k` + uppercase, so `kpepe` is not
    // a real HL form and deliberately does not match here (avoids the KAVA
    // false-positive class).
    expect(isMemeSymbol('pepe', memeList)).toBe(true);
    expect(isMemeSymbol('Pepe', memeList)).toBe(true);
    expect(isMemeSymbol('PEPEUSDT', memeList)).toBe(true);
  });
});
