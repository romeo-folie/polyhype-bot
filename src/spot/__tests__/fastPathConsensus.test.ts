import { jest, describe, it, expect } from '@jest/globals';
import type { SpotMove } from '../thresholdDetector.js';
import type { CorrelatedMarket } from '../marketCorrelator.js';

jest.unstable_mockModule('../../shared/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../shared/config.js', () => ({
  loadConfig: jest.fn().mockReturnValue({
    LLM_PROVIDER: 'openai',
    OPENAI_MODEL: 'gpt-4o-mini',
    GEMINI_MODEL: 'gemini-2.5-flash',
  }),
}));

jest.unstable_mockModule('../../mapping/consensusCalculator.js', () => ({
  estimateConsensusProbability: jest.fn(),
}));

const { estimateConsensusProbability } = await import('../../mapping/consensusCalculator.js');
const { extractPriceTarget, formulaProbability, estimateFastConsensus } = await import(
  '../fastPathConsensus.js'
);

const mockEstimate = estimateConsensusProbability as jest.MockedFunction<
  typeof estimateConsensusProbability
>;

function makeMove(overrides: Partial<SpotMove> = {}): SpotMove {
  return {
    assetId: 'bitcoin',
    currentPrice: 67000,
    referencePrice: 65000,
    changePercent: 3.08,
    windowMinutes: 5,
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMarket(overrides: Partial<CorrelatedMarket> = {}): CorrelatedMarket {
  return {
    marketId: 'mkt-1',
    conditionId: 'cond-1',
    clobTokenIds: ['tok-yes', 'tok-no'],
    question: 'Will Bitcoin be above $100,000 on June 30, 2026?',
    description: 'Resolves YES if BTC spot price exceeds $100,000 on June 30, 2026.',
    currentYesPrice: 0.6,
    correlationDirection: 'positive',
    ...overrides,
  };
}

describe('extractPriceTarget', () => {
  it('extracts price target with date from standard format', () => {
    const result = extractPriceTarget('Will Bitcoin be above $100,000 on June 30, 2026?');

    expect(result).not.toBeNull();
    expect(result!.targetPrice).toBe(100000);
    expect(result!.direction).toBe('above');
    expect(result!.deadlineMs).toBeGreaterThan(Date.now());
  });

  it('handles $XXk format', () => {
    const result = extractPriceTarget('Will BTC exceed $150k by December 2026?');

    expect(result).not.toBeNull();
    expect(result!.targetPrice).toBe(150000);
    expect(result!.direction).toBe('above');
  });

  it('detects "below" direction', () => {
    const result = extractPriceTarget('Will ETH be below $2,000 on March 31, 2026?');

    expect(result).not.toBeNull();
    expect(result!.targetPrice).toBe(2000);
    expect(result!.direction).toBe('below');
  });

  it('returns null for non-price-target questions', () => {
    const result = extractPriceTarget('Will the SEC approve a Bitcoin ETF in 2026?');
    expect(result).toBeNull();
  });

  it('returns null when no date is found', () => {
    const result = extractPriceTarget('Will BTC exceed $100k?');
    expect(result).toBeNull();
  });

  it('handles ISO date format', () => {
    const result = extractPriceTarget('Will BTC be above $100,000 by 2026-06-30?');

    expect(result).not.toBeNull();
    expect(result!.targetPrice).toBe(100000);
  });
});

describe('formulaProbability', () => {
  it('returns higher probability when price is well above target', () => {
    // BTC at 95k, target 80k, 3 months out
    const prob = formulaProbability(95000, 80000, 'above', 0.8, 0.25);
    expect(prob).toBeGreaterThan(0.5);
  });

  it('returns lower probability when price is well below target', () => {
    // BTC at 50k, target 100k, 3 months out
    const prob = formulaProbability(50000, 100000, 'above', 0.8, 0.25);
    expect(prob).toBeLessThan(0.5);
  });

  it('returns ~0.5 when price equals target (approximately)', () => {
    // At the money, short time frame
    const prob = formulaProbability(100000, 100000, 'above', 0.8, 0.01);
    expect(prob).toBeGreaterThan(0.3);
    expect(prob).toBeLessThan(0.7);
  });

  it('handles "below" direction correctly', () => {
    const probAbove = formulaProbability(95000, 80000, 'above', 0.8, 0.25);
    const probBelow = formulaProbability(95000, 80000, 'below', 0.8, 0.25);

    // P(above) + P(below) ≈ 1
    expect(probAbove + probBelow).toBeCloseTo(1, 1);
  });

  it('handles expired options deterministically', () => {
    expect(formulaProbability(95000, 80000, 'above', 0.8, 0)).toBe(1);
    expect(formulaProbability(75000, 80000, 'above', 0.8, 0)).toBe(0);
    expect(formulaProbability(75000, 80000, 'below', 0.8, 0)).toBe(1);
  });

  it('clamps output to [0.01, 0.99]', () => {
    // Very extreme case — far in the money with low vol
    const prob = formulaProbability(200000, 50000, 'above', 0.1, 0.01);
    expect(prob).toBeLessThanOrEqual(0.99);
    expect(prob).toBeGreaterThanOrEqual(0.01);
  });
});

describe('estimateFastConsensus', () => {
  it('uses formula for price-target markets', async () => {
    const result = await estimateFastConsensus(makeMove(), makeMarket());

    expect(result.method).toBe('formula');
    expect(result.probability).toBeGreaterThan(0);
    expect(result.probability).toBeLessThan(1);
    expect(result.reasoning).toContain('Formula');
  });

  it('falls back to LLM for non-price-target markets', async () => {
    mockEstimate.mockResolvedValue({
      probability: 0.65,
      reasoning: 'BTC rally makes SEC approval more likely',
      stddev: 0.01,
      sampleCount: 3,
    });

    const result = await estimateFastConsensus(
      makeMove(),
      makeMarket({ question: 'Will the SEC approve a Bitcoin ETF in 2026?' }),
    );

    expect(result.method).toBe('llm');
    expect(result.probability).toBe(0.65);
    expect(mockEstimate).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'Will the SEC approve a Bitcoin ETF in 2026?',
        headline: expect.stringContaining('bitcoin'),
      }),
    );
  });

  it('passes spot move context to LLM headline', async () => {
    mockEstimate.mockResolvedValue({
      probability: 0.7,
      reasoning: 'test',
      stddev: 0.01,
      sampleCount: 3,
    });

    await estimateFastConsensus(
      makeMove({ changePercent: 5.2 }),
      makeMarket({ question: 'Will crypto regulation pass?' }),
    );

    expect(mockEstimate).toHaveBeenCalledWith(
      expect.objectContaining({
        headline: expect.stringContaining('+5.2%'),
      }),
    );
  });
});
