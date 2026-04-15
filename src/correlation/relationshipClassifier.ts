/**
 * LLM relationship classifier for market pairs.
 *
 * Given two Polymarket binary questions, determines whether a strict
 * logical relationship (implication or mutual exclusion) exists.
 *
 * Uses the same provider pattern as consensusCalculator.ts but with a
 * dedicated prompt. Only one provider is called per pair (cost control —
 * relationship classification is a structural yes/no judgment that
 * doesn't benefit from multi-provider averaging).
 *
 * Results are cached in Redis under a content-hash key.
 */

import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import type { ConstraintType } from './types.js';

const TIMEOUT_MS = 25_000;
const CACHE_PREFIX = 'correlation:classify:';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClassificationResult {
  type: ConstraintType | 'none';
  /** For implication: which direction. Null for mutual-exclusion and none. */
  direction: 'A_implies_B' | 'B_implies_A' | null;
  reasoning: string;
}

interface RawLlmResponse {
  type?: string;
  direction?: string;
  reasoning?: string;
}

// ── Prompt construction ──────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return (
    'You are a prediction market structure analyst. Given two binary Polymarket questions, ' +
    'determine if a strict logical relationship exists between them.\n\n' +
    `Today's date is ${today}.\n\n` +
    'A relationship exists only if it is STRUCTURALLY GUARANTEED by logic or event structure — ' +
    'not merely correlated by shared news or topic. Examples:\n\n' +
    'IMPLICATION (A → B): If A resolves YES, then B MUST also resolve YES.\n' +
    '  Good: "Will the Chiefs win Super Bowl?" → "Will an AFC team win Super Bowl?"\n' +
    '  Bad: "Will Bitcoin reach $100K?" and "Will Ethereum reach $5K?" (correlated but not implied)\n\n' +
    'MUTUAL EXCLUSION: A and B cannot BOTH resolve YES (at most one will).\n' +
    '  Good: "Will Biden win 2028?" and "Will Trump win 2028?" (same election, different candidates)\n' +
    '  Bad: "Will Fed cut rates in Q1?" and "Will Fed cut rates in Q2?" (both can happen)\n\n' +
    'If NO strict logical relationship exists, return type "none".\n\n' +
    'Return ONLY a JSON object with no markdown:\n' +
    '{\n' +
    '  "type": "implication" | "mutual-exclusion" | "none",\n' +
    '  "direction": "A_implies_B" | "B_implies_A" | null,\n' +
    '  "reasoning": "one sentence explaining the structural logic"\n' +
    '}'
  );
}

function buildUserPrompt(questionA: string, questionB: string): string {
  return (
    `Market A: ${questionA}\n` +
    `Market B: ${questionB}\n\n` +
    'Does a strict logical relationship exist between these two binary prediction markets?'
  );
}

// ── Response parsing ─────────────────────────────────────────────────────────

function parseClassification(raw: string): ClassificationResult {
  const cleaned = raw
    .replace(/```(?:json)?\s*/g, '')
    .replace(/```/g, '')
    .trim();

  const parsed = JSON.parse(cleaned) as RawLlmResponse;

  const type = parsed.type;
  if (type === 'implication') {
    const dir = parsed.direction;
    if (dir !== 'A_implies_B' && dir !== 'B_implies_A') {
      throw new Error(`Invalid direction for implication: ${String(dir)}`);
    }
    return {
      type: 'implication',
      direction: dir,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    };
  }

  if (type === 'mutual-exclusion' || type === 'mutual_exclusion') {
    return {
      type: 'mutual-exclusion',
      direction: null,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    };
  }

  return { type: 'none', direction: null, reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '' };
}

// ── Cache key ────────────────────────────────────────────────────────────────

/**
 * Deterministic cache key. Order is preserved because the cached
 * `direction` field is defined relative to the caller's A/B ordering,
 * so (A, B) and (B, A) must not share the same cache entry.
 */
function cacheKey(questionA: string, questionB: string): string {
  const ordered = `${questionA}|${questionB}`;
  const hash = createHash('sha256').update(ordered).digest('hex').slice(0, 16);
  return `${CACHE_PREFIX}${hash}`;
}

// ── Provider calls ───────────────────────────────────────────────────────────

