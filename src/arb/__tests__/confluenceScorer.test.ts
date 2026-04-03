import { describe, it, expect } from 'vitest';
import { scoreFromValues } from '../confluenceScorer.js';

const bullishRSI = 25; // < 30 → oversold (+1 UP)
const bearishRSI = 75; // > 70 → overbought (+1 DOWN)
const neutralRSI = 50;

const bullishMACD = { macdLine: 1, signalLine: 0.5, histogram: 0.5 }; // histogram > 0, macd > signal
const bearishMACD = { macdLine: -1, signalLine: -0.5, histogram: -0.5 }; // histogram < 0, macd < signal
// histogram = 0, no divergence → neutral
const neutralMACD = { macdLine: 0, signalLine: 0, histogram: 0 };

const bullishStoch = { k: 18, d: 10 }; // k > d, both < 20 → oversold_cross
const bearishStoch = { k: 82, d: 90 }; // k < d, both > 80 → overbought_cross
const neutralStoch = { k: 50, d: 50 };

describe('scoreFromValues', () => {
  it('3/3 bullish → score=3, direction=UP', () => {
    const result = scoreFromValues(bullishRSI, bullishMACD, bullishStoch);
    expect(result.score).toBe(3);
    expect(result.direction).toBe('UP');
    expect(result.signals.rsi).toBe('oversold');
    expect(result.signals.macd).toBe('bullish_cross');
    expect(result.signals.stochastic).toBe('oversold_cross');
  });

  it('3/3 bearish → score=3, direction=DOWN', () => {
    const result = scoreFromValues(bearishRSI, bearishMACD, bearishStoch);
    expect(result.score).toBe(3);
    expect(result.direction).toBe('DOWN');
    expect(result.signals.rsi).toBe('overbought');
    expect(result.signals.macd).toBe('bearish_cross');
    expect(result.signals.stochastic).toBe('overbought_cross');
  });

  it('2/3 bearish → score=2, direction=DOWN', () => {
    const result = scoreFromValues(bearishRSI, bearishMACD, neutralStoch);
    expect(result.score).toBe(2);
    expect(result.direction).toBe('DOWN');
    expect(result.signals.stochastic).toBe('neutral');
  });

  it('2/3 bullish → score=2, direction=UP', () => {
    const result = scoreFromValues(bullishRSI, bullishMACD, neutralStoch);
    expect(result.score).toBe(2);
    expect(result.direction).toBe('UP');
  });

  it('all neutral → score=0, direction=NEUTRAL', () => {
    const result = scoreFromValues(neutralRSI, neutralMACD, neutralStoch);
    expect(result.score).toBe(0);
    expect(result.direction).toBe('NEUTRAL');
  });

  it('all null → score=0, direction=NEUTRAL', () => {
    const result = scoreFromValues(null, null, null);
    expect(result.score).toBe(0);
    expect(result.direction).toBe('NEUTRAL');
    expect(result.signals.rsi).toBeUndefined();
    expect(result.signals.macd).toBeUndefined();
    expect(result.signals.stochastic).toBeUndefined();
  });

  it('1 UP vs 1 DOWN vs 1 null → net score=0, direction=NEUTRAL (dissent cancels)', () => {
    // rsi=UP, macd=DOWN, stoch=null → tie 1:1 → net = 1-1 = 0 (active disagreement)
    const result = scoreFromValues(bullishRSI, bearishMACD, null);
    expect(result.score).toBe(0);
    expect(result.direction).toBe('NEUTRAL');
  });

  it('2 UP vs 1 DOWN → net score=1, direction=UP (dissent penalises)', () => {
    // net = 2-1 = 1 — mixed signals reduce confidence vs clean 2-0
    const result = scoreFromValues(bullishRSI, bullishMACD, bearishStoch);
    expect(result.score).toBe(1);
    expect(result.direction).toBe('UP');
  });

  it('neutral MACD (histogram negative but macdLine > signalLine) does not contribute', () => {
    // histogram < 0 but macdLine > signalLine — neither bullish nor bearish condition → neutral
    const result = scoreFromValues(neutralRSI, neutralMACD, neutralStoch);
    expect(result.signals.macd).toBe('neutral');
    expect(result.score).toBe(0);
  });
});
