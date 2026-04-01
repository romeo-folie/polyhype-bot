/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Integration tests for runArbScan orchestrator.
 * Tests config gates, scan error handling, and MAX_ARB_PER_RUN cap enforcement.
 *
 * Strategy: mock external dependencies (Gamma, CLOB, bankroll, config) rather
 * than the internal scanForArb/executeArb functions (same-module mocking doesn't
 * work with jest.unstable_mockModule).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockLoadConfig = vi.fn<(...args: any[]) => any>();
vi.mock('../../shared/config.js', () => ({ loadConfig: mockLoadConfig }));
vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockGetBankroll = vi.fn<(...args: any[]) => any>();
const mockDeductStake = vi.fn<(...args: any[]) => any>();
vi.mock('../../shared/bankroll.js', () => ({
  getBankroll: mockGetBankroll,
  deductStake: mockDeductStake,
}));

const mockSubmitClobBuy = vi.fn<(...args: any[]) => any>();
vi.mock('../../shared/clob.js', () => ({ submitClobBuy: mockSubmitClobBuy }));

vi.mock('../../execution/telegram.js', () => ({
  notifyUnhedgedArbPosition: vi.fn<() => Promise<void>>().mockResolvedValue(),
}));

// Mock Gamma: return a controlled list of markets
const mockGetActiveMarkets = vi.fn<(...args: any[]) => any>();
const { parseOutcomePrices: realParseOutcomePrices, parseClobTokenIds: realParseClobTokenIds } =
  await import('../../mapping/gamma.js');
vi.mock('../../mapping/gamma.js', () => ({
  getActiveMarkets: mockGetActiveMarkets,
  parseOutcomePrices: realParseOutcomePrices,
  parseClobTokenIds: realParseClobTokenIds,
}));

const { runArbScan } = await import('../scanner.js');

// ── Config ────────────────────────────────────────────────────────────────────

const baseConfig = {
  ARB_ENABLED: true,
  CLOB_FALLBACK_ENABLED: true,
  ARB_MIN_EDGE: 0.05,
  ARB_MAX_STAKE_FRACTION: 0.05,
  ARB_FEE_RATE: 0.02,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMarket(id: string, yesAsk = '0.40', noAsk = '0.50') {
  return {
    id,
    question: `Will ${id} happen?`,
    conditionId: `cond-${id}`,
    clobTokenIds: `["yes-${id}","no-${id}"]`,
    outcomePrices: `["${yesAsk}","${noAsk}"]`,
    outcomes: ['Yes', 'No'],
    active: true,
    closed: false,
    volume: '10000',
    liquidity: '5000',
    endDate: null,
    description: null,
  };
}

function makeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => { store.delete(key); return 1; }),
    _store: store,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runArbScan', () => {
  let redis: ReturnType<typeof makeRedis>;

  beforeEach(() => {
    redis = makeRedis();
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(baseConfig);
    mockGetBankroll.mockResolvedValue(100);
    mockDeductStake.mockResolvedValue(90);
    // Default: CLOB accepts orders
    mockSubmitClobBuy.mockResolvedValue({ success: true, tx_hash: '0xabc' });
  });

  it('skips scan when ARB_ENABLED=false', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, ARB_ENABLED: false });
    await runArbScan(redis as any);
    expect(mockGetActiveMarkets).not.toHaveBeenCalled();
  });

  it('skips scan when CLOB_FALLBACK_ENABLED=false', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, CLOB_FALLBACK_ENABLED: false });
    await runArbScan(redis as any);
    expect(mockGetActiveMarkets).not.toHaveBeenCalled();
  });

  it('completes without executing when no markets have sufficient edge', async () => {
    // yesAsk=0.48, noAsk=0.49 → gross=0.03, net ≈ -0.01 < 0.05 threshold
    mockGetActiveMarkets.mockResolvedValue([makeMarket('mkt-1', '0.48', '0.49')]);
    await runArbScan(redis as any);
    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
  });

  it('handles Gamma scan error gracefully — does not throw', async () => {
    mockGetActiveMarkets.mockRejectedValue(new Error('Gamma API 503'));
    await expect(runArbScan(redis as any)).resolves.toBeUndefined();
    expect(mockSubmitClobBuy).not.toHaveBeenCalled();
  });

  it('caps execution at MAX_ARB_PER_RUN=2 even when many opportunities exist', async () => {
    // 5 markets all with good edge (gross=0.10, net≈0.08)
    mockGetActiveMarkets.mockResolvedValue([
      makeMarket('mkt-1'), makeMarket('mkt-2'), makeMarket('mkt-3'),
      makeMarket('mkt-4'), makeMarket('mkt-5'),
    ]);

    await runArbScan(redis as any);

    // 2 markets × 2 legs = 4 CLOB order submissions
    expect(mockSubmitClobBuy).toHaveBeenCalledTimes(4);
  });

  it('executes all opportunities when count < MAX_ARB_PER_RUN', async () => {
    mockGetActiveMarkets.mockResolvedValue([makeMarket('mkt-1')]);
    await runArbScan(redis as any);
    // 1 market × 2 legs = 2 CLOB order submissions
    expect(mockSubmitClobBuy).toHaveBeenCalledTimes(2);
  });
});
