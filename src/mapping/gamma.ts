/**
 * Polymarket Gamma API client.
 *
 * Wraps the public Gamma API for event and market queries.
 * All requests are unauthenticated — no API key required.
 *
 * Docs: https://gamma-api.polymarket.com (OpenAPI)
 */

const BASE_URL = 'https://gamma-api.polymarket.com';
const REQUEST_TIMEOUT_MS = 15_000;

export interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  active: boolean;
  closed: boolean;
  markets: GammaMarket[];
}

export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  /**
   * CLOB token IDs — [YES token, NO token].
   *
   * Gamma currently returns this as a JSON-encoded string in many responses,
   * e.g. '["123", "456"]'. Some environments return it pre-parsed as string[].
   */
  clobTokenIds: string | string[];
  /**
   * Current best-bid prices per outcome.
   *
   * Gamma API v2 returns this as a JSON-encoded string, e.g. `'["0.72","0.28"]'`.
   * Some SDK wrappers pre-parse it to `string[]`. We accept both forms —
   * use `parseOutcomePrices()` to normalise before accessing individual prices.
   */
  outcomePrices: string | string[];
  outcomes: string[];
  active: boolean;
  closed: boolean;
  volume: string;
  liquidity: string;
  endDate: string | null;
  description: string | null;
}

interface SearchEventsOptions {
  query: string;
  /** Max results to return. Defaults to 10. */
  limit?: number;
  /** Only return currently active (non-closed) markets. Defaults to true. */
  activeOnly?: boolean;
}

export function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

/**
 * Search Polymarket events by keyword query.
 *
 * Returns events that match the query string, each with their nested markets.
 */
export async function searchEvents(opts: SearchEventsOptions): Promise<GammaEvent[]> {
  const { query, limit = 10, activeOnly = true } = opts;
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    ...(activeOnly ? { active: 'true', closed: 'false' } : {}),
  });

  const url = `${BASE_URL}/events?${params.toString()}`;
  const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);

  if (!res.ok) {
    throw new Error(`Gamma API error: ${res.status} ${res.statusText} for query="${query}"`);
  }

  const data = (await res.json()) as GammaEvent[];
  return Array.isArray(data) ? data : [];
}

/**
 * Fetch a single market by its Gamma market ID.
 *
 * Used to refresh current prices before execution.
 */
export async function getMarket(marketId: string): Promise<GammaMarket> {
  const url = `${BASE_URL}/markets/${encodeURIComponent(marketId)}`;
  const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);

  if (!res.ok) {
    throw new Error(`Gamma API error: ${res.status} ${res.statusText} for market=${marketId}`);
  }

  return (await res.json()) as GammaMarket;
}

/**
 * Normalise `outcomePrices` from either form returned by the Gamma API.
 *
 * Gamma v2 returns a JSON-encoded string: `'["0.72","0.28"]'`
 * Some SDK wrappers or mock environments may provide it pre-parsed as `string[]`.
 *
 * Returns `string[]` in both cases.
 */
export function parseOutcomePrices(outcomePrices: string | string[]): string[] {
  if (Array.isArray(outcomePrices)) return outcomePrices;
  // JSON-encoded string case
  try {
    const parsed = JSON.parse(outcomePrices) as unknown;
    if (Array.isArray(parsed)) return parsed as string[];
    throw new Error('Parsed outcomePrices is not an array');
  } catch (e) {
    throw new Error(`Cannot parse outcomePrices: "${outcomePrices}" — ${String(e)}`);
  }
}

/**
 * Normalise `clobTokenIds` from either form returned by Gamma.
 *
 * Gamma often returns a JSON-encoded string instead of string[].
 */
export function parseClobTokenIds(clobTokenIds: string | string[]): string[] {
  if (Array.isArray(clobTokenIds)) return clobTokenIds;
  try {
    const parsed = JSON.parse(clobTokenIds) as unknown;
    if (Array.isArray(parsed)) return parsed as string[];
    throw new Error('Parsed clobTokenIds is not an array');
  } catch (e) {
    throw new Error(`Cannot parse clobTokenIds: "${clobTokenIds}" — ${String(e)}`);
  }
}

/**
 * Parse a raw `outcomePrices` field from a Gamma market into a numeric YES price.
 *
 * Gamma returns outcomePrices as a JSON-encoded string, e.g. `'["0.72","0.28"]'`
 * where index 0 = YES price, index 1 = NO price.
 *
 * Accepts both pre-parsed `string[]` and raw JSON string.
 */
/**
 * Fetch active binary markets from Gamma API, sorted by liquidity descending.
 *
 * Fetches up to `maxTotal` markets across multiple paginated requests, each
 * page capped at `pageSize` (Gamma API hard limit: 500 per request).
 *
 * Sorting by `liquidityNum` descending ensures the most liquid (and therefore
 * most executable) markets are scanned first. This matters for arb: thin-book
 * markets appear as arb opportunities on paper but FOK orders reliably fail
 * due to insufficient depth.
 *
 * Pagination stops early if a page returns fewer results than requested
 * (signals end of available markets).
 */
export async function getActiveMarkets(
  maxTotal = 1000,
  pageSize = 500,
): Promise<GammaMarket[]> {
  const results: GammaMarket[] = [];
  let offset = 0;

  while (results.length < maxTotal) {
    const batchSize = Math.min(pageSize, maxTotal - results.length);
    const params = new URLSearchParams({
      active: 'true',
      closed: 'false',
      enable_order_book: 'true',
      limit: String(batchSize),
      offset: String(offset),
      order: 'liquidityNum',
      ascending: 'false',
    });

    const url = `${BASE_URL}/markets?${params.toString()}`;
    const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Gamma markets error: ${res.status}`);

    const data = (await res.json()) as unknown;
    if (!Array.isArray(data) || data.length === 0) break;

    const batch = (data as GammaMarket[]).slice(0, maxTotal - results.length);
    results.push(...batch);
    offset += data.length;

    // Partial page means we've hit the end of available markets
    if (data.length < batchSize) break;
  }

  return results;
}

export function parseYesPrice(outcomePrices: string | string[]): number {
  const prices = parseOutcomePrices(outcomePrices);
  if (prices.length === 0) {
    throw new Error('outcomePrices is empty or not an array');
  }
  const raw = prices[0];
  if (raw === undefined) {
    throw new Error('outcomePrices[0] is undefined');
  }
  const price = parseFloat(raw);
  if (!isFinite(price)) {
    throw new Error(`Cannot parse YES price from outcomePrices[0]="${raw}"`);
  }
  return price;
}
