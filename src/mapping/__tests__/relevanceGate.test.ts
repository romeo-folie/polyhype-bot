import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isMarketRelevant } from '../relevanceGate.js';

// Mock loadConfig to ensure keys / model are present
vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    GEMINI_API_KEY: 'test-key',
    LLM_PROVIDER: 'gemini',
    GEMINI_MODEL: 'gemini-1.5-flash',
  })),
}));

// Mock logger
vi.mock('../../shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock GoogleGenerativeAI
const mockGenerateContent = vi.fn();
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: vi.fn().mockImplementation(() => ({
      generateContent: mockGenerateContent,
    })),
  })),
}));

// Mock OpenAI
const mockChatCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockChatCreate } },
  })),
}));

// Mock Anthropic
const mockAnthropicCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  })),
}));


describe('isMarketRelevant', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockChatCreate.mockReset();
    mockAnthropicCreate.mockReset();
    vi.clearAllMocks();
  });

  it('returns true when model returns YES', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => 'YES' },
    });

    const result = await isMarketRelevant({
      headline: 'Iran launches missiles at Israel',
      question: 'Will there be a major escalation between Iran and Israel before June?',
      description: 'Resolves YES if military action occurs.',
    });

    expect(result).toBe(true);
    expect(mockGenerateContent).toHaveBeenCalled();
  });

  it('returns false when model returns NO', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => 'NO' },
    });

    const result = await isMarketRelevant({
      headline: 'Taylor Swift wins another Grammy',
      question: 'Will there be a major escalation between Iran and Israel before June?',
      description: 'Resolves YES if military action occurs.',
    });

    expect(result).toBe(false);
  });

  it('returns false for verbose responses like "RELEVANT: YES" (strict first-token parsing)', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => 'relevant: yes' },
    });

    const result = await isMarketRelevant({
      headline: 'Something relevant',
      question: 'Something else',
      description: null,
    });

    // Strict parsing: only the first whitespace-delimited token ("RELEVANT:") is checked.
    // A verbose or prefixed response is treated as irrelevant.
    expect(result).toBe(false);
  });

  it('returns true for YES with surrounding whitespace', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '  YES  ' },
    });

    const result = await isMarketRelevant({
      headline: 'Iran launches missiles at Israel',
      question: 'Will there be a major escalation between Iran and Israel before June?',
      description: null,
    });

    expect(result).toBe(true);
  });

  it('fails open (returns true) on timeout', async () => {
    vi.useFakeTimers();
    try {
      // Return a promise that never resolves so the timeout branch fires.
      mockGenerateContent.mockReturnValue(new Promise(() => {}));

      const resultPromise = isMarketRelevant({
        headline: 'Breaking market-moving news',
        question: 'Will this market resolve YES?',
        description: null,
      });

      // Allow microtasks from the async provider chain to run so that the
      // internal setTimeout is registered before we flush fake timers.
      await Promise.resolve();
      await Promise.resolve();

      // Flush all fake timers (including the 10 s relevance gate timeout).
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toBe(true); // Fail-open on timeout
      expect(mockGenerateContent).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  }, 15000);

  it('fails open (returns true) on API error', async () => {
    mockGenerateContent.mockRejectedValue(new Error('API quota exceeded'));

    const result = await isMarketRelevant({
      headline: 'Critically important news',
      question: 'Critical market',
      description: null,
    });

    expect(result).toBe(true); // Fail-open
  });

  it('falls back to OpenAI when Gemini fails', async () => {
    const { loadConfig } = await import('../../shared/config.js');
    (loadConfig as any).mockReturnValue({ 
      GEMINI_API_KEY: 'gem-key', 
      OPENAI_API_KEY: 'oa-key', 
      GEMINI_MODEL: 'flash',
      OPENAI_MODEL: 'mini' 
    });

    // Gemini fails
    mockGenerateContent.mockRejectedValue(new Error('Gemini down'));
    // OpenAI succeeds
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: 'YES' } }]
    });

    const result = await isMarketRelevant({
      headline: 'Relevant news',
      question: 'Question',
      description: null
    });

    expect(result).toBe(true);
    expect(mockGenerateContent).toHaveBeenCalled();
    expect(mockChatCreate).toHaveBeenCalled();
  });

  it('fails open if GEMINI_API_KEY is missing', async () => {
    const { loadConfig } = await import('../../shared/config.js');
    (loadConfig as any).mockReturnValue({ GEMINI_API_KEY: undefined });

    const result = await isMarketRelevant({
      headline: 'News',
      question: 'Market',
      description: null,
    });

    expect(result).toBe(true); // Fail-open when unconfigured
  });
});
