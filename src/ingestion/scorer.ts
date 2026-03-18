/**
 * LLM urgency scorer for geopolitical news headlines.
 *
 * Scores items 1–10 for geopolitical urgency using Gemini Flash (preferred)
 * or OpenAI GPT-4o-mini as fallback. Batches up to 10 items per API call.
 */

import { logger } from '../shared/logger.js';
import type { RssItem } from './rss.js';

export interface ScoredItem extends RssItem {
  urgencyScore: number;
  keywords: string[];
}

interface ScoreResult {
  score: number;
  keywords: string[];
}

const BATCH_SIZE = 10;
const TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT =
  'You are a geopolitical analyst. You will receive a list of news headlines. ' +
  'Rate the geopolitical urgency of each headline on a scale of 1-10, ' +
  'where 10 = immediate geopolitical crisis/military action, 1 = routine news. ' +
  'Return ONLY a JSON object: {"results": [{"score": 7, "keywords": ["war", "conflict"]}]} in the same order as the input headlines. ' +
  'No markdown, no explanation — just the JSON object.';

function buildUserPrompt(items: RssItem[]): string {
  return items.map((item, i) => `${i + 1}. ${item.title}`).join('\n');
}

function parseScores(raw: string, batchLength: number): ScoreResult[] {
  // Strip markdown fences if present
  const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleaned) as { results: ScoreResult[] };
  const results = parsed.results ?? [];
  if (results.length !== batchLength) {
    logger.warn(
      `[scorer] LLM returned ${results.length} scores for ${batchLength} items — filling missing with score 1`,
    );
  }
  return results;
}

async function scoreBatchGemini(items: RssItem[]): Promise<ScoreResult[]> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env['GEMINI_API_KEY']!);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const result = await Promise.race([
    model.generateContent({
      contents: [{ role: 'user', parts: [{ text: buildUserPrompt(items) }] }],
      systemInstruction: { role: 'system', parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: { responseMimeType: 'application/json' },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Gemini timeout')), TIMEOUT_MS),
    ),
  ]);

  const text = result.response.text();
  return parseScores(text, items.length);
}

async function scoreBatchOpenAI(items: RssItem[]): Promise<ScoreResult[]> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await client.chat.completions.create(
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(items) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      },
      { signal: controller.signal },
    );

    const text = response.choices[0]?.message?.content ?? '{"results":[]}';
    return parseScores(text, items.length);
  } finally {
    clearTimeout(timer);
  }
}

async function scoreBatch(items: RssItem[]): Promise<ScoreResult[]> {
  // Prefer Gemini if key available, fall back to OpenAI
  if (process.env['GEMINI_API_KEY']) {
    try {
      return await scoreBatchGemini(items);
    } catch (err) {
      logger.warn('[scorer] Gemini scoring failed, trying OpenAI fallback', {
        error: String(err),
      });
    }
  }

  if (process.env['OPENAI_API_KEY']) {
    return scoreBatchOpenAI(items);
  }

  logger.error('[scorer] No LLM API key configured — cannot score items');
  return [];
}

export async function scoreItems(items: RssItem[]): Promise<ScoredItem[]> {
  if (items.length === 0) return [];

  const scored: ScoredItem[] = [];

  // Process in batches of BATCH_SIZE
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    try {
      const results = await scoreBatch(batch);

      for (let j = 0; j < batch.length; j++) {
        const item = batch[j]!;
        const result = results[j];
        scored.push({
          ...item,
          urgencyScore: result?.score ?? 1,
          keywords: result?.keywords ?? [],
        });
      }
    } catch (err) {
      logger.error('[scorer] batch scoring failed — assigning default score 1', {
        error: String(err),
        batchStart: i,
        batchSize: batch.length,
      });
      for (const item of batch) {
        scored.push({ ...item, urgencyScore: 1, keywords: [] });
      }
    }
  }

  return scored;
}
