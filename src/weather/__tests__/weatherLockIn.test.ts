/**
 * Tests for the Weather Lock-In Scanner.
 * Covers:
 *  1. Dedup — positions with an existing Redis lock are skipped.
 *  2. Gate evaluation — meetsYesPrice && meetsCostCeiling.
 *  3. Partial fill — lock not set when shares_bought < 90% of sharesHeld.
 *  4. Bankroll deduction — deductStake called after a successful fill.
 *  5. Integration with runWeatherScan — lock-in fires even when scan has
 *     no tradable opportunities (early-return paths bypassed).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockLoadConfig = vi.fn();
vi.mock('../../shared/config.js', () => ({ loadConfig: mockLoadConfig }));

vi.mock('../../db/writeQueue.js', () => ({ enqueueWrite: vi.fn() }));

const mockSql = vi.fn();
vi.mock('../../db/client.js', () => ({ getSql: () => mockSql }));

const mockGetMarket = vi.fn();
const mockParseClobTokenIds = vi.fn();
vi.mock('../../mapping/gamma.js', () => ({
  getMarket: mockGetMarket,
  parseClobTokenIds: mockParseClobTokenIds,
}));

const mockGetClobOrderBook = vi.fn();
const mockSubmitClobBuy = vi.fn();
vi.mock('../../shared/clob.js', () => ({
  getClobOrderBook: mockGetClobOrderBook,
  submitClobBuy: mockSubmitClobBuy,
  CLOB_MIN_ORDER_USD: 1.0,
}));

const mockDeductStake = vi.fn().mockResolvedValue(undefined);
vi.mock('../../shared/bankroll.js', () => ({
  deductStake: mockDeductStake,
  getBankroll: vi.fn().mockResolvedValue(100),
}));

vi.mock('../noaaClient.js', async () => {
  const actual = await vi.importActual<typeof import('../noaaClient.js')>('../noaaClient.js');
  return { ...actual };
});

vi.mock('../../execution/executor.js', () => ({
  executeAndRecordSignal: vi.fn().mockResolvedValue({ skipped: true, signal: { stakeUsd: 0 } }),
}));

// ── Dynamic imports ───────────────────────────────────────────────────────────

const { runWeatherLockInScan } = await import('../weatherLockIn.js');
const { runWeatherScan } = await import('../weatherScanner.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides = {}) {
  return {
    WEATHER_LOCK_IN_ENABLED: true,
    WEATHER_LOCK_IN_MAX_YES_PRICE: 0.05,
    WEATHER_LOCK_IN_COST_CEILING: 1.05,
    WEATHER_SCANNER_ENABLED: false,
    WEATHER_EXECUTION_ENABLED: false,
    WEATHER_MAX_POSITIONS_PER_SCAN: 5,
    WEATHER_MAX_PER_CITY: 2,
    WEATHER_MAX_SCAN_EXPOSURE_USD: 50,
    WEATHER_MAX_STAKE_FRACTION: 0.05,
    WEATHER_MAX_STAKE_USD: 10,
    WEATHER_KELLY_FRACTION: 0.5,
    WEATHER_TRADE_SIDES: 'both',
    WEATHER_MAX_LOOKAHEAD_HOURS: 0,
    WEATHER_NEAR_RES_ENTRY_ENABLED: false,
    WEATHER_EXCLUDED_CITIES: '',
    WEATHER_MAX_EVENTS: 50,
    MIN_BET_USD: 5,
    ARB_GLOBAL_MAX_TRADES_PER_MIN: 6,
    ...overrides,
  };
}

function makePosition(overrides = {}) {
  // sharesHeld 40 × default ask 0.03 = $1.20 intended notional — above the $1
  // CLOB minimum, so the default fixture takes the no-bump path. Sub-minimum
  // sizing behaviour is exercised explicitly in the CLOB-minimum-bump block.
  return {
    id: 'pos-1',
    marketId: 'mkt-1',
    direction: 'NO' as const,
    entryPrice: 0.62,
    sharesHeld: 40,
    ...overrides,
  };
}

function makeRedis(lockExists = false) {
  const store = new Map<string, string>();
  if (lockExists) {
    // Pre-populate the lock key so mget returns a hit for pos-1
    store.set('weather:locked:pos-1', '1');
  }
  return {
    exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn().mockResolvedValue(null),
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)),
    _store: store,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runWeatherLockInScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(makeConfig());
    mockGetMarket.mockResolvedValue({ clobTokenIds: '["tok-yes","tok-no"]' });
    mockParseClobTokenIds.mockReturnValue(['tok-yes', 'tok-no']);
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.03' }] });
    mockSubmitClobBuy.mockResolvedValue({ success: true, shares_bought: 40, cost: 1.20 });
  });

  it('skips positions that already have a Redis lock', async () => {
    mockSql.mockResolvedValue([makePosition()]);
    const redis = makeRedis(true); // lock exists

    await runWeatherLockInScan(redis as any);

    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
  });

  it('skips when opposite ask exceeds WEATHER_LOCK_IN_MAX_YES_PRICE', async () => {
    mockSql.mockResolvedValue([makePosition()]);
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.10' }] }); // > 0.05 max
    const redis = makeRedis();

    await runWeatherLockInScan(redis as any);

    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
  });

  it('skips when cost ceiling would be exceeded', async () => {
    mockSql.mockResolvedValue([makePosition({ entryPrice: 1.02 })]);
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.04' }] });
    // costTotal = 1.02 + 0.04 = 1.06 > WEATHER_LOCK_IN_COST_CEILING 1.05
    const redis = makeRedis();

    await runWeatherLockInScan(redis as any);

    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
  });

  it('buys YES (tokenIds[0]) when locking in a NO position', async () => {
    mockSql.mockResolvedValue([makePosition({ direction: 'NO' as const })]);
    const redis = makeRedis();

    await runWeatherLockInScan(redis as any);

    expect(mockSubmitClobBuy).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-yes' }),
    );
  });

  it('reads the lock-in ask from a multi-level raw-REST-order book (asks[0] = WORST ask)', async () => {
    mockSql.mockResolvedValue([makePosition({ direction: 'NO' as const })]);
    // REST books are best-at-the-END: asks descending, real best ask 0.03 is
    // LAST. Pre-fix the price gate read asks[0]=0.99 → every lock-in skipped
    // as over the max price / cost ceiling despite a viable 0.03 hedge.
    mockGetClobOrderBook.mockResolvedValue({
      asks: [
        { price: '0.99', size: '5' },
        { price: '0.50', size: '10' },
        { price: '0.03', size: '60' }, // real best ask — LAST
      ],
    });
    const redis = makeRedis();

    await runWeatherLockInScan(redis as any);

    expect(mockSubmitClobBuy).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-yes' }),
    );
  });

  it('buys NO (tokenIds[1]) when locking in a YES position', async () => {
    mockSql.mockResolvedValue([makePosition({ direction: 'YES' as const })]);
    const redis = makeRedis();

    await runWeatherLockInScan(redis as any);

    // YES position → buy NO → tokenIds[1]
    expect(mockSubmitClobBuy).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-no' }),
    );
  });

  it('does not execute when WEATHER_LOCK_IN_ENABLED=false but still shadow-logs', async () => {
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    mockSql.mockResolvedValue([makePosition()]);
    mockLoadConfig.mockReturnValue(makeConfig({ WEATHER_LOCK_IN_ENABLED: false }));
    const redis = makeRedis();

    await runWeatherLockInScan(redis as any);

    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ kind: 'weather_lock_in', wouldBlock: true }),
    );
  });

  it('does not set lock when fill ratio is below 90%', async () => {
    mockSql.mockResolvedValue([makePosition({ sharesHeld: 40 })]);
    // Only 30 of 40 shares filled → ratio 0.75 < 0.9 threshold
    mockSubmitClobBuy.mockResolvedValue({ success: true, shares_bought: 30, cost: 0.90 });
    const redis = makeRedis();

    await runWeatherLockInScan(redis as any);

    expect(redis.set).not.toHaveBeenCalled();
    // Deduct what was spent even on partial fill
    expect(mockDeductStake).toHaveBeenCalledOnce();
  });

  it('sets the Redis lock and deducts bankroll on a full fill', async () => {
    mockSql.mockResolvedValue([makePosition({ sharesHeld: 40 })]);
    mockSubmitClobBuy.mockResolvedValue({ success: true, shares_bought: 40, cost: 1.20 });
    const redis = makeRedis();

    await runWeatherLockInScan(redis as any);

    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('weather:locked:'),
      '1',
      'EX',
      expect.any(Number),
    );
    expect(mockDeductStake).toHaveBeenCalledWith(redis, 1.20);
  });

  describe('CLOB minimum-order bump (sharesHeld × ask below $1)', () => {
    it('bumps a near-miss order up to the CLOB minimum and locks on fill', async () => {
      // 30 sh × 0.03 = $0.90 intended ≥ 60% of $1 → submit at exactly $1.00.
      mockSql.mockResolvedValue([makePosition({ sharesHeld: 30 })]);
      // $1.00 at ask 0.03 buys ~33 shares → ratio 33/30 > 0.9 → lock sets.
      mockSubmitClobBuy.mockResolvedValue({ success: true, shares_bought: 33, cost: 1.0 });
      const redis = makeRedis();

      await runWeatherLockInScan(redis as any);

      expect(mockSubmitClobBuy).toHaveBeenCalledWith(
        expect.objectContaining({ amountUsd: 1.0 }),
      );
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining('weather:locked:'),
        '1',
        'EX',
        expect.any(Number),
      );
      expect(mockDeductStake).toHaveBeenCalledWith(redis, 1.0);
    });

    it('bumps at exactly the 60% tolerance boundary (inclusive)', async () => {
      // 20 sh × 0.03 = $0.60 — exactly 60% of the $1 minimum → still bumped.
      // IEEE 754 note: `20 * 0.03` and `1.0 * 0.6` evaluate to the IDENTICAL
      // double (0.5999999999999999778), so this genuinely pins the inclusive
      // boundary of the strict `<` skip check — flipping it to `<=` routes
      // this case to the skip path and fails the assertion below.
      mockSql.mockResolvedValue([makePosition({ sharesHeld: 20 })]);
      mockSubmitClobBuy.mockResolvedValue({ success: true, shares_bought: 33, cost: 1.0 });
      const redis = makeRedis();

      await runWeatherLockInScan(redis as any);

      expect(mockSubmitClobBuy).toHaveBeenCalledWith(
        expect.objectContaining({ amountUsd: 1.0 }),
      );
    });

    it('partial fill of a bumped order below 0.9 ratio deducts cost but does not set lock', async () => {
      mockSql.mockResolvedValue([makePosition({ sharesHeld: 30 })]);
      // Bumped to $1.00; only 20 of 30 needed shares fill → ratio 0.67 < 0.9
      // → no lock (retried next scan), but the spent cost is still deducted.
      mockSubmitClobBuy.mockResolvedValue({ success: true, shares_bought: 20, cost: 0.60 });
      const redis = makeRedis();

      await runWeatherLockInScan(redis as any);

      expect(mockSubmitClobBuy).toHaveBeenCalledWith(
        expect.objectContaining({ amountUsd: 1.0 }),
      );
      expect(redis.set).not.toHaveBeenCalled();
      expect(mockDeductStake).toHaveBeenCalledWith(redis, 0.60);
    });

    it('skips entirely when intended notional is too far below the minimum (no oversized bump)', async () => {
      // 10 sh × 0.03 = $0.30 < 60% of $1 → bumping would be a >3× oversize on
      // a near-settled market — skip, no submit, no lock; re-evaluated next scan.
      mockSql.mockResolvedValue([makePosition({ sharesHeld: 10 })]);
      const redis = makeRedis();

      await runWeatherLockInScan(redis as any);

      expect(mockSubmitClobBuy).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
      expect(mockDeductStake).not.toHaveBeenCalled();
    });

    it('passes the intended notional through unchanged when it clears the minimum', async () => {
      // Default 40 sh × 0.03 = $1.20 ≥ $1 → no bump, no rounding.
      mockSql.mockResolvedValue([makePosition()]);
      const redis = makeRedis();

      await runWeatherLockInScan(redis as any);

      expect(mockSubmitClobBuy).toHaveBeenCalledWith(
        expect.objectContaining({ amountUsd: expect.closeTo(1.2, 5) }),
      );
    });
  });
});

describe('runWeatherScan — lock-in runs regardless of scan state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockResolvedValue([]); // no open NO positions → lock-in exits fast
    mockLoadConfig.mockReturnValue(makeConfig());
    // Return empty events list from Gamma so scanWeatherMarkets exits early
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ([]),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls runWeatherLockInScan even when Gamma returns no events', async () => {
    const redis = makeRedis();
    await runWeatherScan(redis as any);
    // Lock-in ran (independently of scan state) — it queried the DB for open NO positions
    expect(mockSql).toHaveBeenCalled();
  });
});
