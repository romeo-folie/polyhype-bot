import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scanHlMomentum, momentumCooldownKey } from '../hlMomentumScanner.js';
import type { ChainlinkTick } from '../../spot/feeds/chainlinkFeed.js';

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
  HL_MOMENTUM_SYMBOLS: 'btc/usd,eth/usd,sol/usd,xrp/usd,doge/usd',
  HL_MOMENTUM_MIN_SCORE: 4,
  HL_MOMENTUM_MIN_ADX: 20,
  HL_MOMENTUM_COOLDOWN_SEC: 600,
  HL_MOMENTUM_CANDLE_LOOKBACK_MS: 3_600_000,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTick(symbol = 'btc/usd', value = 70_000): ChainlinkTick {
  return { symbol, value, oracleTs: Date.now() - 100, receivedAt: Date.now() };
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
    const result = await scanHlMomentum(makeTick('hype/usd'), redis as never);
    expect(result).toBeNull();
  });

  it('returns null for a Chainlink symbol with no HL perp mapping', async () => {
    mockLoadConfig.mockReturnValueOnce({ ...baseConfig, HL_MOMENTUM_SYMBOLS: 'ada/usd' });
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick('ada/usd'), redis as never);
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
});

// ---------------------------------------------------------------------------
// Cooldown + position gates
// ---------------------------------------------------------------------------

describe('scanHlMomentum — cooldown and position gates', () => {
  beforeEach(() => {
    mockBuildCandles.mockResolvedValue([{}]);
    mockScoreHlTrend.mockReturnValue(bullishResult);
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
    // LONG signal; opposite-side SHORT position should block to prevent a delta-neutral wash.
    mockScoreHlTrend.mockReturnValue(bullishResult); // score > 0 → LONG
    // hasOpenPosition is called in parallel for LONG then SHORT via Promise.all.
    mockHasOpenPosition
      .mockResolvedValueOnce(false) // LONG side — none open
      .mockResolvedValueOnce(true); // SHORT side — existing position
    const redis = makeRedis();
    const result = await scanHlMomentum(makeTick(), redis as never);
    expect(result).toBeNull();
  });

  it('does NOT block when SHORT cooldown is set but signal is LONG (side-aware)', async () => {
    // LONG signal; SHORT cooldown must not block it.
    const shortKey = momentumCooldownKey('BTC', 'SHORT');
    const redis = makeRedis({ [shortKey]: '1' });
    // HL_MOMENTUM_ENABLED=false → shadow only, returns null — but the gates all passed.
    const result = await scanHlMomentum(makeTick(), redis as never);
    // Dark mode — null, but for the right reason (dark flag, not cooldown).
    expect(result).toBeNull();
    // redis.get should have been called for the loss cooldown and LONG cooldown keys,
    // NOT for the SHORT cooldown on a LONG signal.
    const getCalls: string[] = (redis.get as ReturnType<typeof vi.fn>).mock.calls.map(
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
});

// ---------------------------------------------------------------------------
// Live mode signal shape
// ---------------------------------------------------------------------------

describe('scanHlMomentum — live mode', () => {
  beforeEach(() => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, HL_MOMENTUM_ENABLED: true });
    mockBuildCandles.mockResolvedValue([{}]);
    mockHasOpenPosition.mockResolvedValue(false);
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
    const result = await scanHlMomentum(makeTick('eth/usd', 3000), redis as never);
    expect(result!.marketId).toBe('ETH');
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
