import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock loadConfig so tests don't need REDIS_URL / SIMMER_* env vars
jest.unstable_mockModule('../../shared/config.js', () => ({
  loadConfig: jest.fn(() => ({
    OPENAI_MODEL: 'gpt-4o-mini',
    GEMINI_MODEL: 'gemini-2.5-flash',
    LLM_PROVIDER: 'gemini',
    CONTEXT_INJECTION_ENABLED: true,
    CONTEXT_INJECTION_LIMIT: 5,
    CONSENSUS_CACHE_ENABLED: false,
    CONSENSUS_CACHE_TTL_S: 1800,
    CONSENSUS_SAMPLES: 2,
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

  it('returns mean and stddev from N=2 samples (dual provider)', async () => {
    // Return different probabilities across 2 calls: 0.70, 0.72
    let callCount = 0;
    const probs = [0.70, 0.72];
    // Gemini handles 1 call
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

    // mean = (0.70 + 0.72) / 2 = 0.71
    expect(result.probability).toBeCloseTo(0.71, 4);
    expect(result.sampleCount).toBe(2);
    // Distributions: 1 Gemini, 1 OpenAI
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
  });

  it('returns result with sampleCount=1 when Gemini fails in dual-provider mode', async () => {
    // Ensemble (1 Gem, 1 OA): mock Gem to fail.
    mockGenerateContent.mockRejectedValue(new Error('Gemini unavailable'));
    // Mock OA to succeed once
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ probability: 0.65, reasoning: 'OA success' }) } }]
    });

    const result = await estimateConsensusProbability(BASE_OPTS);
    expect(result.probability).toBeCloseTo(0.65);
    expect(result.sampleCount).toBe(1);
    expect(result.stddev).toBe(0);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
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
    expect(result.sampleCount).toBe(2);
  });

  it('injects context block into prompt when 3+ outcomes available', async () => {
    mockGetRecentOutcomes.mockResolvedValue([
      { question: 'Q1', direction: 'YES', consensusProbability: 0.7, result: 'won', returnPct: 10, holdingHours: 5 },
      { question: 'Q2', direction: 'NO', consensusProbability: 0.6, result: 'lost', returnPct: -5, holdingHours: 3 },
      { question: 'Q3', direction: 'YES', consensusProbability: 0.8, result: 'won', returnPct: 15, holdingHours: 8 },
    ]);

    let callCount = 0;
    const probs = [0.70, 0.72];
    mockGenerateContent.mockImplementation(async (_prompt: string) => {
      const p = probs[callCount++]!;
      return { response: { text: () => JSON.stringify({ probability: p, reasoning: `G${callCount}` }) } };
    });
    mockChatCreate.mockImplementation(async (_opts: any) => {
      const p = probs[callCount++]!;
      return { choices: [{ message: { content: JSON.stringify({ probability: p, reasoning: 'O1' }) } }] };
    });

    const mockRedis = { get: jest.fn<() => Promise<null>>().mockResolvedValue(null), set: jest.fn<() => Promise<string>>().mockResolvedValue('OK'), zrevrange: jest.fn(), hgetall: jest.fn() };
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

    mockGenerateContent.mockImplementation(async () => {
      return { response: { text: () => JSON.stringify({ probability: 0.7, reasoning: 'test' }) } };
    });
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ probability: 0.7, reasoning: 'test' }) } }],
    });

    const mockRedis = { get: jest.fn<() => Promise<null>>().mockResolvedValue(null), set: jest.fn<() => Promise<string>>().mockResolvedValue('OK'), zrevrange: jest.fn(), hgetall: jest.fn() };
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
      CONSENSUS_CACHE_ENABLED: false,
      CONSENSUS_CACHE_TTL_S: 1800,
      CONSENSUS_SAMPLES: 2,
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

    const mockRedis = { get: jest.fn<() => Promise<null>>().mockResolvedValue(null), set: jest.fn<() => Promise<string>>().mockResolvedValue('OK'), zrevrange: jest.fn(), hgetall: jest.fn() };
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
      CONSENSUS_CACHE_ENABLED: false,
      CONSENSUS_CACHE_TTL_S: 1800,
      CONSENSUS_SAMPLES: 2,
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

    // All 2 samples will fail parsing → throws "All consensus samples failed"
    await expect(estimateConsensusProbability(BASE_OPTS)).rejects.toThrow('All consensus samples failed');
  });

  it('returns cached consensus estimate without LLM calls (cache hit)', async () => {
    const { loadConfig } = await import('../../shared/config.js');
    (loadConfig as jest.Mock).mockReturnValue({
      OPENAI_MODEL: 'gpt-4o-mini',
      GEMINI_MODEL: 'gemini-2.5-flash',
      LLM_PROVIDER: 'gemini',
      CONTEXT_INJECTION_ENABLED: true,
      CONTEXT_INJECTION_LIMIT: 5,
      CONSENSUS_CACHE_ENABLED: true,
      CONSENSUS_CACHE_TTL_S: 1800,
      CONSENSUS_SAMPLES: 2,
    });

    const cachedEstimate = {
      probability: 0.65,
      reasoning: 'cached reasoning',
      stddev: 0.02,
      sampleCount: 2,
    };

    const mockRedis = {
      get: jest.fn<(key: string) => Promise<string | null>>().mockResolvedValue(JSON.stringify(cachedEstimate)),
      set: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
    };

    const result = await estimateConsensusProbability({ ...BASE_OPTS, redis: mockRedis as any });

    expect(result.probability).toBe(0.65);
    expect(result.reasoning).toBe('cached reasoning');
    expect(result.sampleCount).toBe(2);
    // LLM should NOT have been called
    expect(mockGenerateContent).not.toHaveBeenCalled();
    expect(mockChatCreate).not.toHaveBeenCalled();

    // Restore config
    (loadConfig as jest.Mock).mockReturnValue({
      OPENAI_MODEL: 'gpt-4o-mini',
      GEMINI_MODEL: 'gemini-2.5-flash',
      LLM_PROVIDER: 'gemini',
      CONTEXT_INJECTION_ENABLED: true,
      CONTEXT_INJECTION_LIMIT: 5,
      CONSENSUS_CACHE_ENABLED: false,
      CONSENSUS_CACHE_TTL_S: 1800,
      CONSENSUS_SAMPLES: 2,
    });
  });

  it('calls LLM and caches result on cache miss', async () => {
    const { loadConfig } = await import('../../shared/config.js');
    (loadConfig as jest.Mock).mockReturnValue({
      OPENAI_MODEL: 'gpt-4o-mini',
      GEMINI_MODEL: 'gemini-2.5-flash',
      LLM_PROVIDER: 'gemini',
      CONTEXT_INJECTION_ENABLED: false,
      CONTEXT_INJECTION_LIMIT: 5,
      CONSENSUS_CACHE_ENABLED: true,
      CONSENSUS_CACHE_TTL_S: 1800,
      CONSENSUS_SAMPLES: 2,
    });

    mockGenerateContent.mockResolvedValue({
      response: { text: () => JSON.stringify({ probability: 0.7, reasoning: 'fresh' }) },
    });
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ probability: 0.7, reasoning: 'fresh' }) } }],
    });

    const mockRedis = {
      get: jest.fn<(key: string) => Promise<string | null>>().mockResolvedValue(null),
      set: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
    };

    const result = await estimateConsensusProbability({ ...BASE_OPTS, redis: mockRedis as any });

    expect(result.probability).toBeCloseTo(0.7);
    // LLM was called
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    // Result was cached
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^consensus:/),
      expect.any(String),
      'EX',
      1800,
    );

    // Restore config
    (loadConfig as jest.Mock).mockReturnValue({
      OPENAI_MODEL: 'gpt-4o-mini',
      GEMINI_MODEL: 'gemini-2.5-flash',
      LLM_PROVIDER: 'gemini',
      CONTEXT_INJECTION_ENABLED: true,
      CONTEXT_INJECTION_LIMIT: 5,
      CONSENSUS_CACHE_ENABLED: false,
      CONSENSUS_CACHE_TTL_S: 1800,
      CONSENSUS_SAMPLES: 2,
    });
  });

  it('bypasses cache when CONSENSUS_CACHE_ENABLED=false', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => JSON.stringify({ probability: 0.7, reasoning: 'no cache' }) },
    });
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ probability: 0.7, reasoning: 'no cache' }) } }],
    });

    const mockRedis = {
      get: jest.fn<(key: string) => Promise<string | null>>().mockResolvedValue(null),
      set: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
    };

    // Default config has CONSENSUS_CACHE_ENABLED=false
    const result = await estimateConsensusProbability({ ...BASE_OPTS, redis: mockRedis as any });

    expect(result.probability).toBeCloseTo(0.7);
    // LLM was called despite redis being available
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    // Redis get should NOT have been called for consensus cache
    // (it may be called for context injection, but not for consensus cache key)
    expect(mockRedis.set).not.toHaveBeenCalledWith(
      expect.stringMatching(/^consensus:/),
      expect.any(String),
      'EX',
      expect.any(Number),
    );
  });
});
