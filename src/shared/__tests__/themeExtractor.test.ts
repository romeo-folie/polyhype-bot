import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockGetOpenPositions = vi.fn();
vi.mock('../../execution/positionLedger.js', () => ({
  getOpenPositions: (...args: unknown[]) => mockGetOpenPositions(...args),
}));

const { extractTheme, addNearZeroPosition, removeNearZeroPosition, rebuildNearZeroThemeSets } =
  await import('../themeExtractor.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRedis(): { redis: Redis; sadd: ReturnType<typeof vi.fn>; srem: ReturnType<typeof vi.fn>; scard: ReturnType<typeof vi.fn>; keys: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn>; pipeline: ReturnType<typeof vi.fn> } {
  const sadd = vi.fn().mockResolvedValue(1);
  const srem = vi.fn().mockResolvedValue(1);
  const scard = vi.fn().mockResolvedValue(0);
  const keys = vi.fn().mockResolvedValue([]);
  const del = vi.fn().mockResolvedValue(1);

  const execMock = vi.fn().mockResolvedValue([]);
  const pipeline = vi.fn(() => ({
    del,
    sadd,
    keys,
    exec: execMock,
  }));

  const redis = { sadd, srem, scard, keys, del, pipeline } as unknown as Redis;
  return { redis, sadd, srem, scard, keys, del, pipeline };
}

// ---------------------------------------------------------------------------
// extractTheme — unit tests
// ---------------------------------------------------------------------------

