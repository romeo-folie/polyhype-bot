import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClobPriceFeed, WS_PRICE_KEY } from '../clobWebSocket.js';

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

// ── Mock ws module ──────────────────────────────────────────────────────────

type WsListener = (...args: unknown[]) => void;

class MockWebSocket {
  static OPEN = 1;
  readyState = MockWebSocket.OPEN;
  private listeners = new Map<string, WsListener[]>();

  sentMessages: string[] = [];

  on(event: string, fn: WsListener) {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
    // Auto-fire 'open' on next tick
    if (event === 'open') {
      setTimeout(() => this.emit('open'), 0);
    }
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = 3;
  }

  emit(event: string, ...args: unknown[]) {
    for (const fn of this.listeners.get(event) ?? []) {
      fn(...args);
    }
  }
}

// Patch the module-level import by replacing the prototype connect method
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

  it('returns cached value after handleMessage fires', async () => {
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
      JSON.stringify({ type: 'price_change', asset_id: 'yes-token', price: '0.72' }),
    );

    const price = await feed.getCachedPrice('market-1');
    expect(price).toBeCloseTo(0.72, 4);
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

  it('ignores NO token (index 1), caches YES token (index 0)', async () => {
    const feedAny = feed as unknown as {
      watchedMarkets: Map<string, string[]>;
      tokenToMarket: Map<string, string>;
      handleMessage: (raw: string) => Promise<void>;
    };
    feedAny.watchedMarkets.set('mkt-2', ['yes-tok', 'no-tok']);
    feedAny.tokenToMarket.set('yes-tok', 'mkt-2');
    feedAny.tokenToMarket.set('no-tok', 'mkt-2');

    // NO token update — should be ignored
    await feedAny.handleMessage(
      JSON.stringify({ type: 'price_change', asset_id: 'no-tok', price: '0.28' }),
    );
    expect(await feed.getCachedPrice('mkt-2')).toBeNull();

    // YES token update — should be cached
    await feedAny.handleMessage(
      JSON.stringify({ type: 'price_change', asset_id: 'yes-tok', price: '0.72' }),
    );
    expect(await feed.getCachedPrice('mkt-2')).toBeCloseTo(0.72, 4);
  });

  it('handles array-wrapped messages', async () => {
    const feedAny = feed as unknown as {
      watchedMarkets: Map<string, string[]>;
      tokenToMarket: Map<string, string>;
      handleMessage: (raw: string) => Promise<void>;
    };
    feedAny.watchedMarkets.set('mkt-3', ['tok-a', 'tok-b']);
    feedAny.tokenToMarket.set('tok-a', 'mkt-3');

    await feedAny.handleMessage(
      JSON.stringify([
        { type: 'price_change', asset_id: 'tok-a', price: '0.55' },
        { type: 'price_change', asset_id: 'tok-a', price: '0.56' },
      ]),
    );

    // Last update wins
    expect(await feed.getCachedPrice('mkt-3')).toBeCloseTo(0.56, 4);
  });

  it('ignores malformed JSON', async () => {
    const feedAny = feed as unknown as {
      handleMessage: (raw: string) => Promise<void>;
    };
    // Should not throw
    await feedAny.handleMessage('not-json{{{');
  });

  it('ignores unknown token IDs', async () => {
    const feedAny = feed as unknown as {
      handleMessage: (raw: string) => Promise<void>;
    };
    await feedAny.handleMessage(
      JSON.stringify({ type: 'price_change', asset_id: 'unknown-tok', price: '0.50' }),
    );
    // No crash, no cache entry
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
});
