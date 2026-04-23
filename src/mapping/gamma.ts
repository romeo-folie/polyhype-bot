/**
 * Polymarket Gamma API client.
 *
 * Wraps the public Gamma API for event and market queries.
 * All requests are unauthenticated — no API key required.
 *
 * Docs: https://gamma-api.polymarket.com (OpenAPI)
 */

import { logger } from '../shared/logger.js';

const BASE_URL = 'https://gamma-api.polymarket.com';
const REQUEST_TIMEOUT_MS = 15_000;

// Process-local 429 circuit breaker — backs off for 5 minutes after any rate-limit response.
// Prevents tight retry loops from compounding rate limits across scan cycles.
let gammaRateLimitedUntilMs = 0;
let gammaRateLimitLogged = false;
const GAMMA_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

export interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  active: boolean;
  closed: boolean;
  markets: GammaMarket[];
  /** True for NegRisk events (multi-outcome, exactly one resolves YES at $1.00). */
  negRisk?: boolean;
}

export interface GammaMarketEvent {
  id: string;
  slug: string;
}

export interface GammaMarket {
  id: string;
  /** Market slug, e.g. `btc-updown-15m-1776005100`. Present on most Gamma responses. */
  slug?: string;
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
  /** Parent events for this market. Present on /markets responses from Gamma. */
  events?: GammaMarketEvent[];
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
 * Shape of the Gamma `/public-search` response.
 *
 * Unlike `/events`, this endpoint returns a wrapper object with pagination
 * metadata. `limit_per_type` caps events at 50 per request. We only consume
 * the `events` field — profiles/tags are not used.
 */
export interface PublicSearchResponse {
  events?: GammaEvent[];
  pagination?: { hasMore?: boolean; totalResults?: number };
}

export interface PublicSearchOptions {
  query: string;
  /** Max events per page. Polymarket caps this at 50. Defaults to 20. */
  limit?: number;
  /** When true, passes `events_status=active` to exclude closed events. Defaults to true. */
  activeOnly?: boolean;
}

/**
 * Full-text search over Polymarket markets via the Gamma `/public-search`
 * endpoint. Ranks results topically (far better than our local substring +
 * liquidity-sort retriever on political queries where sports markets
 * otherwise dominate liquidity rankings).
 *
 * Filter note: `events_status=active` is required to exclude closed 2023-era
 * markets that still dominate raw substring matches (they share vocabulary
 * like "war" with active Iran markets).
 */
export async function publicSearch(opts: PublicSearchOptions): Promise<GammaEvent[]> {
  const { query, limit = 20, activeOnly = true } = opts;
  const params = new URLSearchParams({
    q: query,
    limit_per_type: Math.min(limit, 50).toString(),
    ...(activeOnly ? { events_status: 'active' } : {}),
  });
  const url = `${BASE_URL}/public-search?${params.toString()}`;
  const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);

  if (!res.ok) {
    throw new Error(
      `Gamma public-search error: ${res.status.toString()} ${res.statusText} for query="${query}"`,
    );
  }

  const data = (await res.json()) as PublicSearchResponse;
  return Array.isArray(data.events) ? data.events : [];
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

    if (Date.now() < gammaRateLimitedUntilMs) {
      if (!gammaRateLimitLogged) {
        logger.warn('[gamma] circuit breaker open — returning empty until backoff expires', {
          remainingMs: gammaRateLimitedUntilMs - Date.now(),
        });
        gammaRateLimitLogged = true;
      }
      return [];
    }
    gammaRateLimitLogged = false;

