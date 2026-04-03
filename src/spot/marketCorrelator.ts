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
  /** True when the Gamma market has fees enabled — skip for CLOB execution */
  feesEnabled: boolean;
}

/** Asset-specific search queries for Gamma API. */
const ASSET_SEARCH_QUERIES: Record<string, string[]> = {
  bitcoin: ['bitcoin', 'BTC', 'crypto'],
  ethereum: ['ethereum', 'ETH'],
  solana: ['solana', 'SOL'],
  bittensor: ['TAO', 'bittensor'],
  ripple: ['XRP', 'ripple'],
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
): Promise<'positive' | 'negative' | 'none'> {
  const redis = getRedis();
  const cacheKey = `spot:correlation:v2:${assetId}:${question}`;

  const cached = await redis.get(cacheKey);
  if (cached === 'positive' || cached === 'negative' || cached === 'none') return cached as any;

  const direction = await callLlmForCorrelation(assetId, question);

  await redis.set(cacheKey, direction, 'EX', CORRELATION_CACHE_TTL);
  return direction;
}

async function callLlmForCorrelation(
  assetId: string,
  question: string,
): Promise<'positive' | 'negative' | 'none'> {
  const cfg = loadConfig();

  const prompt =
    `Asset: ${assetId}\n` +
    `Market question: "${question}"\n\n` +
    `If the price of ${assetId} rises significantly, does that have a DIRECT or STRONG INDIRECT impact on this market?\n` +
    'Answer with "positive" (makes YES more likely), "negative" (makes YES less likely), or "none" (no strong link or irrelevant). ' +
    'Answer ONLY with one of those three words.';

  const useGemini = cfg.LLM_PROVIDER === 'gemini' && Boolean(process.env.GEMINI_API_KEY);

  if (useGemini) {
    try {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
      const model = genai.getGenerativeModel({ model: loadConfig().GEMINI_MODEL });
      const result = await model.generateContent(prompt);
      const text = result.response.text().toLowerCase().trim();
      if (text.includes('none')) return 'none';
      if (text.includes('negative')) return 'negative';
      return 'positive';
    } catch { /* fallback to openai */ }
  }

  if (process.env.OPENAI_API_KEY) {
    const { OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await client.chat.completions.create({
      model: loadConfig().OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 10,
      temperature: 0,
    });
    const text = (completion.choices[0]?.message?.content ?? '').toLowerCase().trim();
    if (text.includes('none')) return 'none';
    if (text.includes('negative')) return 'negative';
    return 'positive';
  }

  return 'none';
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
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('429')) throw err;
      continue;
    }

    const qLower = query.toLowerCase();

    for (const event of events) {
      const titleLower = (event.title || '').toLowerCase();
      // Only keep if title matches the search query (avoiding fuzzy trends fallback)
      if (!titleLower.includes(qLower)) {
        let hasMatchInMarkets = false;
        for (const m of event.markets) {
          if (m.question.toLowerCase().includes(qLower) || (m.description || '').toLowerCase().includes(qLower)) {
            hasMatchInMarkets = true;
            break;
          }
        }
        if (!hasMatchInMarkets) continue;
      }

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

        const corrDir = await inferCorrelationDirection(
          move.assetId,
          market.question,
        );
        if (corrDir === 'none') continue;

        correlatedMarkets.push({
          marketId: market.id,
          conditionId: market.conditionId,
          clobTokenIds,
          question: market.question,
          description: market.description,
          currentYesPrice,
          correlationDirection: corrDir,
          feesEnabled: market.feesEnabled === true,
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
