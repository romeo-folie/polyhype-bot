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
import { getRedis } from '../shared/redis.js';
import { getRecentOutcomes, inferCategory } from '../shared/outcomeRecorder.js';
import { findSimilarCases, formatMemoryContext } from '../db/retrieval.js';
import {
  isProviderOpen,
  recordProviderFailure,
  recordProviderSuccess,
  type ProviderName,
} from './consensusBreaker.js';
import type { Redis } from 'ioredis';

const TIMEOUT_MS = 25_000;

/**
 * Tolerance for detecting the explicit 0.50 abstention anchor. The system
 * prompt instructs providers to return EXACTLY 0.50 when the headline is
 * unrelated to the market. A legitimate "genuinely 50/50" estimate is
 * indistinguishable from abstention at this tolerance — we accept that
 * tradeoff because the prompt contract makes exact 0.5 mean "I don't know",
 * and a real 50/50 market has no edge to trade anyway.
 */
const ABSTENTION_EPSILON = 0.001;

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

function buildSystemPrompt(mode?: 'near-zero', marketPrice?: number): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  if (mode === 'near-zero') {
    const pricePct = marketPrice != null ? `${(marketPrice * 100).toFixed(1)}¢` : 'very low';
    return (
      'You are a probabilistic analyst specialising in prediction markets. ' +
      `Today's date is ${today}. ` +
      'Given a prediction market question and context, estimate the true probability ' +
      '(0.00–1.00) that this market resolves YES. ' +
      `The market is currently priced at ${pricePct}, suggesting the market sees this as ` +
      'very unlikely. Assess whether fundamentals support a higher probability. ' +
      "Pay close attention to any deadlines in the market question relative to today's date. " +
      'Focus on: deadline proximity, structural factors, known information. ' +
      'Return ONLY a JSON object: {"probability": 0.72, "reasoning": "one sentence"} ' +
      'No markdown, no extra keys.'
    );
  }

  return (
    'You are a probabilistic analyst specialising in prediction markets. ' +
    `Today's date is ${today}. ` +
    'Given a market question, its description, and a breaking news headline, ' +
    'estimate the true probability (0.00–1.00) that the market resolves YES. ' +
    "Pay close attention to any deadlines in the market question relative to today's date. " +
    'IMPORTANT: If the news headline is totally UNRELATED to the market question, ' +
    'return the probability EXACTLY 0.50 to signal a neutral estimate without a specific edge. ' +
    'Return ONLY a JSON object: {"probability": 0.72, "reasoning": "one sentence explaining the link or lack thereof"} ' +
    'No markdown, no extra keys.'
  );
}

