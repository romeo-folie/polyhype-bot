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
import {
  searchEvents,
  publicSearch,
  parseOutcomePrices,
  parseOutcomes,
  parseClobTokenIds,
  type GammaMarket,
} from './gamma.js';
import { getCachedMarkets } from '../shared/watchlist.js';
import { enqueueWrite } from '../db/writeQueue.js';
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
        max_completion_tokens: 150,
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
  /**
   * Query most associated with this market's relevance. For word-boundary
   * hits, this is the query whose tokens contributed the most matches (the
   * "best responsible query"), not necessarily the query that retrieved the
   * market. For search-only sentinel hits (score = 0.5), this is the literal
   * /public-search query that returned it. Used for logs/telemetry only.
   */
  matchedQuery: string;
  /**
   * Relevance score for ranking candidate markets. For word-boundary query
   * matching, this is the count of distinct query tokens (union across all
   * queries) that appear in the market's question or description. Fallback
   * retrieval paths may assign a fractional sentinel (e.g. 0.5) to mark a
   * lower-confidence search-only hit that still outranks nothing. Higher =
   * better topical fit. Used as the primary sort key; liquidity is the
   * tiebreaker.
   */
  matchScore?: number;
  /**
   * Insertion rank among `/public-search` hits (lower = earlier in the
   * endpoint's topical ordering). Only set for search-only candidates
   * (word-boundary cache hits leave this undefined). Used as tiebreak for
   * the 0.5 sentinel tier — preserves `/public-search`'s topical rank
   * instead of falling back to liquidity, which otherwise floats
   * high-liquidity sports markets above genuine political hits when a
   * broad query returns many tangential results.
   */
  searchRank?: number;
}

const MIN_LIQUIDITY = 100; // USDC — skip ghost markets

// Shadow-mode budget for the background /public-search comparison. Generous
// enough for a typical Gamma round-trip (~300-800ms × up to 5 queries) but
// short enough that a stalled endpoint never leaks a long-lived timer.
const SHADOW_PUBLIC_SEARCH_TIMEOUT_MS = 5000;

/**
 * Extract word-tokens from a search query. Lowercases, strips punctuation,
 * drops tokens shorter than 3 chars (too noisy — "us" matches "various",
 * "usage"; "ai" matches "said", "against"). The caller de-duplicates.
 *
 * Short entities that MUST match as tokens (e.g. country codes, stock
 * tickers) would need special-casing — none are currently required for
 * geopolitical news mapping.
 */
function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/**
 * Count how many of `tokens` appear in `text` as whole words (word-boundary
 * match). Used for match-strength ranking — multi-token queries that hit
 * more of the question/description outrank single-token matches.
 *
 * Word boundaries prevent the "war" → "Warriors" false-positive class that
 * polluted the prior liquidity-sort retriever on political headlines.
 */
