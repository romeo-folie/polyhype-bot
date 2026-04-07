import { describe, it, expect, vi } from 'vitest';
import { buildCandles } from '../candleAggregator.js';
import type { Redis } from 'ioredis';

const MINUTE_MS = 60_000;

/** Redis mock that routes zrangebyscore by key. */
function makeRedis(byKey: Record<string, string[]>): Redis {
  return {
    zrangebyscore: vi.fn(async (key: string) => byKey[key] ?? []),
  } as unknown as Redis;
}

describe('buildCandles — kline source', () => {
  it('reads JSON klines from spot:klines:<symbol>:1m', async () => {
    const base = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    const k0 = JSON.stringify({
      t: base, o: 100, h: 110, l: 95, c: 108, v: 12.5, q: 1300, n: 50,
    });
    const k1 = JSON.stringify({
      t: base + MINUTE_MS, o: 108, h: 115, l: 107, c: 112, v: 9.8, q: 1100, n: 41,
    });
    const redis = makeRedis({ 'spot:klines:btcusdt:1m': [k0, k1] });

    const candles = await buildCandles('btcusdt', redis);
    expect(candles).toHaveLength(2);
    expect(candles[0]!.open).toBe(100);
    expect(candles[0]!.high).toBe(110);
    expect(candles[0]!.low).toBe(95);
    expect(candles[0]!.close).toBe(108);
    expect(candles[0]!.volume).toBe(12.5);
    expect(candles[0]!.quoteVolume).toBe(1300);
    expect(candles[0]!.tradeCount).toBe(50);
    expect(candles[1]!.close).toBe(112);
  });

  it('honours the timeframe option', async () => {
    const base = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    const k = JSON.stringify({ t: base, o: 1, h: 2, l: 0.5, c: 1.8, v: 5, q: 9, n: 3 });
    const redis = makeRedis({ 'spot:klines:ethusdt:5m': [k] });
    const candles = await buildCandles('ethusdt', redis, { timeframe: '5m' });
    expect(candles).toHaveLength(1);
    expect(candles[0]!.close).toBe(1.8);
  });

  it('skips malformed kline entries', async () => {
    const base = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    const good = JSON.stringify({ t: base, o: 1, h: 1, l: 1, c: 1, v: 1, q: 1, n: 1 });
    const redis = makeRedis({ 'spot:klines:btcusdt:1m': ['not-json', good] });
    const candles = await buildCandles('btcusdt', redis);
    expect(candles).toHaveLength(1);
  });
});

describe('buildCandles — tick fallback', () => {
  it('falls back to tick resampler when no klines exist', async () => {
    const base = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    const t0a = base + 5_000;
    const t0b = base + 30_000;
    const t1a = base + MINUTE_MS + 10_000;
    const redis = makeRedis({
      'spot:klines:btcusdt:1m': [],
      'spot:prices:btcusdt': [`${t0a}:100`, `${t0b}:110`, `${t1a}:105`],
    });

    const candles = await buildCandles('btcusdt', redis);
    expect(candles).toHaveLength(2);
    expect(candles[0]!.open).toBe(100);
    expect(candles[0]!.high).toBe(110);
    expect(candles[0]!.close).toBe(110);
    expect(candles[0]!.volume).toBe(2);
    expect(candles[1]!.close).toBe(105);
  });

  it('returns empty when both kline and tick stores are empty', async () => {
    const redis = makeRedis({});
    const candles = await buildCandles('btcusdt', redis);
    expect(candles).toEqual([]);
  });

  it('does not fall back to ticks for non-1m timeframes', async () => {
    const base = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    const redis = makeRedis({
      'spot:klines:btcusdt:5m': [],
      'spot:prices:btcusdt': [`${base + 5_000}:100`],
    });
    const candles = await buildCandles('btcusdt', redis, { timeframe: '5m' });
    expect(candles).toEqual([]);
  });
});
