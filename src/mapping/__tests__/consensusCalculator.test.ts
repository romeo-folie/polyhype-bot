import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock loadConfig so tests don't need REDIS_URL / SIMMER_* env vars
jest.unstable_mockModule('../../shared/config.js', () => ({
  loadConfig: jest.fn(() => ({
    OPENAI_MODEL: 'gpt-4o-mini',
    GEMINI_MODEL: 'gemini-2.5-flash',
    LLM_PROVIDER: 'gemini',
    CONTEXT_INJECTION_ENABLED: true,
    CONTEXT_INJECTION_LIMIT: 5,
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetRecentOutcomes = jest.fn<(...args: any[]) => any>();
jest.unstable_mockModule('../../shared/outcomeRecorder.js', () => ({
  getRecentOutcomes: mockGetRecentOutcomes,
  inferCategory: jest.fn(() => 'geopolitical'),
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
    mockGetRecentOutcomes.mockReset();
    mockGetRecentOutcomes.mockResolvedValue([]);
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
    // Gemini handles 2 calls
    mockGenerateContent.mockImplementation(async () => {
      const p = probs[callCount++]!;
      return {
        response: {
          text: () => JSON.stringify({ probability: p, reasoning: `Gemini ${callCount}` }),
        },
      };
    });
    // OpenAI handles 1 call
    mockChatCreate.mockImplementation(async () => {
      const p = probs[callCount++]!;
      return {
        choices: [
          { message: { content: JSON.stringify({ probability: p, reasoning: 'OpenAI 1' }) } },
        ],
      };
    });

    const result = await estimateConsensusProbability(BASE_OPTS);

    // mean = (0.70 + 0.72 + 0.68) / 3 = 0.70
    expect(result.probability).toBeCloseTo(0.70, 4);
    expect(result.sampleCount).toBe(3);
    // Distributions: 2 Gemini, 1 OpenAI
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
  });

  it('returns result with sampleCount=1 when 2 of 3 calls fail', async () => {
    let callCount = 0;
    // Ensemble (2 Gem, 1 OA): mock Gem to fail. 
    mockGenerateContent.mockRejectedValue(new Error('Gemini unavailable'));
    // Mock OA to succeed once
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ probability: 0.65, reasoning: 'OA success' }) } }]
    });

    const result = await estimateConsensusProbability(BASE_OPTS);
    expect(result.probability).toBeCloseTo(0.65);
    expect(result.sampleCount).toBe(1);
    expect(result.stddev).toBe(0);
  });

  it('returns sampleCount=1 if Gemini fail — OA succeeds (Ensemble)', async () => {
    mockGenerateContent.mockRejectedValue(new Error('Gemini unavailable'));
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ probability: 0.65, reasoning: 'OA success' }) } }]
    });

    const result = await estimateConsensusProbability(BASE_OPTS);
    expect(result.sampleCount).toBe(1);
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
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
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ probability: 0.5, reasoning: 'OA Uncertain' }) } }]
    });

    const result = await estimateConsensusProbability({ ...BASE_OPTS, description: null });
    expect(result.probability).toBeCloseTo(0.5);
    expect(result.sampleCount).toBe(3);
  });

  it('injects context block into prompt when 3+ outcomes available', async () => {
    mockGetRecentOutcomes.mockResolvedValue([
      { question: 'Q1', direction: 'YES', consensusProbability: 0.7, result: 'won', returnPct: 10, holdingHours: 5 },
      { question: 'Q2', direction: 'NO', consensusProbability: 0.6, result: 'lost', returnPct: -5, holdingHours: 3 },
      { question: 'Q3', direction: 'YES', consensusProbability: 0.8, result: 'won', returnPct: 15, holdingHours: 8 },
    ]);

    let callCount = 0;
    const probs = [0.70, 0.72, 0.68];
    mockGenerateContent.mockImplementation(async (_prompt: string) => {
      const p = probs[callCount++]!;
      return { response: { text: () => JSON.stringify({ probability: p, reasoning: `G${callCount}` }) } };
    });
    mockChatCreate.mockImplementation(async (_opts: any) => {
      const p = probs[callCount++]!;
      return { choices: [{ message: { content: JSON.stringify({ probability: p, reasoning: 'O1' }) } }] };
    });

    const mockRedis = { zrevrange: jest.fn(), hgetall: jest.fn() };
    await estimateConsensusProbability({ ...BASE_OPTS, redis: mockRedis as any });

    // The Gemini call receives the full prompt as a single string — check it includes the context block
    const geminiCall = mockGenerateContent.mock.calls[0]?.[0] as string;
    expect(geminiCall).toContain('Recent track record on geopolitical');
    expect(geminiCall).toContain('Q1');
    expect(geminiCall).toContain('calibrate your estimate');
  });

  it('does not inject context with fewer than 3 outcomes', async () => {
    mockGetRecentOutcomes.mockResolvedValue([
      { question: 'Q1', direction: 'YES', consensusProbability: 0.7, result: 'won', returnPct: 10, holdingHours: 5 },
    ]);

    let callCount = 0;
    mockGenerateContent.mockImplementation(async () => {
      callCount++;
      return { response: { text: () => JSON.stringify({ probability: 0.7, reasoning: 'test' }) } };
    });
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ probability: 0.7, reasoning: 'test' }) } }],
    });

    const mockRedis = { zrevrange: jest.fn(), hgetall: jest.fn() };
    await estimateConsensusProbability({ ...BASE_OPTS, redis: mockRedis as any });

    const geminiCall = mockGenerateContent.mock.calls[0]?.[0] as string;
    expect(geminiCall).not.toContain('Recent track record');
  });

  it('skips context injection when CONTEXT_INJECTION_ENABLED=false', async () => {
    const { loadConfig } = await import('../../shared/config.js');
    (loadConfig as jest.Mock).mockReturnValue({
      OPENAI_MODEL: 'gpt-4o-mini',
      GEMINI_MODEL: 'gemini-2.5-flash',
      LLM_PROVIDER: 'gemini',
      CONTEXT_INJECTION_ENABLED: false,
      CONTEXT_INJECTION_LIMIT: 5,
    });

    mockGetRecentOutcomes.mockResolvedValue([
      { question: 'Q1', direction: 'YES', consensusProbability: 0.7, result: 'won', returnPct: 10, holdingHours: 5 },
      { question: 'Q2', direction: 'NO', consensusProbability: 0.6, result: 'lost', returnPct: -5, holdingHours: 3 },
      { question: 'Q3', direction: 'YES', consensusProbability: 0.8, result: 'won', returnPct: 15, holdingHours: 8 },
    ]);

    mockGenerateContent.mockResolvedValue({
      response: { text: () => JSON.stringify({ probability: 0.7, reasoning: 'test' }) },
    });
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ probability: 0.7, reasoning: 'test' }) } }],
    });

    const mockRedis = { zrevrange: jest.fn(), hgetall: jest.fn() };
    await estimateConsensusProbability({ ...BASE_OPTS, redis: mockRedis as any });

    // getRecentOutcomes should not have been called
    expect(mockGetRecentOutcomes).not.toHaveBeenCalled();

    // Restore config
    (loadConfig as jest.Mock).mockReturnValue({
      OPENAI_MODEL: 'gpt-4o-mini',
      GEMINI_MODEL: 'gemini-2.5-flash',
      LLM_PROVIDER: 'gemini',
      CONTEXT_INJECTION_ENABLED: true,
      CONTEXT_INJECTION_LIMIT: 5,
    });
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