    const url = `${BASE_URL}/markets?${params.toString()}`;
    const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
    if (!res.ok) {
      if (res.status === 429) {
        gammaRateLimitedUntilMs = Date.now() + GAMMA_RATE_LIMIT_BACKOFF_MS;
        throw new Error('Gamma API rate-limited (429) — circuit breaker open for 5 minutes');
      }
      throw new Error(`Gamma markets error: ${res.status.toString()}`);
    }

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
 * Fetch active NegRisk events from Gamma API, sorted by liquidity descending.
 *
 * NegRisk events have N mutually exclusive outcomes — exactly one resolves YES
 * at $1.00. Each outcome is a separate market with its own CLOB order book.
 *
 * Gamma API does not support a `neg_risk` query parameter (returns 422),
 * so we fetch top events by liquidity and filter client-side.
 * The `limit` here controls the Gamma fetch window; the returned array
 * will be smaller (only NegRisk events).
 */
export async function getNegRiskEvents(opts?: {
  limit?: number;
}): Promise<GammaEvent[]> {
  const maxResults = opts?.limit ?? 50;
  // Over-fetch from Gamma since we filter client-side; NegRisk events
  // are a subset of all events. Capped at 500 (Gamma API per-request max).
  const fetchLimit = Math.min(Math.max(maxResults * 4, 200), 500);

  if (Date.now() < gammaRateLimitedUntilMs) {
    if (!gammaRateLimitLogged) {
      logger.warn('[gamma] circuit breaker open — returning empty for NegRisk', {
        remainingMs: gammaRateLimitedUntilMs - Date.now(),
      });
      gammaRateLimitLogged = true;
    }
    return [];
  }
  gammaRateLimitLogged = false;

  // Note: `neg_risk` query param is NOT supported by Gamma (returns 422).
  // We fetch all top-liquidity events and filter client-side.
  // Events endpoint uses `liquidity` (not `liquidityNum` like /markets).
  const params = new URLSearchParams({
    active: 'true',
    closed: 'false',
    limit: fetchLimit.toString(),
    order: 'liquidity',
    ascending: 'false',
  });

  const url = `${BASE_URL}/events?${params.toString()}`;

  try {
    const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
    if (!res.ok) {
      if (res.status === 429) {
        gammaRateLimitedUntilMs = Date.now() + GAMMA_RATE_LIMIT_BACKOFF_MS;
        throw new Error('Gamma API rate-limited (429) — circuit breaker open for 5 minutes');
      }
      throw new Error(`Gamma events error: ${res.status.toString()} ${res.statusText}`);
    }
    const data = (await res.json()) as GammaEvent[];
    if (!Array.isArray(data)) return [];
    // Client-side filter: only NegRisk events, capped at requested limit
    return data.filter((e) => e.negRisk === true).slice(0, maxResults);
  } catch (err) {
    logger.warn('[gamma] getNegRiskEvents failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
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

      return data
        .map((event) => ({
          ...event,
          markets: event.markets.filter((m) => {
            if (!m.active || m.closed || !m.endDate) return false;
            const endMs = new Date(m.endDate).getTime();
            return endMs > now && endMs <= cutoff;
          }),
        }))
        .filter((event) => event.markets.length > 0);
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

// ============================================================================
// Up/Down 15m market discovery (oracle-lag-15m epic, task 002)
// ============================================================================

/**
 * Gamma event tag. Gamma returns a list of tag objects on each event with
 * fields like `{id, label, slug}`. We only need `slug` (e.g. "15M", "5M")
 * for the lifetime filter.
 */
export interface GammaEventTag {
  id?: string;
  label?: string;
  slug?: string;
}

/**
 * Variant of `GammaEvent` that exposes the `tags` array. The base `GammaEvent`
 * interface omits `tags` because most call sites don't need it — we widen it
 * locally here for Up/Down market discovery.
 */
export interface GammaEventWithTags extends GammaEvent {
  tags?: GammaEventTag[];
}

/**
 * Slug prefix map: which Polymarket slug prefix to look for given an asset.
 * Example: bitcoin → "btc" → matches slugs like "btc-updown-15m-1776005100".
 */
export const UPDOWN_ASSET_SLUG_PREFIX: Record<string, string> = {
  bitcoin: 'btc',
  ethereum: 'eth',
  solana: 'sol',
  xrp: 'xrp',
  dogecoin: 'doge',
  bnb: 'bnb',
  hyperliquid: 'hype',
};

/**
 * Asset identifier for Up/Down market discovery. Values matching keys of
 * `UPDOWN_ASSET_SLUG_PREFIX` are recognised; unknown assets return `[]` with
 * a warn log.
 */
export type UpDownAsset = string;
export type UpDownLifetime = '5m' | '15m';

/**
 * A Polymarket Up/Down market normalised for the oracle-lag scanner.
 *
 * `clobTokenIds` is always `[UP_token, DOWN_token]` for Up/Down markets.
 * UP resolves YES when the asset closes above the strike, so:
 *   yesTokenId = clobTokenIds[0] (UP)
 *   noTokenId  = clobTokenIds[1] (DOWN)
 */
export interface UpDownMarket {
  marketId: string;
  slug: string;
  question: string;
  endDate: Date;
  timeToResolutionMs: number;
  lifetime: UpDownLifetime;
  asset: string;
  outcomePrices: [number, number];
  clobTokenIds: [string, string];
  yesTokenId: string;
  noTokenId: string;
}

export interface ListUpDownMarketsOptions {
  asset: UpDownAsset;
  lifetime: UpDownLifetime;
  /** Cap on remaining time-to-resolution. Markets with `endDate - now > maxTimeToResolutionMin*60_000` are filtered out. */
  maxTimeToResolutionMin: number;
  /** Optional override of the events fetch limit. Defaults to 50. */
  limit?: number;
}

/**
 * Fetcher signature for `listUpDownMarkets`. Accepts the events `limit` the
 * scanner wants and returns raw Gamma events (with `tags` preserved). This
 * indirection exists so unit tests can inject canned responses without
 * stubbing `global.fetch`.
 */
export type UpDownMarketsFetcher = (limit: number) => Promise<GammaEventWithTags[]>;

/**
 * Default fetcher: hits the Gamma `/events?tag=crypto&...` endpoint using the
 * same query-param shape as `listRecentCryptoEvents`. Kept local to
 * `listUpDownMarkets` so task 001's logic is untouched.
 *
 * Returns `[]` on any fetch error (logs structured) — the scanner treats a
 * missing response as "no active markets this tick" rather than crashing.
 */
export async function fetchRecentCryptoEventsRaw(limit: number): Promise<GammaEventWithTags[]> {
  const params = new URLSearchParams({
    tag: 'crypto',
    order: 'startDate',
    ascending: 'false',
    active: 'true',
    closed: 'false',
    limit: limit.toString(),
  });

  const url = `${BASE_URL}/events?${params.toString()}`;

  try {
    const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
    if (!res.ok) {
      logger.warn('[gamma] fetchRecentCryptoEventsRaw non-ok response', {
        status: res.status,
        statusText: res.statusText,
      });
      return [];
    }
    const data = (await res.json()) as GammaEventWithTags[];
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.warn('[gamma] fetchRecentCryptoEventsRaw failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * List active Polymarket Up/Down markets matching the requested asset +
 * lifetime + max-time-to-resolution profile.
 *
 * Filter predicate (all must hold, evaluated client-side on the Gamma
 * events response):
 *   1. Market slug matches `^<assetPrefix>-updown-<lifetime>-\d+$`
 *      (e.g. `btc-updown-15m-1776005100`)
 *   2. Parent event's `tags` array contains an entry whose `slug` equals the
 *      uppercase lifetime tag ("15M" or "5M")
 *   3. `market.closed === false` and `market.endDate > now`
 *   4. `endDate - now ≤ maxTimeToResolutionMin * 60_000`
 *
 * `fetcher` is injectable for testing. Pass a canned fetcher in unit tests;
 * omit it in production to use the live Gamma API via
 * `fetchRecentCryptoEventsRaw`.
 */
export async function listUpDownMarkets(
  opts: ListUpDownMarketsOptions,
  fetcher: UpDownMarketsFetcher = fetchRecentCryptoEventsRaw,
): Promise<UpDownMarket[]> {
  const { asset, lifetime, maxTimeToResolutionMin } = opts;
  const limit = opts.limit ?? 50;

  const slugPrefix = UPDOWN_ASSET_SLUG_PREFIX[asset];
  if (!slugPrefix) {
    logger.warn('[gamma] listUpDownMarkets: unknown asset — no slug prefix', { asset });
    return [];
  }

  let events: GammaEventWithTags[];
  try {
    events = await fetcher(limit);
  } catch (err) {
    logger.warn('[gamma] listUpDownMarkets fetcher threw', {
      asset,
      lifetime,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (!Array.isArray(events) || events.length === 0) return [];

  const slugRe = new RegExp(`^${slugPrefix}-updown-${lifetime}-\\d+$`);
  const lifetimeTag = lifetime.toUpperCase(); // '15M' | '5M'
  const maxMs = maxTimeToResolutionMin * 60_000;
  const now = Date.now();

  const results: UpDownMarket[] = [];

  for (const event of events) {
    const tagMatch = (event.tags ?? []).some((t) => t?.slug === lifetimeTag);
    if (!tagMatch) continue;

    for (const m of event.markets ?? []) {
      if (!m.slug || !slugRe.test(m.slug)) continue;
      if (m.closed) continue;
      if (!m.endDate) continue;

      const endMs = new Date(m.endDate).getTime();
      if (!isFinite(endMs)) continue;

      const ttr = endMs - now;
      if (ttr <= 0 || ttr > maxMs) continue;

      let pricesArr: string[];
      let tokensArr: string[];
      try {
        pricesArr = parseOutcomePrices(m.outcomePrices);
        tokensArr = parseClobTokenIds(m.clobTokenIds);
      } catch (err) {
        logger.warn('[gamma] listUpDownMarkets: failed to parse prices/tokens', {
          marketId: m.id,
          slug: m.slug,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (pricesArr.length < 2 || tokensArr.length < 2) continue;

      const upPriceRaw = pricesArr[0];
      const downPriceRaw = pricesArr[1];
      const upToken = tokensArr[0];
      const downToken = tokensArr[1];
      if (
        upPriceRaw === undefined ||
        downPriceRaw === undefined ||
        upToken === undefined ||
        downToken === undefined
      ) {
        continue;
      }

      const upPrice = parseFloat(upPriceRaw);
      const downPrice = parseFloat(downPriceRaw);
      if (!isFinite(upPrice) || !isFinite(downPrice)) continue;

      results.push({
        marketId: m.id,
        slug: m.slug,
        question: m.question,
        endDate: new Date(endMs),
        timeToResolutionMs: ttr,
        lifetime,
        asset,
        outcomePrices: [upPrice, downPrice],
        clobTokenIds: [upToken, downToken],
        yesTokenId: upToken,
        noTokenId: downToken,
      });
    }
  }

  return results;
}

/**
 * Cadence (in seconds) of each Up/Down market lifetime. Slug timestamps are
 * aligned to multiples of this value — e.g. `btc-updown-15m-1775928600` means
 * the 15-minute observation window starting at epoch 1775928600 seconds,
 * resolving `900s` later.
 */
const LIFETIME_CADENCE_SEC: Record<UpDownLifetime, number> = {
  '5m': 300,
  '15m': 900,
};

/** Single-slug fetcher injectable by tests. */
export type UpDownSlugFetcher = (slug: string) => Promise<GammaEventWithTags | null>;

/**
 * Default slug fetcher: hits `/events?slug=<slug>` and returns the first
 * event or null. Returns null on any non-ok or fetch error — callers treat a
 * missing event as "this window doesn't exist yet".
 */
export async function fetchUpDownEventBySlug(
  slug: string,
): Promise<GammaEventWithTags | null> {
  const params = new URLSearchParams({ slug });
  const url = `${BASE_URL}/events?${params.toString()}`;
  try {
    const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
    if (!res.ok) {
      logger.warn('[gamma] fetchUpDownEventBySlug non-ok response', {
        slug,
        status: res.status,
        statusText: res.statusText,
      });
      return null;
    }
    const data = (await res.json()) as GammaEventWithTags[];
    if (!Array.isArray(data) || data.length === 0) return null;
    return data[0] ?? null;
  } catch (err) {
    logger.warn('[gamma] fetchUpDownEventBySlug failed', {
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface DiscoverUpDownMarketsBySlugOptions {
  asset: UpDownAsset;
  lifetime: UpDownLifetime;
  /**
   * How many future windows to probe beyond the currently-open one. Defaults
   * to 2. With `lifetime='15m'` and `windowsAhead=2` we fetch 3 slugs:
   * current window, +15min, +30min.
   */
  windowsAhead?: number;
  /** Injectable current time for deterministic tests. */
  now?: Date;
  /** Injectable fetcher for deterministic tests. */
  fetcher?: UpDownSlugFetcher;
}

/**
 * Discover active Up/Down markets by **predicting their slugs**.
 *
 * Why this exists: Gamma's `/events?tag=crypto` endpoint only orders by
 * `startDate`, not `endDate`. Up/Down markets are created ~24h before their
 * resolution window opens, so "about to resolve" markets are buried >500
 * entries deep — past Gamma's hard response cap. The only reliable discovery
 * path is slug prediction, which is trivially deterministic: every
 * `<asset>-updown-<lifetime>-<timestamp>` slug has `timestamp` aligned to a
 * multiple of the lifetime cadence in seconds (`5m` → 300, `15m` → 900), and
 * `endDate = timestamp + cadenceSec`.
 *
 * Fetches the current window plus `windowsAhead` future windows concurrently
 * via `/events?slug=<slug>` and parses each into an `UpDownMarket`. Missing
 * slugs are silently skipped — not every expected window will exist on
 * Polymarket yet (new series can be lagged).
 */
export async function discoverUpDownMarketsBySlug(
  opts: DiscoverUpDownMarketsBySlugOptions,
): Promise<UpDownMarket[]> {
  const { asset, lifetime } = opts;
  const windowsAhead = opts.windowsAhead ?? 2;
  const now = opts.now ?? new Date();
  const fetcher: UpDownSlugFetcher = opts.fetcher ?? fetchUpDownEventBySlug;

  const slugPrefix = UPDOWN_ASSET_SLUG_PREFIX[asset];
  if (!slugPrefix) {
    logger.warn('[gamma] discoverUpDownMarketsBySlug: unknown asset', { asset });
    return [];
  }

  const cadenceSec = LIFETIME_CADENCE_SEC[lifetime];
  const nowSec = Math.floor(now.getTime() / 1000);
  // Current boundary = start of the window containing `now`. resolves at
  // currentBoundary + cadenceSec.
  const currentBoundary = Math.floor(nowSec / cadenceSec) * cadenceSec;

  const slugs: string[] = [];
  for (let i = 0; i <= windowsAhead; i++) {
    const ts = currentBoundary + i * cadenceSec;
    slugs.push(`${slugPrefix}-updown-${lifetime}-${ts.toString()}`);
  }

  const events = await Promise.all(slugs.map((s) => fetcher(s)));

  const lifetimeTag = lifetime.toUpperCase(); // '15M' | '5M'
  const slugRe = new RegExp(`^${slugPrefix}-updown-${lifetime}-\\d+$`);
  const results: UpDownMarket[] = [];

  for (const event of events) {
    if (!event) continue;
    const tagMatch = (event.tags ?? []).some((t) => t?.slug === lifetimeTag);
    if (!tagMatch) continue;

    for (const m of event.markets ?? []) {
      if (!m.slug || !slugRe.test(m.slug)) continue;
      if (m.closed) continue;
      if (!m.endDate) continue;

      const endMs = new Date(m.endDate).getTime();
      if (!isFinite(endMs)) continue;

      const ttr = endMs - now.getTime();
      if (ttr <= 0) continue;

      let pricesArr: string[];
      let tokensArr: string[];
      try {
        pricesArr = parseOutcomePrices(m.outcomePrices);
        tokensArr = parseClobTokenIds(m.clobTokenIds);
      } catch (err) {
        logger.warn('[gamma] discoverUpDownMarketsBySlug: failed to parse prices/tokens', {
          marketId: m.id,
          slug: m.slug,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (pricesArr.length < 2 || tokensArr.length < 2) continue;

      const upPriceRaw = pricesArr[0];
      const downPriceRaw = pricesArr[1];
      const upToken = tokensArr[0];
      const downToken = tokensArr[1];
      if (
        upPriceRaw === undefined ||
        downPriceRaw === undefined ||
        upToken === undefined ||
        downToken === undefined
      ) {
        continue;
      }

      const upPrice = parseFloat(upPriceRaw);
      const downPrice = parseFloat(downPriceRaw);
      if (!isFinite(upPrice) || !isFinite(downPrice)) continue;

      results.push({
        marketId: m.id,
        slug: m.slug,
        question: m.question,
        endDate: new Date(endMs),
        timeToResolutionMs: ttr,
        lifetime,
        asset,
        outcomePrices: [upPrice, downPrice],
        clobTokenIds: [upToken, downToken],
        yesTokenId: upToken,
        noTokenId: downToken,
      });
    }
  }

  return results;
}

// Process-local tag cache — 24h TTL per hit, 5-min TTL per miss/error.
const eventTagCache = new Map<string, { slugs: string[]; expiresAt: number }>();
const EVENT_TAG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const EVENT_TAG_CACHE_MISS_TTL_MS = 5 * 60 * 1000;
const EVENT_TAG_CACHE_MAX = 2000;

function setEventTagEntry(eventId: string, slugs: string[], ttlMs: number): void {
  // Evict all expired entries before inserting when near the cap.
  // This prevents unbounded growth without nuking fresh entries.
  if (eventTagCache.size >= EVENT_TAG_CACHE_MAX) {
    const now = Date.now();
    for (const [key, entry] of eventTagCache) {
      if (now >= entry.expiresAt) eventTagCache.delete(key);
    }
    // If still at the cap after evicting expired entries, remove the oldest live entry.
    if (eventTagCache.size >= EVENT_TAG_CACHE_MAX) {
      const oldestKey = eventTagCache.keys().next().value;
      if (oldestKey !== undefined) eventTagCache.delete(oldestKey);
    }
  }
  eventTagCache.set(eventId, { slugs, expiresAt: Date.now() + ttlMs });
}

/**
 * Fetch Gamma tag slugs for a single event ID.
 *
 * Successful lookups are cached 24h; errors/non-OK responses are cached 5 min
 * to prevent hammering a degraded Gamma endpoint on a hot eventId.
 * Slugs are lowercased for case-insensitive matching. Malformed/nullish
 * tag entries from the API are silently skipped.
 * Returns [] on any error — callers degrade gracefully.
 */
export async function getEventTagSlugs(eventId: string): Promise<string[]> {
  const cached = eventTagCache.get(eventId);
  if (cached) {
    if (Date.now() < cached.expiresAt) return cached.slugs;
    eventTagCache.delete(eventId);
  }

  try {
    const url = `${BASE_URL}/events/${encodeURIComponent(eventId)}`;
    const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
    if (!res.ok) {
      setEventTagEntry(eventId, [], EVENT_TAG_CACHE_MISS_TTL_MS);
      return [];
    }

    const event = (await res.json()) as { tags?: unknown[] };
    const slugs = Array.isArray(event.tags)
      ? event.tags
          .filter((t): t is { slug: string } => typeof (t as any)?.slug === 'string')
          .map((t) => t.slug.toLowerCase())
      : [];
    setEventTagEntry(eventId, slugs, EVENT_TAG_CACHE_TTL_MS);
    return slugs;
  } catch {
    setEventTagEntry(eventId, [], EVENT_TAG_CACHE_MISS_TTL_MS);
    return [];
  }
}
