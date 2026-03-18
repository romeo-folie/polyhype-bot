import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

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

  it('returns probability from Gemini on success', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify({ probability: 0.72, reasoning: 'Troops massing is escalatory' }),
      },
    });

    const result = await estimateConsensusProbability(BASE_OPTS);
    expect(result.probability).toBeCloseTo(0.72);
    expect(result.reasoning).toBe('Troops massing is escalatory');
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('falls back to OpenAI when Gemini fails', async () => {
    mockGenerateContent.mockRejectedValue(new Error('Gemini unavailable'));
    mockChatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ probability: 0.65, reasoning: 'OpenAI fallback' }),
          },
        },
      ],
    });

    const result = await estimateConsensusProbability(BASE_OPTS);
    expect(result.probability).toBeCloseTo(0.65);
    expect(result.reasoning).toBe('OpenAI fallback');
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
  });

  it('throws when both providers fail', async () => {
    mockGenerateContent.mockRejectedValue(new Error('Gemini error'));
    mockChatCreate.mockRejectedValue(new Error('OpenAI error'));

    await expect(estimateConsensusProbability(BASE_OPTS)).rejects.toThrow('OpenAI error');
  });

  it('throws when no API keys configured', async () => {
    delete process.env['GEMINI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];

    await expect(estimateConsensusProbability(BASE_OPTS)).rejects.toThrow(
      'No LLM provider configured',
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
  });

  it('throws on invalid probability value when both providers return bad data', async () => {
    // Both providers return out-of-range probability
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

    // Gemini will throw on parse (caught → warn), then OpenAI also throws on parse
    await expect(estimateConsensusProbability(BASE_OPTS)).rejects.toThrow('Invalid probability');
  });
});
