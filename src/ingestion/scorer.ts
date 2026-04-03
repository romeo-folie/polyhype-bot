/**
 * LLM urgency scorer for news headlines.
 *
 * Scores items 1–10 using Gemini Flash (preferred) or OpenAI GPT-4o-mini
 * as fallback. Batches up to 10 items per API call.
 */

import { createHash } from 'node:crypto';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import type { RssItem } from './rss.js';
import type { Redis } from 'ioredis';

export interface ScoredItem extends RssItem {
  urgencyScore: number;
  keywords: string[];
  categoryId: string;
  categoryLabel: string;
  entityContext: string;
  sentiment: 'YES' | 'NO' | 'NEUTRAL';
}

interface ScoreResult {
  score: number;
  keywords: string[];
  sentiment: 'YES' | 'NO' | 'NEUTRAL';
}

const BATCH_SIZE = 10;
const TIMEOUT_MS = 30_000;

const DEFAULT_SYSTEM_PROMPT =
  'You are a geopolitical analyst. You will receive a list of news headlines. ' +
  'Rate the geopolitical urgency of each headline on a scale of 1-10, ' +
  'where 10 = immediate geopolitical crisis/military action, 1 = routine news. ' +
  'Also identify the directional sentiment: "YES" if the news makes the event more likely, ' +
  '"NO" if less likely, or "NEUTRAL" if unclear. ' +
  'Return ONLY a JSON object: {"results": [{"score": 7, "keywords": ["war", "conflict"], "sentiment": "YES"}]} in the same order as the input headlines. ' +
  'No markdown, no explanation — just the JSON object.';

function buildUserPrompt(items: RssItem[]): string {
  return items.map((item, i) => `${i + 1}. ${item.title}`).join('\n');
}

function parseScores(raw: string, batchLength: number): ScoreResult[] {
  // Strip markdown fences if present
  const cleaned = raw
    .replace(/```(?:json)?\s*/g, '')
    .replace(/```/g, '')
    .trim();
  const parsed = JSON.parse(cleaned) as { results: ScoreResult[] };
  const results = parsed.results ?? [];
  if (results.length !== batchLength) {
    logger.warn(
      `[scorer] LLM returned ${results.length} scores for ${batchLength} items — filling missing with score 1`,
    );
  }
  return results;
}

async function scoreBatchGemini(items: RssItem[], systemPrompt: string): Promise<ScoreResult[]> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const cfg = loadConfig();
  if (!cfg.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set — cannot call Gemini scorer');
  const genAI = new GoogleGenerativeAI(cfg.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: loadConfig().GEMINI_MODEL });

  const result = await Promise.race([
    model.generateContent({
      contents: [{ role: 'user', parts: [{ text: buildUserPrompt(items) }] }],
      systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
      generationConfig: { responseMimeType: 'application/json' },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error('Gemini timeout'));
      }, TIMEOUT_MS),
    ),
  ]);

  const text = result.response.text();
  return parseScores(text, items.length);
}

async function scoreBatchOpenAI(items: RssItem[], systemPrompt: string): Promise<ScoreResult[]> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: loadConfig().OPENAI_API_KEY });

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const response = await client.chat.completions.create(
      {
        model: loadConfig().OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
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

async function scoreBatch(items: RssItem[], systemPrompt: string): Promise<ScoreResult[]> {
  // Prefer Gemini if key available, fall back to OpenAI
  const cfg = loadConfig();

  if (cfg.LLM_PROVIDER === 'gemini' && cfg.GEMINI_API_KEY) {
    try {
      return await scoreBatchGemini(items, systemPrompt);
    } catch (err) {
      logger.warn('[scorer] Gemini scoring failed, trying OpenAI fallback', {
        error: String(err),
      });
    }
  }

  if (cfg.OPENAI_API_KEY) {
    return scoreBatchOpenAI(items, systemPrompt);
  }

  logger.error('[scorer] No LLM API key configured — cannot score items');
  return [];
}

export async function scoreItems(
  items: RssItem[],
  opts: {
    systemPrompt?: string;
    categoryId: string;
    categoryLabel: string;
    entityContext: string;
    redis?: Redis;
  },
): Promise<ScoredItem[]> {
  if (items.length === 0) return [];

  const cfg = loadConfig();
  const scored: ScoredItem[] = [];
  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  // Separate items into cache-hit and cache-miss buckets
  const toScore: RssItem[] = [];
  if (opts.redis) {
    for (const item of items) {
      const cacheKey = 'scored:' + createHash('sha256').update(item.url).digest('hex');
      try {
        const cached = await opts.redis.get(cacheKey);
        if (cached) {
          const cachedItem = JSON.parse(cached) as ScoredItem;
          if (typeof cachedItem.publishedAt === 'string') {
            cachedItem.publishedAt = new Date(cachedItem.publishedAt);
          }
          scored.push(cachedItem);
          continue;
        }
      } catch {
        // cache read failed — fall through to LLM
      }
      toScore.push(item);
    }
  } else {
    toScore.push(...items);
  }

  // Process cache-misses in batches of BATCH_SIZE
  for (let i = 0; i < toScore.length; i += BATCH_SIZE) {
    const batch = toScore.slice(i, i + BATCH_SIZE);
    try {
      const results = await scoreBatch(batch, systemPrompt);

      for (let j = 0; j < batch.length; j++) {
        const item = batch[j]!;
        const result = results[j];
        const scoredItem: ScoredItem = {
          ...item,
          urgencyScore: result?.score ?? 1,
          keywords: result?.keywords ?? [],
          categoryId: opts.categoryId,
          categoryLabel: opts.categoryLabel,
          entityContext: opts.entityContext,
          sentiment: result?.sentiment ?? 'NEUTRAL',
        };
        scored.push(scoredItem);

        // Cache the scored item
        if (opts.redis) {
          const cacheKey = 'scored:' + createHash('sha256').update(item.url).digest('hex');
          try {
            await opts.redis.set(
              cacheKey,
              JSON.stringify(scoredItem),
              'EX',
              cfg.SCORER_CACHE_TTL_S,
            );
          } catch {
            // cache write failed — non-fatal
          }
        }
      }
    } catch (err) {
      logger.error('[scorer] batch scoring failed — assigning default score 1', {
        error: String(err),
        batchStart: i,
        batchSize: batch.length,
      });
      for (const item of batch) {
        scored.push({
          ...item,
          urgencyScore: 1,
          keywords: [],
          categoryId: opts.categoryId,
          categoryLabel: opts.categoryLabel,
          entityContext: opts.entityContext,
          sentiment: 'NEUTRAL',
        });
      }
    }
  }

  return scored;
}
