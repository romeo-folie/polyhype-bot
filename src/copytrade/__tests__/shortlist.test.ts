import { vi, describe, it, expect, beforeEach } from 'vitest';
import type * as GammaModule from '../../mapping/gamma.js';

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const mockFetchWithTimeout = vi.fn();
const mockLoadConfig = vi.fn();
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockRename = vi.fn();
const mockFetchAndScoreWallet = vi.fn();
const mockEnqueueWrite = vi.fn();
const mockRedis = {
  hset: vi.fn().mockResolvedValue('OK'),
  expire: vi.fn().mockResolvedValue(1),
};
const mockGetRedis = vi.fn(() => mockRedis);
const mockCloseRedis = vi.fn().mockResolvedValue(undefined);

vi.mock('../../shared/logger.js', () => ({ logger: mockLogger }));
vi.mock('../../mapping/gamma.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GammaModule>();
  return { ...actual, fetchWithTimeout: mockFetchWithTimeout };
});
vi.mock('../../shared/config.js', () => ({ loadConfig: mockLoadConfig }));
vi.mock('fs/promises', () => ({
  default: { readFile: mockReadFile, writeFile: mockWriteFile, rename: mockRename },
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  rename: mockRename,
}));
vi.mock('../walletQuality.js', () => ({
  fetchAndScoreWallet: mockFetchAndScoreWallet,
}));
vi.mock('../../db/writeQueue.js', () => ({ enqueueWrite: mockEnqueueWrite }));
vi.mock('../../shared/redis.js', () => ({
  getRedis: mockGetRedis,
  closeRedis: mockCloseRedis,
}));

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    COPYTRADE_ENABLED: true,
    COPYTRADE_MARKET_SCOPE: ['weather'],
    COPYTRADE_SHORTLIST_TIME_WINDOW: 'WEEK',
    COPYTRADE_SHORTLIST_TOP_N: 5,
    COPYTRADE_SHORTLIST_MIN_PNL_USD: 10000,
    COPYTRADE_SHORTLIST_MIN_VOL_USD: 100000,
    COPYTRADE_SHORTLIST_AUTO_APPLY: true,
    COPYTRADE_SHORTLIST_MIN_VOL_PNL_RATIO: 0,
    COPYTRADE_QUALITY_SHORTLIST_ENABLED: false,
    COPYTRADE_WALLET_MAX_TRADES: 100,
    COPYTRADE_WALLET_MIN_AVG_SIZE_USD: 10000,
    COPYTRADE_WALLET_MAX_AVG_SIZE_USD: 50000,
    COPYTRADE_WALLET_MIN_CATEGORY_CONCENTRATION: 0.5,
    COPYTRADE_WALLET_MIN_SCORE: 0.5,
    COPYTRADE_QUALITY_WEIGHT_TRADE_COUNT: 0.3,
    COPYTRADE_QUALITY_WEIGHT_AVG_SIZE: 0.2,
    COPYTRADE_QUALITY_WEIGHT_CATEGORY_FOCUS: 0.3,
    COPYTRADE_QUALITY_WEIGHT_SHARPE: 0.2,
    COPYTRADE_WIN_RATE_BONUS_MULT: 1.2,
    COPYTRADE_WIN_RATE_PENALTY_MULT: 0.8,
    COPYTRADE_WIN_RATE_MIN_RESOLVED: 10,
    ...overrides,
  };
}

