import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';

// Mock Redis with prices
function makeRedisWithTicks(ticks: Array<{ timestamp: number; price: number }>): Redis {
  const entries = ticks.map(t => `${t.timestamp}:${t.price}`);
  return {
    zrangebyscore: vi.fn().mockResolvedValue(entries),
  } as unknown as Redis;
}

describe('candleAggregator', () => {
  it('correctly groups ticks into 1-min buckets', async () => {
    const { buildCandles } = await import('../candleAggregator.js');

    // 3 ticks in bucket 0, 2 ticks in bucket 60000
    const ticks = [
      { timestamp: 1000, price: 100 },
      { timestamp: 30000, price: 105 },
      { timestamp: 59000, price: 95 },
      { timestamp: 60000, price: 110 },
      { timestamp: 90000, price: 120 },
    ];

    const redis = makeRedisWithTicks(ticks);
    const candles = await buildCandles('btcusdt', redis, 200_000);

    expect(candles).toHaveLength(2);

    // First bucket: openTime=0
    expect(candles[0]!.openTime).toBe(0);
    expect(candles[0]!.volume).toBe(3);

    // Second bucket: openTime=60000
    expect(candles[1]!.openTime).toBe(60_000);
    expect(candles[1]!.volume).toBe(2);
  });

  it('computes OHLCV correctly for known price series', async () => {
    const { buildCandles } = await import('../candleAggregator.js');

    // All ticks in same 1-min bucket
    const ticks = [
      { timestamp: 1000, price: 100 },   // open
      { timestamp: 10000, price: 110 },  // high
      { timestamp: 20000, price: 90 },   // low
      { timestamp: 30000, price: 105 },
      { timestamp: 40000, price: 102 },  // close
    ];

    const redis = makeRedisWithTicks(ticks);
    const candles = await buildCandles('btcusdt', redis, 100_000);

    expect(candles).toHaveLength(1);

    const candle = candles[0]!;
    expect(candle.open).toBe(100);
    expect(candle.high).toBe(110);
    expect(candle.low).toBe(90);
    expect(candle.close).toBe(102);
    expect(candle.volume).toBe(5);
  });

  it('returns empty array when no data in Redis', async () => {
    const { buildCandles } = await import('../candleAggregator.js');

    const redis = {
      zrangebyscore: vi.fn().mockResolvedValue([]),
    } as unknown as Redis;

    const candles = await buildCandles('btcusdt', redis);
    expect(candles).toHaveLength(0);
  });

  it('skips invalid entries', async () => {
    const { buildCandles } = await import('../candleAggregator.js');

    const redis = {
      zrangebyscore: vi.fn().mockResolvedValue([
        '1000:100',
        'invalid:entry',
        '2000:NaN',
        '3000:105',
      ]),
    } as unknown as Redis;

    const candles = await buildCandles('btcusdt', redis, 100_000);

    // Should only have valid ticks (1000:100 and 3000:105)
    expect(candles).toHaveLength(1);
    expect(candles[0]!.volume).toBe(2);
  });

  it('sorts candles by openTime ascending', async () => {
    const { buildCandles } = await import('../candleAggregator.js');

    // Ticks out of chronological bucket order
    const ticks = [
      { timestamp: 120_000, price: 200 },
      { timestamp: 60_000, price: 150 },
      { timestamp: 1000, price: 100 },
    ];

    const redis = makeRedisWithTicks(ticks);
    const candles = await buildCandles('btcusdt', redis, 200_000);

    expect(candles).toHaveLength(3);
    expect(candles[0]!.openTime).toBe(0);
    expect(candles[1]!.openTime).toBe(60_000);
    expect(candles[2]!.openTime).toBe(120_000);
  });
});
