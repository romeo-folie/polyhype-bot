import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const mockFetchWithTimeout = jest.fn() as any;
const mockLoadConfig = jest.fn() as any;

const mockReadFile = jest.fn() as any;
const mockWriteFile = jest.fn() as any;
const mockRename = jest.fn() as any;

jest.unstable_mockModule('../../shared/logger.js', () => ({ logger: mockLogger }));
jest.unstable_mockModule('../../mapping/gamma.js', async () => {
  const actual = await import('../../mapping/gamma.js');
  return { ...actual, fetchWithTimeout: mockFetchWithTimeout };
});
jest.unstable_mockModule('../../shared/config.js', () => ({ loadConfig: mockLoadConfig }));
jest.unstable_mockModule('fs/promises', () => ({
  default: { readFile: mockReadFile, writeFile: mockWriteFile, rename: mockRename },
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  rename: mockRename,
}));

beforeEach(() => {
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
  mockFetchWithTimeout.mockReset();
  mockLoadConfig.mockReset();
  mockReadFile.mockReset();
  mockWriteFile.mockReset();
  mockRename.mockReset();
});

describe('copytrade shortlist', () => {
  it('fetches leaderboard and parses entries', async () => {
    const payload = [
      { rank: '1', proxyWallet: '0x0000000000000000000000000000000000000abc', userName: 'foo', vol: 200000, pnl: 50000 },
    ];
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: async () => payload } as Response);

    const { fetchLeaderboard } = await import('../shortlist.js');
    const result = await fetchLeaderboard('WEATHER', 'WEEK', 10);

    expect(result).toEqual(payload);
  });

  it('selects by threshold and backfills to top N', async () => {
    const entries = [
      { rank: '1', proxyWallet: '0x0000000000000000000000000000000000000001', userName: 'a', vol: 150000, pnl: 20000 },
      { rank: '2', proxyWallet: '0x0000000000000000000000000000000000000002', userName: 'b', vol: 90000, pnl: 5000 },
      { rank: '3', proxyWallet: '0x0000000000000000000000000000000000000003', userName: 'c', vol: 200000, pnl: 15000 },
    ];

    const { selectWallets } = await import('../shortlist.js');
    const { selected, backfilled } = selectWallets(entries, 10000, 100000, 2);

    expect(selected.map(e => e.proxyWallet)).toEqual([
      '0x0000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000003',
    ]);
    expect(backfilled).toHaveLength(0);

    const { selected: selected2, backfilled: backfilled2 } = selectWallets(entries, 10000, 250000, 2);
    expect(selected2).toHaveLength(0);
    expect(backfilled2.map(e => e.proxyWallet)).toEqual([
      '0x0000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000002',
    ]);
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
      expect.stringContaining('COPYTRADE_WALLETS=0x0000000000000000000000000000000000000abc,0x0000000000000000000000000000000000000def'),
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
      COPYTRADE_MARKET_SCOPE: 'weather',
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
});
