import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChainlinkFeed,
  parseChainlinkMessage,
  type ChainlinkTick,
} from '../chainlinkFeed.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Silence logger — these tests assert behavior, not log lines.
vi.mock('../../../shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Fake WebSocket: captures handlers so tests can inject frames without
// opening a real socket.
type Handler = (...args: unknown[]) => void;
interface FakeWs {
  on: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  handlers: Record<string, Handler>;
}

function makeFakeWs(): FakeWs {
  const handlers: Record<string, Handler> = {};
  const ws: FakeWs = {
    handlers,
    on: vi.fn((event: string, cb: Handler) => {
      handlers[event] = cb;
      return ws;
    }),
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
    removeAllListeners: vi.fn(),
  };
  return ws;
}

let currentWs: FakeWs;
vi.mock('ws', () => {
  return {
    WebSocket: vi.fn(() => currentWs),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeChainlinkMsg(
  symbol: string,
  value: number,
  oracleTs = 1_775_919_469_000,
): string {
  return JSON.stringify({
    connection_id: 'abc',
    payload: {
      symbol,
      value,
      full_accuracy_value: String(Math.round(value * 1e18)),
      timestamp: oracleTs,
    },
    topic: 'crypto_prices_chainlink',
    type: 'update',
    timestamp: oracleTs + 1517,
  });
}

const validChainlinkMsg = makeChainlinkMsg('btc/usd', 72745.63);

const binanceMsg = JSON.stringify({
  connection_id: 'abc',
  payload: {
    symbol: 'btcusdt',
    value: 72745.63,
    full_accuracy_value: '72745630000000',
    timestamp: 1_775_919_469_000,
  },
  topic: 'crypto_prices',
  type: 'update',
  timestamp: 1_775_919_470_517,
});

const malformed = '{not json';
const unknownSymbolMsg = makeChainlinkMsg('ada/usd', 0.52);

// Helper: dispatch a raw frame into the feed's message handler.
function deliver(feed: ChainlinkFeed, raw: string): void {
  // start() is what wires up the handlers to our fake WS.
  // Tests should call start() once then deliver() repeatedly.
  void feed;
  const handler = currentWs.handlers.message;
  if (!handler) throw new Error('message handler not registered');
  handler(Buffer.from(raw, 'utf8'));
}

// ---------------------------------------------------------------------------
// parseChainlinkMessage — pure function tests
// ---------------------------------------------------------------------------

describe('parseChainlinkMessage', () => {
  it('parses a valid Chainlink message', () => {
    const beforeParse = 1_775_919_475_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(beforeParse);

    const tick = parseChainlinkMessage(validChainlinkMsg);
    expect(tick).not.toBeNull();
    expect(tick).toEqual<ChainlinkTick>({
      symbol: 'btc/usd',
      value: 72745.63,
      oracleTs: 1_775_919_469_000,
      receivedAt: beforeParse,
    });

    vi.useRealTimers();
  });

  it('lowercases the symbol', () => {
    const raw = makeChainlinkMsg('BTC/USD', 100);
    const tick = parseChainlinkMessage(raw);
    expect(tick?.symbol).toBe('btc/usd');
  });

  it('returns null for the Binance crypto_prices sibling topic', () => {
    expect(parseChainlinkMessage(binanceMsg)).toBeNull();
  });

  it('returns null for malformed JSON (and does not throw)', () => {
    expect(() => parseChainlinkMessage(malformed)).not.toThrow();
    expect(parseChainlinkMessage(malformed)).toBeNull();
  });

  it('returns null for missing payload', () => {
    const raw = JSON.stringify({
      topic: 'crypto_prices_chainlink',
      type: 'update',
    });
    expect(parseChainlinkMessage(raw)).toBeNull();
  });

  it('returns null for non-numeric value', () => {
    const raw = JSON.stringify({
      topic: 'crypto_prices_chainlink',
      type: 'update',
      payload: { symbol: 'btc/usd', value: 'not a number', timestamp: 1 },
    });
    expect(parseChainlinkMessage(raw)).toBeNull();
  });

  it('returns null for non-positive value', () => {
    const raw = makeChainlinkMsg('btc/usd', 0);
    expect(parseChainlinkMessage(raw)).toBeNull();
  });

  it('accepts a Buffer input', () => {
    const tick = parseChainlinkMessage(Buffer.from(validChainlinkMsg, 'utf8'));
    expect(tick?.symbol).toBe('btc/usd');
    expect(tick?.value).toBe(72745.63);
  });
});

// ---------------------------------------------------------------------------
// ChainlinkFeed — class-level tests (ringbuffer + getMoveSince)
// ---------------------------------------------------------------------------

describe('ChainlinkFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWs = makeFakeWs();
    // Only fake Date so the feed's internal timers (used by reconnect) are
    // untouched by the fake-timer swap. The mocked WS never emits 'close',
    // so reconnect scheduling is never exercised.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_775_919_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores Binance crypto_prices messages — nothing lands in the buffer', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();

    deliver(feed, binanceMsg);
    expect(feed.getLatest('btc/usd')).toBeNull();
    expect(feed.getMoveSince('btc/usd', 60_000)).toBeNull();
  });

  it('ignores malformed JSON — nothing lands in the buffer', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();

    expect(() => deliver(feed, malformed)).not.toThrow();
    expect(feed.getLatest('btc/usd')).toBeNull();
  });

  it('ignores unknown symbols (not in the configured list)', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();

    // Parser will decode it, but the feed filters on its symbol allowlist.
    deliver(feed, unknownSymbolMsg);
    expect(feed.getLatest('ada/usd')).toBeNull();
    expect(feed.getLatest('btc/usd')).toBeNull();
  });

  it('stores valid ticks and exposes them via getLatest', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();

    deliver(feed, makeChainlinkMsg('btc/usd', 72_000));
    const latest = feed.getLatest('btc/usd');
    expect(latest).not.toBeNull();
    expect(latest?.symbol).toBe('btc/usd');
    expect(latest?.value).toBe(72_000);
  });

  it('ringbuffer capacity: pushing 700 ticks leaves only the latest 600', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'], capacity: 600 });
    feed.start();

    const base = 60_000; // starting price
    const baseTime = 1_775_919_000_000;
    for (let i = 0; i < 700; i++) {
      vi.setSystemTime(baseTime + i * 10); // 10ms apart
      deliver(feed, makeChainlinkMsg('btc/usd', base + i));
    }

    // After 700 pushes into a 600-slot buffer, only ticks 100..699 remain.
    const latest = feed.getLatest('btc/usd');
    expect(latest?.value).toBe(base + 699);

    // Pull everything within a very wide window — should be exactly 600 ticks.
    // The oldest tick's receivedAt is baseTime + 100*10 = baseTime + 1000.
    vi.setSystemTime(baseTime + 700 * 10);
    const move = feed.getMoveSince('btc/usd', 24 * 60 * 60_000);
    expect(move).not.toBeNull();
    expect(move?.ticks).toBe(600);
    expect(move?.oldPrice).toBe(base + 100); // first surviving tick
    expect(move?.newPrice).toBe(base + 699);
  });

  // -------------------------------------------------------------------------
  // getMoveSince — null cases
  // -------------------------------------------------------------------------

  it('getMoveSince returns null when buffer is empty', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();

    expect(feed.getMoveSince('btc/usd', 60_000)).toBeNull();
  });

  it('getMoveSince returns null when only 1 tick exists', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();

    deliver(feed, makeChainlinkMsg('btc/usd', 72_000));
    expect(feed.getMoveSince('btc/usd', 60_000)).toBeNull();
  });

  it('getMoveSince returns null when all ticks are older than the window', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();

    const t0 = 1_775_919_000_000;
    vi.setSystemTime(t0);
    deliver(feed, makeChainlinkMsg('btc/usd', 72_000));
    vi.setSystemTime(t0 + 1000);
    deliver(feed, makeChainlinkMsg('btc/usd', 72_100));

    // Now advance well past the window — both ticks fall outside.
    vi.setSystemTime(t0 + 10 * 60_000);
    expect(feed.getMoveSince('btc/usd', 60_000)).toBeNull();
  });

  it('getMoveSince returns null for an unknown symbol', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();

    expect(feed.getMoveSince('eth/usd', 60_000)).toBeNull();
  });

  it('getMoveSince returns null for non-finite or non-positive windows', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();

    deliver(feed, makeChainlinkMsg('btc/usd', 72_000));
    deliver(feed, makeChainlinkMsg('btc/usd', 72_100));

    expect(feed.getMoveSince('btc/usd', 0)).toBeNull();
    expect(feed.getMoveSince('btc/usd', -1000)).toBeNull();
    expect(feed.getMoveSince('btc/usd', Number.NaN)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // getMoveSince — happy paths
  // -------------------------------------------------------------------------

  it('getMoveSince: happy path with up-move returns positive pctMove', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();

    const t0 = 1_775_919_000_000;
    const oldP = 72_000;
    const newP = 72_720; // +1.0%

    vi.setSystemTime(t0);
    deliver(feed, makeChainlinkMsg('btc/usd', oldP));
    vi.setSystemTime(t0 + 30_000);
    deliver(feed, makeChainlinkMsg('btc/usd', newP));

    // Read from a time inside the 60s window.
    vi.setSystemTime(t0 + 45_000);
    const move = feed.getMoveSince('btc/usd', 60_000);
    expect(move).not.toBeNull();
    expect(move?.oldPrice).toBe(oldP);
    expect(move?.newPrice).toBe(newP);
    expect(move?.ticks).toBe(2);
    // pctMove is fractional in this feed (not percent).
    expect(move?.pctMove).toBeGreaterThan(0);
    expect((move?.pctMove ?? 0) * 100).toBeCloseTo(((newP - oldP) / oldP) * 100, 4);
  });

  it('getMoveSince: happy path with down-move returns negative pctMove', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();

    const t0 = 1_775_919_000_000;
    const oldP = 72_000;
    const newP = 71_280; // -1.0%

    vi.setSystemTime(t0);
    deliver(feed, makeChainlinkMsg('btc/usd', oldP));
    vi.setSystemTime(t0 + 30_000);
    deliver(feed, makeChainlinkMsg('btc/usd', newP));

    vi.setSystemTime(t0 + 45_000);
    const move = feed.getMoveSince('btc/usd', 60_000);
    expect(move).not.toBeNull();
    expect(move?.oldPrice).toBe(oldP);
    expect(move?.newPrice).toBe(newP);
    expect(move?.pctMove).toBeLessThan(0);
    expect((move?.pctMove ?? 0) * 100).toBeCloseTo(((newP - oldP) / oldP) * 100, 4);
  });

  it('getMoveSince: window trims old ticks, keeps recent ones', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();

    const t0 = 1_775_919_000_000;
    // Push a very old tick that should be excluded from the window.
    vi.setSystemTime(t0);
    deliver(feed, makeChainlinkMsg('btc/usd', 60_000));
    // Push two recent ticks inside the window.
    vi.setSystemTime(t0 + 5 * 60_000);
    deliver(feed, makeChainlinkMsg('btc/usd', 72_000));
    vi.setSystemTime(t0 + 5 * 60_000 + 30_000);
    deliver(feed, makeChainlinkMsg('btc/usd', 72_360)); // +0.5%

    vi.setSystemTime(t0 + 5 * 60_000 + 45_000);
    const move = feed.getMoveSince('btc/usd', 60_000); // 1-minute window
    expect(move).not.toBeNull();
    expect(move?.ticks).toBe(2);
    expect(move?.oldPrice).toBe(72_000);
    expect(move?.newPrice).toBe(72_360);
    expect((move?.pctMove ?? 0) * 100).toBeCloseTo(0.5, 4);
  });

  // -------------------------------------------------------------------------
  // getTicksSince — used by SigmaCalibrator rolling window
  // -------------------------------------------------------------------------

  it('getTicksSince returns [] when buffer is empty', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();
    expect(feed.getTicksSince('btc/usd', 60_000)).toEqual([]);
  });

  it('getTicksSince returns [] for unknown symbol', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();
    deliver(feed, makeChainlinkMsg('btc/usd', 72_000));
    expect(feed.getTicksSince('eth/usd', 60_000)).toEqual([]);
  });

  it('getTicksSince returns [] for windowMs <= 0', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();
    deliver(feed, makeChainlinkMsg('btc/usd', 72_000));
    expect(feed.getTicksSince('btc/usd', 0)).toEqual([]);
    expect(feed.getTicksSince('btc/usd', -1)).toEqual([]);
  });

  it('getTicksSince returns [] for non-finite windowMs', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();
    deliver(feed, makeChainlinkMsg('btc/usd', 72_000));
    expect(feed.getTicksSince('btc/usd', Number.NaN)).toEqual([]);
    expect(feed.getTicksSince('btc/usd', Infinity)).toEqual([]);
  });

  it('getTicksSince returns ticks inside the window in chronological order', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();
    const t0 = 1_775_919_000_000;
    vi.setSystemTime(t0);
    deliver(feed, makeChainlinkMsg('btc/usd', 50_000));
    vi.setSystemTime(t0 + 10_000);
    deliver(feed, makeChainlinkMsg('btc/usd', 50_100));
    vi.setSystemTime(t0 + 20_000);
    deliver(feed, makeChainlinkMsg('btc/usd', 50_200));

    vi.setSystemTime(t0 + 25_000);
    const ticks = feed.getTicksSince('btc/usd', 60_000);
    expect(ticks.length).toBe(3);
    expect(ticks[0]?.value).toBe(50_000);
    expect(ticks[1]?.value).toBe(50_100);
    expect(ticks[2]?.value).toBe(50_200);
  });

  it('getTicksSince filters out ticks older than the window', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();
    const t0 = 1_775_919_000_000;
    vi.setSystemTime(t0);
    deliver(feed, makeChainlinkMsg('btc/usd', 50_000)); // too old
    vi.setSystemTime(t0 + 5 * 60_000);
    deliver(feed, makeChainlinkMsg('btc/usd', 50_100)); // inside window

    vi.setSystemTime(t0 + 5 * 60_000 + 30_000);
    const ticks = feed.getTicksSince('btc/usd', 60_000);
    expect(ticks.length).toBe(1);
    expect(ticks[0]?.value).toBe(50_100);
  });

  // -------------------------------------------------------------------------
  // findTickAt — used by FvScanner to resolve window-open strike K
  // -------------------------------------------------------------------------

  it('findTickAt returns null when buffer is empty', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();
    const t0 = 1_775_919_000_000;
    expect(feed.findTickAt('btc/usd', t0, 60_000)).toBeNull();
  });

  it('findTickAt returns null for unknown symbol', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();
    deliver(feed, makeChainlinkMsg('btc/usd', 72_000));
    expect(feed.findTickAt('eth/usd', Date.now(), 60_000)).toBeNull();
  });

  it('findTickAt returns null when no tick falls within tolerance', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();
    const t0 = 1_775_919_000_000;
    vi.setSystemTime(t0);
    deliver(feed, makeChainlinkMsg('btc/usd', 50_000, t0)); // oracleTs = t0
    vi.setSystemTime(t0 + 1000);
    // Query far away from any buffered oracleTs
    expect(feed.findTickAt('btc/usd', t0 - 5 * 60_000, 60_000)).toBeNull();
  });

  it('findTickAt returns closest tick when within tolerance', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();
    const t0 = 1_775_919_000_000;
    // Three ticks at t0, t0+30s, t0+60s
    vi.setSystemTime(t0);
    deliver(feed, makeChainlinkMsg('btc/usd', 50_000, t0));
    vi.setSystemTime(t0 + 30_000);
    deliver(feed, makeChainlinkMsg('btc/usd', 50_100, t0 + 30_000));
    vi.setSystemTime(t0 + 60_000);
    deliver(feed, makeChainlinkMsg('btc/usd', 50_200, t0 + 60_000));

    // Query at t0+32s — closest oracleTs is t0+30_000 (diff 2s)
    vi.setSystemTime(t0 + 65_000);
    const tick = feed.findTickAt('btc/usd', t0 + 32_000, 10_000);
    expect(tick).not.toBeNull();
    expect(tick?.value).toBe(50_100);
  });

  it('findTickAt rejects closest-but-outside-tolerance', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();
    const t0 = 1_775_919_000_000;
    vi.setSystemTime(t0);
    deliver(feed, makeChainlinkMsg('btc/usd', 50_000, t0));
    vi.setSystemTime(t0 + 1000);
    // Closest is t0 but diff = 30s — larger than tolerance 10s
    const tick = feed.findTickAt('btc/usd', t0 + 30_000, 10_000);
    expect(tick).toBeNull();
  });

  it('findTickAt handles future targets by returning null (no future ticks)', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();
    const t0 = 1_775_919_000_000;
    vi.setSystemTime(t0);
    deliver(feed, makeChainlinkMsg('btc/usd', 50_000, t0));
    // Target 5 minutes in the future, tolerance 60s — no tick within range
    const tick = feed.findTickAt('btc/usd', t0 + 5 * 60_000, 60_000);
    expect(tick).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ChainlinkFeed — Redis publisher behavior
// ---------------------------------------------------------------------------

interface FakePipeline {
  set: ReturnType<typeof vi.fn>;
  zadd: ReturnType<typeof vi.fn>;
  zremrangebyrank: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
}

interface FakeRedis {
  pipeline: ReturnType<typeof vi.fn>;
  lastPipeline: FakePipeline | null;
}

function makeFakeRedis(): FakeRedis {
  const fake: FakeRedis = {
    lastPipeline: null,
    pipeline: vi.fn(),
  };
  fake.pipeline.mockImplementation(() => {
    const pipe: FakePipeline = {
      set: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      zremrangebyrank: vi.fn().mockReturnThis(),
      publish: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    fake.lastPipeline = pipe;
    return pipe;
  });
  return fake;
}

describe('ChainlinkFeed Redis publisher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWs = makeFakeWs();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_775_919_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not call redis when no client is provided', () => {
    const feed = new ChainlinkFeed({ symbols: ['btc/usd'] });
    feed.start();

    deliver(feed, makeChainlinkMsg('btc/usd', 72_000));
    // No assertion needed beyond "doesn't throw" — there is no redis to inspect.
    expect(feed.getLatest('btc/usd')?.value).toBe(72_000);
  });

  it('publishes SET + ZADD + ZREMRANGEBYRANK + PUBLISH in one pipeline per tick', async () => {
    const fakeRedis = makeFakeRedis();
    const feed = new ChainlinkFeed({
      symbols: ['btc/usd'],
      redis: fakeRedis as unknown as ConstructorParameters<typeof ChainlinkFeed>[0]['redis'],
    });
    feed.start();

    const oracleTs = 1_775_919_469_000;
    deliver(feed, makeChainlinkMsg('btc/usd', 72_000, oracleTs));

    // publishTick is fire-and-forget (void); flush any queued microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(fakeRedis.pipeline).toHaveBeenCalledTimes(1);
    const pipe = fakeRedis.lastPipeline;
    expect(pipe).not.toBeNull();
    expect(pipe!.set).toHaveBeenCalledWith('oracle:last:btc/usd', '72000', 'EX', 120);
    expect(pipe!.zadd).toHaveBeenCalledWith(
      'oracle:prices:btc/usd',
      oracleTs,
      `${oracleTs}:72000`,
    );
    // ZREMRANGEBYRANK keeps the latest 3600 entries (default capacity): 0..-3601 removes everything older.
    expect(pipe!.zremrangebyrank).toHaveBeenCalledWith('oracle:prices:btc/usd', 0, -3601);
    expect(pipe!.publish).toHaveBeenCalledTimes(1);
    const [channel, payload] = pipe!.publish.mock.calls[0];
    expect(channel).toBe('oracle:price_moved');
    const parsed = JSON.parse(payload as string);
    expect(parsed).toMatchObject({
      symbol: 'btc/usd',
      value: 72_000,
      oracleTs,
    });
    expect(typeof parsed.receivedAt).toBe('number');
    expect(pipe!.exec).toHaveBeenCalledTimes(1);
  });

  it('does not publish for symbols outside the configured allowlist', async () => {
    const fakeRedis = makeFakeRedis();
    const feed = new ChainlinkFeed({
      symbols: ['btc/usd'],
      redis: fakeRedis as unknown as ConstructorParameters<typeof ChainlinkFeed>[0]['redis'],
    });
    feed.start();

    deliver(feed, makeChainlinkMsg('eth/usd', 3_400));
    await Promise.resolve();
    expect(fakeRedis.pipeline).not.toHaveBeenCalled();
  });

  it('survives a redis pipeline rejection without throwing or interrupting in-process state', async () => {
    const fakeRedis = makeFakeRedis();
    fakeRedis.pipeline.mockImplementationOnce(() => {
      const pipe: FakePipeline = {
        set: vi.fn().mockReturnThis(),
        zadd: vi.fn().mockReturnThis(),
        zremrangebyrank: vi.fn().mockReturnThis(),
        publish: vi.fn().mockReturnThis(),
        exec: vi.fn().mockRejectedValue(new Error('redis down')),
      };
      fakeRedis.lastPipeline = pipe;
      return pipe;
    });

    const feed = new ChainlinkFeed({
      symbols: ['btc/usd'],
      redis: fakeRedis as unknown as ConstructorParameters<typeof ChainlinkFeed>[0]['redis'],
    });
    feed.start();

    expect(() => deliver(feed, makeChainlinkMsg('btc/usd', 72_000))).not.toThrow();
    // In-process ringbuffer must still be populated even when publish fails.
    expect(feed.getLatest('btc/usd')?.value).toBe(72_000);
    // Drain the rejected promise so vitest doesn't flag an unhandled rejection.
    await Promise.resolve();
    await Promise.resolve();
  });
});
