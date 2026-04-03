import { vi, describe, it, expect, beforeEach } from 'vitest';
import type * as GammaModule from '../../mapping/gamma.js';

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const mockFetchWithTimeout = vi.fn();
const mockLoadConfig = vi.fn();
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockRename = vi.fn();

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

beforeEach(() => {
  vi.clearAllMocks();
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
    // vol/pnl ratios: wallet A = 1.5, B = 0.5 (below threshold of 1.0), C = 2.0
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
      { rank: '1', proxyWallet: '0xA', userName: 'a', vol: 50000, pnl: 0 }, // pnl=0 → skip ratio check (would div/0)
      { rank: '2', proxyWallet: '0xB', userName: 'b', vol: 50000, pnl: 100 }, // pnl>0, ratio = 500 > 1.0 ✓
    ];

    // Both pass: 0xA bypasses ratio guard (pnl not > 0), 0xB passes ratio check.
    // minPnl=0 and minVol=0 so neither threshold filters them.
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
    mockLoadConfig.mockReturnValue({
      COPYTRADE_ENABLED: true,
      COPYTRADE_MARKET_SCOPE: ['weather'],
      COPYTRADE_SHORTLIST_TIME_WINDOW: 'WEEK',
      COPYTRADE_SHORTLIST_TOP_N: 5,
      COPYTRADE_SHORTLIST_MIN_PNL_USD: 10000,
      COPYTRADE_SHORTLIST_MIN_VOL_USD: 100000,
      COPYTRADE_SHORTLIST_AUTO_APPLY: false,
    });
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => [] } as Response);

    const { run } = await import('../shortlist.js');
    await run();

    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('fetches multiple categories and merges results', async () => {
    mockLoadConfig.mockReturnValue({
      COPYTRADE_ENABLED: true,
      COPYTRADE_MARKET_SCOPE: ['weather', 'geopolitics'],
      COPYTRADE_SHORTLIST_TIME_WINDOW: 'WEEK',
      COPYTRADE_SHORTLIST_TOP_N: 1,
      COPYTRADE_SHORTLIST_MIN_PNL_USD: 1000,
      COPYTRADE_SHORTLIST_MIN_VOL_USD: 1000,
      COPYTRADE_SHORTLIST_AUTO_APPLY: true,
    });

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

    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(
        'COPYTRADE_WALLETS=0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222',
      ),
      'utf8',
    );
  });
});
