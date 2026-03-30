import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';

// Mock indicators
const mockComputeRSI = vi.fn();
const mockComputeMACD = vi.fn();
const mockComputeStochastic = vi.fn();

vi.mock('../indicators.js', () => ({
  computeRSI: (...args: unknown[]) => mockComputeRSI(...args),
  computeMACD: (...args: unknown[]) => mockComputeMACD(...args),
  computeStochastic: (...args: unknown[]) => mockComputeStochastic(...args),
}));

describe('confluenceScorer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scores 3/3 bullish correctly', async () => {
    const { scoreConfluence } = await import('../confluenceScorer.js');

    // All indicators bullish
    mockComputeRSI.mockResolvedValue(25);  // oversold
    mockComputeMACD.mockResolvedValue({
      macdLine: 10,
      signalLine: 5,
      histogram: 5,  // bullish_cross
    });
    mockComputeStochastic.mockResolvedValue({
      k: 18,  // > d and both < 20
      d: 15,  // oversold_cross
    });

    const redis = {} as Redis;
    const result = await scoreConfluence('btcusdt', redis);

    expect(result.direction).toBe('UP');
    expect(result.score).toBe(3);
    expect(result.signals.rsi).toBe('oversold');
    expect(result.signals.macd).toBe('bullish_cross');
    expect(result.signals.stochastic).toBe('oversold_cross');
  });

  it('scores 2/3 bearish correctly', async () => {
    const { scoreConfluence } = await import('../confluenceScorer.js');

    // 2 bearish, 1 neutral
    mockComputeRSI.mockResolvedValue(75);  // overbought
    mockComputeMACD.mockResolvedValue({
      macdLine: -10,
      signalLine: -5,
      histogram: -5,  // bearish_cross
    });
    mockComputeStochastic.mockResolvedValue({
      k: 50,  // neutral
      d: 50,
    });

    const redis = {} as Redis;
    const result = await scoreConfluence('btcusdt', redis);

    expect(result.direction).toBe('DOWN');
    expect(result.score).toBe(2);
    expect(result.signals.rsi).toBe('overbought');
    expect(result.signals.macd).toBe('bearish_cross');
    expect(result.signals.stochastic).toBe('neutral');
  });

  it('returns NEUTRAL when all indicators neutral/null', async () => {
    const { scoreConfluence } = await import('../confluenceScorer.js');

    // All neutral or null
    mockComputeRSI.mockResolvedValue(null);
    mockComputeMACD.mockResolvedValue(null);
    mockComputeStochastic.mockResolvedValue(null);

    const redis = {} as Redis;
    const result = await scoreConfluence('btcusdt', redis);

    expect(result.direction).toBe('NEUTRAL');
    expect(result.score).toBe(0);
  });

  it('handles tie correctly (1 UP, 1 DOWN, 1 neutral)', async () => {
    const { scoreConfluence } = await import('../confluenceScorer.js');

    // Mixed signals: 1 bullish, 1 bearish, 1 neutral
    mockComputeRSI.mockResolvedValue(25);  // oversold (UP)
    mockComputeMACD.mockResolvedValue({
      macdLine: -10,
      signalLine: -5,
      histogram: -5,  // bearish_cross (DOWN)
    });
    mockComputeStochastic.mockResolvedValue({
      k: 50,  // neutral
      d: 50,
    });

    const redis = {} as Redis;
    const result = await scoreConfluence('btcusdt', redis);

    // Tie → NEUTRAL
    expect(result.direction).toBe('NEUTRAL');
    expect(result.score).toBe(1);
  });

  it('detects RSI neutral range correctly', async () => {
    const { scoreConfluence } = await import('../confluenceScorer.js');

    mockComputeRSI.mockResolvedValue(50);  // 30 < RSI < 70 → neutral
    mockComputeMACD.mockResolvedValue(null);
    mockComputeStochastic.mockResolvedValue(null);

    const redis = {} as Redis;
    const result = await scoreConfluence('btcusdt', redis);

    expect(result.signals.rsi).toBe('neutral');
    expect(result.direction).toBe('NEUTRAL');
    expect(result.score).toBe(0);
  });

  it('detects MACD neutral (mixed conditions)', async () => {
    const { scoreConfluence } = await import('../confluenceScorer.js');

    mockComputeRSI.mockResolvedValue(null);
    // histogram > 0 but macdLine < signalLine → neutral (not both conditions met)
    mockComputeMACD.mockResolvedValue({
      macdLine: 5,
      signalLine: 10,
      histogram: 2,
    });
    mockComputeStochastic.mockResolvedValue(null);

    const redis = {} as Redis;
    const result = await scoreConfluence('btcusdt', redis);

    expect(result.signals.macd).toBe('neutral');
  });

  it('detects Stochastic overbought_cross correctly', async () => {
    const { scoreConfluence } = await import('../confluenceScorer.js');

    mockComputeRSI.mockResolvedValue(null);
    mockComputeMACD.mockResolvedValue(null);
    // %K < %D and both > 80 → overbought_cross
    mockComputeStochastic.mockResolvedValue({
      k: 82,
      d: 85,
    });

    const redis = {} as Redis;
    const result = await scoreConfluence('btcusdt', redis);

    expect(result.signals.stochastic).toBe('overbought_cross');
    expect(result.direction).toBe('DOWN');
    expect(result.score).toBe(1);
  });
});
