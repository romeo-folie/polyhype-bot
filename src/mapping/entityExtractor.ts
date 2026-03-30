/**
 * Entity extractor.
 *
 * Given a scored news item, uses an LLM to extract domain-specific entities
 * as terse search keywords, then queries
 * the Polymarket Gamma API to find relevant active markets.
 */

import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { searchEvents, parseOutcomePrices, parseClobTokenIds } from './gamma.js';
import type { ScoredItem } from '../ingestion/scorer.js';

const TIMEOUT_MS = 20_000;

// ─── LLM helpers (shared with scorer pattern) ────────────────────────────────

function buildEntitySystemPrompt(entityContext: string): string {
  return (
    'You are an analyst. Extract the most important named entities from a ' +
    'news headline for a Polymarket keyword search. Focus on: ' +
    `${entityContext}. ` +
    'Return ONLY a JSON object: {"entities": ["entity1", "entity2"]} — max 5 short keywords, no phrases. ' +
    'No markdown, no explanation.'
  );
}

async function extractEntitiesOpenAI(headline: string, entityContext: string): Promise<string[]> {
  const { OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const systemPrompt = buildEntitySystemPrompt(entityContext);
  const completion = await client.chat.completions.create(
    {
      model: loadConfig().OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: headline },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 150,
      temperature: 0,
    },
    { signal: (() => { const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), TIMEOUT_MS); return ctrl.signal; })() },
  );

  const raw = completion.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(raw) as { entities?: string[] };
  return Array.isArray(parsed.entities) ? parsed.entities.slice(0, 5) : [];
}

async function extractEntitiesGemini(headline: string, entityContext: string): Promise<string[]> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
  const model = genai.getGenerativeModel({ model: loadConfig().GEMINI_MODEL });
  const systemPrompt = buildEntitySystemPrompt(entityContext);

  const result = await Promise.race([
    model.generateContent(`${systemPrompt}\n\n${headline}`),
    new Promise<never>((_, reject) =>
      setTimeout(() => { reject(new Error('Gemini timeout')); }, TIMEOUT_MS),
    ),
  ]);

  const raw = result.response.text().replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(raw) as { entities?: string[] };
  return Array.isArray(parsed.entities) ? parsed.entities.slice(0, 5) : [];
}

/**
 * Extract entities from a headline using the category context.
 *
 * Tries Gemini first (cheaper), falls back to OpenAI on error.
 */
export async function extractEntities(headline: string, entityContext: string): Promise<string[]> {
  const provider = loadConfig().LLM_PROVIDER;
  const useGemini = provider === 'gemini' && Boolean(process.env.GEMINI_API_KEY);
  const useOpenAI = Boolean(process.env.OPENAI_API_KEY);

  if (useGemini) {
    try {
      return await extractEntitiesGemini(headline, entityContext);
    } catch (err) {
      logger.warn('[entity-extractor] Gemini failed, trying OpenAI', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (useOpenAI) {
    return await extractEntitiesOpenAI(headline, entityContext);
  }

  throw new Error('No LLM provider configured (OPENAI_API_KEY or GEMINI_API_KEY required)');
}

// ─── Market search ────────────────────────────────────────────────────────────

export interface CandidateMarket {
  /** Gamma market ID */
  marketId: string;
  question: string;
  conditionId: string;
  clobTokenIds: string[];
  /** Current YES price (0–1 scale) */
  currentYesPrice: number;
  volume: number;
  liquidity: number;
  endDate: string | null;
  description: string | null;
  /** Search query that surfaced this market */
  matchedQuery: string;
}

const MIN_LIQUIDITY = 100; // USDC — skip ghost markets

/**
 * Given a scored item, extract entities and search Polymarket for candidate markets.
 *
 * De-duplicates across multiple query terms (same marketId wins first occurrence).
 * Filters out markets with liquidity below MIN_LIQUIDITY.
 */
export async function findCandidateMarkets(item: ScoredItem): Promise<CandidateMarket[]> {
  // Combine scorer keywords with LLM-extracted entities for richer queries
  let entities: string[] = [];
  try {
    entities = await extractEntities(item.title, item.entityContext);
  } catch (err) {
    logger.warn('[entity-extractor] entity extraction failed, falling back to keywords', {
      error: err instanceof Error ? err.message : String(err),
    });
    entities = item.keywords.slice(0, 3);
  }

  // Deduplicate queries
  const querySet = new Set<string>([...item.keywords.slice(0, 3), ...entities]);
  const queries = Array.from(querySet).slice(0, 5); // cap at 5 searches

  const seen = new Map<string, CandidateMarket>();

  for (const query of queries) {
    try {
      const events = await searchEvents({ query, limit: 5, activeOnly: true });
      for (const event of events) {
        for (const market of event.markets ?? []) {
          if (seen.has(market.id)) continue;

          const liquidity = parseFloat(market.liquidity ?? '0');
          if (!isFinite(liquidity) || liquidity < MIN_LIQUIDITY) continue;

          // Parse YES price — normalise from JSON-encoded string or pre-parsed array
          let currentYesPrice: number;
          try {
            const prices = parseOutcomePrices(market.outcomePrices);
            if (prices.length === 0) continue;
            currentYesPrice = parseFloat(prices[0] ?? '0');
            if (!isFinite(currentYesPrice) || currentYesPrice < 0 || currentYesPrice > 1) continue;
          } catch {
            continue;
          }

          let clobTokenIds: string[];
          try {
            clobTokenIds = parseClobTokenIds(market.clobTokenIds ?? []);
            if (clobTokenIds.length < 2) continue;
          } catch {
            continue;
          }

          seen.set(market.id, {
            marketId: market.id,
            question: market.question,
            conditionId: market.conditionId,
            clobTokenIds,
            currentYesPrice,
            volume: parseFloat(market.volume ?? '0'),
            liquidity,
            endDate: market.endDate ?? null,
            description: market.description ?? null,
            matchedQuery: query,
          });
        }
      }
    } catch (err) {
      logger.warn('[entity-extractor] gamma search failed for query', {
        query,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const candidates = Array.from(seen.values());
  // Sort by liquidity descending — highest liquidity markets first
  candidates.sort((a, b) => b.liquidity - a.liquidity);
  return candidates;
}
