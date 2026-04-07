import { describe, it, expect, vi } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const cfgMock = {
  COPYTRADE_SHORTLIST_SOURCE: 'leaderboard',
  COPYTRADE_SHORTLIST_MIN_PNL_USD: 0,
  COPYTRADE_SHORTLIST_MIN_VOL_USD: 0,
  COPYTRADE_SHORTLIST_TOP_N: 5,
  COPYTRADE_SHORTLIST_MIN_VOL_PNL_RATIO: 0,
  COPYTRADE_SHORTLIST_AUTO_APPLY: false,
};
vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => cfgMock),
}));

const updateEnvWalletsMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../shortlist.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    updateEnvWallets: (...args: unknown[]) => updateEnvWalletsMock(...args),
  };
});

const { aggregateTapeRows, rowsToLeaderboardEntries, run } = await import(
  '../tapeBasedShortlist.js'
);

describe('aggregateTapeRows', () => {
  it('aggregates notional per wallet', () => {
    const tapes = new Map<string, { price?: number; size?: number; side?: 'BUY' | 'SELL'; taker?: string }[]>();
    tapes.set('m1', [
      { price: 0.5, size: 100, side: 'BUY', taker: '0xa' },
      { price: 0.5, size: 200, side: 'BUY', taker: '0xb' },
      { price: 0.5, size: 50, side: 'SELL', taker: '0xa' },
    ]);
    const rows = aggregateTapeRows(tapes, new Set(), new Map());
    const a = rows.find((r) => r.proxyWallet === '0xa');
    const b = rows.find((r) => r.proxyWallet === '0xb');
    expect(a?.notional).toBe(0.5 * 100 + 0.5 * 50);
    expect(b?.notional).toBe(0.5 * 200);
  });

  it('computes realised PnL only for resolved markets', () => {
    const tapes = new Map<string, { price?: number; size?: number; side?: 'BUY' | 'SELL'; taker?: string }[]>();
    tapes.set('mResolved', [{ price: 0.4, size: 100, side: 'BUY', taker: '0xa' }]);
    tapes.set('mOpen', [{ price: 0.4, size: 100, side: 'BUY', taker: '0xa' }]);
    const rows = aggregateTapeRows(
      tapes,
      new Set(['mResolved']),
      new Map([['mResolved', 1.0]]),
    );
    const a = rows.find((r) => r.proxyWallet === '0xa');
    expect(a?.realizedPnl).toBeCloseTo((1.0 - 0.4) * 100);
    expect(a?.resolvedTrades).toBe(1);
  });
});

describe('rowsToLeaderboardEntries', () => {
  it('produces LeaderboardEntry shape sorted by PnL', () => {
    const rows = [
      { proxyWallet: '0xa', notional: 100, realizedPnl: 10, resolvedTrades: 1 },
      { proxyWallet: '0xb', notional: 200, realizedPnl: 50, resolvedTrades: 2 },
    ];
    const entries = rowsToLeaderboardEntries(rows);
    expect(entries[0]?.proxyWallet).toBe('0xb');
    expect(entries[0]?.pnl).toBe(50);
    expect(entries[0]?.vol).toBe(200);
  });
});

describe('run', () => {
  it('does nothing when COPYTRADE_SHORTLIST_SOURCE != tape', async () => {
    cfgMock.COPYTRADE_SHORTLIST_SOURCE = 'leaderboard';
    await run();
    expect(updateEnvWalletsMock).not.toHaveBeenCalled();
  });
});
