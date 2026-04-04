/**
 * Relevance Gate utility.
 *
 * Uses a fast, low-token LLM (Gemini 1.5 Flash) to confirm if a news headline
 * is directly relevant to a Polymarket question before proceeding to
 * expensive consensus estimation.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';

/** Hard timeout for relevance check — must stay high-speed. */
const RELEVANCE_TIMEOUT_MS = 10_000;

// Reusable provider clients
let _genai: GoogleGenerativeAI | null = null;
let _genaiKey: string | null = null;

/**
 * Checks if a news headline is directly relevant to a market question.
 * Uses Gemini 1.5 Flash for high-speed zero-shot classification.
 */
export async function isMarketRelevant(opts: {
  headline: string;
  question: string;
  description: string | null;
}): Promise<boolean> {
  const cfg = loadConfig();

  const systemPrompt =
    'You are a high-speed relevance classifier for prediction markets. ' +
    'Identify if the provided news headline is DIRECTLY RELEVANT to the market question. ' +
    'A headline is relevant if it provides information that would likely change ' +
    'a rational person\'s probability estimate for that market. ' +
    'Return ONLY the word "YES" or "NO".';

  const userPrompt =
    `Market Question: "${opts.question}"\n` +
    `Market Description: "${opts.description ?? 'N/A'}"\n` +
    `News Headline: "${opts.headline}"\n` +
    'Is this headline directly relevant to this market?';

  // 1. Prioritized list of providers for high-speed gating
  const providers: Array<{
    name: string;
    apiKey: string | undefined;
    call: () => Promise<string>;
  }> = [
    {
      name: 'Gemini',
      apiKey: cfg.GEMINI_API_KEY,
      call: async () => {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        if (!_genai || cfg.GEMINI_API_KEY !== _genaiKey) {
          _genai = new GoogleGenerativeAI(cfg.GEMINI_API_KEY!);
          _genaiKey = cfg.GEMINI_API_KEY!;
        }
        const model = _genai.getGenerativeModel({ model: cfg.GEMINI_MODEL });
        const result = await Promise.race([
          model.generateContent(`${systemPrompt}\n\n${userPrompt}`),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Gemini timeout')), RELEVANCE_TIMEOUT_MS)
          ),
        ]);
        return result.response.text();
      },
    },
    {
      name: 'OpenAI',
      apiKey: cfg.OPENAI_API_KEY,
      call: async () => {
        const { default: OpenAI } = await import('openai');
        const openai = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });
        const completion = await openai.chat.completions.create({
          model: cfg.OPENAI_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0,
          max_tokens: 5,
        }, { timeout: RELEVANCE_TIMEOUT_MS });
        return completion.choices[0]?.message.content ?? '';
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
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 5,
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
          max_tokens: 5,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          temperature: 0,
        }, { timeout: RELEVANCE_TIMEOUT_MS });
        return completion.content[0]?.type === 'text' ? completion.content[0].text : '';
      },
    },
  ];

  // 2. Sequential fallback across available providers
  for (const provider of providers) {
    if (!provider.apiKey) continue;

    try {
      const resultText = await provider.call();
      const raw = resultText.trim().toUpperCase();
      const relevant = raw.includes('YES');

      if (!relevant) {
        logger.info('[relevance-gate] market rejected — irrelevant headline', {
          headline: opts.headline,
          question: opts.question,
          provider: provider.name,
          reason: 'Hard strictness: LLM identified no direct link',
        });
      }

      return relevant;
    } catch (err) {
      logger.warn(`[relevance-gate] ${provider.name} failed, falling back`, {
        error: err instanceof Error ? err.message : String(err),
      });
      // Continue to next provider in loop
    }
  }

  // 3. Fail-open if all configured providers fail or none are configured
  logger.warn('[relevance-gate] all providers failed or none configured, skipping (fail-open)');
  return true;
}
