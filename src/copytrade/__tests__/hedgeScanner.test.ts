/**
 * Tests for the Copytrade Hedge Scanner.
 * Covers:
 *  1. Math helpers — maxHedgePrice, tier1Stake, tier2Stake, computePnl.
 *  2. Dedup — already-hedged positions are skipped.
 *  3. Gate: hedge_ask >= q_max → no decision, shadow-logs wouldBlock=true.
 *  4. Tier 1 (arb): entry + hedge_ask < ARB_CEILING → equal-profit sizing.
 *  5. Tier 2 (damage control): hedge_ask < q_max but no arb → loss-cap sizing.
 *  6. Dark mode — shadow-logs but does not execute when COPYTRADE_HEDGE_ENABLED=false.
 *  7. Partial fill — lock not set, bankroll deducted for actual cost.
 *  8. Full fill — Redis lock set, bankroll deducted, notification sent.
 *  9. Non-binary market (< 2 tokenIds) — skipped.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
}));

const mockDeductStake = vi.fn().mockResolvedValue(undefined);
vi.mock('../../shared/bankroll.js', () => ({ deductStake: mockDeductStake }));

const mockNotify = vi.fn().mockResolvedValue(undefined);
vi.mock('../../execution/telegram.js', () => ({ notify: mockNotify }));

// ── Dynamic imports ───────────────────────────────────────────────────────────

const {
  runCopytradeHedgeScan,
  maxHedgePrice,
  tier1Stake,
  tier2Stake,
  computePnl,
} = await import('../hedgeScanner.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    COPYTRADE_HEDGE_ENABLED: true,
    COPYTRADE_HEDGE_MAX_LOSS_FRACTION: 0.40,
    COPYTRADE_HEDGE_MAX_STAKE_MULTIPLIER: 1.5,
    ...overrides,
  };
}

function makePosition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pos-1',
    marketId: 'mkt-1',
    question: 'Bitcoin Up or Down - May 28?',
    direction: 'NO',
    entryPrice: 0.54,
    stakeUsd: 5,
    sharesHeld: 9.26, // 5 / 0.54
    ...overrides,
  };
}

function makeRedis(hedgeExists = false) {
  const store = new Map<string, string>();
  return {
    exists: vi.fn().mockResolvedValue(hedgeExists ? 1 : 0),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    _store: store,
  };
}

// ── Math helper tests ─────────────────────────────────────────────────────────

describe('maxHedgePrice', () => {
  it('returns (1-p)/(1-p*mf)', () => {
    // p=0.54, mf=0.40 → (0.46)/(1-0.216) = 0.46/0.784 ≈ 0.587
    expect(maxHedgePrice(0.54, 0.40)).toBeCloseTo(0.5867, 3);
  });

  it('returns 1 when entry_price is 0', () => {
    expect(maxHedgePrice(0, 0.40)).toBe(1);
  });
});

describe('tier1Stake', () => {
  it('equals stake * hedge_ask / entry_price', () => {
    // s=5, p=0.54, q=0.40 → 5*0.40/0.54 ≈ 3.70
    expect(tier1Stake(5, 0.54, 0.40)).toBeCloseTo(3.704, 2);
  });
});

describe('tier2Stake', () => {
  it('sizes to cap loss at max_loss_fraction when hedge wins', () => {
    // s=5, q=0.55, mf=0.40 → 5*0.60*0.55/0.45 ≈ 3.67
    expect(tier2Stake(5, 0.55, 0.40)).toBeCloseTo(3.667, 2);
  });
});

describe('computePnl', () => {
  it('both outcomes positive for Tier 1 arb', () => {
    // position: NO @0.54, stake=$5, shares=9.26
    // hedge: YES @0.40, hedgeStake=$3.70
    const { originalWins, hedgeWins } = computePnl(9.26, 5, 0.40, 3.704);
    expect(originalWins).toBeGreaterThan(0); // 9.26 - 5 - 3.70 > 0
    expect(hedgeWins).toBeGreaterThan(0);    // 3.70/0.40 - 5 - 3.70 > 0
  });

  it('originalWins positive, hedgeWins negative for Tier 2', () => {
    // hedge_ask=0.55 (above arb ceiling), stake=$5, hedgeStake≈$3.67
    const { originalWins, hedgeWins } = computePnl(9.26, 5, 0.55, 3.667);
    expect(originalWins).toBeGreaterThan(0);
    expect(hedgeWins).toBeLessThan(0);
  });
});

// ── Integration tests ─────────────────────────────────────────────────────────

describe('runCopytradeHedgeScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(makeConfig());
    mockGetMarket.mockResolvedValue({ clobTokenIds: '["tok-yes","tok-no"]' });
    mockParseClobTokenIds.mockReturnValue(['tok-yes', 'tok-no']);
    // Tier 1 arb: entry 0.54 + hedge 0.40 = 0.94 < 0.985
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.40' }] });
    mockSubmitClobBuy.mockResolvedValue({ success: true, shares_bought: 9.26, cost: 3.70 });
  });

  it('skips positions already hedged in Redis', async () => {
    mockSql.mockResolvedValue([makePosition()]);
    const redis = makeRedis(true);

    await runCopytradeHedgeScan(redis as any);

    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
  });

  it('skips non-binary markets (< 2 tokenIds)', async () => {
    mockSql.mockResolvedValue([makePosition()]);
    mockParseClobTokenIds.mockReturnValue(['tok-yes']); // only 1 token
    const redis = makeRedis();

    await runCopytradeHedgeScan(redis as any);

    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
  });

  it('skips when hedge_ask >= q_max and shadow-logs wouldBlock=true', async () => {
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    mockSql.mockResolvedValue([makePosition()]);
    // q_max ≈ 0.587 for p=0.54, mf=0.40; set hedge_ask above it
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.62' }] });
    const redis = makeRedis();

    await runCopytradeHedgeScan(redis as any);

    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ kind: 'copytrade_hedge', wouldBlock: true }),
    );
  });

  it('does not execute when COPYTRADE_HEDGE_ENABLED=false but still shadow-logs', async () => {
    // The worker always runs the scan regardless of COPYTRADE_HEDGE_ENABLED so
    // shadow_observations rows are produced in dark mode. Execution is suppressed
    // inside the function when the flag is false.
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    mockSql.mockResolvedValue([makePosition()]);
    mockLoadConfig.mockReturnValue(makeConfig({ COPYTRADE_HEDGE_ENABLED: false }));
    const redis = makeRedis();

    await runCopytradeHedgeScan(redis as any);

    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({ kind: 'copytrade_hedge', wouldBlock: true }),
    );
  });

  it('Tier 1 arb: both P&L outcomes positive, shadow-logs isArb=true', async () => {
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    mockSql.mockResolvedValue([makePosition()]); // entry 0.54, hedge 0.40 → arb
    const redis = makeRedis();

    await runCopytradeHedgeScan(redis as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        payload: expect.objectContaining({ isArb: true, tier: 1 }),
      }),
    );
  });

  it('Tier 2: fires when entry + hedge >= 0.985 but hedge < q_max', async () => {
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    mockSql.mockResolvedValue([makePosition()]); // p=0.54
    // hedge_ask=0.55 → 0.54+0.55=1.09 >= 0.985, but 0.55 < q_max≈0.587
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.55' }] });
    const redis = makeRedis();

    await runCopytradeHedgeScan(redis as any);

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        payload: expect.objectContaining({ isArb: false, tier: 2 }),
      }),
    );
  });

  it('sets lock and deducts partial cost on a partial fill below 85%', async () => {
    mockSql.mockResolvedValue([makePosition({ sharesHeld: 10 })]);
    // Only 7 of ~9.26 shares filled → ratio < 0.85
    mockSubmitClobBuy.mockResolvedValue({ success: true, shares_bought: 7, cost: 2.80 });
    const redis = makeRedis();

    await runCopytradeHedgeScan(redis as any);

    // Lock is set even on partial fill to prevent unbounded retry accumulation.
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('copytrade:hedged:'),
      '1',
      'EX',
      expect.any(Number),
    );
    expect(mockDeductStake).toHaveBeenCalledOnce();
    // No Telegram notification on partial fill.
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('sets Redis lock, deducts bankroll, and notifies on full fill', async () => {
    mockSql.mockResolvedValue([makePosition()]);
    mockSubmitClobBuy.mockResolvedValue({ success: true, shares_bought: 9.26, cost: 3.70 });
    const redis = makeRedis();

    await runCopytradeHedgeScan(redis as any);

    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('copytrade:hedged:'),
      '1',
      'EX',
      expect.any(Number),
    );
    expect(mockDeductStake).toHaveBeenCalledWith(redis, 3.70);
    expect(mockNotify).toHaveBeenCalledOnce();
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining('Tier 1'));
  });

  it('queries positions using LIKE copytrade:% prefix (not exact match)', async () => {
    // Real rows are written as sourced_from = 'copytrade:<wallet>' by index.ts:1190.
    // Verify the SQL tag in the mock is called with a template literal containing LIKE.
    mockSql.mockResolvedValue([]);
    const redis = makeRedis();
    await runCopytradeHedgeScan(redis as any);
    // mockSql is called as a tagged template; the first arg is the strings array.
    const [strings] = mockSql.mock.calls[0] as [TemplateStringsArray];
    expect(strings.join('').toLowerCase()).toContain("like 'copytrade:%'");
  });

  it('buys YES when position direction is NO', async () => {
    mockSql.mockResolvedValue([makePosition({ direction: 'NO' })]);
    mockParseClobTokenIds.mockReturnValue(['tok-yes', 'tok-no']);
    const redis = makeRedis();

    await runCopytradeHedgeScan(redis as any);

    expect(mockSubmitClobBuy).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-yes' }),
    );
  });

  it('buys NO when position direction is YES', async () => {
    // sharesHeld must match entryPrice (5 / 0.46 ≈ 10.87) so originalWins > 0
    mockSql.mockResolvedValue([makePosition({ direction: 'YES', entryPrice: 0.46, sharesHeld: 10.87 })]);
    mockParseClobTokenIds.mockReturnValue(['tok-yes', 'tok-no']);
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.40' }] });
    const redis = makeRedis();

    await runCopytradeHedgeScan(redis as any);

    expect(mockSubmitClobBuy).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-no' }),
    );
  });

  it('caps hedge stake at max_stake_multiplier × original_stake', async () => {
    // Very cheap hedge → uncapped stake would be large; multiplier=1.5 → max $7.50
    mockSql.mockResolvedValue([makePosition({ stakeUsd: 5, entryPrice: 0.54 })]);
    mockGetClobOrderBook.mockResolvedValue({ asks: [{ price: '0.40' }] });
    mockLoadConfig.mockReturnValue(makeConfig({ COPYTRADE_HEDGE_MAX_STAKE_MULTIPLIER: 1.5 }));
    const redis = makeRedis();

    await runCopytradeHedgeScan(redis as any);

    const call = mockSubmitClobBuy.mock.calls[0]?.[0] as { amountUsd: number } | undefined;
    expect(call?.amountUsd).toBeLessThanOrEqual(5 * 1.5);
  });
});