function makeScore(score: number) {
  return {
    stats: {
      wallet: '0x0',
      tradeCount: 40,
      avgTradeSizeUsd: 20000,
      totalVolumeUsd: 800000,
      categoryDistribution: {},
      categoryHhi: 0.8,
      overallWinRate: 0.6,
      overallResolvedTrades: 20,
      sharpe: 1.2,
    },
    result: {
      score,
      factors: {
        tradeCount: 0.8,
        avgSize: 0.8,
        categoryFocus: 0.8,
        sharpe: 0.8,
        winRateMultiplier: 1.0,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchAndScoreWallet.mockResolvedValue(null); // default: scoring failed → no-op
});

describe('copytrade shortlist', () => {
  it('fetches leaderboard and parses entries', async () => {
    const payload = [
      {
        rank: '1',
        proxyWallet: '0x0000000000000000000000000000000000000abc',
        userName: 'foo',
        vol: 200000,
        pnl: 50000,
      },
    ];
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => payload } as Response);

    const { fetchLeaderboard } = await import('../shortlist.js');
    const result = await fetchLeaderboard('WEATHER', 'WEEK', 10);

    expect(result).toEqual(payload);
  });

  it('selects by threshold and backfills to top N', async () => {
    const entries = [
      {
        rank: '1',
        proxyWallet: '0x0000000000000000000000000000000000000001',
        userName: 'a',
        vol: 150000,
        pnl: 20000,
      },
      {
        rank: '2',
        proxyWallet: '0x0000000000000000000000000000000000000002',
        userName: 'b',
        vol: 90000,
        pnl: 5000,
      },
      {
        rank: '3',
        proxyWallet: '0x0000000000000000000000000000000000000003',
        userName: 'c',
        vol: 200000,
        pnl: 15000,
      },
    ];

    const { selectWallets } = await import('../shortlist.js');
    const { selected, backfilled } = selectWallets(entries, 10000, 100000, 2);

    expect(selected.map((e) => e.proxyWallet)).toEqual([
      '0x0000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000003',
    ]);
    expect(backfilled).toHaveLength(0);

    const { selected: selected2, backfilled: backfilled2 } = selectWallets(
      entries,
      10000,
      250000,
      2,
    );
    expect(selected2).toHaveLength(0);
    expect(backfilled2.map((e) => e.proxyWallet)).toEqual([
      '0x0000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000002',
    ]);
  });

  it('minVolPnlRatio filters low-vol/pnl wallets', async () => {
    const { selectWallets } = await import('../shortlist.js');
    const entries = [
      { rank: '1', proxyWallet: '0xA', userName: 'a', vol: 150000, pnl: 100000 }, // ratio 1.5 ✓
      { rank: '2', proxyWallet: '0xB', userName: 'b', vol: 50000, pnl: 100000 }, // ratio 0.5 ✗
      { rank: '3', proxyWallet: '0xC', userName: 'c', vol: 200000, pnl: 100000 }, // ratio 2.0 ✓
    ];

    const { selected } = selectWallets(entries, 50000, 40000, 5, 1.0);
    expect(selected.map((e) => e.proxyWallet)).toEqual(['0xA', '0xC']);
    expect(selected.map((e) => e.proxyWallet)).not.toContain('0xB');
  });

  it('minVolPnlRatio is skipped when pnl <= 0, avoiding division by zero', async () => {
    const { selectWallets } = await import('../shortlist.js');
    const entries = [
      { rank: '1', proxyWallet: '0xA', userName: 'a', vol: 50000, pnl: 0 },
      { rank: '2', proxyWallet: '0xB', userName: 'b', vol: 50000, pnl: 100 },
    ];

    const { selected } = selectWallets(entries, 0, 0, 5, 1.0);
    expect(selected).toHaveLength(2);
    expect(selected.map((e) => e.proxyWallet)).toContain('0xA');
    expect(selected.map((e) => e.proxyWallet)).toContain('0xB');
  });

  it('updates .env with atomic write and replacement', async () => {
    mockReadFile.mockResolvedValue('FOO=bar\nCOPYTRADE_WALLETS=old\n');

    const { updateEnvWallets } = await import('../shortlist.js');
    await updateEnvWallets([
      '0x0000000000000000000000000000000000000abc',
      '0x0000000000000000000000000000000000000def',
    ]);

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('.env.tmp'),
      expect.stringContaining(
        'COPYTRADE_WALLETS=0x0000000000000000000000000000000000000abc,0x0000000000000000000000000000000000000def',
      ),
      'utf8',
    );
    expect(mockRename).toHaveBeenCalledWith(
      expect.stringContaining('.env.tmp'),
      expect.stringContaining('.env'),
    );
  });

  it('appends COPYTRADE_WALLETS if missing', async () => {
    mockReadFile.mockResolvedValue('FOO=bar\n');

    const { updateEnvWallets } = await import('../shortlist.js');
    await updateEnvWallets(['0x0000000000000000000000000000000000000abc']);

    const writeArgs = mockWriteFile.mock.calls[0] ?? [];
    expect(writeArgs[1]).toContain('COPYTRADE_WALLETS=0x0000000000000000000000000000000000000abc');
  });

  it('skips env mutation when auto-apply is false', async () => {
    mockLoadConfig.mockReturnValue(baseConfig({ COPYTRADE_SHORTLIST_AUTO_APPLY: false }));
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [] } as Response);

    const { run } = await import('../shortlist.js');
    await run();

    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('fetches multiple categories and merges results (quality scoring off)', async () => {
    mockLoadConfig.mockReturnValue(
      baseConfig({
        COPYTRADE_MARKET_SCOPE: ['weather', 'geopolitical'],
        COPYTRADE_SHORTLIST_TOP_N: 1,
        COPYTRADE_SHORTLIST_MIN_PNL_USD: 1000,
        COPYTRADE_SHORTLIST_MIN_VOL_USD: 1000,
      }),
    );

    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { proxyWallet: '0x1111111111111111111111111111111111111111', vol: 5000, pnl: 2000 },
      ],
    } as Response);
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { proxyWallet: '0x2222222222222222222222222222222222222222', vol: 5000, pnl: 2000 },
      ],
    } as Response);

    mockReadFile.mockResolvedValue('COPYTRADE_WALLETS=old\n');

    const { run } = await import('../shortlist.js');
    await run();

    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2); // scoring is mocked, so no activity calls
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(
        'COPYTRADE_WALLETS=0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222',
      ),
      'utf8',
    );
  });

  it('shadow-logs scores to Redis and writeQueue when scoring returns results', async () => {
    mockLoadConfig.mockReturnValue(baseConfig());
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: async () => [
        { proxyWallet: '0x1111111111111111111111111111111111111111', vol: 5000, pnl: 2000 },
      ],
    } as Response);
    mockFetchAndScoreWallet.mockResolvedValueOnce(makeScore(0.7));
    mockReadFile.mockResolvedValue('COPYTRADE_WALLETS=old\n');

    const { run } = await import('../shortlist.js');
    await run();

    expect(mockFetchAndScoreWallet).toHaveBeenCalledWith(
      '0x1111111111111111111111111111111111111111',
      expect.any(Object),
    );
    expect(mockRedis.hset).toHaveBeenCalledWith(
      expect.stringContaining('copytrade:wallet_quality:0x1111'),
      expect.any(Object),
    );
    expect(mockEnqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        kind: 'copytrade_wallet_quality',
        source: 'copytrade',
        wouldBlock: false,
        metricValue: 0.7,
      }),
    );
  });

  it('filters low-scoring wallets when COPYTRADE_QUALITY_SHORTLIST_ENABLED=true', async () => {
    mockLoadConfig.mockReturnValue(
      baseConfig({
        COPYTRADE_QUALITY_SHORTLIST_ENABLED: true,
        COPYTRADE_WALLET_MIN_SCORE: 0.6,
        COPYTRADE_SHORTLIST_TOP_N: 3,
      }),
    );
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: async () => [
        { proxyWallet: '0x1111111111111111111111111111111111111111', vol: 500000, pnl: 100000 },
        { proxyWallet: '0x2222222222222222222222222222222222222222', vol: 500000, pnl: 100000 },
      ],
    } as Response);
    mockFetchAndScoreWallet.mockImplementation(async (wallet: string) => {
      if (wallet === '0x1111111111111111111111111111111111111111') return makeScore(0.8);
      if (wallet === '0x2222222222222222222222222222222222222222') return makeScore(0.3);
      return null;
    });
    mockReadFile.mockResolvedValue('COPYTRADE_WALLETS=old\n');

    const { run } = await import('../shortlist.js');
    await run();

    expect(mockWriteFile).toHaveBeenCalled();
    const writeArgs = mockWriteFile.mock.calls[0] ?? [];
    const envContent = String(writeArgs[1]);
    expect(envContent).toContain('0x1111111111111111111111111111111111111111');
    expect(envContent).not.toContain('0x2222222222222222222222222222222222222222');
  });

  it('enabled=true + scoring outage: retains leaderboard candidates rather than emptying the shortlist', async () => {
    mockLoadConfig.mockReturnValue(
      baseConfig({
        COPYTRADE_QUALITY_SHORTLIST_ENABLED: true,
        COPYTRADE_WALLET_MIN_SCORE: 0.6,
        COPYTRADE_SHORTLIST_TOP_N: 3,
      }),
    );
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: async () => [
        { proxyWallet: '0x1111111111111111111111111111111111111111', vol: 500000, pnl: 100000 },
        { proxyWallet: '0x2222222222222222222222222222222222222222', vol: 500000, pnl: 100000 },
      ],
    } as Response);
    // Scoring fails for every wallet (e.g. Data API outage) → all unscored.
    mockFetchAndScoreWallet.mockResolvedValue(null);
    mockReadFile.mockResolvedValue('COPYTRADE_WALLETS=old\n');

    const { run } = await import('../shortlist.js');
    await run();

    expect(mockWriteFile).toHaveBeenCalled();
    const writeArgs = mockWriteFile.mock.calls[0] ?? [];
    const envContent = String(writeArgs[1]);
    expect(envContent).toContain('0x1111111111111111111111111111111111111111');
    expect(envContent).toContain('0x2222222222222222222222222222222222222222');
  });

  it('enabled=true + mixed: scored-passing ranked ahead of unscored, explicitly-filtered dropped', async () => {
    mockLoadConfig.mockReturnValue(
      baseConfig({
        COPYTRADE_QUALITY_SHORTLIST_ENABLED: true,
        COPYTRADE_WALLET_MIN_SCORE: 0.6,
        COPYTRADE_SHORTLIST_TOP_N: 5,
      }),
    );
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: async () => [
        { proxyWallet: '0x1111111111111111111111111111111111111111', vol: 500000, pnl: 100000 },
        { proxyWallet: '0x2222222222222222222222222222222222222222', vol: 500000, pnl: 100000 },
        { proxyWallet: '0x3333333333333333333333333333333333333333', vol: 500000, pnl: 100000 },
      ],
    } as Response);
    mockFetchAndScoreWallet.mockImplementation(async (wallet: string) => {
      if (wallet === '0x1111111111111111111111111111111111111111') return makeScore(0.9); // pass
      if (wallet === '0x2222222222222222222222222222222222222222') return makeScore(0.3); // filtered
      if (wallet === '0x3333333333333333333333333333333333333333') return null; // unscored
      return null;
    });
    mockReadFile.mockResolvedValue('COPYTRADE_WALLETS=old\n');

    const { run } = await import('../shortlist.js');
    await run();

    const writeArgs = mockWriteFile.mock.calls[0] ?? [];
    const envContent = String(writeArgs[1]);
    // Scored-passing retained; scored-filtered dropped; unscored retained.
    expect(envContent).toContain('0x1111111111111111111111111111111111111111');
    expect(envContent).not.toContain('0x2222222222222222222222222222222222222222');
    expect(envContent).toContain('0x3333333333333333333333333333333333333333');
    // Ordering in the .env line: scored-passing wallet should come before the unscored one.
    const idx1 = envContent.indexOf('0x1111111111111111111111111111111111111111');
    const idx3 = envContent.indexOf('0x3333333333333333333333333333333333333333');
    expect(idx1).toBeGreaterThan(-1);
    expect(idx3).toBeGreaterThan(idx1);
  });

  it('shadow mode (enabled=false) keeps the leaderboard shortlist regardless of scores', async () => {
    mockLoadConfig.mockReturnValue(
      baseConfig({
        COPYTRADE_QUALITY_SHORTLIST_ENABLED: false,
        COPYTRADE_WALLET_MIN_SCORE: 0.6,
        COPYTRADE_SHORTLIST_TOP_N: 3,
      }),
    );
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: async () => [
        { proxyWallet: '0x1111111111111111111111111111111111111111', vol: 500000, pnl: 100000 },
        { proxyWallet: '0x2222222222222222222222222222222222222222', vol: 500000, pnl: 100000 },
      ],
    } as Response);
    mockFetchAndScoreWallet.mockResolvedValue(makeScore(0.2)); // everyone fails
    mockReadFile.mockResolvedValue('COPYTRADE_WALLETS=old\n');

    const { run } = await import('../shortlist.js');
    await run();

    const writeArgs = mockWriteFile.mock.calls[0] ?? [];
    const envContent = String(writeArgs[1]);
    expect(envContent).toContain('0x1111111111111111111111111111111111111111');
    expect(envContent).toContain('0x2222222222222222222222222222222222222222');
  });
});
