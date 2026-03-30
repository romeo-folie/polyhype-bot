import { describe, it, expect, vi } from 'vitest';
import { buildCandles } from '../candleAggregator.js';
import type { Redis } from 'ioredis';

/** Build a minimal Redis mock with zrangebyscore returning provided entries. */
function makeRedisMock(entries: string[]): Redis {
  return {
    zrangebyscore: vi.fn().mockResolvedValue(entries),
  } as unknown as Redis;
}

const MINUTE_MS = 60_000;

describe('buildCandles', () => {
  it('returns empty array when Redis has no entries', async () => {
    const redis = makeRedisMock([]);
    const candles = await buildCandles('btcusdt', redis);
    expect(candles).toEqual([]);
  });

  it('groups ticks into correct 1-minute buckets', async () => {
    // Two ticks in minute 0, one tick in minute 1
    const base = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    const t0a = base + 5_000;
    const t0b = base + 30_000;
    const t1a = base + MINUTE_MS + 10_000;

    const entries = [
      `${t0a}:100`,
      `${t0b}:110`,
      `${t1a}:105`,
    ];

    const redis = makeRedisMock(entries);
    const candles = await buildCandles('btcusdt', redis);

    expect(candles).toHaveLength(2);

    const c0 = candles[0]!;
    expect(c0.openTime).toBe(base);
    expect(c0.open).toBe(100);
    expect(c0.high).toBe(110);
    expect(c0.low).toBe(100);
    expect(c0.close).toBe(110);
    expect(c0.volume).toBe(2);

    const c1 = candles[1]!;
    expect(c1.openTime).toBe(base + MINUTE_MS);
    expect(c1.open).toBe(105);
    expect(c1.close).toBe(105);
    expect(c1.volume).toBe(1);
  });

  it('computes OHLCV correctly for a multi-tick bucket', async () => {
    const base = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    const prices = [200, 180, 220, 190, 210];
    const entries = prices.map((p, i) => `${base + i * 5000}:${p}`);

    const redis = makeRedisMock(entries);
    const candles = await buildCandles('btcusdt', redis);

    expect(candles).toHaveLength(1);
    const c = candles[0]!;
    expect(c.open).toBe(200);
    expect(c.high).toBe(220);
    expect(c.low).toBe(180);
    expect(c.close).toBe(210);
    expect(c.volume).toBe(5);
  });

  it('returns candles sorted ascending by openTime', async () => {
    const base = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    // Deliberately out of order
    const entries = [
      `${base + MINUTE_MS * 2 + 1000}:300`,
      `${base + 1000}:100`,
      `${base + MINUTE_MS + 1000}:200`,
    ];

    const redis = makeRedisMock(entries);
    const candles = await buildCandles('btcusdt', redis);

    expect(candles).toHaveLength(3);
    expect(candles[0]!.openTime).toBeLessThan(candles[1]!.openTime);
    expect(candles[1]!.openTime).toBeLessThan(candles[2]!.openTime);
  });

  it('skips invalid entries gracefully', async () => {
    const base = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    const entries = [
      'invalid',
      `${base + 1000}:badprice`,
      `${base + 2000}:100`,
      `${base + 3000}:0`,    // price <= 0 — skip
      `${base + 4000}:110`,
    ];

    const redis = makeRedisMock(entries);
    const candles = await buildCandles('btcusdt', redis);

    expect(candles).toHaveLength(1);
    // Only the two valid ticks (100 and 110) should be in the bucket
    expect(candles[0]!.volume).toBe(2);
    expect(candles[0]!.open).toBe(100);
    expect(candles[0]!.close).toBe(110);
  });
});
