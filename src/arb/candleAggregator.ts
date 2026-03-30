/**
 * Candle Aggregator — Phase 9
 *
 * Resamples raw tick data from BinanceFeed (stored in Redis sorted sets)
 * into 1-minute OHLCV candles for technical indicator computation.
 */

import type { Redis } from 'ioredis';

export interface OHLCVCandle {
  openTime: number;   // bucket start ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;     // tick count as volume proxy
}

/**
 * Build 1-minute OHLCV candles from the raw tick sorted set.
 * Returns candles sorted oldest-first.
 * Exported for unit testing.
 *
 * @param symbol - Binance symbol (e.g. 'btcusdt')
 * @param redis - Redis client
 * @param lookbackMs - Lookback window in milliseconds (default: 60 minutes)
 * @returns Array of OHLCV candles sorted by openTime ascending
 */
export async function buildCandles(
  symbol: string,
  redis: Redis,
  lookbackMs = 40 * 60 * 1000,  // 40 minutes default (enough for MACD slow=26 + signal=9)
): Promise<OHLCVCandle[]> {
  const key = `spot:prices:${symbol}`;
  const now = Date.now();
  const minScore = now - lookbackMs;

  // Fetch all ticks in the lookback window
  // Members are stored as "timestamp:price", score is the timestamp
  let entries: string[];
  try {
    entries = await redis.zrangebyscore(key, minScore, now);
  } catch (err) {
    return [];  // Redis failure → return empty candles
  }

  if (entries.length === 0) {
    return [];
  }

  // Parse ticks: "timestamp:price" → { timestamp, price }
  interface Tick {
    timestamp: number;
    price: number;
  }

  const ticks: Tick[] = [];
  for (const entry of entries) {
    const parts = entry.split(':');
    const timestamp = parseInt(parts[0] ?? '0', 10);
    const price = parseFloat(parts[1] ?? '0');

    // Skip invalid entries
    if (isFinite(timestamp) && timestamp > 0 && isFinite(price) && price > 0) {
      ticks.push({ timestamp, price });
    }
  }

  if (ticks.length === 0) {
    return [];
  }

  // Group ticks by 1-minute buckets
  const buckets = new Map<number, Tick[]>();

  for (const tick of ticks) {
    const bucketStart = Math.floor(tick.timestamp / 60_000) * 60_000;
    const existing = buckets.get(bucketStart) ?? [];
    existing.push(tick);
    buckets.set(bucketStart, existing);
  }

  // Build OHLCV candles from each bucket
  const candles: OHLCVCandle[] = [];

  for (const [openTime, bucketTicks] of buckets.entries()) {
    if (bucketTicks.length === 0) continue;

    // Sort ticks by timestamp within bucket to ensure correct open/close
    bucketTicks.sort((a, b) => a.timestamp - b.timestamp);

    const open = bucketTicks[0]!.price;
    const close = bucketTicks[bucketTicks.length - 1]!.price;

    // Find high/low without spread operator (avoids stack overflow on large tick counts)
    let high = bucketTicks[0]!.price;
    let low = bucketTicks[0]!.price;
    for (const tick of bucketTicks) {
      if (tick.price > high) high = tick.price;
      if (tick.price < low) low = tick.price;
    }

    const volume = bucketTicks.length;  // tick count as volume proxy

    candles.push({
      openTime,
      open,
      high,
      low,
      close,
      volume,
    });
  }

  // Sort candles by openTime ascending (oldest first)
  candles.sort((a, b) => a.openTime - b.openTime);

  return candles;
}
