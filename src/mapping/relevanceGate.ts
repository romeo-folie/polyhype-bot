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

let _genai: GoogleGenerativeAI | null = null;
let _genaiKey: string | null = null;

function getGenAI(): GoogleGenerativeAI {
  const currentKey = loadConfig().GEMINI_API_KEY ?? null;
  if (!_genai || currentKey !== _genaiKey) {
    _genai = new GoogleGenerativeAI(currentKey ?? '');
    _genaiKey = currentKey;
  }
  return _genai;
}

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
  if (!cfg.GEMINI_API_KEY) {
    logger.warn('[relevance-gate] GEMINI_API_KEY missing, skipping gate (fail-open)');
    return true;
  }

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

  try {
    const genai = getGenAI();
    // Use gemini-1.5-flash specifically for speed and cost.
    const model = genai.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const result = await Promise.race([
      model.generateContent(`${systemPrompt}\n\n${userPrompt}`),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(new Error('RelevanceGate timeout'));
        }, RELEVANCE_TIMEOUT_MS),
      ),
    ]);

    const raw = result.response.text().trim().toUpperCase();
    const relevant = raw.includes('YES');

    if (!relevant) {
      logger.info('[relevance-gate] market rejected — irrelevant headline', {
        headline: opts.headline,
        question: opts.question,
        reason: 'Hard strictness: LLM identified no direct link',
      });
    }

    return relevant;
  } catch (err) {
    logger.warn('[relevance-gate] check failed, falling back to YES (fail-open)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return true; // Fail-open to avoid missing trades on API errors
  }
}
