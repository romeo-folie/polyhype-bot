import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ClobPriceFeed,
  WS_PRICE_KEY,
  WS_YES_PRICE_KEY,
  WS_NO_PRICE_KEY,
} from '../clobWebSocket.js';

// ── Mock Redis ──────────────────────────────────────────────────────────────

function makeMockRedis() {
  const store = new Map<string, { value: string; expireAt: number }>();
  return {
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expireAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }),
    setex: vi.fn(async (key: string, ttl: number, value: string | number) => {
      store.set(key, { value: String(value), expireAt: Date.now() + ttl * 1000 });
      return 'OK';
    }),
    _store: store,
  };
}


// We test handleMessage directly since it's the core logic.

describe('ClobPriceFeed', () => {
  let redis: ReturnType<typeof makeMockRedis>;
  let feed: ClobPriceFeed;

  beforeEach(() => {
    redis = makeMockRedis();
    // Create feed with WS disabled so constructor doesn't open a real connection
    feed = new ClobPriceFeed(redis as never, { enabled: false });
  });

  afterEach(() => {
    feed.destroy();
  });

  // ── getCachedPrice ──────────────────────────────────────────────────────

  it('returns null on cold cache', async () => {
    const price = await feed.getCachedPrice('market-1');
    expect(price).toBeNull();
  });

  it('returns cached best-bid after a book event fires', async () => {
    // Set up token mapping manually (watch is a no-op when disabled,
    // so we access internals)
    const feedAny = feed as unknown as {
      watchedMarkets: Map<string, string[]>;
      tokenToMarket: Map<string, string>;
      handleMessage: (raw: string) => Promise<void>;
    };
    feedAny.watchedMarkets.set('market-1', ['yes-token', 'no-token']);
    feedAny.tokenToMarket.set('yes-token', 'market-1');
    feedAny.tokenToMarket.set('no-token', 'market-1');

    await feedAny.handleMessage(
      JSON.stringify({
        event_type: 'book',
        asset_id: 'yes-token',
        bids: [{ price: '0.72', size: '50' }, { price: '0.71', size: '10' }],
        asks: [{ price: '0.75', size: '20' }],
      }),
    );

    const price = await feed.getCachedPrice('market-1');
    expect(price).toBeCloseTo(0.72, 4);
  });

  it('caches the REAL best bid from ascending (REST-style) level arrays', async () => {
    // WS book events document bids-descending, but the touch extraction is
    // order-agnostic — an ascending array (the REST convention, where [0] is
    // the WORST bid) must still cache the max.
    const feedAny = feed as unknown as {
      watchedMarkets: Map<string, string[]>;
      tokenToMarket: Map<string, string>;
      handleMessage: (raw: string) => Promise<void>;
    };
    feedAny.watchedMarkets.set('market-1', ['yes-token', 'no-token']);
    feedAny.tokenToMarket.set('yes-token', 'market-1');

    await feedAny.handleMessage(
      JSON.stringify({
        event_type: 'book',
        asset_id: 'yes-token',
        bids: [{ price: '0.01', size: '5' }, { price: '0.71', size: '10' }, { price: '0.72', size: '50' }],
        asks: [{ price: '0.75', size: '20' }],
      }),
    );

    const price = await feed.getCachedPrice('market-1');
    expect(price).toBeCloseTo(0.72, 4); // max bid, not bids[0]=0.01
  });

  // ── watch / unwatch ─────────────────────────────────────────────────────

  it('watch() sets up tokenToMarket mapping (enabled feed)', async () => {
    const enabledFeed = new ClobPriceFeed(redis as never, { enabled: false });
    // Even though WS is disabled, the internal maps should be set
    // Actually with enabled=false, watch() is a no-op — so test the mapping
    // setup by using an enabled feed that we control
    const feedAny = enabledFeed as unknown as {
      enabled: boolean;
      watchedMarkets: Map<string, string[]>;
      tokenToMarket: Map<string, string>;
    };
    // Manually enable but prevent connect by not having a real WS
    feedAny.enabled = true;

    // Override connect to be a no-op
    (enabledFeed as unknown as { connect: () => void }).connect = () => {};

    await enabledFeed.watch('mkt-abc', ['tok-yes', 'tok-no']);

    expect(feedAny.watchedMarkets.get('mkt-abc')).toEqual(['tok-yes', 'tok-no']);
    expect(feedAny.tokenToMarket.get('tok-yes')).toBe('mkt-abc');
    expect(feedAny.tokenToMarket.get('tok-no')).toBe('mkt-abc');

    enabledFeed.destroy();
  });

  it('unwatch() cleans up mapping', async () => {
    const feedAny = feed as unknown as {
      watchedMarkets: Map<string, string[]>;
      tokenToMarket: Map<string, string>;
    };
    feedAny.watchedMarkets.set('mkt-1', ['t1', 't2']);
    feedAny.tokenToMarket.set('t1', 'mkt-1');
    feedAny.tokenToMarket.set('t2', 'mkt-1');

    feed.unwatch('mkt-1');

    expect(feedAny.watchedMarkets.has('mkt-1')).toBe(false);
    expect(feedAny.tokenToMarket.has('t1')).toBe(false);
    expect(feedAny.tokenToMarket.has('t2')).toBe(false);
  });

  // ── handleMessage ───────────────────────────────────────────────────────

  it('caches YES best-bid to YES key, NO best-bid to NO key', async () => {
    const feedAny = feed as unknown as {
      watchedMarkets: Map<string, string[]>;
      tokenToMarket: Map<string, string>;
      handleMessage: (raw: string) => Promise<void>;
    };
    feedAny.watchedMarkets.set('mkt-2', ['yes-tok', 'no-tok']);
    feedAny.tokenToMarket.set('yes-tok', 'mkt-2');
    feedAny.tokenToMarket.set('no-tok', 'mkt-2');

    // NO book event → NO key only
    await feedAny.handleMessage(
      JSON.stringify({
        event_type: 'book',
        asset_id: 'no-tok',
        bids: [{ price: '0.28', size: '5' }],
        asks: [{ price: '0.30', size: '5' }],
      }),
    );
    expect(await feed.getCachedPrice('mkt-2')).toBeNull();
    expect(redis._store.get(WS_NO_PRICE_KEY('mkt-2'))?.value).toBe('0.280000');

    // YES book event → YES key and legacy key
    await feedAny.handleMessage(
      JSON.stringify({
        event_type: 'book',
        asset_id: 'yes-tok',
        bids: [{ price: '0.72', size: '10' }],
        asks: [{ price: '0.74', size: '10' }],
      }),
    );
    expect(await feed.getCachedPrice('mkt-2')).toBeCloseTo(0.72, 4);
    expect(redis._store.get(WS_YES_PRICE_KEY('mkt-2'))?.value).toBe('0.720000');
  });

  it('returns the max bid regardless of array ordering (WS-descending case)', async () => {
    // In WS-descending order bids[0] coincidentally IS the max — the cache
    // must extract the touch by scanning, never by trusting index 0 (the
    // REST endpoint ships the opposite ordering; see shared/bookTouch.ts).
    const feedAny = feed as unknown as {
      watchedMarkets: Map<string, string[]>;
      tokenToMarket: Map<string, string>;
      handleMessage: (raw: string) => Promise<void>;
    };
    feedAny.watchedMarkets.set('mkt-3', ['tok-a', 'tok-b']);
    feedAny.tokenToMarket.set('tok-a', 'mkt-3');

    await feedAny.handleMessage(
      JSON.stringify([
        {
          event_type: 'book',
          asset_id: 'tok-a',
          bids: [
            { price: '0.56', size: '100' },
            { price: '0.55', size: '50' },
            { price: '0.40', size: '10' },
          ],
          asks: [{ price: '0.58', size: '20' }],
        },
      ]),
    );

    expect(await feed.getCachedPrice('mkt-3')).toBeCloseTo(0.56, 4);
  });

  it('does NOT cache from price_change events (2026-04-24 incident guard)', async () => {
    const feedAny = feed as unknown as {
      watchedMarkets: Map<string, string[]>;
      tokenToMarket: Map<string, string>;
      handleMessage: (raw: string) => Promise<void>;
    };
    feedAny.watchedMarkets.set('mkt-p', ['yes-tok', 'no-tok']);
    feedAny.tokenToMarket.set('yes-tok', 'mkt-p');

    // Seed the cache with a real best-bid from a book event first.
    await feedAny.handleMessage(
      JSON.stringify({
        event_type: 'book',
        asset_id: 'yes-tok',
        bids: [{ price: '0.78', size: '10' }],
        asks: [{ price: '0.79', size: '10' }],
      }),
    );
    expect(await feed.getCachedPrice('mkt-p')).toBeCloseTo(0.78, 4);

    // A spurious price_change event at a non-touch level of 0.30 must NOT
    // overwrite the cached best-bid of 0.78. This exact pattern produced the
    // stale -40% stop-loss fire on 2026-04-24.
    await feedAny.handleMessage(
      JSON.stringify({ type: 'price_change', asset_id: 'yes-tok', price: '0.30' }),
    );
    expect(await feed.getCachedPrice('mkt-p')).toBeCloseTo(0.78, 4);
  });

  it('ignores malformed JSON', async () => {
    const feedAny = feed as unknown as {
      handleMessage: (raw: string) => Promise<void>;
    };
    // Should not throw
    await feedAny.handleMessage('not-json{{{');
  });

  it('ignores unknown token IDs on book events', async () => {
    const feedAny = feed as unknown as {
      handleMessage: (raw: string) => Promise<void>;
    };
    await feedAny.handleMessage(
      JSON.stringify({
        event_type: 'book',
        asset_id: 'unknown-tok',
        bids: [{ price: '0.50', size: '5' }],
        asks: [{ price: '0.52', size: '5' }],
      }),
    );
    // No crash, no cache entry
  });

  it('ignores book events with empty bids', async () => {
    const feedAny = feed as unknown as {
      watchedMarkets: Map<string, string[]>;
      tokenToMarket: Map<string, string>;
      handleMessage: (raw: string) => Promise<void>;
    };
    feedAny.watchedMarkets.set('mkt-empty', ['yes-tok', 'no-tok']);
    feedAny.tokenToMarket.set('yes-tok', 'mkt-empty');

    await feedAny.handleMessage(
      JSON.stringify({
        event_type: 'book',
        asset_id: 'yes-tok',
        bids: [],
        asks: [{ price: '0.60', size: '5' }],
      }),
    );

    // No bid means nothing to cache — legacy and YES keys should stay empty.
    expect(await feed.getCachedPrice('mkt-empty')).toBeNull();
  });

  // ── WS_PRICE_KEY ────────────────────────────────────────────────────────

  it('WS_PRICE_KEY formats correctly', () => {
    expect(WS_PRICE_KEY('abc-123')).toBe('ws:price:abc-123');
  });

  // ── enabled=false ───────────────────────────────────────────────────────

  it('watch() is a no-op when disabled', async () => {
    const disabledFeed = new ClobPriceFeed(redis as never, { enabled: false });
    const feedAny = disabledFeed as unknown as {
      watchedMarkets: Map<string, string[]>;
    };

    await disabledFeed.watch('mkt-x', ['t1', 't2']);
    expect(feedAny.watchedMarkets.size).toBe(0);

    disabledFeed.destroy();
  });

  describe('book/trade dispatch', () => {
    it('invokes onBook handler for book event', async () => {
      const onBook = vi.fn().mockResolvedValue(undefined);
      feed.onBook = onBook;
      await feed.handleMessage(JSON.stringify({
        event_type: 'book',
        asset_id: 'tok-1',
        bids: [{ price: '0.5', size: '10' }],
        asks: [{ price: '0.55', size: '5' }],
      }));
      expect(onBook).toHaveBeenCalledOnce();
    });

    it('invokes onTrade handler for last_trade_price event', async () => {
      const onTrade = vi.fn().mockResolvedValue(undefined);
      feed.onTrade = onTrade;
      await feed.handleMessage(JSON.stringify({
        event_type: 'last_trade_price',
        asset_id: 'tok-1',
        price: '0.42',
        size: '100',
        side: 'BUY',
      }));
      expect(onTrade).toHaveBeenCalledOnce();
    });

    it('still caches best-bid from book events when onBook is also registered', async () => {
      // Flow-monitor-style registration + internal caching must coexist.
      const f = new ClobPriceFeed(redis as never, { enabled: true });
      const onBook = vi.fn().mockResolvedValue(undefined);
      f.onBook = onBook;
      (f as unknown as { tokenToMarket: Map<string, string>; watchedMarkets: Map<string, string[]> })
        .tokenToMarket.set('tok-yes', 'mkt-1');
      (f as unknown as { tokenToMarket: Map<string, string>; watchedMarkets: Map<string, string[]> })
        .watchedMarkets.set('mkt-1', ['tok-yes', 'tok-no']);
      await f.handleMessage(JSON.stringify({
        event_type: 'book',
        asset_id: 'tok-yes',
        bids: [{ price: '0.42', size: '10' }],
        asks: [{ price: '0.44', size: '10' }],
      }));
      expect(onBook).toHaveBeenCalledOnce();
      expect(redis._store.get(WS_PRICE_KEY('mkt-1'))?.value).toBe('0.420000');
      f.destroy();
    });
  });
});
