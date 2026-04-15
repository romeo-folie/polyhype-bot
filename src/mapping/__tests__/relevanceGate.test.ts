import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isMarketRelevant, scoreMarketRelevance, parseFitScore, SYSTEM_PROMPT } from '../relevanceGate.js';

const mockConfig = {
  GEMINI_API_KEY: 'test-key' as string | undefined,
  OPENAI_API_KEY: undefined as string | undefined,
  DEEPSEEK_API_KEY: undefined as string | undefined,
  ANTHROPIC_API_KEY: undefined as string | undefined,
  LLM_PROVIDER: 'gemini',
  GEMINI_MODEL: 'gemini-1.5-flash',
  OPENAI_MODEL: 'gpt-4o-mini',
  DEEPSEEK_MODEL: 'deepseek-chat',
  ANTHROPIC_MODEL: 'claude-3-haiku',
  RELEVANCE_CACHE_TTL_S: 3600,
  RELEVANCE_MIN_FIT_SCORE: 0.5,
};

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => mockConfig),
}));

vi.mock('../../shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
  })),
}));

const mockGenerateContent = vi.fn();
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: vi.fn().mockImplementation(() => ({
      generateContent: mockGenerateContent,
    })),
  })),
}));

const mockChatCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockChatCreate } },
  })),
}));

const mockAnthropicCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  })),
}));

function resetMocks() {
  mockGenerateContent.mockReset();
  mockChatCreate.mockReset();
  mockAnthropicCreate.mockReset();
  mockRedisGet.mockReset();
  mockRedisSet.mockReset();
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockConfig.GEMINI_API_KEY = 'test-key';
  mockConfig.OPENAI_API_KEY = undefined;
  mockConfig.DEEPSEEK_API_KEY = undefined;
  mockConfig.ANTHROPIC_API_KEY = undefined;
  mockConfig.RELEVANCE_MIN_FIT_SCORE = 0.5;
  vi.clearAllMocks();
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
}

describe('SYSTEM_PROMPT anchors', () => {
  // The 0.30 / 0.70 bimodal gap was observed pushing genuine-but-indirect
  // matches (e.g. Iran war-action headlines vs. Iran war markets) below the
  // 0.5 threshold. The 0.50 anchor gives the LLM a landing zone for on-topic,
  // plausible-chain cases.
  it('includes the 0.50 anchor so on-topic plausible-chain cases are not floored to 0.30', () => {
    expect(SYSTEM_PROMPT).toMatch(/0\.50\s*=.*plausible causal chain/);
  });

  it('preserves the 0.30 and 0.70 anchors', () => {
    expect(SYSTEM_PROMPT).toMatch(/0\.30\s*=.*shares an entity/);
    expect(SYSTEM_PROMPT).toMatch(/0\.70\s*=.*clear causal chain/);
  });
});

describe('parseFitScore', () => {
  it('parses a clean float', () => {
    expect(parseFitScore('0.8')).toBe(0.8);
  });

  it('parses a float from noisy prefix', () => {
    expect(parseFitScore('Score: 0.35')).toBe(0.35);
  });

  it('clamps values > 1 to 1', () => {
    expect(parseFitScore('1.4')).toBe(1);
  });

  it('clamps negative values to 0', () => {
    expect(parseFitScore('-0.2')).toBe(0);
  });

  it('returns null for non-numeric input', () => {
    expect(parseFitScore('YES')).toBeNull();
  });

  it('parses integers', () => {
    expect(parseFitScore('0')).toBe(0);
    expect(parseFitScore('1')).toBe(1);
  });
});

