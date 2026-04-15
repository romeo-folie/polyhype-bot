import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock loadConfig so tests don't need REDIS_URL / SIMMER_* env vars
vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    OPENAI_API_KEY: 'test-openai-key',
    GEMINI_API_KEY: 'test-gemini-key',
    ANTHROPIC_API_KEY: undefined,
    DEEPSEEK_API_KEY: undefined,
    OPENAI_MODEL: 'gpt-4o-mini',
    GEMINI_MODEL: 'gemini-2.5-flash',
    LLM_PROVIDER: 'gemini',
    CONTEXT_INJECTION_ENABLED: true,
    CONTEXT_INJECTION_LIMIT: 5,
    CONSENSUS_CACHE_ENABLED: false,
    CONSENSUS_CACHE_TTL_S: 1800,
  })),
}));

const mockGetRecentOutcomes = vi.fn();
vi.mock('../../shared/outcomeRecorder.js', () => ({
  getRecentOutcomes: mockGetRecentOutcomes,
  inferCategory: vi.fn(() => 'geopolitical'),
}));

// Suppress logger output in tests
vi.mock('../../shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Stub getRedis — consensus calculator now calls it to check breaker state.
// Returns a no-op Redis-like object; breaker fails open on errors, so nothing
// is skipped.
vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn(() => ({
    exists: vi.fn().mockResolvedValue(0),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
  })),
}));

const mockGenerateContent = vi.fn();
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({
      generateContent: mockGenerateContent,
    }),
  })),
}));

const mockChatCreate = vi.fn();
const mockOpenAIConstructor = vi.fn().mockImplementation(() => ({
  chat: {
    completions: {
      create: mockChatCreate,
    },
  },
}));
vi.mock('openai', () => ({
  default: mockOpenAIConstructor,
  OpenAI: mockOpenAIConstructor,
}));

const { estimateConsensusProbability } = await import('../consensusCalculator.js');

const BASE_OPTS = {
  question: 'Will Russia invade Ukraine again in 2026?',
  description: 'Resolves YES if a major invasion occurs.',
  headline: 'Russia masses troops on Ukrainian border',
};

