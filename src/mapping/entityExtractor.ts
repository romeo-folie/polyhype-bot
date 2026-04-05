/**
 * Entity extractor.
 *
 * Given a scored news item, uses an LLM to extract domain-specific entities
 * as terse search keywords, then queries
 * the Polymarket Gamma API to find relevant active markets.
 */

import { createHash } from 'node:crypto';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getRedis } from '../shared/redis.js';
import { searchEvents, parseOutcomePrices, parseClobTokenIds } from './gamma.js';
import { importMarket } from '../shared/simmerImport.js';
import type { ScoredItem } from '../ingestion/scorer.js';

const TIMEOUT_MS = 20_000;

// ─── LLM helpers (shared with scorer pattern) ────────────────────────────────

function buildEntitySystemPrompt(entityContext: string): string {
  return (
    'You are a Polymarket search specialist. Extract the 3-5 most specific named entities ' +
    'from a news headline for a Gamma API keyword search. Focus on: ' +
    `${entityContext}. ` +
    'CRITICAL: Return entities as they would appear in MARKET TITLES on Polymarket. ' +
    'Prefer proper nouns (country names, leader surnames, organization abbreviations). ' +
    'BAD: "border tensions" (too vague), "the president" (too generic) ' +
    'GOOD: "Russia", "NATO", "Iran", "Trump", "tariff" ' +
    'Return ONLY a JSON object: {"entities": ["entity1", "entity2"]} — no phrases, just search keywords. ' +
    'No markdown, no explanation.'
  );
}

