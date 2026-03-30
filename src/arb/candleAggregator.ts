/**
 * Candle aggregator.
 *
 * Resamples raw tick data from the BinanceFeed sorted set into 1-minute OHLCV candles.
 * BinanceFeed stores ticks as: key=spot:prices:<symbol>, members="<timestamp>:<price>", score=timestamp(ms)
 */

import type { Redis } from 'ioredis';

export interface OHLCVCandle {
  openTime: number; // bucket start ms (floor of minute)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // tick count as volume proxy
}

const MINUTE_MS = 60_000;
const DEFAULT_LOOKBACK_MS = 60 * MINUTE_MS; // 60 minutes

/**
 * Build 1-minute OHLCV candles from the raw tick sorted set.
 * Returns candles sorted oldest-first.
 * Exported for unit testing.
 */
export async function buildCandles(
  symbol: string,
  redis: Redis,
  lookbackMs: number = DEFAULT_LOOKBACK_MS,
): Promise<OHLCVCandle[]> {
  const key = `spot:prices:${symbol}`;
  const now = Date.now();
  const from = now - lookbackMs;

  const entries = await redis.zrangebyscore(key, from, '+inf');
  if (entries.length === 0) return [];

  // Group ticks into 1-minute buckets
  const buckets = new Map<number, number[]>();
  for (const entry of entries) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) continue;
    const ts = parseInt(entry.slice(0, colonIdx), 10);
    const price = parseFloat(entry.slice(colonIdx + 1));
    if (!isFinite(ts) || !isFinite(price) || price <= 0) continue;

    const bucket = Math.floor(ts / MINUTE_MS) * MINUTE_MS;
    const existing = buckets.get(bucket);
    if (existing) {
      existing.push(price);
    } else {
      buckets.set(bucket, [price]);
    }
  }

  if (buckets.size === 0) return [];

  const candles: OHLCVCandle[] = [];
  for (const [openTime, prices] of buckets) {
    candles.push({
      openTime,
      open: prices[0]!,
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: prices[prices.length - 1]!,
      volume: prices.length,
    });
  }

  // Sort ascending by openTime
  candles.sort((a, b) => a.openTime - b.openTime);
  return candles;
}
