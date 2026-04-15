/**
 * Relevance Gate utility.
 *
 * Uses a fast, low-token LLM (Gemini 1.5 Flash) to assign a 0..1 fit score
 * for how directly a headline bears on a Polymarket question's specific
 * outcome. Callers can either rank candidates by score (top-fit selection)
 * or use the thin isMarketRelevant() boolean wrapper that applies the
 * RELEVANCE_MIN_FIT_SCORE threshold.
 */

import { createHash } from 'node:crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getRedis } from '../shared/redis.js';

/** Hard timeout for relevance check — must stay high-speed. */
const RELEVANCE_TIMEOUT_MS = 10_000;
/** Fallback score when LLM output can't be parsed or all providers fail. */
const FIT_SCORE_FAIL_OPEN = 0.5;

// Reusable provider clients
let _genai: GoogleGenerativeAI | null = null;
let _genaiKey: string | null = null;

export interface MarketRelevanceScore {
  fitScore: number;
  reason: 'cache' | 'llm' | 'parse_fallback' | 'fail_open';
  provider?: string;
}

export const SYSTEM_PROMPT =
  'You are a relevance scorer for prediction markets. ' +
  'Rate how directly the news headline bears on the SPECIFIC OUTCOME asked about ' +
  'in the market question. Sharing a named entity (person, country, company) is NOT enough — ' +
  'the headline must bear on the exact outcome. ' +
  'Return ONLY a single number between 0.00 and 1.00 with no commentary. Anchors: ' +
  '0.00 = unrelated. ' +
  '0.30 = shares an entity but doesn\'t affect the specific outcome (e.g. "Trump threatens Iran" for "Trump out as President?"). ' +
  '0.50 = on-topic and within the outcome\'s domain, plausible causal chain but many independent factors determine it (e.g. "Trump threatens to blockade Iran" for "Will the U.S. invade Iran?"). ' +
  '0.70 = clear causal chain but indirect (e.g. "Supreme Court sides with DOJ in Trump case" for "Trump out as President?"). ' +
  '1.00 = direct material bearing on the outcome (e.g. "Senate votes to remove Trump" for "Trump out as President?").';

function buildUserPrompt(opts: { headline: string; question: string; description: string | null }): string {
  return (
    `Market Question: "${opts.question}"\n` +
    `Market Description: "${opts.description ?? 'N/A'}"\n` +
    `News Headline: "${opts.headline}"\n` +
    'Score:'
  );
}

/** Extract the first float in [0,1] from a possibly-noisy LLM response. Clamps to [0,1]. */
export function parseFitScore(raw: string): number | null {
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = parseFloat(match[0]);
  if (!isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function buildProviders(cfg: ReturnType<typeof loadConfig>, userPrompt: string) {
  // Order matters: first provider with an apiKey is used; the rest are
  // fallbacks only. OpenAI is primary because Gemini 2.5-flash has been
  // observed scoring genuinely-relevant headline↔market pairs conservatively
  // (median 0.00, max 0.30 on Iran war news vs. Iran regime markets over a
  // 6.5h sample on 2026-04-15), which stalled the pipeline at the fit gate.
  return [
    {
      name: 'OpenAI',
      apiKey: cfg.OPENAI_API_KEY,
      call: async () => {
        const { default: OpenAI } = await import('openai');
        const openai = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });
        const completion = await openai.chat.completions.create({
          model: cfg.OPENAI_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0,
          max_tokens: 10,
        }, { timeout: RELEVANCE_TIMEOUT_MS });
        return completion.choices[0]?.message.content ?? '';
      },
    },
    {
      name: 'Gemini',
      apiKey: cfg.GEMINI_API_KEY,
      call: async () => {
        if (!_genai || cfg.GEMINI_API_KEY !== _genaiKey) {
          _genai = new GoogleGenerativeAI(cfg.GEMINI_API_KEY!);
          _genaiKey = cfg.GEMINI_API_KEY!;
        }
        const model = _genai.getGenerativeModel({ model: cfg.GEMINI_MODEL });
        const result = await Promise.race([
          model.generateContent(`${SYSTEM_PROMPT}\n\n${userPrompt}`),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Gemini timeout')), RELEVANCE_TIMEOUT_MS)
          ),
        ]);
        return result.response.text();
      },
    },
    {
      name: 'DeepSeek',
      apiKey: cfg.DEEPSEEK_API_KEY,
      call: async () => {
        const { default: OpenAI } = await import('openai');
        const client = new OpenAI({
          apiKey: cfg.DEEPSEEK_API_KEY,
          baseURL: 'https://api.deepseek.com',
        });
        const completion = await client.chat.completions.create({
          model: cfg.DEEPSEEK_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0,
          max_tokens: 10,
        }, { timeout: RELEVANCE_TIMEOUT_MS });
        return completion.choices[0]?.message.content ?? '';
      },
    },
    {
      name: 'Anthropic',
      apiKey: cfg.ANTHROPIC_API_KEY,
      call: async () => {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
        const completion = await client.messages.create({
          model: cfg.ANTHROPIC_MODEL,
          max_tokens: 10,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
          temperature: 0,
        }, { timeout: RELEVANCE_TIMEOUT_MS });
        return completion.content[0]?.type === 'text' ? completion.content[0].text : '';
      },
    },
  ];
}