async function extractEntitiesOpenAI(headline: string, entityContext: string): Promise<string[]> {
  const { OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const systemPrompt = buildEntitySystemPrompt(entityContext);
  const abortCtrl = new AbortController();
  const abortTimer = setTimeout(() => { abortCtrl.abort(); }, TIMEOUT_MS);
  let completion: Awaited<ReturnType<typeof client.chat.completions.create>>;
  try {
    completion = await client.chat.completions.create(
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
      { signal: abortCtrl.signal },
    );
  } finally {
    clearTimeout(abortTimer);
  }

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
  const parsed = JSON.parse(raw) as { entities?: string[] };
  return Array.isArray(parsed.entities) ? parsed.entities.slice(0, 5) : [];
}

/**
 * Extract entities from a headline using the category context.
 *
 * Tries Gemini first (cheaper), falls back to OpenAI on error.
 */
export async function extractEntities(headline: string, entityContext: string): Promise<string[]> {
  const cfg = loadConfig();

  // Redis cache check
  const cacheRaw = `${entityContext}|${headline.trim()}`;
  const cacheKey = 'entities:' + createHash('sha256').update(cacheRaw).digest('hex');
  try {
    const cached = await getRedis().get(cacheKey);
    if (cached !== null) {
      return JSON.parse(cached) as string[];
    }
  } catch {
    // cache read failed — fall through to LLM
  }

  const provider = cfg.LLM_PROVIDER;
  const useGemini = provider === 'gemini' && Boolean(process.env.GEMINI_API_KEY);
  const useOpenAI = Boolean(process.env.OPENAI_API_KEY);

  let entities: string[] | undefined;

  if (useGemini) {
    try {
      entities = await extractEntitiesGemini(headline, entityContext);
    } catch (err: unknown) {
      logger.warn('[entity-extractor] Gemini failed, trying OpenAI', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!entities && useOpenAI) {
    entities = await extractEntitiesOpenAI(headline, entityContext);
  }

  if (!entities) {
    throw new Error('No LLM provider configured (OPENAI_API_KEY or GEMINI_API_KEY required)');
  }

  // Cache the result
  try {
    await getRedis().set(cacheKey, JSON.stringify(entities), 'EX', cfg.ENTITY_CACHE_TTL_S);
  } catch {
    // cache write failed — non-fatal
  }

  return entities;
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
 * Universal Domain Guard — compiled regex with word boundaries.
 * Blocks sports, entertainment, and weather markets from being mapped.
 *
 * Word boundaries (\b) prevent false positives:
 *   "endgame" ≠ "game", "headwinds" ≠ "wind", "Starlink" ≠ "star",
 *   "Washington DC" → we removed "dc" entirely (too ambiguous).
 *
 * Ambiguous terms that were REMOVED from earlier versions:
 *   - "dc" → matches "Washington DC" (US politics)
 *   - "star" → matches "Starlink", "Star Alliance"
 *   - "match" → matches "match expectations"
 *   - "wind" → matches "headwinds", "wind down"
 *
 * Terms kept with word boundaries (e.g. \bgame\b) are safe: they will not
 * match longer words like "endgame".
 */
const DOMAIN_BLOCKLIST_TERMS = [
  // Sports
  '\\bwin\\b', '\\bwins\\b', '\\bgame\\b', '\\bteam\\b', '\\bplayoffs\\b',
  '\\btournament\\b', '\\bchampionship\\b', '\\bathlete\\b', '\\bplayer\\b',
  '\\bscored\\b', '\\broster\\b', '\\btouchdown\\b', '\\bgoal\\b',
  // Leagues
  '\\bnba\\b', '\\bnfl\\b', '\\bmlb\\b', '\\bnhl\\b', '\\bfifa\\b',
  'premier league', 'laliga', 'super bowl', 'world cup',
  // Entertainment
  '\\boscar\\b', '\\bgrammy\\b', '\\bemmy\\b', '\\btony award',
  '\\bactor\\b', '\\bactress\\b', '\\bmovie\\b', '\\bfilm\\b',
  'box office', '\\bcelebrity\\b', 'hollywood', '\\bnetflix\\b',
  '\\bhbo\\b', '\\bdisney\\b', '\\bmarvel\\b', '\\bbatman\\b',
  '\\bsuperman\\b', '\\bspiderman\\b',
  // Weather
  '\\bcelsius\\b', '\\bfahrenheit\\b', '\\bhurricane\\b', '\\bcyclone\\b',
  '\\btyphoon\\b', '\\btemperature\\b', '\\bweather\\b', '\\bmeteorologist\\b',
];
const DOMAIN_BLOCKLIST_RE = new RegExp(DOMAIN_BLOCKLIST_TERMS.join('|'), 'i');

/**
 * Given a scored item, extract entities and search Polymarket for candidate markets.
 *
 * De-duplicates across multiple query terms (same marketId wins first occurrence).
 * Filters out markets with liquidity below MIN_LIQUIDITY.
 */
export async function findCandidateMarkets(item: ScoredItem): Promise<CandidateMarket[]> {
  // Hoist config read — avoids repeated loadConfig() calls inside the triple-nested market loop below.
  const cfg = loadConfig();

  // Combine scorer keywords with LLM-extracted entities for richer queries
  let entities: string[] = [];
  try {
    entities = await extractEntities(item.title, item.entityContext);
  } catch (err: unknown) {
    logger.warn('[entity-extractor] entity extraction failed, falling back to keywords', {
      error: err instanceof Error ? err.message : String(err),
    });
    entities = item.keywords.slice(0, 3);
  }

  // Deduplicate queries
  const querySet = new Set<string>([...item.keywords.slice(0, 3), ...entities]);
  const queries = Array.from(querySet).slice(0, 5); // cap at 5 searches

  const seen = new Map<string, CandidateMarket>();
  // Track slugs already queued for import to prevent bursting concurrent API calls
  // when the same event appears across multiple search queries.
  const importedSlugs = new Set<string>();

  for (const query of queries) {
    try {
      const events = await searchEvents({ query, limit: 5, activeOnly: true });
      const qLower = query.toLowerCase();

      for (const event of events) {
        // Strict keyword matching: Polymarket Gamma API often falls back to trending/liquid
        // markets if the query has no direct hits. We must verify the result is relevant.
        const titleLower = (event.title || '').toLowerCase();
        const eventMatches = titleLower.includes(qLower);

        for (const market of event.markets ?? []) {
          if (seen.has(market.id)) continue;

          // If event title didn't match, check market question/desc
          if (!eventMatches) {
            const mMatch =
              market.question.toLowerCase().includes(qLower) ||
              (market.description || '').toLowerCase().includes(qLower);
            if (!mMatch) continue;
          }

          // Universal Domain Guard: block sports/entertainment/weather markets.
          // Uses word-boundary regex (hoisted above) to prevent false positives
          // like "endgame", "Washington DC", "Starlink", or "headwinds".
          const questionLower = market.question.toLowerCase();
          if (DOMAIN_BLOCKLIST_RE.test(questionLower)) {
            continue;
          }

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

          // Fire-and-forget Simmer import if enabled.
          // Deduplicates by event slug — same event won't be re-queued if it appears
          // in multiple query results, avoiding API burst.
          if (cfg.SIMMER_AUTO_IMPORT_ENABLED && event.slug && !importedSlugs.has(event.slug)) {
            importedSlugs.add(event.slug);
            const polymarketUrl = `https://polymarket.com/event/${event.slug}`;
            void importMarket(polymarketUrl).catch((err) => {
              logger.debug('[entity-extractor] simmer import failed (non-blocking)', {
                marketId: market.id,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        }
      }
    } catch (err: unknown) {
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
