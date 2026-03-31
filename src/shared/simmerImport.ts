/**
 * Simmer market import utilities.
 *
 * importMarket(polymarketUrl): imports a Polymarket event/market URL into Simmer
 * discoverUnimportedMarkets(): returns markets available for import
 */

import { z } from 'zod';
import { loadConfig } from './config.js';
import { logger } from './logger.js';

const SIMMER_BASE_URL = 'https://api.simmer.markets';
const IMPORT_ENDPOINT = `${SIMMER_BASE_URL}/api/sdk/markets/import`;
const DISCOVER_ENDPOINT = `${SIMMER_BASE_URL}/api/sdk/markets/discover`;
const REQUEST_TIMEOUT_MS = 30_000;

// ── Request / response types ──────────────────────────────────────────────────


/** Zod schema for Simmer import response. */
const SimmerImportResultSchema = z.object({
  success: z.boolean(),
  market_id: z.string().optional(),
  error: z.string().optional().nullable(),
  message: z.string().optional().nullable(),
});

export type SimmerImportResult = z.infer<typeof SimmerImportResultSchema>;

/** Discovery result from GET /api/sdk/markets/discover. */
export interface SimmerDiscoverResult {
  polymarket_url: string;
  question?: string;
  volume_usd?: number;
  liquidity_usd?: number;
  [key: string]: unknown;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Import a Polymarket market into Simmer.
 *
 * Enriches imported markets with divergence scores, tags, and Simmer's internal market ID.
 *
 * @param polymarketUrl - Full Polymarket event or market URL
 * @returns Success status, Simmer market ID on success, error on failure
 */
export async function importMarket(polymarketUrl: string): Promise<{
  success: boolean;
  marketId?: string;
  alreadyImported?: boolean;
  error?: string;
}> {
  const { SIMMER_API_KEY: apiKey } = loadConfig();

  try {
    const resp = await fetch(IMPORT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        polymarket_url: polymarketUrl,
        shared: true,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    let responseBody: unknown;
    try {
      responseBody = await resp.json();
    } catch {
      responseBody = await resp.text().catch(() => '(unreadable body)');
    }

    // 409 Conflict = already imported — treat as success
    if (resp.status === 409) {
      logger.debug('[simmer-import] market already imported', { url: polymarketUrl });
      return { success: true, alreadyImported: true };
    }

    // 402 Payment Required = x402 payment needed
    if (resp.status === 402) {
      logger.warn('[simmer-import] x402 payment required', { url: polymarketUrl });
      return { success: false, error: 'x402_payment_required' };
    }

    if (!resp.ok) {
      logger.warn('[simmer-import] import failed', {
        url: polymarketUrl,
        status: resp.status,
        body: typeof responseBody === 'string' ? responseBody.slice(0, 200) : JSON.stringify(responseBody).slice(0, 200),
      });
      return {
        success: false,
        error: `HTTP ${resp.status.toString()}`,
      };
    }

    const parsed = SimmerImportResultSchema.safeParse(responseBody);
    if (!parsed.success) {
      logger.warn('[simmer-import] response validation failed', {
        url: polymarketUrl,
        error: parsed.error.message,
      });
      return { success: false, error: 'invalid_response' };
    }

    const result = parsed.data;
    if (!result.success) {
      return {
        success: false,
        error: result.error ?? result.message ?? 'unknown_error',
      };
    }

    logger.info('[simmer-import] market imported successfully', {
      url: polymarketUrl,
      marketId: result.market_id,
    });

    return {
      success: true,
      ...(result.market_id ? { marketId: result.market_id } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[simmer-import] import request failed', {
      url: polymarketUrl,
      error: message,
    });
    return { success: false, error: message };
  }
}

/**
 * Discover markets not yet imported to Simmer.
 *
 * Returns markets that are open for trading, not already imported, above minimum volume.
 *
 * @param opts.tags - Optional tag filter
 * @param opts.limit - Max results to return (default 50)
 * @returns Array of discoverable markets
 */
export async function discoverUnimportedMarkets(opts: {
  tags?: string;
  limit?: number;
} = {}): Promise<SimmerDiscoverResult[]> {
  const { SIMMER_API_KEY: apiKey } = loadConfig();
  const { tags, limit = 50 } = opts;

  try {
    const params = new URLSearchParams({ limit: limit.toString() });
    if (tags) params.set('tags', tags);

    const resp = await fetch(`${DISCOVER_ENDPOINT}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!resp.ok) {
      logger.warn('[simmer-import] discover failed', { status: resp.status });
      return [];
    }

    const data = (await resp.json()) as { markets?: SimmerDiscoverResult[] } | SimmerDiscoverResult[];
    const markets = Array.isArray(data) ? data : (data.markets ?? []);

    logger.debug('[simmer-import] discovery complete', { count: markets.length });
    return markets;
  } catch (err) {
    logger.error('[simmer-import] discovery request failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
