/**
 * Market correlator.
 *
 * Given a SpotMove, finds Polymarket markets whose resolution is plausibly affected.
 * Queries Gamma API with asset-specific search terms and determines correlation direction
 * via a lightweight LLM call (cached 24h in Redis).
 */

import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getRedis } from '../shared/redis.js';
import { searchEvents, parseOutcomePrices, parseClobTokenIds } from '../mapping/gamma.js';
import type { GammaMarket } from '../mapping/gamma.js';
import type { SpotMove } from './thresholdDetector.js';

export interface CorrelatedMarket {
  marketId: string;
  conditionId: string;
  clobTokenIds: string[];
  question: string;
  description: string | null;
  currentYesPrice: number;
  correlationDirection: 'positive' | 'negative';
}

/** Asset-specific search queries for Gamma API. */
const ASSET_SEARCH_QUERIES: Record<string, string[]> = {
  bitcoin: ['bitcoin', 'BTC', 'crypto'],
  ethereum: ['ethereum', 'ETH'],
  'CL=F': ['oil', 'crude', 'OPEC', 'sanctions'],
  'GC=F': ['gold', 'safe haven', 'precious metals'],
};

const CORRELATION_CACHE_TTL = 86400; // 24 hours
const MIN_VOLUME = 10_000;
const MIN_LIQUIDITY = 5_000;

/**
 * Determine correlation direction via LLM (with Redis cache).
 *
 * "Does {asset} rising make this market more or less likely to resolve YES?"
 */
async function inferCorrelationDirection(
  assetId: string,
  question: string,
): Promise<'positive' | 'negative'> {
  const redis = getRedis();
  const cacheKey = `spot:correlation:${assetId}:${question}`;

  const cached = await redis.get(cacheKey);
  if (cached === 'positive' || cached === 'negative') return cached;

  const direction = await callLlmForCorrelation(assetId, question);

  await redis.set(cacheKey, direction, 'EX', CORRELATION_CACHE_TTL);
  return direction;
}

async function callLlmForCorrelation(
  assetId: string,
  question: string,
): Promise<'positive' | 'negative'> {
  const cfg = loadConfig();

  // Always ask about the asset *rising* — this makes the cached answer
  // direction-independent. The caller accounts for actual move direction.
  const prompt =
    `Asset: ${assetId}\n` +
    `Market question: "${question}"\n\n` +
    `If ${assetId} rises significantly in price, does that make this market MORE likely or LESS likely to resolve YES?\n` +
    'Answer with ONLY one word: "positive" (more likely YES) or "negative" (less likely YES).';

  const useGemini = cfg.LLM_PROVIDER === 'gemini' && Boolean(process.env['GEMINI_API_KEY']);

  if (useGemini) {
    try {
      return await callGeminiCorrelation(prompt);
    } catch (err) {
      logger.warn('[spot-correlator] Gemini failed for correlation, trying OpenAI', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (process.env['OPENAI_API_KEY']) {
    return await callOpenAICorrelation(prompt);
  }

  // Default to positive if no LLM available
  logger.warn('[spot-correlator] no LLM available for correlation, defaulting to positive');
  return 'positive';
}

async function callGeminiCorrelation(prompt: string): Promise<'positive' | 'negative'> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genai = new GoogleGenerativeAI(process.env['GEMINI_API_KEY'] ?? '');
  const model = genai.getGenerativeModel({ model: loadConfig().GEMINI_MODEL });

  const result = await Promise.race([
    model.generateContent(prompt),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Gemini timeout')), 15_000),
    ),
  ]);

  const text = result.response.text().toLowerCase().trim();
  return text.includes('negative') ? 'negative' : 'positive';
}

async function callOpenAICorrelation(prompt: string): Promise<'positive' | 'negative'> {
  const { OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] });

  const completion = await client.chat.completions.create(
    {
      model: loadConfig().OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 10,
      temperature: 0,
    },
    { signal: AbortSignal.timeout(15_000) },
  );

  const text = (completion.choices[0]?.message?.content ?? '').toLowerCase().trim();
  return text.includes('negative') ? 'negative' : 'positive';
}

function meetsLiquidityFilter(market: GammaMarket): boolean {
  const volume = parseFloat(market.volume || '0');
  const liquidity = parseFloat(market.liquidity || '0');
  return volume >= MIN_VOLUME && liquidity >= MIN_LIQUIDITY;
}

/**
 * Find Polymarket markets correlated to a spot move.
 */
export async function findCorrelatedMarkets(move: SpotMove): Promise<CorrelatedMarket[]> {
  const queries = ASSET_SEARCH_QUERIES[move.assetId] ?? [move.assetId];
  const seenMarketIds = new Set<string>();
  const correlatedMarkets: CorrelatedMarket[] = [];

  for (const query of queries) {
    let events;
    try {
      events = await searchEvents({ query, limit: 10, activeOnly: true });
    } catch (err) {
      logger.warn('[spot-correlator] Gamma search failed', {
        query,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const event of events) {
      for (const market of event.markets) {
        if (!market.active || market.closed) continue;
        if (seenMarketIds.has(market.id)) continue;
        seenMarketIds.add(market.id);

        if (!meetsLiquidityFilter(market)) continue;

        let currentYesPrice: number;
        try {
          const prices = parseOutcomePrices(market.outcomePrices);
          currentYesPrice = parseFloat(prices[0] ?? '0');
          if (!isFinite(currentYesPrice) || currentYesPrice <= 0 || currentYesPrice >= 1) continue;
        } catch {
          continue;
        }

        let clobTokenIds: string[];
        try {
          clobTokenIds = parseClobTokenIds(market.clobTokenIds);
        } catch {
          continue;
        }

        let correlationDirection: 'positive' | 'negative';
        try {
          correlationDirection = await inferCorrelationDirection(
            move.assetId,
            market.question,
          );
        } catch (err) {
          logger.warn('[spot-correlator] correlation inference failed', {
            marketId: market.id,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        correlatedMarkets.push({
          marketId: market.id,
          conditionId: market.conditionId,
          clobTokenIds,
          question: market.question,
          description: market.description,
          currentYesPrice,
          correlationDirection,
        });
      }
    }
  }

  logger.info('[spot-correlator] found correlated markets', {
    assetId: move.assetId,
    count: correlatedMarkets.length,
  });

  return correlatedMarkets;
}
