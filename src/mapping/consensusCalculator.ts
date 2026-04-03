/**
 * Consensus probability calculator.
 *
 * Given a market question, the triggering news headline, and the market description,
 * asks an LLM: "What is the true probability this market resolves YES?"
 *
 * Returns a number in [0, 1].
 */

import { createHash } from 'node:crypto';
import type { OpenAI as OpenAIType } from 'openai';
import type { GoogleGenerativeAI as GoogleGenerativeAIType } from '@google/generative-ai';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getRecentOutcomes, inferCategory } from '../shared/outcomeRecorder.js';
import type { Redis } from 'ioredis';

const TIMEOUT_MS = 25_000;

/**
 * Extract a safe error message from any thrown value.
 * Axios errors include the full request config (headers, auth keys) in String(err).
 * We only log err.message — never the full object — to prevent credential leaks.
 */
function sanitiseError(err: unknown): string {
  if (err instanceof Error) {
    // Axios errors carry request config (potentially with auth headers) in err.config.
    // Only return the message — never serialise the full error object.
    return err.message;
  }
  // Guard against non-Error objects (e.g. Axios response objects) that may contain
  // sensitive headers or auth tokens when serialised.
  if (typeof err === 'object' && err !== null) {
    // Extract message without mutating the original error object.
    // Axios errors embed request config (with auth headers) — never serialise the full object.
    const axiosErr = err as Record<string, unknown>;
    const msg = axiosErr.message;
    if (typeof msg === 'string') return msg;
    return '[non-Error object thrown — message unavailable]';
  }
  return String(err);
}

function buildSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return (
    'You are a probabilistic analyst specialising in prediction markets. ' +
    `Today's date is ${today}. ` +
    'Given a market question, its description, and a breaking news headline, ' +
    'estimate the true probability (0.00–1.00) that the market resolves YES. ' +
    "Pay close attention to any deadlines in the market question relative to today's date. " +
    'IMPORTANT: If the news headline is totally UNRELATED to the market question, ' +
    'return the probability EXACTLY EQUAL to the current market price to signal neutral edge. ' +
    'Return ONLY a JSON object: {"probability": 0.72, "reasoning": "one sentence explaining the link or lack thereof"} ' +
    'No markdown, no extra keys.'
  );
}

function buildUserPrompt(opts: {
  question: string;
  description: string | null;
  headline: string;
  currentYesPrice: number;
}): string {
  return (
    `Market question: ${opts.question}\n` +
    `Market description: ${opts.description ?? 'N/A'}\n` +
    `Current market YES price: ${(opts.currentYesPrice * 100).toFixed(1)}%\n` +
    `Breaking news: ${opts.headline}`
  );
}

interface ConsensusResult {
  probability: number;
  reasoning: string;
}

async function callOpenAI(
  question: string,
  description: string | null,
  headline: string,
  currentYesPrice: number,
): Promise<ConsensusResult> {
  const { OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: loadConfig().OPENAI_API_KEY });

  const abortCtrl = new AbortController();
  const abortTimer = setTimeout(() => { abortCtrl.abort(); }, TIMEOUT_MS);
  let completion: Awaited<ReturnType<typeof client.chat.completions.create>>;
  try {
    completion = await client.chat.completions.create(
      {
        model: loadConfig().OPENAI_MODEL,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          {
            role: 'user',
            content: buildUserPrompt({ question, description, headline, currentYesPrice }),
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 200,
        temperature: 0,
      },
      { signal: abortCtrl.signal },
    );
  } finally {
    clearTimeout(abortTimer);
  }

  const raw = completion.choices[0]?.message?.content ?? '{}';
  return parseResult(raw);
}

async function callAnthropic(
  question: string,
  description: string | null,
  headline: string,
  currentYesPrice: number,
): Promise<ConsensusResult> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: loadConfig().ANTHROPIC_API_KEY });

  const abortCtrl = new AbortController();
  const abortTimer = setTimeout(() => { abortCtrl.abort(); }, TIMEOUT_MS);
  let completion: Awaited<ReturnType<typeof client.messages.create>>;
  try {
    completion = await client.messages.create(
      {
        model: loadConfig().ANTHROPIC_MODEL,
        max_tokens: 200,
        system: buildSystemPrompt(),
        messages: [
          {
            role: 'user',
            content: buildUserPrompt({ question, description, headline, currentYesPrice }),
          },
        ],
        temperature: 0,
      },
      { signal: abortCtrl.signal } as Parameters<typeof client.messages.create>[1],
    );
  } finally {
    clearTimeout(abortTimer);
  }

  const raw = completion.content[0]?.type === 'text' ? completion.content[0].text : '{}';
  return parseResult(raw);
}