describe('estimateConsensusProbability', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockChatCreate.mockReset();
    mockGetRecentOutcomes.mockReset();
    mockGetRecentOutcomes.mockResolvedValue([]);
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('returns mean and stddev from N=2 samples (dual provider)', async () => {
    // Return different probabilities across 2 calls: 0.70, 0.72
    let callCount = 0;
    const probs = [0.7, 0.72];
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
      choices: [
        { message: { content: JSON.stringify({ probability: 0.65, reasoning: 'OA success' }) } },
      ],
    });

    const result = await estimateConsensusProbability(BASE_OPTS);
    expect(result.probability).toBeCloseTo(0.65);
    expect(result.sampleCount).toBe(1);
    // n=1 → no dispersion measurable → Infinity so downstream noise gates trip.
    expect(result.stddev).toBe(Infinity);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
  });

  it('throws when all samples fail', async () => {
    mockGenerateContent.mockRejectedValue(new Error('Gemini error'));
    mockChatCreate.mockRejectedValue(new Error('OpenAI error'));

    await expect(estimateConsensusProbability(BASE_OPTS)).rejects.toThrow(
      'All consensus samples failed',
    );
  });

  it('throws when no API keys configured', async () => {
    const { loadConfig } = await import('../../shared/config.js');
    (loadConfig as any).mockReturnValue({
      OPENAI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      DEEPSEEK_API_KEY: undefined,
      OPENAI_MODEL: 'gpt-4o-mini',
      GEMINI_MODEL: 'gemini-2.5-flash',
      LLM_PROVIDER: 'gemini',
      CONTEXT_INJECTION_ENABLED: true,
      CONTEXT_INJECTION_LIMIT: 5,
      CONSENSUS_CACHE_ENABLED: false,
      CONSENSUS_CACHE_TTL_S: 1800,
    });

    await expect(estimateConsensusProbability(BASE_OPTS)).rejects.toThrow(
      'No LLM providers configured',
    );

    // Restore default config
    (loadConfig as any).mockReturnValue({
      OPENAI_API_KEY: 'test-openai-key',
      GEMINI_API_KEY: 'test-gemini-key',
      ANTHROPIC_API_KEY: undefined,
      DEEPSEEK_API_KEY: undefined,
      OPENAI_MODEL: 'gpt-4o-mini',
      GEMINI_MODEL: 'gemini-2.5-flash',
      LLM_PROVIDER: 'gemini',
      CONTEXT_INJECTION_ENABLED: true,
      CONTEXT_INJECTION_LIMIT: 5,
      CONSENSUS_CACHE_ENABLED: false,
      CONSENSUS_CACHE_TTL_S: 1800,
    });
  });

  it('handles null description gracefully', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify({ probability: 0.5, reasoning: 'Uncertain' }),
      },
    });
    mockChatCreate.mockResolvedValue({
      choices: [
        { message: { content: JSON.stringify({ probability: 0.5, reasoning: 'OA Uncertain' }) } },
      ],
    });

    const result = await estimateConsensusProbability({ ...BASE_OPTS, description: null });
    expect(result.probability).toBeCloseTo(0.5);
    expect(result.sampleCount).toBe(2);
  });

  it('injects context block into prompt when 3+ outcomes available', async () => {
    mockGetRecentOutcomes.mockResolvedValue([
      {
        question: 'Q1',
        direction: 'YES',
        consensusProbability: 0.7,
        result: 'won',
        returnPct: 10,
        holdingHours: 5,
      },
      {
        question: 'Q2',
        direction: 'NO',
        consensusProbability: 0.6,
        result: 'lost',
        returnPct: -5,
        holdingHours: 3,
      },
      {
        question: 'Q3',
        direction: 'YES',
        consensusProbability: 0.8,
        result: 'won',
        returnPct: 15,
        holdingHours: 8,
      },
    ]);

    let callCount = 0;
    const probs = [0.7, 0.72];
    mockGenerateContent.mockImplementation(async (_prompt: string) => {
      const p = probs[callCount++]!;
      return {
        response: { text: () => JSON.stringify({ probability: p, reasoning: `G${callCount}` }) },
      };
    });
    mockChatCreate.mockImplementation(async (_opts: any) => {
      const p = probs[callCount++]!;
      return {
        choices: [{ message: { content: JSON.stringify({ probability: p, reasoning: 'O1' }) } }],
      };
    });

    const mockRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      zrevrange: vi.fn(),
      hgetall: vi.fn(),
    };
    await estimateConsensusProbability({ ...BASE_OPTS, redis: mockRedis as any });

    // The Gemini call receives the full prompt as a single string — check it includes the context block
    const geminiCall = mockGenerateContent.mock.calls[0]?.[0] as string;
    expect(geminiCall).toContain('Recent track record on geopolitical');
    expect(geminiCall).toContain('Q1');
    expect(geminiCall).toContain('calibrate your estimate');
  });

  it('does not inject context with fewer than 3 outcomes', async () => {
    mockGetRecentOutcomes.mockResolvedValue([
      {
        question: 'Q1',
        direction: 'YES',
        consensusProbability: 0.7,
        result: 'won',
        returnPct: 10,
        holdingHours: 5,
      },
    ]);

    mockGenerateContent.mockImplementation(async () => {
      return { response: { text: () => JSON.stringify({ probability: 0.7, reasoning: 'test' }) } };
    });
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ probability: 0.7, reasoning: 'test' }) } }],
    });

    const mockRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      zrevrange: vi.fn(),
      hgetall: vi.fn(),
    };
    await estimateConsensusProbability({ ...BASE_OPTS, redis: mockRedis as any });

    const geminiCall = mockGenerateContent.mock.calls[0]?.[0] as string;
    expect(geminiCall).not.toContain('Recent track record');
  });

  it('skips context injection when CONTEXT_INJECTION_ENABLED=false', async () => {
    const { loadConfig } = await import('../../shared/config.js');
    (loadConfig as any).mockReturnValue({
      OPENAI_API_KEY: 'test-openai-key',
      GEMINI_API_KEY: 'test-gemini-key',
      ANTHROPIC_API_KEY: undefined,
      DEEPSEEK_API_KEY: undefined,
      OPENAI_MODEL: 'gpt-4o-mini',
      GEMINI_MODEL: 'gemini-2.5-flash',
      LLM_PROVIDER: 'gemini',
      CONTEXT_INJECTION_ENABLED: false,
      CONTEXT_INJECTION_LIMIT: 5,
      CONSENSUS_CACHE_ENABLED: false,
      CONSENSUS_CACHE_TTL_S: 1800,
    });

    mockGetRecentOutcomes.mockResolvedValue([
      {
        question: 'Q1',
        direction: 'YES',
        consensusProbability: 0.7,
        result: 'won',
        returnPct: 10,
        holdingHours: 5,
      },
      {
        question: 'Q2',
        direction: 'NO',
        consensusProbability: 0.6,
        result: 'lost',
        returnPct: -5,
        holdingHours: 3,
      },
      {
        question: 'Q3',
        direction: 'YES',
        consensusProbability: 0.8,
        result: 'won',
        returnPct: 15,
        holdingHours: 8,
      },
    ]);

    mockGenerateContent.mockResolvedValue({
      response: { text: () => JSON.stringify({ probability: 0.7, reasoning: 'test' }) },
    });
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ probability: 0.7, reasoning: 'test' }) } }],
    });

    const mockRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      zrevrange: vi.fn(),
      hgetall: vi.fn(),
    };
    await estimateConsensusProbability({ ...BASE_OPTS, redis: mockRedis as any });

    // getRecentOutcomes should not have been called
    expect(mockGetRecentOutcomes).not.toHaveBeenCalled();

    // Restore config
    (loadConfig as any).mockReturnValue({
      OPENAI_API_KEY: 'test-openai-key',
      GEMINI_API_KEY: 'test-gemini-key',
      ANTHROPIC_API_KEY: undefined,
      DEEPSEEK_API_KEY: undefined,
      OPENAI_MODEL: 'gpt-4o-mini',
      GEMINI_MODEL: 'gemini-2.5-flash',
      LLM_PROVIDER: 'gemini',
      CONTEXT_INJECTION_ENABLED: true,
      CONTEXT_INJECTION_LIMIT: 5,
      CONSENSUS_CACHE_ENABLED: false,
      CONSENSUS_CACHE_TTL_S: 1800,
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
    await expect(estimateConsensusProbability(BASE_OPTS)).rejects.toThrow(
      'All consensus samples failed',
    );
  });

  it('returns cached consensus estimate without LLM calls (cache hit)', async () => {
    const { loadConfig } = await import('../../shared/config.js');
    (loadConfig as any).mockReturnValue({
      OPENAI_API_KEY: 'test-openai-key',
      GEMINI_API_KEY: 'test-gemini-key',
      ANTHROPIC_API_KEY: undefined,
      DEEPSEEK_API_KEY: undefined,
      OPENAI_MODEL: 'gpt-4o-mini',
      GEMINI_MODEL: 'gemini-2.5-flash',
      LLM_PROVIDER: 'gemini',
      CONTEXT_INJECTION_ENABLED: true,
      CONTEXT_INJECTION_LIMIT: 5,
      CONSENSUS_CACHE_ENABLED: true,
      CONSENSUS_CACHE_TTL_S: 1800,
    });

    const cachedEstimate = {
      probability: 0.65,
      reasoning: 'cached reasoning',
      stddev: 0.02,
      sampleCount: 2,
    };

    const mockRedis = {
      get: vi.fn().mockResolvedValue(JSON.stringify(cachedEstimate)),
      set: vi.fn().mockResolvedValue('OK'),
    };

    const result = await estimateConsensusProbability({ ...BASE_OPTS, redis: mockRedis as any });

    expect(result.probability).toBe(0.65);
    expect(result.reasoning).toBe('cached reasoning');
    expect(result.sampleCount).toBe(2);
    // LLM should NOT have been called
    expect(mockGenerateContent).not.toHaveBeenCalled();
    expect(mockChatCreate).not.toHaveBeenCalled();

    // Restore config
    (loadConfig as any).mockReturnValue({
      OPENAI_API_KEY: 'test-openai-key',
      GEMINI_API_KEY: 'test-gemini-key',
      ANTHROPIC_API_KEY: undefined,
      DEEPSEEK_API_KEY: undefined,
      OPENAI_MODEL: 'gpt-4o-mini',
      GEMINI_MODEL: 'gemini-2.5-flash',
      LLM_PROVIDER: 'gemini',
      CONTEXT_INJECTION_ENABLED: true,
      CONTEXT_INJECTION_LIMIT: 5,
      CONSENSUS_CACHE_ENABLED: false,
      CONSENSUS_CACHE_TTL_S: 1800,
    });
  });

  it('calls LLM and caches result on cache miss', async () => {
    const { loadConfig } = await import('../../shared/config.js');
    (loadConfig as any).mockReturnValue({
      OPENAI_API_KEY: 'test-openai-key',
      GEMINI_API_KEY: 'test-gemini-key',
      ANTHROPIC_API_KEY: undefined,
      DEEPSEEK_API_KEY: undefined,
      OPENAI_MODEL: 'gpt-4o-mini',
      GEMINI_MODEL: 'gemini-2.5-flash',
      LLM_PROVIDER: 'gemini',
      CONTEXT_INJECTION_ENABLED: false,
      CONTEXT_INJECTION_LIMIT: 5,
      CONSENSUS_CACHE_ENABLED: true,
      CONSENSUS_CACHE_TTL_S: 1800,
    });

    mockGenerateContent.mockResolvedValue({
      response: { text: () => JSON.stringify({ probability: 0.7, reasoning: 'fresh' }) },
    });
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ probability: 0.7, reasoning: 'fresh' }) } }],
    });

    const mockRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
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
    (loadConfig as any).mockReturnValue({
      OPENAI_API_KEY: 'test-openai-key',
      GEMINI_API_KEY: 'test-gemini-key',
      ANTHROPIC_API_KEY: undefined,
      DEEPSEEK_API_KEY: undefined,
      OPENAI_MODEL: 'gpt-4o-mini',
      GEMINI_MODEL: 'gemini-2.5-flash',
      LLM_PROVIDER: 'gemini',
      CONTEXT_INJECTION_ENABLED: true,
      CONTEXT_INJECTION_LIMIT: 5,
      CONSENSUS_CACHE_ENABLED: false,
      CONSENSUS_CACHE_TTL_S: 1800,
    });
  });

  it('bypasses cache when CONSENSUS_CACHE_ENABLED=false', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => JSON.stringify({ probability: 0.7, reasoning: 'no cache' }) },
    });
    mockChatCreate.mockResolvedValue({
      choices: [
        { message: { content: JSON.stringify({ probability: 0.7, reasoning: 'no cache' }) } },
      ],
    });

    const mockRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
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

  it('returns 0.50 when LLM says news is unrelated (Blind Consensus)', async () => {
    // Mock both models to return 0.50 as instructed by the new blind prompt
    mockGenerateContent.mockResolvedValue({
      response: { 
        text: () => JSON.stringify({ 
          probability: 0.50, 
          reasoning: "Headline is unrelated to the market question." 
        }) 
      },
    });
    mockChatCreate.mockResolvedValue({
      choices: [
        { 
          message: { 
            content: JSON.stringify({ 
              probability: 0.50, 
              reasoning: "Unrelated news." 
            }) 
          } 
        },
      ],
    });

    const result = await estimateConsensusProbability({
      ...BASE_OPTS,
      headline: "Something completely different",
    });

    // Blind consensus: LLM returns 0.50 for unrelated news,
    // regardless of what the market price actually is.
    expect(result.probability).toBe(0.50);
  });
});

