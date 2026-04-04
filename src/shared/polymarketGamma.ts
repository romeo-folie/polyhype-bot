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
  const url = `https://gamma-api.polymarket.com/v1/markets?condition_id=${conditionId}`;
  
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
