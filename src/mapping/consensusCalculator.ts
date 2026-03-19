/**
 * Consensus probability calculator.
 *
 * Given a market question, the triggering news headline, and the market description,
 * asks an LLM: "What is the true probability this market resolves YES?"
 *
 * Returns a number in [0, 1].
 */

import { logger } from '../shared/logger.js';

const TIMEOUT_MS = 25_000;

const SYSTEM_PROMPT =
  'You are a probabilistic analyst specialising in prediction markets. ' +
  'Given a market question, its description, and a relevant breaking news headline, ' +
  'estimate the true probability (0.00–1.00) that the market resolves YES. ' +
  'Account for the current market price only as a weak prior — focus on the news. ' +
  'Return ONLY a JSON object: {"probability": 0.72, "reasoning": "one sentence"} ' +
  'No markdown, no extra keys.';

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
  const client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] });

  const completion = await client.chat.completions.create(
    {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildUserPrompt({ question, description, headline, currentYesPrice }),
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 200,
      temperature: 0.1,
    },
    { signal: AbortSignal.timeout(TIMEOUT_MS) },
  );

  const raw = completion.choices[0]?.message?.content ?? '{}';
  return parseResult(raw);
}

async function callGemini(
  question: string,
  description: string | null,
  headline: string,
  currentYesPrice: number,
): Promise<ConsensusResult> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genai = new GoogleGenerativeAI(process.env['GEMINI_API_KEY'] ?? '');
  const model = genai.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const prompt =
    `${SYSTEM_PROMPT}\n\n` +
    buildUserPrompt({ question, description, headline, currentYesPrice });

  const result = await Promise.race([
    model.generateContent(prompt),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Gemini timeout')), TIMEOUT_MS),
    ),
  ]);

  const raw = result.response.text().replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
  return parseResult(raw);
}

function parseResult(raw: string): ConsensusResult {
  const parsed = JSON.parse(raw) as { probability?: unknown; reasoning?: unknown };
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
  probability: number;
  reasoning: string;
}

/**
 * Estimate the true YES probability for a market given a triggering headline.
 *
 * Tries Gemini first (cheaper), falls back to OpenAI.
 */
export async function estimateConsensusProbability(opts: {
  question: string;
  description: string | null;
  headline: string;
  currentYesPrice: number;
}): Promise<ConsensusEstimate> {
  const useGemini = Boolean(process.env['GEMINI_API_KEY']);
  const useOpenAI = Boolean(process.env['OPENAI_API_KEY']);

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
    return await callOpenAI(opts.question, opts.description, opts.headline, opts.currentYesPrice);
  }

  throw new Error('No LLM provider configured (OPENAI_API_KEY or GEMINI_API_KEY required)');
}
