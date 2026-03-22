import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock loadConfig so tests don't need REDIS_URL / SIMMER_* env vars
jest.unstable_mockModule('../../shared/config.js', () => ({
  loadConfig: jest.fn(() => ({
    OPENAI_MODEL: 'gpt-4o-mini',
    GEMINI_MODEL: 'gemini-2.5-flash',
    LLM_PROVIDER: 'gemini', // default: try Gemini first, fall back to OpenAI
  })),
}));

// Suppress logger output in tests
jest.unstable_mockModule('../../shared/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGenerateContent = jest.fn<(...args: any[]) => any>();
jest.unstable_mockModule('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({
      generateContent: mockGenerateContent,
    }),
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockChatCreate = jest.fn<(...args: any[]) => any>();
const mockOpenAIConstructor = jest.fn().mockImplementation(() => ({
  chat: {
    completions: {
      create: mockChatCreate,
    },
  },
}));
jest.unstable_mockModule('openai', () => ({
  default: mockOpenAIConstructor,
  OpenAI: mockOpenAIConstructor,
}));

const { estimateConsensusProbability } = await import('../consensusCalculator.js');

const BASE_OPTS = {
  question: 'Will Russia invade Ukraine again in 2026?',
  description: 'Resolves YES if a major invasion occurs.',
  headline: 'Russia masses troops on Ukrainian border',
  currentYesPrice: 0.4,
};

describe('estimateConsensusProbability', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockChatCreate.mockReset();
    process.env['GEMINI_API_KEY'] = 'test-gemini-key';
    process.env['OPENAI_API_KEY'] = 'test-openai-key';
  });

  afterEach(() => {
    delete process.env['GEMINI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
  });

  it('returns mean and stddev from N=3 samples', async () => {
    // Return different probabilities across 3 calls: 0.70, 0.72, 0.68
    let callCount = 0;
    const probs = [0.70, 0.72, 0.68];
    mockGenerateContent.mockImplementation(async () => {
      const p = probs[callCount++]!;
      return {
        response: {
          text: () => JSON.stringify({ probability: p, reasoning: `Call ${callCount}` }),
        },
      };
    });

    const result = await estimateConsensusProbability(BASE_OPTS);

    // mean = (0.70 + 0.72 + 0.68) / 3 = 0.70
    expect(result.probability).toBeCloseTo(0.70, 4);
    // stddev = sqrt(((0.70-0.70)^2 + (0.72-0.70)^2 + (0.68-0.70)^2) / 3)
    //        = sqrt((0 + 0.0004 + 0.0004) / 3) = sqrt(0.000267) ≈ 0.01633
    expect(result.stddev).toBeCloseTo(0.01633, 3);
    expect(result.sampleCount).toBe(3);
    // Parallel calls — reasoning comes from whichever resolves first; any call label is valid
    expect(['Call 1', 'Call 2', 'Call 3']).toContain(result.reasoning);
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
  });

  it('returns result with sampleCount=1 when 2 of 3 calls fail', async () => {
    let callCount = 0;
    mockGenerateContent.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) throw new Error('Gemini unavailable');
      return {
        response: {
          text: () => JSON.stringify({ probability: 0.65, reasoning: 'only success' }),
        },
      };
    });
    // OpenAI also fails (so fallback doesn't produce extra samples)
    mockChatCreate.mockRejectedValue(new Error('OpenAI unavailable'));

    const result = await estimateConsensusProbability(BASE_OPTS);
    expect(result.probability).toBeCloseTo(0.65);
    expect(result.sampleCount).toBe(1);
    expect(result.stddev).toBe(0); // single sample → 0 variance
  });

  it('falls back to OpenAI when Gemini fails for all samples', async () => {
    mockGenerateContent.mockRejectedValue(new Error('Gemini unavailable'));
    let callCount = 0;
    const probs = [0.65, 0.67, 0.63];
    mockChatCreate.mockImplementation(async () => {
      const p = probs[callCount++]!;
      return {
        choices: [
          { message: { content: JSON.stringify({ probability: p, reasoning: 'OpenAI fallback' }) } },
        ],
      };
    });

    const result = await estimateConsensusProbability(BASE_OPTS);
    expect(result.probability).toBeCloseTo(0.65, 2);
    expect(result.sampleCount).toBe(3);
    // Gemini fails 3 times, OpenAI succeeds 3 times
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    expect(mockChatCreate).toHaveBeenCalledTimes(3);
  });

  it('throws when all samples fail', async () => {
    mockGenerateContent.mockRejectedValue(new Error('Gemini error'));
    mockChatCreate.mockRejectedValue(new Error('OpenAI error'));

    await expect(estimateConsensusProbability(BASE_OPTS)).rejects.toThrow('All consensus samples failed');
  });

  it('throws when no API keys configured', async () => {
    delete process.env['GEMINI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];

    await expect(estimateConsensusProbability(BASE_OPTS)).rejects.toThrow(
      'All consensus samples failed',
    );
  });

  it('handles null description gracefully', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify({ probability: 0.5, reasoning: 'Uncertain' }),
      },
    });

    const result = await estimateConsensusProbability({ ...BASE_OPTS, description: null });
    expect(result.probability).toBeCloseTo(0.5);
    expect(result.sampleCount).toBe(3);
  });

  it('throws on invalid probability value when all providers return bad data', async () => {
    // Both providers return out-of-range probability for all samples
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify({ probability: 1.5, reasoning: 'out of range' }),
      },
    });
    mockChatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ probability: 2.0, reasoning: 'also bad' }),
          },
        },
      ],
    });

    // All 3 samples will fail parsing → throws "All consensus samples failed"
    await expect(estimateConsensusProbability(BASE_OPTS)).rejects.toThrow('All consensus samples failed');
  });
});
