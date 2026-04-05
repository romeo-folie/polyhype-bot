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
  outcomes: string | string[];
  active: boolean;
  closed: boolean;
  volume: string;
  liquidity: string;
  endDate: string | null;
  description: string | null;
  /** True when the market charges fees (Polymarket fee markets — avoid for arb/execution) */
  feesEnabled?: boolean;
  /** Fee type string when feesEnabled=true (e.g. "taker", "both"). Null when no fees. */
  feeType?: string | null;
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
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => {
    clearTimeout(timer);
  });
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
    limit: limit.toString(),
    ...(activeOnly ? { active: 'true', closed: 'false' } : {}),
  });

  const url = `${BASE_URL}/events?${params.toString()}`;
  const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);

  if (!res.ok) {
    throw new Error(`Gamma API error: ${res.status.toString()} ${res.statusText} for query="${query}"`);
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
    throw new Error(`Gamma API error: ${res.status.toString()} ${res.statusText} for market=${marketId}`);
  }

  return (await res.json()) as GammaMarket;
}

/**
 * Fetch a market by slug (returns the first match or null).
 */
export async function getMarketBySlug(slug: string): Promise<GammaMarket | null> {
  const params = new URLSearchParams({ slug });
  const url = `${BASE_URL}/markets?${params.toString()}`;
  const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);

  if (!res.ok) {
    throw new Error(`Gamma API error: ${res.status.toString()} ${res.statusText} for slug=${slug}`);
  }

  const data = (await res.json()) as GammaMarket[];
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0] ?? null;
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
 * Normalise `outcomes` from either form returned by Gamma.
 *
 * Gamma often returns a JSON-encoded string instead of string[].
 */
export function parseOutcomes(outcomes: string | string[]): string[] {
  if (Array.isArray(outcomes)) return outcomes;
  try {
    const parsed = JSON.parse(outcomes) as unknown;
    if (Array.isArray(parsed)) return parsed as string[];
    throw new Error('Parsed outcomes is not an array');
  } catch (e) {
    throw new Error(`Cannot parse outcomes: "${outcomes}" — ${String(e)}`);
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
export async function getActiveMarkets(maxTotal = 1000, pageSize = 500): Promise<GammaMarket[]> {
  const results: GammaMarket[] = [];
  let offset = 0;

  while (results.length < maxTotal) {
    const batchSize = Math.min(pageSize, maxTotal - results.length);
    const params = new URLSearchParams({
      active: 'true',
      closed: 'false',
      enable_order_book: 'true',
      limit: batchSize.toString(),
      offset: offset.toString(),
      order: 'liquidityNum',
      ascending: 'false',
    });

    const url = `${BASE_URL}/markets?${params.toString()}`;
    const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Gamma markets error: ${res.status.toString()}`);

    const data = (await res.json());
    if (!Array.isArray(data) || data.length === 0) break;

    const batch = (data as GammaMarket[]).slice(0, maxTotal - results.length);
    results.push(...batch);
    offset += data.length;

    // Partial page means we've hit the end of available markets
    if (data.length < batchSize) break;
  }

  return results;
}

/**
 * List recent crypto events from Gamma, sorted by start date descending.
 *
 * Unlike `searchEvents` (keyword-based), this uses tag-based listing to
 * discover ephemeral markets like "Bitcoin Up or Down" that don't appear
 * in keyword search results.
 *
 * Filters to events resolving within `maxHoursToResolution` (default 1 hour).
 */
export async function listRecentCryptoEvents(opts?: {
  maxHoursToResolution?: number;
  limit?: number;
}): Promise<GammaEvent[]> {
  const maxHours = opts?.maxHoursToResolution ?? 1;
  const limit = opts?.limit ?? 20;

  const params = new URLSearchParams({
    tag: 'crypto',
    order: 'startDate',
    ascending: 'false',
    active: 'true',
    closed: 'false',
    limit: limit.toString(),
  });

  const url = `${BASE_URL}/events?${params.toString()}`;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
      if (!res.ok) {
        throw new Error(`Gamma API error: ${res.status.toString()} ${res.statusText} for crypto events`);
      }
      const data = (await res.json()) as GammaEvent[];
      if (!Array.isArray(data)) return [];

      // Filter to events with markets resolving within the time window
      const now = Date.now();
      const cutoff = now + maxHours * 60 * 60 * 1000;

      return data.filter((event) => {
        // Check if any market in the event resolves within the window
        return event.markets.some((m) => {
          if (!m.active || m.closed || !m.endDate) return false;
          const endMs = new Date(m.endDate).getTime();
          return endMs > now && endMs <= cutoff;
        });
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === 0) {
        // Brief pause before retry
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  throw lastError ?? new Error('listRecentCryptoEvents failed');
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
