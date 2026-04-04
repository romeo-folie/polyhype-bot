import { logger } from './logger.js';

export interface GammaMarket {
  id: string; // numeric ID as string
  question: string;
  conditionId: string;
  clobTokenIds: string[]; // [yes, no]
  active: boolean;
  closed: boolean;
}

/**
 * Fetch market metadata from Polymarket Gamma API by conditionId.
 * Validates the condition exists and returns the numeric ID and question.
 */
export async function fetchMarketByConditionId(conditionId: string): Promise<GammaMarket | null> {
  const url = `https://gamma-api.polymarket.com/markets?condition_ids=${conditionId}`;
  
  try {
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) return null;

    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    const market = data[0] as Record<string, unknown>;
    
    // Gamma returns 'id' as a numeric string, 'question' as the title, 
    // and 'clobTokenIds' as a JSON string or array.
    const clobTokenIdsRaw = market.clobTokenIds;
    let clobTokenIds: string[] = [];
    if (typeof clobTokenIdsRaw === 'string') {
      clobTokenIds = JSON.parse(clobTokenIdsRaw) as string[];
    } else if (Array.isArray(clobTokenIdsRaw)) {
      clobTokenIds = clobTokenIdsRaw as string[];
    }

    return {
      id: String(market.id),
      question: String(market.question),
      conditionId: String(market.conditionId),
      clobTokenIds,
      active: market.active === true,
      closed: market.closed === true,
    };
  } catch (err) {
    logger.error('[polymarket-gamma] fetch failed', { conditionId, error: String(err) });
    return null;
  }
}

/**
 * Search for a market by its question text on Gamma.
 * Used as a fallback for Simmer UUID resolution.
 */
export async function fetchMarketByQuestion(question: string): Promise<GammaMarket | null> {
  const url = `https://gamma-api.polymarket.com/markets?q=${encodeURIComponent(question)}`;
  
  try {
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) return null;

    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    // Use normalized comparison to ensure it's the right market
    const normalize = (q: string) => q?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
    const target = normalize(question);

    for (const m of data) {
      if (normalize(m.question) === target) {
        const market = m as Record<string, unknown>;
        let clobTokenIds: string[] = [];
        if (typeof market.clobTokenIds === 'string') {
          clobTokenIds = JSON.parse(market.clobTokenIds) as string[];
        } else if (Array.isArray(market.clobTokenIds)) {
          clobTokenIds = market.clobTokenIds as string[];
        }

        return {
          id: String(market.id),
          question: String(market.question),
          conditionId: String(market.conditionId),
          clobTokenIds,
          active: market.active === true,
          closed: market.closed === true,
        };
      }
    }

    return null;
  } catch (err) {
    logger.error('[polymarket-gamma] search failed', { question, error: String(err) });
    return null;
  }
}
