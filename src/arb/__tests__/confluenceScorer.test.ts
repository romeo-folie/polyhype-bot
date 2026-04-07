import { describe, it, expect, vi } from 'vitest';
import { scoreFromValues, computeClobFlowImbalance } from '../confluenceScorer.js';

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

  describe('Phase 2 volume voters', () => {
    const volCfg = {
      OBV_SLOPE_EPS: 0,
      MFI_OVERSOLD: 20,
      MFI_OVERBOUGHT: 80,
      VWAP_BAND: 0.001,
      CMF_THRESHOLD: 0.05,
    };

    it('all four volume voters bullish → score 4 UP on top of price voters', () => {
      const result = scoreFromValues(
        bullishRSI, bullishMACD, bullishStoch,
        { obvSlope: 1000, mfi: 10, vwap: 100, cmf: 0.2, lastClose: 101, cfg: volCfg },
      );
      expect(result.direction).toBe('UP');
      expect(result.score).toBe(7); // 3 price + 4 volume, all UP
      expect(result.signals.obv).toBe('rising');
      expect(result.signals.mfi).toBe('oversold');
      expect(result.signals.vwap).toBe('above');
      expect(result.signals.cmf).toBe('positive');
    });

    it('all four volume voters bearish → score 4 DOWN', () => {
      const result = scoreFromValues(
        null, null, null,
        { obvSlope: -1000, mfi: 90, vwap: 100, cmf: -0.2, lastClose: 99, cfg: volCfg },
      );
      expect(result.direction).toBe('DOWN');
      expect(result.score).toBe(4);
      expect(result.signals.obv).toBe('falling');
      expect(result.signals.cmf).toBe('negative');
    });

    it('mixed volume voters net out', () => {
      const result = scoreFromValues(
        null, null, null,
        { obvSlope: 1000, mfi: 90, vwap: 100, cmf: 0.0, lastClose: 100, cfg: volCfg },
      );
      // OBV up (+1), MFI overbought (+1 down), VWAP at price (neutral), CMF zero (neutral)
      expect(result.score).toBe(0);
      expect(result.direction).toBe('NEUTRAL');
    });

    it('volume snapshot ratio is computed', () => {
      const result = scoreFromValues(
        null, null, null,
        undefined,
        { current: 250, sma: 100 },
      );
      expect(result.volume?.ratio).toBe(2.5);
    });

    it('volume snapshot null sma → null ratio', () => {
      const result = scoreFromValues(
        null, null, null,
        undefined,
        { current: 100, sma: null },
      );
      expect(result.volume?.ratio).toBeNull();
    });
  });

  describe('clob_flow_imbalance voter', () => {
    it('buy-heavy ratio above threshold votes UP', () => {
      const r = scoreFromValues(null, null, null, undefined, undefined, {
        ratio: 2.0,
        threshold: 1.5,
      });
      expect(r.signals.clob_flow_imbalance).toBe('buy_heavy');
      expect(r.direction).toBe('UP');
      expect(r.score).toBe(1);
    });
    it('sell-heavy ratio below 1/threshold votes DOWN', () => {
      const r = scoreFromValues(null, null, null, undefined, undefined, {
        ratio: 0.5,
        threshold: 1.5,
      });
      expect(r.signals.clob_flow_imbalance).toBe('sell_heavy');
      expect(r.direction).toBe('DOWN');
      expect(r.score).toBe(1);
    });
    it('balanced ratio is neutral', () => {
      const r = scoreFromValues(null, null, null, undefined, undefined, {
        ratio: 1.0,
        threshold: 1.5,
      });
      expect(r.signals.clob_flow_imbalance).toBe('neutral');
      expect(r.direction).toBe('NEUTRAL');
      expect(r.score).toBe(0);
    });
    it('null ratio does not vote', () => {
      const r = scoreFromValues(null, null, null, undefined, undefined, {
        ratio: null,
        threshold: 1.5,
      });
      expect(r.signals.clob_flow_imbalance).toBeUndefined();
    });
    it('combines with bullish RSI for max score = 8', () => {
      const r = scoreFromValues(
        25,
        { macdLine: 1, signalLine: 0.5, histogram: 0.5 },
        { k: 18, d: 10 },
        {
          obvSlope: 1, mfi: 10, vwap: 100, cmf: 0.1, lastClose: 102,
          cfg: { OBV_SLOPE_EPS: 0, MFI_OVERSOLD: 20, MFI_OVERBOUGHT: 80, VWAP_BAND: 0.001, CMF_THRESHOLD: 0.05 },
        },
        undefined,
        { ratio: 3, threshold: 1.5 },
      );
      // 8 voters: rsi+macd+stoch+obv+mfi+vwap+cmf+clob_flow
      expect(r.score).toBe(8);
      expect(r.direction).toBe('UP');
    });
  });

  describe('computeClobFlowImbalance', () => {
    it('returns null on empty tape', async () => {
      const redis = { zrangebyscore: vi.fn().mockResolvedValue([]) };
      const r = await computeClobFlowImbalance('mkt-1', redis as never, 60);
      expect(r).toBeNull();
    });

    it('computes buy/sell ratio from tape entries', async () => {
      const tape = [
        JSON.stringify({ price: 0.5, size: 100, side: 'BUY' }),
        JSON.stringify({ price: 0.5, size: 50, side: 'SELL' }),
      ];
      const redis = { zrangebyscore: vi.fn().mockResolvedValue(tape) };
      const r = await computeClobFlowImbalance('mkt-1', redis as never, 60);
      expect(r).toBe(2);
    });

    it('returns Infinity when there is only buy notional', async () => {
      const tape = [JSON.stringify({ price: 0.5, size: 10, side: 'BUY' })];
      const redis = { zrangebyscore: vi.fn().mockResolvedValue(tape) };
      const r = await computeClobFlowImbalance('mkt-1', redis as never, 60);
      expect(r).toBe(Number.POSITIVE_INFINITY);
    });
  });
});
