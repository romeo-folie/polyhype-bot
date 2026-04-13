import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';

// Mock config and logger before dynamic import.
const DEFAULT_CONFIG = {
  OPENAI_API_KEY: 'test-openai-key',
  OPENAI_MODEL: 'gpt-4o-mini',
  GEMINI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  DEEPSEEK_API_KEY: '',
  DEEPSEEK_MODEL: 'deepseek-chat',
  GEMINI_MODEL: 'gemini-pro',
  ANTHROPIC_MODEL: 'claude-3-haiku-20240307',
};

const mockLoadConfig = vi.fn(() => ({ ...DEFAULT_CONFIG }));
vi.mock('../../shared/config.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock OpenAI — the only provider with a key in DEFAULT_CONFIG.
const mockCreate = vi.fn();
vi.mock('openai', () => ({
  OpenAI: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

const { classifyRelationship, parseClassification, cacheKey } = await import(
  '../relationshipClassifier.js'
);

function makeRedis(overrides: Partial<Redis> = {}): Redis {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    ...overrides,
  } as unknown as Redis;
}

describe('relationshipClassifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG });
  });

  describe('parseClassification', () => {
    it('parses implication response', () => {
      const raw = JSON.stringify({
        type: 'implication',
        direction: 'A_implies_B',
        reasoning: 'Chiefs winning Super Bowl implies AFC team wins',
      });
      const result = parseClassification(raw);
      expect(result.type).toBe('implication');
      expect(result.direction).toBe('A_implies_B');
      expect(result.reasoning).toContain('Chiefs');
    });

    it('parses mutual-exclusion response', () => {
      const raw = JSON.stringify({
        type: 'mutual-exclusion',
        direction: null,
        reasoning: 'Same election, different candidates',
      });
      const result = parseClassification(raw);
      expect(result.type).toBe('mutual-exclusion');
      expect(result.direction).toBeNull();
    });

    it('accepts mutual_exclusion (underscore variant)', () => {
      const raw = JSON.stringify({ type: 'mutual_exclusion', reasoning: 'test' });
      const result = parseClassification(raw);
      expect(result.type).toBe('mutual-exclusion');
    });

    it('parses none response', () => {
      const raw = JSON.stringify({ type: 'none', reasoning: 'No relationship' });
      const result = parseClassification(raw);
      expect(result.type).toBe('none');
      expect(result.direction).toBeNull();
    });

    it('strips markdown code fences', () => {
      const raw = '```json\n{"type": "none", "reasoning": "test"}\n```';
      const result = parseClassification(raw);
      expect(result.type).toBe('none');
    });

    it('throws on invalid implication direction', () => {
      const raw = JSON.stringify({ type: 'implication', direction: 'bad_value' });
      expect(() => parseClassification(raw)).toThrow('Invalid direction');
    });
  });

  describe('cacheKey', () => {
    it('produces different keys for swapped question order', () => {
      const k1 = cacheKey('Question A', 'Question B');
      const k2 = cacheKey('Question B', 'Question A');
      expect(k1).not.toBe(k2);
    });

    it('produces different keys for different pairs', () => {
      const k1 = cacheKey('Question A', 'Question B');
      const k2 = cacheKey('Question A', 'Question C');
      expect(k1).not.toBe(k2);
    });

    it('produces the same key for identical order', () => {
      const k1 = cacheKey('Question A', 'Question B');
      const k2 = cacheKey('Question A', 'Question B');
      expect(k1).toBe(k2);
    });
  });

  describe('classifyRelationship', () => {
    it('returns cached result when available', async () => {
      const cached = JSON.stringify({
        type: 'implication',
        direction: 'A_implies_B',
        reasoning: 'cached',
      });
      const redis = makeRedis({ get: vi.fn().mockResolvedValue(cached) });

      const result = await classifyRelationship('Q1', 'Q2', redis, 3600);
      expect(result.type).toBe('implication');
      expect(result.reasoning).toBe('cached');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('calls LLM and caches result on cache miss', async () => {
      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              type: 'mutual-exclusion',
              direction: null,
              reasoning: 'Both cannot win',
            }),
          },
        }],
      });

      const redis = makeRedis();
      const result = await classifyRelationship('Q1', 'Q2', redis, 3600);

      expect(result.type).toBe('mutual-exclusion');
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalled();
    });

    it('returns none when all providers fail', async () => {
      mockCreate.mockRejectedValue(new Error('API down'));

      const redis = makeRedis();
      const result = await classifyRelationship('Q1', 'Q2', redis, 3600);

      expect(result.type).toBe('none');
      expect(result.reasoning).toContain('failed');
    });
  });
});