async function callOpenAI(systemPrompt: string, userPrompt: string): Promise<string> {
  const { OpenAI } = await import('openai');
  const cfg = loadConfig();
  const client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });

  const abortCtrl = new AbortController();
  const timer = setTimeout(() => { abortCtrl.abort(); }, TIMEOUT_MS);
  try {
    const completion = await client.chat.completions.create(
      {
        model: cfg.OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 200,
        temperature: 0,
      },
      { signal: abortCtrl.signal },
    );
    return completion.choices[0]?.message?.content ?? '{}';
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(systemPrompt: string, userPrompt: string): Promise<string> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const cfg = loadConfig();
  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });

  const abortCtrl = new AbortController();
  const timer = setTimeout(() => { abortCtrl.abort(); }, TIMEOUT_MS);
  try {
    const completion = await client.messages.create(
      {
        model: cfg.ANTHROPIC_MODEL,
        max_tokens: 200,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0,
      },
      { signal: abortCtrl.signal } as Parameters<typeof client.messages.create>[1],
    );
    return completion.content[0]?.type === 'text' ? completion.content[0].text : '{}';
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(systemPrompt: string, userPrompt: string): Promise<string> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const cfg = loadConfig();
  const genai = new GoogleGenerativeAI(cfg.GEMINI_API_KEY ?? '');
  const model = genai.getGenerativeModel({ model: cfg.GEMINI_MODEL });

  const result = await Promise.race([
    model.generateContent(`${systemPrompt}\n\n${userPrompt}`),
    new Promise<never>((_, reject) =>
      setTimeout(() => { reject(new Error('Gemini timeout')); }, TIMEOUT_MS),
    ),
  ]);

  return result.response
    .text()
    .replace(/```(?:json)?\s*/g, '')
    .replace(/```/g, '')
    .trim();
}

async function callDeepSeek(systemPrompt: string, userPrompt: string): Promise<string> {
  const { default: OpenAI } = await import('openai');
  const cfg = loadConfig();
  const client = new OpenAI({
    apiKey: cfg.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com',
  });

  const abortCtrl = new AbortController();
  const timer = setTimeout(() => { abortCtrl.abort(); }, TIMEOUT_MS);
  try {
    const completion = await client.chat.completions.create(
      {
        model: cfg.DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 200,
        temperature: 0,
      },
      { signal: abortCtrl.signal },
    );
    return completion.choices[0]?.message?.content ?? '{}';
  } finally {
    clearTimeout(timer);
  }
}

// ── Provider chain ───────────────────────────────────────────────────────────

type ProviderFn = (system: string, user: string) => Promise<string>;

function getProviderChain(): ProviderFn[] {
  const cfg = loadConfig();
  const chain: ProviderFn[] = [];
  if (cfg.OPENAI_API_KEY) chain.push(callOpenAI);
  if (cfg.GEMINI_API_KEY) chain.push(callGemini);
  if (cfg.ANTHROPIC_API_KEY) chain.push(callAnthropic);
  if (cfg.DEEPSEEK_API_KEY) chain.push(callDeepSeek);
  return chain;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Classify the relationship between two market questions.
 *
 * Checks Redis cache first. On miss, calls the first available LLM
 * provider (with fallback). Caches successful results.
 */
export async function classifyRelationship(
  questionA: string,
  questionB: string,
  redis: Redis,
  cacheTtlS: number,
): Promise<ClassificationResult> {
  // 1. Cache check.
  const key = cacheKey(questionA, questionB);
  const cached = await redis.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as ClassificationResult;
    } catch {
      // Stale/malformed cache entry — proceed to LLM call.
    }
  }

  // 2. Call providers in order until one succeeds.
  const chain = getProviderChain();
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(questionA, questionB);

  let lastError: string | undefined;
  for (const callProvider of chain) {
    try {
      const raw = await callProvider(systemPrompt, userPrompt);
      const result = parseClassification(raw);

      // Cache the result (even 'none' — prevents re-calling LLM on the same pair).
      await redis.set(key, JSON.stringify(result), 'EX', cacheTtlS).catch(() => {
        // Non-fatal cache write failure.
      });

      return result;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn('[correlation] LLM provider failed, trying next', {
        error: lastError,
        questionA: questionA.slice(0, 80),
        questionB: questionB.slice(0, 80),
      });
    }
  }

  // All providers failed — return 'none' so the discovery run continues.
  logger.error('[correlation] all LLM providers failed for pair', {
    error: lastError,
    questionA: questionA.slice(0, 80),
    questionB: questionB.slice(0, 80),
  });
  return { type: 'none', direction: null, reasoning: 'LLM classification failed' };
}

// Export for testing.
export { parseClassification, cacheKey, buildSystemPrompt, buildUserPrompt };