describe('time-to-deadline prompt injection', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockChatCreate.mockReset();
    mockGetRecentOutcomes.mockReset();
    mockGetRecentOutcomes.mockResolvedValue([]);
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    mockGenerateContent.mockResolvedValue({
      response: { text: () => JSON.stringify({ probability: 0.6, reasoning: 'ok' }) },
    });
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ probability: 0.6, reasoning: 'ok' }) } }],
    });
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('appends days-to-deadline and resolution date when endDateIso is provided', async () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString();

    await estimateConsensusProbability({
      ...BASE_OPTS,
      endDateIso: future,
    });

    const geminiPrompt = mockGenerateContent.mock.calls[0]?.[0] as string;
    expect(geminiPrompt).toMatch(/Time to deadline: 30 days/);
    expect(geminiPrompt).toContain(future.slice(0, 10));
  });

  it('uses singular "day" when exactly 1 day to deadline', async () => {
    const future = new Date(Date.now() + 1 * 86_400_000).toISOString();

    await estimateConsensusProbability({ ...BASE_OPTS, endDateIso: future });

    const geminiPrompt = mockGenerateContent.mock.calls[0]?.[0] as string;
    expect(geminiPrompt).toMatch(/Time to deadline: 1 day \(/);
  });

  it('clamps days-to-deadline to 0 for past endDates', async () => {
    const past = new Date(Date.now() - 5 * 86_400_000).toISOString();

    await estimateConsensusProbability({ ...BASE_OPTS, endDateIso: past });

    const geminiPrompt = mockGenerateContent.mock.calls[0]?.[0] as string;
    expect(geminiPrompt).toMatch(/Time to deadline: 0 days/);
  });

  it('omits the deadline line when endDateIso is missing', async () => {
    await estimateConsensusProbability(BASE_OPTS);

    const geminiPrompt = mockGenerateContent.mock.calls[0]?.[0] as string;
    expect(geminiPrompt).not.toContain('Time to deadline');
  });

  it('produces different prompts for date-variant markets (regression guard)', async () => {
    // The Iran-conflict failure mode: three variants of the same question with
    // different deadlines should emit three DIFFERENT prompts. If this test
    // fails, the LLM is seeing identical inputs for Apr 30 / May 15 / Jun 30.
    const apr30 = new Date(Date.now() + 15 * 86_400_000).toISOString();
    const may15 = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const jun30 = new Date(Date.now() + 76 * 86_400_000).toISOString();

    await estimateConsensusProbability({ ...BASE_OPTS, endDateIso: apr30 });
    await estimateConsensusProbability({ ...BASE_OPTS, endDateIso: may15 });
    await estimateConsensusProbability({ ...BASE_OPTS, endDateIso: jun30 });

    const p1 = mockGenerateContent.mock.calls[0]?.[0] as string;
    const p2 = mockGenerateContent.mock.calls[1]?.[0] as string;
    const p3 = mockGenerateContent.mock.calls[2]?.[0] as string;

    expect(p1).toMatch(/Time to deadline: 15 days/);
    expect(p2).toMatch(/Time to deadline: 30 days/);
    expect(p3).toMatch(/Time to deadline: 76 days/);
    expect(p1).not.toBe(p2);
    expect(p2).not.toBe(p3);
  });
});
