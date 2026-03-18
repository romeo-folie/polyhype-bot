/**
 * Task 1.4 — LLM urgency scorer.
 *
 * Scores articles 1–10 for geopolitical urgency using OpenAI gpt-4o-mini
 * (primary) or Gemini 1.5 Flash (fallback). Extracts up to 5 keywords.
 */

import { logger } from '../shared/logger.js';
import type { RawArticle, ScoredArticle } from './types.js';

const SYSTEM_PROMPT = `You are a geopolitical risk analyst. Score news articles for urgency on a 1-10 scale where:
1-3: routine news, low impact
4-6: notable events, moderate potential for market movement
7-9: significant geopolitical events with direct prediction market relevance
10: breaking crisis (war declaration, coup, major attack, etc.)

Extract up to 5 key entities/keywords relevant to prediction markets (country names, leader names, organizations, events).

Respond ONLY with valid JSON: {"score": <number>, "keywords": ["...", "..."]}`;

const MAX_CONCURRENT = 5;

interface ScoreResult {
  score: number;
  keywords: string[];
}

export function parseScoreResponse(text: string): ScoreResult {
  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { score: 0, keywords: [] };

    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (typeof parsed !== 'object' || parsed === null) return { score: 0, keywords: [] };

    const obj = parsed as Record<string, unknown>;
    const rawScore = obj['score'];
    const rawKeywords = Array.isArray(obj['keywords']) ? obj['keywords'] : [];

    // Missing or non-numeric score → 0 (unscored)
    if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) {
      return { score: 0, keywords: rawKeywords.filter((k): k is string => typeof k === 'string').slice(0, 5) };
    }

    // Clamp score to valid range
    const score = Math.max(1, Math.min(10, Math.round(rawScore)));

    const keywords = rawKeywords
      .filter((k): k is string => typeof k === 'string')
      .slice(0, 5);

    return { score, keywords };
  } catch {
    return { score: 0, keywords: [] };
  }
}

function buildUserMessage(article: RawArticle): string {
  return `Title: ${article.title}\nSummary: ${article.summary}\nSource: ${article.source}`;
}

async function scoreWithOpenAI(article: RawArticle, apiKey: string): Promise<ScoreResult> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 100,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(article) },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error ${String(res.status)}: ${body}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? '';
  return parseScoreResponse(content);
}

async function scoreWithGemini(article: RawArticle, apiKey: string): Promise<ScoreResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: `${SYSTEM_PROMPT}\n\n${buildUserMessage(article)}` },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 100,
        temperature: 0,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini API error ${String(res.status)}: ${body}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return parseScoreResponse(content);
}

export async function scoreArticles(articles: RawArticle[]): Promise<ScoredArticle[]> {
  if (articles.length === 0) return [];

  const openaiKey = process.env['OPENAI_API_KEY'];
  const geminiKey = process.env['GEMINI_API_KEY'];

  const scoreFn = openaiKey
    ? (article: RawArticle) => scoreWithOpenAI(article, openaiKey)
    : geminiKey
      ? (article: RawArticle) => scoreWithGemini(article, geminiKey)
      : null;

  if (!scoreFn) {
    logger.error('[scorer] no LLM API key configured');
    return articles.map((a) => ({
      ...a,
      urgencyScore: 0,
      keywords: [],
      scoredAt: new Date(),
    }));
  }

  // Semaphore for max concurrent calls
  let running = 0;
  const queue: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (running < MAX_CONCURRENT) {
      running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queue.push(resolve);
    });
  }

  function release(): void {
    running--;
    const next = queue.shift();
    if (next) {
      running++;
      next();
    }
  }

  const results = await Promise.allSettled(
    articles.map(async (article): Promise<ScoredArticle> => {
      await acquire();
      try {
        const result = await scoreFn(article);
        return {
          ...article,
          urgencyScore: result.score,
          keywords: result.keywords,
          scoredAt: new Date(),
        };
      } catch (err) {
        logger.warn(`[scorer] failed to score article: ${article.title}`, {
          error: String(err),
        });
        return {
          ...article,
          urgencyScore: 0,
          keywords: [],
          scoredAt: new Date(),
        };
      } finally {
        release();
      }
    }),
  );

  const scored: ScoredArticle[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      scored.push(result.value);
    }
  }

  logger.info(`[scorer] scored ${String(scored.length)} articles`);
  return scored;
}