async function callGemini(
  question: string,
  description: string | null,
  headline: string,
  currentYesPrice: number,
): Promise<ConsensusResult> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genai = new GoogleGenerativeAI(loadConfig().GEMINI_API_KEY ?? '');
  const model = genai.getGenerativeModel({ model: loadConfig().GEMINI_MODEL });

  const prompt =
    `${buildSystemPrompt()}\n\n` +
    buildUserPrompt({ question, description, headline, currentYesPrice });

  const result = await Promise.race([
    model.generateContent(prompt),
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error('Gemini timeout'));
      }, TIMEOUT_MS),
    ),
  ]);

  const raw = result.response
    .text()
    .replace(/```(?:json)?\s*/g, '')
    .replace(/```/g, '')
    .trim();
  return parseResult(raw);
}

async function callDeepSeek(
  question: string,
  description: string | null,
  headline: string,
  currentYesPrice: number,
): Promise<ConsensusResult> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({
    apiKey: loadConfig().DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com',
  });

  const abortCtrl = new AbortController();
  const abortTimer = setTimeout(() => { abortCtrl.abort(); }, TIMEOUT_MS);
  let completion: Awaited<ReturnType<typeof client.chat.completions.create>>;
  try {
    completion = await client.chat.completions.create(
      {
        model: loadConfig().DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          {
            role: 'user',
            content: buildUserPrompt({ question, description, headline, currentYesPrice }),
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 200,
        temperature: 0,
      },
      { signal: abortCtrl.signal },
    );
  } finally {
    clearTimeout(abortTimer);
  }

  const raw = completion.choices[0]?.message?.content ?? '{}';
  return parseResult(raw);
}

function parseResult(raw: string): ConsensusResult {
  const cleaned = raw
    .replace(/```(?:json)?\s*/g, '')
    .replace(/```/g, '')
    .trim();
  const parsed = JSON.parse(cleaned) as { probability?: unknown; reasoning?: unknown };
  const probability = Number(parsed.probability);
  if (!isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error(`Invalid probability: ${String(parsed.probability)}`);
  }
  return {
    probability,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
  };
}

export interface ConsensusEstimate {
  probability: number; // mean across N runs
  reasoning: string; // reasoning from first call
  stddev: number; // standard deviation across N runs
  sampleCount: number; // how many calls succeeded
}

