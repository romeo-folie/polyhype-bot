import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  parseBookMessage,
  parseTradeMessage,
  persistBookDelta,
  persistTradePrint,
} = await import('../flowMonitor.js');

const { CLOB_TAPE_MAX_LEN } = await import('../../shared/clobWebSocket.js');

interface MockRedis {
  hset: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  zadd: ReturnType<typeof vi.fn>;
  zremrangebyrank: ReturnType<typeof vi.fn>;
}

function mkRedis(): MockRedis {
  return {
    hset: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    publish: vi.fn().mockResolvedValue(1),
    zadd: vi.fn().mockResolvedValue(1),
    zremrangebyrank: vi.fn().mockResolvedValue(0),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseBookMessage', () => {
  it('extracts top of book bid/ask', () => {
    const out = parseBookMessage({
      asset_id: 'tok-1',
      market: 'mkt-1',
      bids: [{ price: '0.42', size: '100' }, { price: '0.41', size: '200' }],
      asks: [{ price: '0.45', size: '50' }],
      timestamp: 1700000000000,
    });
    expect(out).not.toBeNull();
    expect(out?.tokenId).toBe('tok-1');
    expect(out?.snapshot.bestBid).toBe(0.42);
    expect(out?.snapshot.bestAsk).toBe(0.45);
    expect(out?.snapshot.bidSize).toBe(100);
    expect(out?.snapshot.askSize).toBe(50);
  });
  it('returns null without an asset_id', () => {
    expect(parseBookMessage({ bids: [], asks: [] })).toBeNull();
  });

  it('extracts the touch order-agnostically (REST-style best-at-the-END arrays)', () => {
    // WS book events document best-first, but the REST endpoint ships the
    // opposite ordering — the parser scans all levels so either shape yields
    // the real touch (and the touch level's size).
    const out = parseBookMessage({
      asset_id: 'tok-1',
      market: 'mkt-1',
      bids: [{ price: '0.01', size: '5' }, { price: '0.41', size: '200' }, { price: '0.42', size: '100' }],
      asks: [{ price: '0.99', size: '5' }, { price: '0.46', size: '20' }, { price: '0.45', size: '50' }],
      timestamp: 1700000000000,
    });

    expect(out?.snapshot.bestBid).toBe(0.42);
    expect(out?.snapshot.bestAsk).toBe(0.45);
    expect(out?.snapshot.bidSize).toBe(100);
    expect(out?.snapshot.askSize).toBe(50);
  });
});

describe('parseTradeMessage', () => {
  it('parses a BUY print', () => {
    const out = parseTradeMessage({
      asset_id: 'tok-1',
      market: 'mkt-1',
      price: '0.43',
      size: '25',
      side: 'BUY',
      taker: '0xabc',
      maker: '0xdef',
      timestamp: 1700000000000,
    });
    expect(out?.trade.price).toBe(0.43);
    expect(out?.trade.size).toBe(25);
    expect(out?.trade.side).toBe('BUY');
    expect(out?.trade.taker).toBe('0xabc');
  });
  it('returns null on missing price', () => {
    expect(parseTradeMessage({ asset_id: 't', size: '1' })).toBeNull();
  });
});

describe('persistBookDelta', () => {
  it('writes hash + publishes', async () => {
    const redis = mkRedis();
    await persistBookDelta(redis as never, {
      asset_id: 'tok-1',
      market: 'mkt-1',
      bids: [{ price: '0.5', size: '10' }],
      asks: [{ price: '0.55', size: '5' }],
      timestamp: 12345,
    });
    expect(redis.hset).toHaveBeenCalledWith(
      'clob:book_state:tok-1',
      expect.objectContaining({ bestBid: '0.5', bestAsk: '0.55' }),
    );
    expect(redis.publish).toHaveBeenCalledWith('clob:book_delta', expect.any(String));
  });
});

describe('persistTradePrint', () => {
  it('zadds, caps, expires, publishes', async () => {
    const redis = mkRedis();
    await persistTradePrint(redis as never, {
      asset_id: 'tok-1',
      market: 'mkt-1',
      price: '0.5',
      size: '10',
      side: 'BUY',
      timestamp: 100,
    });
    expect(redis.zadd).toHaveBeenCalledWith('clob:tape:mkt-1', 100, expect.any(String));
    expect(redis.zremrangebyrank).toHaveBeenCalledWith(
      'clob:tape:mkt-1',
      0,
      -CLOB_TAPE_MAX_LEN - 1,
    );
    expect(redis.publish).toHaveBeenCalledWith('clob:trade', expect.any(String));
  });
});
