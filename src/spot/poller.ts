/**
 * Spot price poller.
 *
 * Polls CoinGecko (crypto) and Yahoo Finance (commodities) for spot prices.
 * Stores a rolling 60-minute price window in Redis sorted sets.
 */

import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getRedis } from '../shared/redis.js';

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const ROLLING_WINDOW_MS = 60 * 60 * 1000; // 60 minutes
const REQUEST_TIMEOUT_MS = 10_000;

export interface SpotPrice {
  assetId: string;
  price: number;
  timestamp: number; // epoch ms
}

type CoinGeckoResponse = Record<string, { usd?: number; last_updated_at?: number }>;

interface YahooChartResponse {
  chart?: {
    result?: { meta?: { regularMarketPrice?: number } }[];
    error?: { code?: string; description?: string };
  };
}

function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Fetch crypto prices from CoinGecko (single batch call).
 */
export async function fetchCryptoPrices(assetIds: string[]): Promise<SpotPrice[]> {
  if (assetIds.length === 0) return [];

  const ids = assetIds.join(',');
  const url = `${COINGECKO_URL}?ids=${ids}&vs_currencies=usd&include_last_updated_at=true`;

  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`CoinGecko API error: ${res.status.toString()} ${res.statusText}`);
  }

  const data = (await res.json()) as CoinGeckoResponse;
  const now = Date.now();
  const prices: SpotPrice[] = [];

  for (const id of assetIds) {
    const entry = data[id];
    if (entry?.usd != null) {
      prices.push({
        assetId: id,
        price: entry.usd,
        timestamp: entry.last_updated_at ? entry.last_updated_at * 1000 : now,
      });
    }
  }

  return prices;
}

/**
 * Fetch a single commodity price from Yahoo Finance v8 chart endpoint.
 */
export async function fetchCommodityPrice(ticker: string): Promise<SpotPrice | null> {
  const url = `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?interval=1m&range=5m`;

  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  if (!res.ok) {
    throw new Error(
      `Yahoo Finance API error: ${res.status.toString()} ${res.statusText} for ${ticker}`,
    );
  }

  const data = (await res.json()) as YahooChartResponse;
  const price = data.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (price == null) return null;

  return { assetId: ticker, price, timestamp: Date.now() };
}

/**
 * Fetch all commodity prices in parallel (one call per ticker).
 */
export async function fetchCommodityPrices(tickers: string[]): Promise<SpotPrice[]> {
  const results = await Promise.allSettled(tickers.map((t) => fetchCommodityPrice(t)));
  const prices: SpotPrice[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (!result) continue;
    if (result.status === 'fulfilled' && result.value) {
      prices.push(result.value);
    } else if (result.status === 'rejected') {
      logger.warn('[spot-poller] commodity fetch failed', {
        ticker: tickers[i] ?? 'unknown',
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  return prices;
}

/**
 * Store a price in the Redis rolling window.
 *
 * Redis schema:
 *   spot:prices:{assetId} → SortedSet(score=timestamp, member=price)
 *   spot:last:{assetId}   → JSON { price, timestamp }
 */
export async function storePrice(sp: SpotPrice): Promise<void> {
  const redis = getRedis();
  const pricesKey = `spot:prices:${sp.assetId}`;
  const lastKey = `spot:last:${sp.assetId}`;

  const pipeline = redis.pipeline();
  // Add to sorted set (score = timestamp, member = `ts:price` to ensure uniqueness)
  pipeline.zadd(pricesKey, sp.timestamp, `${sp.timestamp.toString()}:${sp.price.toString()}`);
  // Prune entries older than rolling window
  const cutoff = sp.timestamp - ROLLING_WINDOW_MS;
  pipeline.zremrangebyscore(pricesKey, '-inf', cutoff);
  // Update latest price
  pipeline.set(lastKey, JSON.stringify({ price: sp.price, timestamp: sp.timestamp }));
  // TTL: 2 hours (auto-cleanup if poller stops)
  pipeline.expire(pricesKey, 7200);
  pipeline.expire(lastKey, 7200);

  await pipeline.exec();
}

/**
 * Get the price at a given lookback from the rolling window.
 * Returns the price closest to `now - lookbackMs`.
 */
export async function getPriceAtLookback(
  assetId: string,
  lookbackMs: number,
): Promise<number | null> {
  const redis = getRedis();
  const pricesKey = `spot:prices:${assetId}`;
  const targetTs = Date.now() - lookbackMs;

  // Get entries around the target timestamp
  const entries = await redis.zrangebyscore(
    pricesKey,
    targetTs - 60_000, // 1 min before target
    targetTs + 60_000, // 1 min after target
  );

  if (entries.length === 0) {
    // Fall back: get the oldest entry in the window
    const oldest = await redis.zrange(pricesKey, 0, 0);
    if (oldest.length === 0 || !oldest[0]) return null;
    return parsePriceEntry(oldest[0]);
  }

  // Find the entry closest to the target timestamp
  let bestEntry = entries[0] ?? '';
  let bestDelta = Infinity;

  for (const entry of entries) {
    if (!entry) continue;
    const ts = parseTimestampEntry(entry);
    const delta = Math.abs(ts - targetTs);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestEntry = entry;
    }
  }

  if (!bestEntry) return null;
  return parsePriceEntry(bestEntry);
}

function parsePriceEntry(entry: string): number {
  // Format: "timestamp:price"
  const colonIdx = entry.indexOf(':');
  return parseFloat(entry.substring(colonIdx + 1));
}

function parseTimestampEntry(entry: string): number {
  const colonIdx = entry.indexOf(':');
  return parseInt(entry.substring(0, colonIdx), 10);
}

/**
 * Run a single poll cycle: fetch all prices and store in Redis.
 */
export async function pollSpotPrices(): Promise<SpotPrice[]> {
  const cfg = loadConfig();
  const cryptoAssets = cfg.SPOT_CRYPTO_ASSETS.split(',').filter(Boolean);
  const commodityAssets = cfg.SPOT_COMMODITY_ASSETS.split(',').filter(Boolean);

  // Fetch crypto and commodity prices in parallel
  const [cryptoPrices, commodityPrices] = await Promise.allSettled([
    fetchCryptoPrices(cryptoAssets),
    fetchCommodityPrices(commodityAssets),
  ]);

  const allPrices: SpotPrice[] = [];

  if (cryptoPrices.status === 'fulfilled') {
    allPrices.push(...cryptoPrices.value);
  } else {
    logger.warn('[spot-poller] crypto fetch failed', {
      error:
        cryptoPrices.reason instanceof Error
          ? cryptoPrices.reason.message
          : String(cryptoPrices.reason),
    });
  }

  if (commodityPrices.status === 'fulfilled') {
    allPrices.push(...commodityPrices.value);
  } else {
    logger.warn('[spot-poller] commodity fetch failed', {
      error:
        commodityPrices.reason instanceof Error
          ? commodityPrices.reason.message
          : String(commodityPrices.reason),
    });
  }

  // Store all prices in Redis
  for (const sp of allPrices) {
    await storePrice(sp);
  }

  logger.info('[spot-poller] poll complete', {
    cryptoCount: cryptoPrices.status === 'fulfilled' ? cryptoPrices.value.length : 0,
    commodityCount: commodityPrices.status === 'fulfilled' ? commodityPrices.value.length : 0,
  });

  return allPrices;
}