function buildUserPrompt(opts: {
  question: string;
  description: string | null;
  headline: string;
  endDateIso?: string | null | undefined;
}): string {
  // Surface days-to-deadline explicitly so the LLM can't miss the time horizon.
  // Fixes the "date-invariance" failure mode where the same Iran-conflict question
  // with April 30 / May 15 / June 30 variants all came back at ~0.48 regardless.
  let timeLine = '';
  if (opts.endDateIso) {
    const endMs = new Date(opts.endDateIso).getTime();
    if (isFinite(endMs)) {
      const days = Math.max(0, Math.round((endMs - Date.now()) / 86_400_000));
      const resolves = opts.endDateIso.slice(0, 10);
      timeLine = `Time to deadline: ${days.toString()} day${days === 1 ? '' : 's'} (resolves ${resolves}).\n`;
    }
  }
  return (
    `Market question: ${opts.question}\n` +
    `Market description: ${opts.description ?? 'N/A'}\n` +
    timeLine +
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
  promptMode?: 'near-zero',
  marketPrice?: number,
  endDateIso?: string | null,
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
          { role: 'system', content: buildSystemPrompt(promptMode, marketPrice) },
          {
            role: 'user',
            content: buildUserPrompt({ question, description, headline, endDateIso }),
          },
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 200,
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
  promptMode?: 'near-zero',
  marketPrice?: number,
  endDateIso?: string | null,
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
        system: buildSystemPrompt(promptMode, marketPrice),
        messages: [
          {
            role: 'user',
            content: buildUserPrompt({ question, description, headline, endDateIso }),
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
  promptMode?: 'near-zero',
  marketPrice?: number,
  endDateIso?: string | null,
): Promise<ConsensusResult> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genai = new GoogleGenerativeAI(loadConfig().GEMINI_API_KEY ?? '');
  const model = genai.getGenerativeModel({ model: loadConfig().GEMINI_MODEL });

  const prompt =
    `${buildSystemPrompt(promptMode, marketPrice)}\n\n` +
    buildUserPrompt({ question, description, headline, endDateIso });

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
  promptMode?: 'near-zero',
  marketPrice?: number,
  endDateIso?: string | null,
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
          { role: 'system', content: buildSystemPrompt(promptMode, marketPrice) },
          {
            role: 'user',
            content: buildUserPrompt({ question, description, headline, endDateIso }),
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
  mode?: 'near-zero';
  marketPrice?: number;
  endDateIso?: string | null;
}): Promise<ConsensusResult> {
  const cfg = loadConfig();
  const provider = cfg.LLM_PROVIDER;
  const useGemini = provider === 'gemini' && Boolean(cfg.GEMINI_API_KEY);
  const useOpenAI = Boolean(cfg.OPENAI_API_KEY);

  if (useGemini) {
    try {
      return await callGemini(opts.question, opts.description, opts.headline, opts.mode, opts.marketPrice, opts.endDateIso);
    } catch (err) {
      logger.warn('[consensus-calc] Gemini failed, trying OpenAI', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (useOpenAI) {
    try {
      return await callOpenAI(opts.question, opts.description, opts.headline, opts.mode, opts.marketPrice, opts.endDateIso);
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
        opts.mode,
        opts.marketPrice,
        opts.endDateIso,
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
        opts.mode,
        opts.marketPrice,
        opts.endDateIso,
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
 * Price is deliberately excluded — blind consensus means the same
 * question+headline always produces the same estimate regardless of market price.
 * Headline is trimmed to remove whitespace variation before slicing.
 */
function buildConsensusCacheKey(
  question: string,
  headline: string,
): string {
  const raw = `${question}|${headline.trim().slice(0, 200)}`;
  return 'consensus:' + createHash('sha256').update(raw).digest('hex');
}

export async function estimateConsensusProbability(opts: {
  question: string;
  description: string | null;
  headline: string;
  redis?: Redis;
  skipContextInjection?: boolean;
  mode?: 'near-zero';
  marketPrice?: number;
  /** ISO-8601 market resolution date. When provided, days-to-deadline is
   *  appended to the user prompt so the LLM can't miss the time horizon. */
  endDateIso?: string | null;
}): Promise<ConsensusEstimate> {
  const cfg = loadConfig();

  // Check consensus cache
  if (cfg.CONSENSUS_CACHE_ENABLED && opts.redis) {
    const cacheKey = buildConsensusCacheKey(opts.question, opts.headline);
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
  if (cfg.CONTEXT_INJECTION_ENABLED && opts.redis && !opts.skipContextInjection) {
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

  // Phase 5: Memory retrieval — prepend similar past trade cases to the LLM prompt.
  // Requires MEMORY_RETRIEVAL_ENABLED=true, PG_URL, and OPENAI_API_KEY.
  // Runs after Phase 8a context injection so outcome history + memory both appear.
  if (cfg.MEMORY_RETRIEVAL_ENABLED && !opts.skipContextInjection) {
    try {
      const category = inferCategory(opts.question);
      const cases = await findSimilarCases(opts.question, category, cfg.MEMORY_RETRIEVAL_LIMIT);
      const memBlock = formatMemoryContext(cases);
      if (memBlock) {
        enrichedHeadline = memBlock + enrichedHeadline;
      }
    } catch (err) {
      logger.warn('[consensus-calc] memory retrieval failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Call each configured provider exactly once — one vote per model, no duplicates.
  const useOpenAI = Boolean(cfg.OPENAI_API_KEY);
  const useGemini = Boolean(cfg.GEMINI_API_KEY);
  const useAnthropic = Boolean(cfg.ANTHROPIC_API_KEY);
  const useDeepSeek = Boolean(cfg.DEEPSEEK_API_KEY);
  type ProviderFn = (q: string, d: string | null, h: string, m?: 'near-zero', p?: number, e?: string | null) => Promise<ConsensusResult>;
  interface ProviderEntry { name: ProviderName; fn: ProviderFn }
  const allEntries: ProviderEntry[] = [
    ...(useOpenAI ? [{ name: 'openai' as const, fn: callOpenAI as ProviderFn }] : []),
    ...(useGemini ? [{ name: 'gemini' as const, fn: callGemini as ProviderFn }] : []),
    ...(useAnthropic ? [{ name: 'anthropic' as const, fn: callAnthropic as ProviderFn }] : []),
    ...(useDeepSeek ? [{ name: 'deepseek' as const, fn: callDeepSeek as ProviderFn }] : []),
  ];

  if (allEntries.length === 0) {
    throw new Error(
      'No LLM providers configured — set OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, or DEEPSEEK_API_KEY',
    );
  }

  // Skip providers whose circuit is currently open. On Redis error, isProviderOpen
  // returns false (fail-open) so we never silently drop all providers.
  const breakerRedis = getRedis();
  const entries: ProviderEntry[] = [];
  for (const entry of allEntries) {
    if (await isProviderOpen(breakerRedis, entry.name)) {
      logger.debug('[consensus-calc] provider circuit open, skipping', { provider: entry.name });
      continue;
    }
    entries.push(entry);
  }

  if (entries.length === 0) {
    throw new Error('All consensus provider circuits are open');
  }

  const settled = await Promise.allSettled(
    entries.map((entry) =>
      entry.fn(opts.question, opts.description, enrichedHeadline, opts.mode, opts.marketPrice, opts.endDateIso),
    ),
  );

  const results: number[] = [];
  let reasoning = '';

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const entry = entries[i];
    if (!outcome || !entry) continue;
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value.probability);
      if (reasoning === '') reasoning = outcome.value.reasoning;
      void recordProviderSuccess(breakerRedis, entry.name);
    } else {
      logger.warn('[consensus-calc] sample failed', {
        provider: entry.name,
        error: sanitiseError(outcome.reason),
      });
      void recordProviderFailure(breakerRedis, entry.name);
    }
  }

  if (results.length === 0) throw new Error('All consensus samples failed');

  // Abstention filter: the system prompt instructs providers to return EXACTLY
  // 0.50 when the headline is unrelated to the market question. Treating that
  // anchor as a regular vote biases the mean toward 0.5 and synthetically
  // inflates stddev — producing quantized (mean, stddev) pairs that repeat
  // across unrelated questions (e.g. {0.5, 0.85, 0.85} → 0.733 ± 0.202 lands
  // on three different markets that share the pattern). Filter abstentions
  // before aggregating; downstream `consensusMinSamples` naturally catches
  // the case where too few real votes remain.
  const realVotes = results.filter((p) => Math.abs(p - 0.5) > ABSTENTION_EPSILON);
  const abstentionCount = results.length - realVotes.length;
  if (abstentionCount > 0) {
    logger.info('[consensus-calc] abstentions filtered', {
      totalProviders: results.length,
      abstentions: abstentionCount,
      realVotes: realVotes.length,
    });
  }

  // All providers abstained → unrelated headline. Return 0.5 with
  // sampleCount=0 so downstream insufficient_samples / anchor_collapse gates
  // reject cleanly instead of the panel pretending it has a signal.
  if (realVotes.length === 0) {
    const estimate: ConsensusEstimate = {
      probability: 0.5,
      reasoning: reasoning || 'All providers abstained (unrelated headline).',
      stddev: 0,
      sampleCount: 0,
    };
    return estimate;
  }

  const mean = realVotes.reduce((a, b) => a + b, 0) / realVotes.length;
  // Unbiased sample variance (Bessel-corrected: divide by n-1). With n=1 we
  // can't measure dispersion — return Infinity so downstream stddev-based
  // gates (noise gate, pessimistic EV) treat it as maximally uncertain.
  const stddev =
    realVotes.length < 2
      ? Infinity
      : Math.sqrt(
          realVotes.reduce((s, x) => s + (x - mean) ** 2, 0) / (realVotes.length - 1),
        );

  // Log when we're running in degraded regime — fewer providers returning than
  // the configured target means stddev-based gates behave differently than when
  // tuned. Surfaces silent provider degradation.
  const targetSamples = cfg.CONSENSUS_TARGET_SAMPLES;
  if (realVotes.length < targetSamples) {
    logger.warn('[consensus-calc] degraded regime', {
      sampleCount: realVotes.length,
      targetSamples,
      stddev: Number.isFinite(stddev) ? stddev.toFixed(4) : 'inf',
    });
  }

  const estimate: ConsensusEstimate = {
    probability: mean,
    reasoning,
    stddev,
    sampleCount: realVotes.length,
  };

  // Cache the result
  if (cfg.CONSENSUS_CACHE_ENABLED && opts.redis) {
    const cacheKey = buildConsensusCacheKey(opts.question, opts.headline);
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

  // Redis cache check
  const sentimentCacheKey = 'sentiment:' + createHash('sha256').update(headline.trim()).digest('hex');
  try {
    const cached = await getRedis().get(sentimentCacheKey);
    if (cached === 'LONG' || cached === 'SHORT' || cached === 'NEUTRAL') {
      return cached;
    }
  } catch {
    // cache read failed — fall through to LLM
  }

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
          max_completion_tokens: 10,
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

  let result: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  if (raw.includes('POSITIVE')) result = 'LONG';
  else if (raw.includes('NEGATIVE')) result = 'SHORT';

  // Cache the result
  try {
    await getRedis().set(sentimentCacheKey, result, 'EX', cfg.SENTIMENT_CACHE_TTL_S);
  } catch {
    // cache write failed — non-fatal
  }

  return result;
}
