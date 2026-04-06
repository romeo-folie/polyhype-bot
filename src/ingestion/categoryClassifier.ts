/**
 * Keyword-based category classifier for Telegram messages.
 *
 * Picks the best-matching CategoryConfig from keyword hit counts.
 * Falls back to LLM classification on ties/zero matches, then to geopolitical.
 */

import { CATEGORIES, geopolitical } from './categories/index.js';
import type { CategoryConfig } from './categories/types.js';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';

const KEYWORD_MAP: Record<string, string[]> = {
  'crypto-regulatory': [
    'bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'token', 'sec', 'etf',
    'stablecoin', 'defi', 'nft', 'blockchain', 'solana', 'ripple', 'xrp',
    'binance', 'coinbase', 'staking', 'wallet', 'mining', 'halving',
    'altcoin', 'memecoin',
  ],
  'macro': [
    'fed', 'federal reserve', 'rate cut', 'rate hike', 'inflation', 'cpi',
    'gdp', 'central bank', 'treasury', 'yield', 'bonds', 'recession',
    'employment', 'ecb', 'boj', 'interest rate', 'monetary policy',
    'tariff', 'trade war',
  ],
  'ai-tech': [
    'ai', 'artificial intelligence', 'gpt', 'openai', 'google deepmind',
    'meta ai', 'frontier model', 'agi', 'llm', 'chip', 'nvidia',
    'semiconductor', 'machine learning', 'chatbot', 'anthropic',
  ],
  'us-politics': [
    'congress', 'senate', 'house of representatives', 'president', 'biden',
    'trump', 'supreme court', 'executive order', 'legislation', 'bill',
    'impeach', 'governor', 'democrat', 'republican', 'doj', 'fbi',
  ],
};

/**
 * Count keyword hits for each category against lowercased text.
 * Multi-word keywords use includes(); single-word keywords use word-boundary regex.
 */
function countHits(text: string): Map<string, number> {
  const lower = text.toLowerCase();
  const counts = new Map<string, number>();

  for (const [catId, keywords] of Object.entries(KEYWORD_MAP)) {
    let hits = 0;
    for (const kw of keywords) {
      if (kw.includes(' ')) {
        // Multi-word phrase: simple substring match
        if (lower.includes(kw)) hits++;
      } else {
        // Single word: word-boundary match to avoid false positives
        // (e.g. "eth" in "method")
        const re = new RegExp(`\\b${kw}\\b`, 'i');
        if (re.test(lower)) hits++;
      }
    }
    counts.set(catId, hits);
  }

  return counts;
}

/**
 * LLM fallback for ambiguous cases (ties or zero keyword matches).
 */
async function classifyWithLlm(text: string): Promise<string | null> {
  const cfg = loadConfig();
  const categoryIds = CATEGORIES.map(c => c.id).join(', ');
  const prompt = `Classify this headline into exactly one of: ${categoryIds}. Return ONLY the category ID, nothing else.\n\nHeadline: ${text}`;

  try {
    if (cfg.GEMINI_API_KEY) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${cfg.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (res.ok) {
        const json = (await res.json()) as any;
        const answer = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase();
        if (answer && CATEGORIES.some(c => c.id === answer)) return answer;
      }
    }

    if (cfg.OPENAI_API_KEY) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 20,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const json = (await res.json()) as any;
        const answer = json?.choices?.[0]?.message?.content?.trim().toLowerCase();
        if (answer && CATEGORIES.some(c => c.id === answer)) return answer;
      }
    }
  } catch (err) {
    logger.warn('[categoryClassifier] LLM fallback failed', { error: String(err) });
  }

  return null;
}

/**
 * Classify a text snippet into the best-matching category.
 * Uses keyword counting first, LLM fallback on ties/zero, geopolitical as safety net.
 */
export async function classifyCategory(text: string): Promise<CategoryConfig> {
  const counts = countHits(text);

  // Find the max hit count
  let maxHits = 0;
  for (const hits of counts.values()) {
    if (hits > maxHits) maxHits = hits;
  }

  if (maxHits > 0) {
    // Collect categories tied at the max
    const winners = [...counts.entries()].filter(([, h]) => h === maxHits);

    if (winners.length === 1) {
      const catId = winners[0]![0];
      const cat = CATEGORIES.find(c => c.id === catId);
      if (cat) {
        logger.debug('[categoryClassifier] keyword match', { category: catId, hits: maxHits });
        return cat;
      }
    }

    // Tie — use LLM to break it
    logger.debug('[categoryClassifier] keyword tie, using LLM', {
      tied: winners.map(([id, h]) => `${id}:${h}`),
    });
    const llmResult = await classifyWithLlm(text);
    if (llmResult) {
      const cat = CATEGORIES.find(c => c.id === llmResult);
      if (cat) return cat;
    }
  } else {
    // Zero keyword matches — try LLM
    logger.debug('[categoryClassifier] no keyword matches, using LLM');
    const llmResult = await classifyWithLlm(text);
    if (llmResult) {
      const cat = CATEGORIES.find(c => c.id === llmResult);
      if (cat) return cat;
    }
  }

  // Safety net: default to geopolitical
  logger.debug('[categoryClassifier] defaulting to geopolitical');
  return geopolitical;
}