/** Single-call estimate — tries Gemini first, falls back to OpenAI, then Anthropic, then DeepSeek. */
async function _estimateSingle(opts: {
  question: string;
  description: string | null;
  headline: string;
  currentYesPrice: number;
}): Promise<ConsensusResult> {
  const cfg = loadConfig();
  const provider = cfg.LLM_PROVIDER;
  const useGemini = provider === 'gemini' && Boolean(cfg.GEMINI_API_KEY);
  const useOpenAI = Boolean(cfg.OPENAI_API_KEY);

  if (useGemini) {
    try {
      return await callGemini(opts.question, opts.description, opts.headline, opts.currentYesPrice);
    } catch (err) {
      logger.warn('[consensus-calc] Gemini failed, trying OpenAI', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (useOpenAI) {
    try {
      return await callOpenAI(opts.question, opts.description, opts.headline, opts.currentYesPrice);
    } catch (err) {
      logger.warn('[consensus-calc] OpenAI failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const useAnthropic = Boolean(cfg.ANTHROPIC_API_KEY);
  if (useAnthropic) {
    try {
      return await callAnthropic(
        opts.question,
        opts.description,
        opts.headline,
        opts.currentYesPrice,
      );
    } catch (err) {
      logger.warn('[consensus-calc] Anthropic failed, trying DeepSeek', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (cfg.DEEPSEEK_API_KEY) {
    try {
      return await callDeepSeek(
        opts.question,
        opts.description,
        opts.headline,
        opts.currentYesPrice,
      );
    } catch (err) {
      logger.warn('[consensus-calc] DeepSeek failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw new Error(
    'No LLM provider configured (OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, or DEEPSEEK_API_KEY required)',
  );
}

/**
 * Estimate the true YES probability for a market given a triggering headline.
 *
 * Calls each configured LLM provider once and returns mean + stddev for confidence gating.
 * Each provider gets one vote — no duplicates. Supports OpenAI, Gemini, Anthropic, and DeepSeek.
 */
/**
 * Build a stable cache key for a consensus estimate.
 * - Price is bucketed to 0.05 increments to tolerate minor market drift.
 * - Headline is trimmed to remove whitespace variation before slicing.
 */
function buildConsensusCacheKey(
  question: string,
  headline: string,
  currentYesPrice: number,
): string {
  const priceBucket = Math.round(currentYesPrice / 0.05) * 0.05;
  const raw = `${question}|${headline.trim().slice(0, 200)}|${priceBucket.toFixed(2)}`;
  return 'consensus:' + createHash('sha256').update(raw).digest('hex');
}

export async function estimateConsensusProbability(opts: {
  question: string;
  description: string | null;
  headline: string;
  currentYesPrice: number;
  redis?: Redis;
}): Promise<ConsensusEstimate> {
  const cfg = loadConfig();

  // Check consensus cache
  if (cfg.CONSENSUS_CACHE_ENABLED && opts.redis) {
    const cacheKey = buildConsensusCacheKey(opts.question, opts.headline, opts.currentYesPrice);
    try {
      const cached = await opts.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as ConsensusEstimate;
      }
    } catch {
      // cache read failed — fall through to LLM
    }
  }

  // Phase 8a: Context injection — prepend recent outcomes to headline
  let enrichedHeadline = opts.headline;
  if (cfg.CONTEXT_INJECTION_ENABLED && opts.redis) {
    try {
      const category = inferCategory(opts.question);
      const outcomes = await getRecentOutcomes(opts.redis, category, cfg.CONTEXT_INJECTION_LIMIT);
      if (outcomes.length >= 3) {
        const contextBlock =
          `Recent track record on ${category} signals (last ${outcomes.length.toString()} closed positions):\n` +
          outcomes
            .map(
              (o) =>
                `• "${o.question.slice(0, 100)}" → ${o.direction} at ${(o.consensusProbability * 100).toFixed(0)}% confidence → ${o.result.toUpperCase()} (${o.returnPct >= 0 ? '+' : ''}${o.returnPct.toFixed(1)}% in ${o.holdingHours.toFixed(1)}h)`,
            )
            .join('\n') +
          '\n\nUse this track record to calibrate your estimate. Adjust probability up or down based on patterns you observe.\n\n';
        enrichedHeadline = contextBlock + opts.headline;
      }
    } catch (err) {
      logger.warn('[consensus-calc] context injection failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Call each configured provider exactly once — one vote per model, no duplicates.
  const useOpenAI = Boolean(cfg.OPENAI_API_KEY);
  const useGemini = Boolean(cfg.GEMINI_API_KEY);
  const useAnthropic = Boolean(cfg.ANTHROPIC_API_KEY);
  const useDeepSeek = Boolean(cfg.DEEPSEEK_API_KEY);
  type ProviderFn = (q: string, d: string | null, h: string, p: number) => Promise<ConsensusResult>;
  const providers: ProviderFn[] = [
    ...(useOpenAI ? [callOpenAI as ProviderFn] : []),
    ...(useGemini ? [callGemini as ProviderFn] : []),
    ...(useAnthropic ? [callAnthropic as ProviderFn] : []),
    ...(useDeepSeek ? [callDeepSeek as ProviderFn] : []),
  ];

  if (providers.length === 0) {
    throw new Error(
      'No LLM providers configured — set OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, or DEEPSEEK_API_KEY',
    );
  }
  const calls = providers.map((provider) =>
    provider(opts.question, opts.description, enrichedHeadline, opts.currentYesPrice),
  );

  const settled = await Promise.allSettled(calls);

  const results: number[] = [];
  let reasoning = '';

  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value.probability);
      if (reasoning === '') reasoning = outcome.value.reasoning;
    } else {
      logger.warn('[consensus-calc] sample failed', {
        error: sanitiseError(outcome.reason),
      });
    }
  }

  if (results.length === 0) throw new Error('All consensus samples failed');

  const mean = results.reduce((a, b) => a + b, 0) / results.length;
  const variance = results.reduce((s, x) => s + (x - mean) ** 2, 0) / results.length;
  const stddev = Math.sqrt(variance);

  const estimate: ConsensusEstimate = {
    probability: mean,
    reasoning,
    stddev,
    sampleCount: results.length,
  };

  // Cache the result
  if (cfg.CONSENSUS_CACHE_ENABLED && opts.redis) {
    const cacheKey = buildConsensusCacheKey(opts.question, opts.headline, opts.currentYesPrice);
    try {
      await opts.redis.set(cacheKey, JSON.stringify(estimate), 'EX', cfg.CONSENSUS_CACHE_TTL_S);
    } catch {
      // cache write failed — non-fatal
    }
  }

  return estimate;
}

// Module-level singleton clients — created once, reused across all estimateSentiment calls.
// Module-level singleton clients — lazy-initialized on first use, reused thereafter.
// Key rotation: compare current env var to the key used at last construction; recreate if changed.
let _sentimentOpenAIClient: OpenAIType | null = null;
let _sentimentOpenAIKey: string | null = null;
let _sentimentGeminiClient: GoogleGenerativeAIType | null = null;
let _sentimentGeminiKey: string | null = null;

async function getSentimentOpenAI(): Promise<OpenAIType> {
  const currentKey = loadConfig().OPENAI_API_KEY ?? null;
  if (!_sentimentOpenAIClient || currentKey !== _sentimentOpenAIKey) {
    const { OpenAI } = await import('openai');
    _sentimentOpenAIClient = new OpenAI({ apiKey: currentKey ?? undefined });
    _sentimentOpenAIKey = currentKey;
  }
  return _sentimentOpenAIClient;
}

async function getSentimentGemini(): Promise<GoogleGenerativeAIType> {
  const currentKey = loadConfig().GEMINI_API_KEY ?? null;
  if (!_sentimentGeminiClient || currentKey !== _sentimentGeminiKey) {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    _sentimentGeminiClient = new GoogleGenerativeAI(currentKey ?? '');
    _sentimentGeminiKey = currentKey;
  }
  return _sentimentGeminiClient;
}

/**
 * Rapid sentiment check for futures trading.
 * Performs a single-call zero-shot classification: POSITIVE, NEGATIVE, or NEUTRAL.
 * LLM clients are created once and reused across calls.
 */
export async function estimateSentiment(headline: string): Promise<'LONG' | 'SHORT' | 'NEUTRAL'> {
  const cfg = loadConfig();
  const useGemini = cfg.LLM_PROVIDER === 'gemini' && Boolean(cfg.GEMINI_API_KEY);
  const useOpenAI = Boolean(cfg.OPENAI_API_KEY);

  const system =
    'You are a high-speed financial sentiment classifier. ' +
    'Classify the given headline as POSITIVE or NEGATIVE for the relevant asset. ' +
    'If the impact is ambiguous or insignificant, return NEUTRAL. ' +
    'Return ONLY the word: POSITIVE, NEGATIVE, or NEUTRAL.';

  /** Hard timeout for sentiment calls — must not block the futures pipeline. */
  const SENTIMENT_TIMEOUT_MS = 10_000;

  let raw = '';
  let sentimentTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      sentimentTimer = setTimeout(
        () => { reject(new Error('estimateSentiment timeout')); },
        SENTIMENT_TIMEOUT_MS,
      );
    });

    if (useGemini) {
      const genai = await getSentimentGemini();
      const model = genai.getGenerativeModel({ model: cfg.GEMINI_MODEL });
      const prompt = `${system}\n\nHeadline: ${headline}`;
      const result = await Promise.race([model.generateContent(prompt), timeoutPromise]);
      raw = result.response.text().trim().toUpperCase();
    } else if (useOpenAI) {
      const client = await getSentimentOpenAI();
      const completion = await Promise.race([
        client.chat.completions.create({
          model: cfg.OPENAI_MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: headline },
          ],
          max_tokens: 10,
          temperature: 0,
        }),
        timeoutPromise,
      ]);
      raw = (completion.choices[0]?.message?.content ?? '').trim().toUpperCase();
    }
  } catch (err) {
    logger.warn('[sentiment-calc] LLM failed or timed out, falling back to NEUTRAL', {
      error: String(err),
    });
    return 'NEUTRAL';
  } finally {
    clearTimeout(sentimentTimer);
  }

  if (raw.includes('POSITIVE')) return 'LONG';
  if (raw.includes('NEGATIVE')) return 'SHORT';
  return 'NEUTRAL';
}