/**
 * Scores a headline's relevance to a market question on a 0..1 scale.
 * Ranking callers (e.g. strict top-fit candidate selection) sort by this score;
 * boolean callers use isMarketRelevant() which wraps this against RELEVANCE_MIN_FIT_SCORE.
 */
export async function scoreMarketRelevance(opts: {
  headline: string;
  question: string;
  description: string | null;
}): Promise<MarketRelevanceScore> {
  const cfg = loadConfig();
  const userPrompt = buildUserPrompt(opts);

  // 0. Redis cache check — v2: stores numeric score, not 0/1 boolean.
  const cacheRaw = `${opts.question}|${opts.headline.trim().slice(0, 200)}`;
  const cacheKey = 'relevance:v2:' + createHash('sha256').update(cacheRaw).digest('hex');
  try {
    const cached = await getRedis().get(cacheKey);
    if (cached !== null) {
      const n = parseFloat(cached);
      if (isFinite(n)) return { fitScore: Math.max(0, Math.min(1, n)), reason: 'cache' };
    }
  } catch {
    // cache read failed — fall through to LLM
  }

  const providers = buildProviders(cfg, userPrompt);

  for (const provider of providers) {
    if (!provider.apiKey) continue;

    try {
      const resultText = await provider.call();
      const parsed = parseFitScore(resultText.trim());
      const fitScore = parsed ?? FIT_SCORE_FAIL_OPEN;
      const reason: MarketRelevanceScore['reason'] = parsed === null ? 'parse_fallback' : 'llm';

      if (parsed === null) {
        logger.warn('[relevance-gate] failed to parse fit score, falling back', {
          provider: provider.name,
          raw: resultText.slice(0, 80),
        });
      }

      // Only cache parsed LLM scores — don't persist the parse-fallback fallback
      // value, or a transient provider hiccup would poison the cache for an hour.
      if (parsed !== null) {
        try {
          await getRedis().set(cacheKey, fitScore.toFixed(3), 'EX', cfg.RELEVANCE_CACHE_TTL_S);
        } catch {
          // cache write failed — non-fatal
        }
      }

      if (fitScore < cfg.RELEVANCE_MIN_FIT_SCORE) {
        logger.info('[relevance-gate] low fit score', {
          headline: opts.headline,
          question: opts.question,
          provider: provider.name,
          fitScore: fitScore.toFixed(3),
          threshold: cfg.RELEVANCE_MIN_FIT_SCORE,
        });
      }

      return { fitScore, reason, provider: provider.name };
    } catch (err) {
      logger.warn(`[relevance-gate] ${provider.name} failed, falling back`, {
        error: err instanceof Error ? err.message : String(err),
      });
      // Continue to next provider in loop
    }
  }

  // Fail-open if all configured providers fail or none are configured.
  // Scoring callers (strict top-fit) look at `reason === 'fail_open'` explicitly
  // if they need the old permissive behavior; the isMarketRelevant() boolean
  // wrapper already short-circuits on this reason to preserve prior semantics
  // regardless of the configured RELEVANCE_MIN_FIT_SCORE threshold.
  logger.warn('[relevance-gate] all providers failed or none configured, failing open');
  return { fitScore: FIT_SCORE_FAIL_OPEN, reason: 'fail_open' };
}

/**
 * Thin boolean wrapper for callers that just need a yes/no relevance decision.
 * Applies RELEVANCE_MIN_FIT_SCORE threshold to the underlying fit score, but
 * explicitly fails open (returns true) when every provider was unreachable —
 * matching the prior boolean implementation regardless of threshold value.
 */
export async function isMarketRelevant(opts: {
  headline: string;
  question: string;
  description: string | null;
}): Promise<boolean> {
  const cfg = loadConfig();
  const { fitScore, reason } = await scoreMarketRelevance(opts);
  if (reason === 'fail_open') return true;
  return fitScore >= cfg.RELEVANCE_MIN_FIT_SCORE;
}