describe('scoreMarketRelevance', () => {
  beforeEach(resetMocks);

  it('returns the parsed fit score from Gemini', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => '0.87' } });

    const result = await scoreMarketRelevance({
      headline: 'Iran launches missiles at Israel',
      question: 'Will there be a major escalation between Iran and Israel before June?',
      description: 'Resolves YES if military action occurs.',
    });

    expect(result.fitScore).toBe(0.87);
    expect(result.reason).toBe('llm');
    expect(result.provider).toBe('Gemini');
    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringContaining('relevance:v2:'),
      '0.870',
      'EX',
      3600,
    );
  });

  it('falls back to 0.5 when provider returns unparseable output', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => 'maybe' } });

    const result = await scoreMarketRelevance({
      headline: 'Something',
      question: 'Something else',
      description: null,
    });

    expect(result.fitScore).toBe(0.5);
    expect(result.reason).toBe('parse_fallback');
  });

  it('clamps scores above 1 to 1', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => '1.4' } });

    const result = await scoreMarketRelevance({
      headline: 'News',
      question: 'Market',
      description: null,
    });

    expect(result.fitScore).toBe(1);
  });

  it('returns cached score without calling the LLM', async () => {
    mockRedisGet.mockResolvedValueOnce('0.62');

    const result = await scoreMarketRelevance({
      headline: 'Cached headline',
      question: 'Cached market',
      description: null,
    });

    expect(result.fitScore).toBeCloseTo(0.62, 3);
    expect(result.reason).toBe('cache');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('falls back to Gemini when OpenAI fails', async () => {
    // OpenAI is primary since 2026-04-15 (Gemini observed scoring too
    // conservatively). This test exercises the fallback path.
    mockConfig.OPENAI_API_KEY = 'openai-key';
    mockChatCreate.mockRejectedValue(new Error('OpenAI down'));
    mockGenerateContent.mockResolvedValue({ response: { text: () => '0.72' } });

    const result = await scoreMarketRelevance({
      headline: 'News',
      question: 'Question',
      description: null,
    });

    expect(result.fitScore).toBe(0.72);
    expect(result.provider).toBe('Gemini');
    expect(mockChatCreate).toHaveBeenCalled();
    expect(mockGenerateContent).toHaveBeenCalled();
  });

  it('fails open to 0.5 when all providers unavailable', async () => {
    mockConfig.GEMINI_API_KEY = undefined;

    const result = await scoreMarketRelevance({
      headline: 'News',
      question: 'Market',
      description: null,
    });

    expect(result.fitScore).toBe(0.5);
    expect(result.reason).toBe('fail_open');
  });

  it('fails open to 0.5 on API error', async () => {
    mockGenerateContent.mockRejectedValue(new Error('API quota exceeded'));

    const result = await scoreMarketRelevance({
      headline: 'Critically important news',
      question: 'Critical market',
      description: null,
    });

    expect(result.fitScore).toBe(0.5);
    expect(result.reason).toBe('fail_open');
  });
});

describe('isMarketRelevant (wrapper)', () => {
  beforeEach(resetMocks);

  it('returns true when score >= threshold', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => '0.75' } });

    const relevant = await isMarketRelevant({
      headline: 'Relevant news',
      question: 'Market question',
      description: null,
    });

    expect(relevant).toBe(true);
  });

  it('returns false when score below threshold', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => '0.30' } });

    const relevant = await isMarketRelevant({
      headline: 'Unrelated news',
      question: 'Market question',
      description: null,
    });

    expect(relevant).toBe(false);
  });

  it('respects configured RELEVANCE_MIN_FIT_SCORE', async () => {
    mockConfig.RELEVANCE_MIN_FIT_SCORE = 0.8;
    mockGenerateContent.mockResolvedValue({ response: { text: () => '0.60' } });

    const relevant = await isMarketRelevant({
      headline: 'News',
      question: 'Market',
      description: null,
    });

    expect(relevant).toBe(false);
  });

  it('fails open to fit=0.5 which passes default threshold of 0.5', async () => {
    mockConfig.GEMINI_API_KEY = undefined;

    const relevant = await isMarketRelevant({
      headline: 'News',
      question: 'Market',
      description: null,
    });

    // fail_open returns 0.5; default threshold is 0.5 so >= passes.
    expect(relevant).toBe(true);
  });
});