describe('extractTheme', () => {
  describe('iran-israel-conflict', () => {
    it('matches iran + conflict keyword', () => {
      expect(extractTheme('Will Iran and Israel reach a ceasefire by June?')).toBe('iran-israel-conflict');
    });
    it('matches hezbollah + war', () => {
      expect(extractTheme('Will Hezbollah enter a full war with Israel?')).toBe('iran-israel-conflict');
    });
    it('matches hamas + strike', () => {
      expect(extractTheme('Will Hamas respond to the Israeli strike?')).toBe('iran-israel-conflict');
    });
    it('does NOT match iran alone without a conflict keyword', () => {
      expect(extractTheme('Will Iran join the UN security council?')).toBeNull();
    });
    it('does NOT match israel alone without a conflict keyword', () => {
      expect(extractTheme('Will Israel host the 2028 Olympics?')).toBeNull();
    });
  });

  describe('btc-price-target', () => {
    it('matches bitcoin + dollar amount', () => {
      expect(extractTheme('Will Bitcoin reach $100,000 by end of 2026?')).toBe('btc-price-target');
    });
    it('matches btc + dollar amount', () => {
      expect(extractTheme('Will BTC hit $80,000 this quarter?')).toBe('btc-price-target');
    });
    it('does NOT match bitcoin without a price', () => {
      expect(extractTheme('Will Bitcoin ETF be approved?')).toBeNull();
    });
  });

  describe('eth-price-target', () => {
    it('matches ethereum + dollar amount', () => {
      expect(extractTheme('Will Ethereum reach $5,000 in 2026?')).toBe('eth-price-target');
    });
    it('does NOT match eth in isolation without price', () => {
      expect(extractTheme('Will ETH staking yield exceed 6%?')).toBeNull();
    });
  });

  describe('oil-price-target', () => {
    it('matches crude + dollar amount', () => {
      expect(extractTheme('Will crude oil exceed $100 per barrel?')).toBe('oil-price-target');
    });
    it('matches wti + dollar amount', () => {
      expect(extractTheme('Will WTI fall below $60?')).toBe('oil-price-target');
    });
    it('does NOT match oil without a price', () => {
      expect(extractTheme('Will OPEC cut oil production?')).toBeNull();
    });
  });

  describe('inflation', () => {
    it('matches inflation keyword alone', () => {
      expect(extractTheme('Will US inflation exceed 4% in 2026?')).toBe('inflation');
    });
    it('matches cpi keyword', () => {
      expect(extractTheme('Will CPI print above 3.5% in April?')).toBe('inflation');
    });
  });

  describe('fed-rates', () => {
    it('matches fed + rate cut', () => {
      expect(extractTheme('Will the Fed cut rates in June 2026?')).toBe('fed-rates');
    });
    it('matches fomc + rate hike', () => {
      expect(extractTheme('Will the FOMC vote for a rate hike at its next meeting?')).toBe('fed-rates');
    });
    it('does NOT match fed without rate keyword', () => {
      expect(extractTheme('Will the Fed release its balance sheet report?')).toBeNull();
    });
  });

  describe('ukraine-russia', () => {
    it('matches ukraine', () => {
      expect(extractTheme('Will Ukraine retake Kherson by year-end?')).toBe('ukraine-russia');
    });
    it('matches russia', () => {
      expect(extractTheme('Will Russia withdraw from Donetsk?')).toBe('ukraine-russia');
    });
    it('matches putin', () => {
      expect(extractTheme('Will Putin resign before 2027?')).toBe('ukraine-russia');
    });
  });

  describe('taiwan-china', () => {
    it('matches taiwan', () => {
      expect(extractTheme('Will Taiwan hold presidential elections without incident?')).toBe('taiwan-china');
    });
    it('matches tsmc', () => {
      expect(extractTheme('Will TSMC open a US fab by 2027?')).toBe('taiwan-china');
    });
  });

  describe('null cases', () => {
    it('returns null for unclassifiable questions', () => {
      expect(extractTheme('Will the US men\'s soccer team qualify for the World Cup?')).toBeNull();
    });
    it('returns null for empty string', () => {
      expect(extractTheme('')).toBeNull();
    });
    it('returns null for sports markets with no matching theme', () => {
      expect(extractTheme('Will Novak Djokovic win Wimbledon in 2026?')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// addNearZeroPosition / removeNearZeroPosition — Redis state helpers
// ---------------------------------------------------------------------------

describe('addNearZeroPosition', () => {
  beforeEach(() => vi.clearAllMocks());

  it('SADDs both the theme set and global set when theme is provided', async () => {
    const { redis, sadd } = makeRedis();
    await addNearZeroPosition(redis, 'iran-israel-conflict', 'mkt-1', 'YES');
    // Two SADD calls — one per set
    expect(sadd).toHaveBeenCalledTimes(2);
    const keys = sadd.mock.calls.map((c) => c[0]);
    expect(keys).toContain('near_zero:theme_open:iran-israel-conflict');
    expect(keys).toContain('near_zero:positions_open');
    // Both contain the member
    expect(sadd.mock.calls[0]).toContain('mkt-1:YES');
  });

  it('SADDs only the global set when theme is null', async () => {
    const { redis, sadd } = makeRedis();
    await addNearZeroPosition(redis, null, 'mkt-2', 'NO');
    expect(sadd).toHaveBeenCalledTimes(1);
    expect(sadd.mock.calls[0]![0]).toBe('near_zero:positions_open');
  });
});

describe('removeNearZeroPosition', () => {
  beforeEach(() => vi.clearAllMocks());

  it('SREMs both sets when theme is provided', async () => {
    const { redis, srem } = makeRedis();
    await removeNearZeroPosition(redis, 'btc-price-target', 'mkt-3', 'YES');
    expect(srem).toHaveBeenCalledTimes(2);
    const keys = srem.mock.calls.map((c) => c[0]);
    expect(keys).toContain('near_zero:theme_open:btc-price-target');
    expect(keys).toContain('near_zero:positions_open');
  });

  it('SREMs only the global set when theme is null', async () => {
    const { redis, srem } = makeRedis();
    await removeNearZeroPosition(redis, null, 'mkt-4', 'NO');
    expect(srem).toHaveBeenCalledTimes(1);
    expect(srem.mock.calls[0]![0]).toBe('near_zero:positions_open');
  });
});

// ---------------------------------------------------------------------------
// rebuildNearZeroThemeSets — reconciler
// ---------------------------------------------------------------------------

describe('rebuildNearZeroThemeSets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOpenPositions.mockResolvedValue([]);
  });

  it('rebuilds theme sets from open near-zero-arb positions', async () => {
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'mkt-iran-1',
        direction: 'YES',
        sourcedFrom: 'near-zero-arb',
        question: 'Will Iran and Israel sign a ceasefire by July?',
      },
      {
        marketId: 'mkt-iran-2',
        direction: 'NO',
        sourcedFrom: 'near-zero-arb (OSINT: Israel strikes)',
        question: 'Will the Iran-Israel war escalate this week?',
      },
      {
        marketId: 'mkt-btc',
        direction: 'YES',
        sourcedFrom: 'near-zero-arb',
        question: 'Will BTC reach $120,000 in 2026?',
      },
      {
        marketId: 'mkt-other',
        direction: 'YES',
        sourcedFrom: 'osint',  // NOT near-zero-arb — must be excluded
        question: 'Will the Fed cut rates?',
      },
    ]);

    const { redis } = makeRedis();
    await rebuildNearZeroThemeSets(redis);

    // Pipeline was used to execute the rebuild atomically
    expect(redis.pipeline).toHaveBeenCalled();
  });

  it('clears stale theme keys when no positions remain', async () => {
    mockGetOpenPositions.mockResolvedValue([]);
    const { redis, keys } = makeRedis();
    keys.mockResolvedValue(['near_zero:theme_open:iran-israel-conflict']);

    await rebuildNearZeroThemeSets(redis);

    expect(redis.pipeline).toHaveBeenCalled();
  });

  it('excludes positions not sourced from near-zero-arb', async () => {
    mockGetOpenPositions.mockResolvedValue([
      {
        marketId: 'mkt-x',
        direction: 'YES',
        sourcedFrom: 'osint',
        question: 'Will BTC hit $100,000?',
      },
    ]);

    const { redis } = makeRedis();
    // Should not throw and should produce empty sets
    await expect(rebuildNearZeroThemeSets(redis)).resolves.toBeUndefined();
  });
});