function countMatchingTokens(text: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const t of tokens) {
    // Escape regex metachars defensively; tokens are [a-z0-9] but future
    // callers could pass anything.
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`).test(lower)) hits++;
  }
  return hits;
}

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
 * Validate + normalise a `GammaMarket` into a `CandidateMarket` given a
 * primary query string and a pre-computed match score. Returns null when
 * the market fails any gate (domain blocklist, binary-only, expired, low
 * liquidity, extreme price, unparseable token IDs).
 */
function buildCandidate(
  market: GammaMarket,
  matchedQuery: string,
  matchScore: number,
  searchRank?: number,
): CandidateMarket | null {
  const questionLower = market.question.toLowerCase();
  if (DOMAIN_BLOCKLIST_RE.test(questionLower)) return null;

  // Binary-only gate: multi-outcome markets produce extreme-priced outcomes
  // (2-5¢) that trigger phantom LLM edge. The near-zero scanner handles those.
  if (market.outcomes) {
    try {
      const outcomeList = parseOutcomes(market.outcomes);
      if (outcomeList.length !== 2) return null;
    } catch {
      return null;
    }
  }

  if (market.endDate) {
    const end = new Date(market.endDate).getTime();
    if (!isNaN(end) && end < Date.now()) return null;
  }

  const liquidity = parseFloat(market.liquidity ?? '0');
  if (!isFinite(liquidity) || liquidity < MIN_LIQUIDITY) return null;

  let currentYesPrice: number;
  try {
    const prices = parseOutcomePrices(market.outcomePrices);
    if (prices.length === 0) return null;
    currentYesPrice = parseFloat(prices[0] ?? '0');
    if (!isFinite(currentYesPrice) || currentYesPrice < 0 || currentYesPrice > 1) return null;
  } catch {
    return null;
  }

  // Minimum price gate: longshot structural overpricing is handled by the
  // near-zero scanner; mapping pipeline skips anything outside 5¢–95¢.
  if (currentYesPrice < 0.05 || currentYesPrice > 0.95) return null;

  let clobTokenIds: string[];
  try {
    clobTokenIds = parseClobTokenIds(market.clobTokenIds ?? []);
    if (clobTokenIds.length < 2) return null;
  } catch {
    return null;
  }

  return {
    marketId: market.id,
    question: market.question,
    conditionId: market.conditionId,
    clobTokenIds,
    currentYesPrice,
    volume: parseFloat(market.volume ?? '0'),
    liquidity,
    endDate: market.endDate ?? null,
    description: market.description ?? null,
    matchedQuery,
    matchScore,
    ...(searchRank !== undefined ? { searchRank } : {}),
  };
}

/**
 * Compute the match score for a market against a set of queries: count of
 * distinct query tokens (unioned across ALL queries) that appear in
 * question ∪ description under word-boundary match.
 *
 * Returns `{ score, matchedQuery }`. `score === 0` means no token matched.
 * `matchedQuery` is the single query that contributed the most matching
 * tokens on its own (ties broken by query order) — used for logging to
 * identify which entity string surfaced the candidate.
 */
function scoreMarketAgainstQueries(
  market: GammaMarket,
  queries: string[],
): { score: number; matchedQuery: string } {
  const haystack = `${market.question} ${market.description ?? ''}`;
  const tokenSet = new Set<string>();
  for (const q of queries) {
    for (const t of tokenizeQuery(q)) tokenSet.add(t);
  }
  const score = countMatchingTokens(haystack, Array.from(tokenSet));

  // Pick the single query that matched the most of its own tokens — this is
  // the "best responsible query" for debug/logging, independent of the
  // unioned score.
  let bestQuery = queries[0] ?? '';
  let bestQueryScore = 0;
  for (const q of queries) {
    const s = countMatchingTokens(haystack, tokenizeQuery(q));
    if (s > bestQueryScore) {
      bestQueryScore = s;
      bestQuery = q;
    }
  }
  return { score, matchedQuery: bestQuery };
}

/**
 * Local-cache retriever: word-boundary match against each cached market,
 * rank by (matchScore desc, liquidity desc).
 *
 * Replaces the pre-2026-04-15 substring + liquidity-sort path. Word-boundary
 * matching stops "war" from matching "Warriors" (sports markets) and the
 * match-score sort stops high-liquidity irrelevant markets from crowding out
 * correct low-liquidity political markets.
 */
function retrieveFromCache(
  queries: string[],
  cachedMarkets: GammaMarket[],
): Map<string, CandidateMarket> {
  const out = new Map<string, CandidateMarket>();
  for (const market of cachedMarkets) {
    if (out.has(market.id)) continue;
    const { score, matchedQuery } = scoreMarketAgainstQueries(market, queries);
    if (score === 0) continue;
    const cand = buildCandidate(market, matchedQuery, score);
    if (cand) out.set(market.id, cand);
  }
  return out;
}

/**
 * Public-search retriever: call Polymarket's `/public-search` once per
 * query, look each returned market up in the local cache (we need the full
 * cached record for prices/tokens/descriptions the search payload also
 * provides, but resolving via cache keeps the downstream shape identical
 * to the legacy path), then rank by (matchScore desc, liquidity desc).
 *
 * Markets returned by `/public-search` that aren't in our local cache are
 * still usable — we fall back to the search payload directly. This keeps
 * us resilient to cache-refresh lag.
 */
async function retrieveFromPublicSearch(
  queries: string[],
  cachedMarkets: GammaMarket[],
  limitPerEntity: number,
): Promise<Map<string, CandidateMarket>> {
  const out = new Map<string, CandidateMarket>();
  const cacheById = new Map(cachedMarkets.map((m) => [m.id, m]));
  let searchRank = 0;

  for (const query of queries) {
    let events: Awaited<ReturnType<typeof publicSearch>> = [];
    try {
      events = await publicSearch({ query, limit: limitPerEntity, activeOnly: true });
    } catch (err) {
      logger.warn('[entity-extractor] public-search failed for query', {
        query,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const event of events) {
      for (const market of event.markets ?? []) {
        if (out.has(market.id)) continue;
        // Prefer the cached record (authoritative for downstream price/token fields).
        // Fall back to the search payload when the market isn't in cache yet.
        const source = cacheById.get(market.id) ?? market;
        const { score, matchedQuery } = scoreMarketAgainstQueries(source, queries);
        // Trust the search endpoint's topical ranking even when our
        // word-boundary token match score is 0 — it uses richer signals than
        // token matching alone. Use 0.5 as a sentinel "search-only hit"
        // score so genuine word-boundary matches still outrank it. For
        // sentinel hits, stamp the insertion index so rankCandidates can
        // preserve /public-search's own ordering within the 0.5 tier.
        const finalScore = score > 0 ? score : 0.5;
        const finalQuery = score > 0 ? matchedQuery : query;
        const stampedRank = score > 0 ? undefined : searchRank;
        const cand = buildCandidate(source, finalQuery, finalScore, stampedRank);
        if (cand) {
          out.set(market.id, cand);
          if (score === 0) searchRank++;
        }
      }
    }
  }
  return out;
}

/**
 * Rank candidates: match-strength first, then liquidity — except when both
 * candidates are `/public-search` sentinel hits (matchScore = 0.5 tier), in
 * which case we preserve the endpoint's topical order via `searchRank`.
 * Liquidity-tiebreak on the sentinel tier floated high-liquidity sports
 * markets above political hits when broad queries flooded the pool.
 * Mutates and returns the input array.
 */
function rankCandidates(candidates: CandidateMarket[]): CandidateMarket[] {
  candidates.sort((a, b) => {
    const scoreDiff = (b.matchScore ?? 0) - (a.matchScore ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    if (a.searchRank !== undefined && b.searchRank !== undefined) {
      return a.searchRank - b.searchRank;
    }
    return b.liquidity - a.liquidity;
  });
  return candidates;
}

/**
 * Gamma `/events` fallback used only when the market cache is empty AND
 * public-search is off. Kept for graceful degradation — historically the
 * `/events?query=` endpoint has been unreliable, which is why we added
 * local caching in the first place.
 */
async function retrieveFromGammaEvents(
  queries: string[],
): Promise<Map<string, CandidateMarket>> {
  const out = new Map<string, CandidateMarket>();
  for (const query of queries) {
    try {
      const events = await searchEvents({ query, limit: 5, activeOnly: true });
      for (const event of events) {
        for (const market of event.markets ?? []) {
          if (out.has(market.id)) continue;
          const { score, matchedQuery } = scoreMarketAgainstQueries(market, queries);
          if (score === 0) continue;
          const cand = buildCandidate(market, matchedQuery, score);
          if (cand) out.set(market.id, cand);
        }
      }
    } catch (err: unknown) {
      logger.warn('[entity-extractor] gamma /events search failed for query', {
        query,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/**
 * Shadow-mode diff: emits how the legacy and public-search retrievers
 * differ on the top-N candidate set, so we can evaluate the switch before
 * flipping MARKET_RETRIEVAL_MODE=public_search in production.
 */
function logRetrievalShadow(params: {
  headline: string;
  queries: string[];
  legacyTop: CandidateMarket[];
  publicTop: CandidateMarket[];
  topN: number;
}): void {
  const { headline, queries, legacyTop, publicTop, topN } = params;
  const legacyIds = new Set(legacyTop.slice(0, topN).map((c) => c.marketId));
  const publicIds = new Set(publicTop.slice(0, topN).map((c) => c.marketId));
  const overlap = Array.from(legacyIds).filter((id) => publicIds.has(id)).length;
  const onlyInPublic = Array.from(publicIds).filter((id) => !legacyIds.has(id));
  const onlyInLegacy = Array.from(legacyIds).filter((id) => !publicIds.has(id));
  // Effective N: when either side has fewer than topN candidates, comparing
  // overlap against topN over-reports diffs (overlap is capped by the smaller
  // set). Use the smaller of the three for both wouldBlock and the persisted
  // threshold so the shadow metric reflects a real disagreement.
  const effectiveN = Math.min(topN, legacyIds.size, publicIds.size);

  logger.info('[entity-extractor] retrieval_shadow', {
    headline: headline.slice(0, 120),
    queries,
    legacyCount: legacyTop.length,
    publicCount: publicTop.length,
    topN,
    effectiveN,
    overlap,
    onlyInPublicCount: onlyInPublic.length,
    onlyInLegacyCount: onlyInLegacy.length,
    legacyTopQuestions: legacyTop.slice(0, 5).map((c) => c.question.slice(0, 80)),
    publicTopQuestions: publicTop.slice(0, 5).map((c) => c.question.slice(0, 80)),
  });
  void enqueueWrite('shadow_observations', {
    kind: 'market_retrieval',
    source: 'osint',
    wouldBlock: effectiveN > 0 && overlap < effectiveN,
    metricValue: overlap,
    threshold: effectiveN,
    payload: {
      headline: headline.slice(0, 200),
      queries,
      legacyCount: legacyTop.length,
      publicCount: publicTop.length,
      topN,
      effectiveN,
      onlyInPublicCount: onlyInPublic.length,
      onlyInLegacyCount: onlyInLegacy.length,
      legacyTopIds: Array.from(legacyIds).slice(0, 10),
      publicTopIds: Array.from(publicIds).slice(0, 10),
    },
  });
}

/**
 * Given a scored item, extract entities and find candidate Polymarket markets.
 *
 * Retrieval strategy is controlled by `MARKET_RETRIEVAL_MODE`:
 *   - legacy        — local cache, word-boundary token match
 *   - public_search — merge /public-search results with local cache lookups
 *   - shadow        — run both, return legacy, log the diff
 *
 * Results are ranked by `(matchScore desc, liquidity desc)` in all modes.
 * `matchScore` = count of distinct query tokens (taken from the union of all
 * queries) that appear in the market's question or description under
 * word-boundary matching. Search-only hits without a literal match get a
 * 0.5 sentinel so they rank below any word-boundary match but above nothing.
 */
export async function findCandidateMarkets(item: ScoredItem): Promise<CandidateMarket[]> {
  const cfg = loadConfig();

  let entities: string[] = [];
  try {
    entities = await extractEntities(item.title, item.entityContext);
  } catch (err: unknown) {
    logger.warn('[entity-extractor] entity extraction failed, falling back to keywords', {
      error: err instanceof Error ? err.message : String(err),
    });
    entities = item.keywords.slice(0, 3);
  }

  const querySet = new Set<string>([...item.keywords.slice(0, 3), ...entities]);
  const queries = Array.from(querySet).slice(0, 5);

  const cachedMarkets = await getCachedMarkets(getRedis());

  // Retrieval mode dispatch. In shadow mode we run both retrievers and log
  // the diff; the returned candidates are the legacy path's so behavior is
  // byte-identical to pre-rollout until we flip to public_search.
  const mode = cfg.MARKET_RETRIEVAL_MODE;

  if (mode === 'legacy') {
    const legacy = cachedMarkets.length > 0
      ? retrieveFromCache(queries, cachedMarkets)
      : await retrieveFromGammaEvents(queries);
    return rankCandidates(Array.from(legacy.values()));
  }

  if (mode === 'public_search') {
    const cacheHits = cachedMarkets.length > 0
      ? retrieveFromCache(queries, cachedMarkets)
      : new Map<string, CandidateMarket>();
    const publicHits = await retrieveFromPublicSearch(
      queries,
      cachedMarkets,
      cfg.PUBLIC_SEARCH_LIMIT_PER_ENTITY,
    );
    // Merge: public-search results take precedence (fresher, better-ranked),
    // but local-cache hits that public-search missed are still included.
    const merged = new Map<string, CandidateMarket>(cacheHits);
    for (const [id, cand] of publicHits) merged.set(id, cand);
    return rankCandidates(Array.from(merged.values()));
  }

  // mode === 'shadow' — return legacy synchronously; fire /public-search in
  // the background so Gamma latency never stretches the live mapping path.
  // Bounded by SHADOW_PUBLIC_SEARCH_TIMEOUT_MS; errors/timeouts are swallowed.
  const legacy = cachedMarkets.length > 0
    ? retrieveFromCache(queries, cachedMarkets)
    : await retrieveFromGammaEvents(queries);
  const legacyRanked = rankCandidates(Array.from(legacy.values()));

  let shadowTimeout: NodeJS.Timeout | undefined;
  const publicPromise = retrieveFromPublicSearch(
    queries,
    cachedMarkets,
    cfg.PUBLIC_SEARCH_LIMIT_PER_ENTITY,
  );
  const timeoutPromise = new Promise<never>((_, reject) => {
    shadowTimeout = setTimeout(
      () => { reject(new Error('shadow timeout')); },
      SHADOW_PUBLIC_SEARCH_TIMEOUT_MS,
    );
  });
  void Promise.race([publicPromise, timeoutPromise])
    .then((publicHits) => {
      const publicRanked = rankCandidates(Array.from(publicHits.values()));
      logRetrievalShadow({
        headline: item.title,
        queries,
        legacyTop: legacyRanked,
        publicTop: publicRanked,
        topN: cfg.RELEVANCE_CANDIDATE_CAP,
      });
    })
    .catch((err: unknown) => {
      logger.warn('[entity-extractor] retrieval shadow failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      if (shadowTimeout) clearTimeout(shadowTimeout);
    });

  return legacyRanked;
}

/**
 * Exported for tests. Ranking is a pure function of the candidate list.
 */
export const __testing = {
  tokenizeQuery,
  countMatchingTokens,
  scoreMarketAgainstQueries,
  buildCandidate,
  retrieveFromCache,
  retrieveFromPublicSearch,
  rankCandidates,
};
