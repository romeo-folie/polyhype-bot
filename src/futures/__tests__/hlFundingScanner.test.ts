import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scanHlFunding, fundingCooldownKey } from '../hlFundingScanner.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../db/writeQueue.js', () => ({ enqueueWrite: vi.fn().mockResolvedValue(undefined) }));

const baseConfig = {
  HL_FUNDING_SCANNER_ENABLED: false,
  HL_FUNDING_SCANNER_POLL_INTERVAL_SEC: 300,
  HL_FUNDING_SCANNER_BULK_CTX_TTL_SEC: 120,
  HL_FUNDING_SCANNER_ENTRY_APR_THRESHOLD: 100,
  HL_FUNDING_SCANNER_EXIT_APR_THRESHOLD: 20,
  HL_FUNDING_SCANNER_STAKE_USD: 15,
  HL_FUNDING_SCANNER_STOP_LOSS_PCT: 15,
  HL_FUNDING_SCANNER_TAKE_PROFIT_PCT: 20,
  HL_FUNDING_SCANNER_MAX_HOLD_HOURS: 48,
  HL_FUNDING_SCANNER_COOLDOWN_SEC: 3600,
  HL_FUNDING_SCANNER_MIN_SKIP_COOLDOWN_SEC: 60,
  HL_FUNDING_SCANNER_SYMBOL_DENYLIST: '',
  FUTURES_MAX_PER_TRADE_USD: 15,
  // Log ALL decisions in tests; sampling is covered explicitly below.
  HL_DECISION_LOG_SAMPLE_RATE: 1,
};

const mockLoadConfig = vi.fn(() => ({ ...baseConfig }));
vi.mock('../../shared/config.js', () => ({ loadConfig: () => mockLoadConfig() }));

const mockGetAllCachedAssetCtxs = vi.fn();
const mockHasOpenPosition = vi.fn().mockResolvedValue(false);

vi.mock('../hlAssetCtxCache.js', async () => {
  const actual = await vi.importActual('../hlAssetCtxCache.js');
  return {
    ...(actual as Record<string, unknown>),
    getAllCachedAssetCtxs: (...args: unknown[]) => mockGetAllCachedAssetCtxs(...args),
  };
});

vi.mock('../../execution/positionLedger.js', () => ({
  hasOpenPosition: (...args: unknown[]) => mockHasOpenPosition(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRedis(overrides: Record<string, string | null> = {}): {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, string | null>(Object.entries(overrides));
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  };
}

/** hourlyRate that gives the specified APR% via fundingRateToApr */
function aprToHourly(aprPct: number): number {
  return aprPct / (24 * 365 * 100);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockImplementation(() => ({ ...baseConfig }));
  mockHasOpenPosition.mockResolvedValue(false);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scanHlFunding', () => {
  it('returns SHORT signal when APR > +100% and scanner enabled', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, HL_FUNDING_SCANNER_ENABLED: true });
    mockGetAllCachedAssetCtxs.mockResolvedValue({
      BTC: { fundingRate: aprToHourly(150), markPrice: 70000, openInterest: 1000 },
    });
    const redis = makeRedis();
    const signals = await scanHlFunding(redis as never);
    expect(signals).toHaveLength(1);
    expect(signals[0].direction).toBe('SHORT');
    expect(signals[0].marketId).toBe('BTC');
    expect(signals[0].source).toBe('hl-funding');
    expect(signals[0].entryFundingApr).toBeCloseTo(150, 0);
    expect(signals[0].isFutures).toBe(true);
  });

  it('returns LONG signal when APR < -100% and scanner enabled', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, HL_FUNDING_SCANNER_ENABLED: true });
    mockGetAllCachedAssetCtxs.mockResolvedValue({
      ETH: { fundingRate: aprToHourly(-120), markPrice: 3500, openInterest: 500 },
    });
    const redis = makeRedis();
    const signals = await scanHlFunding(redis as never);
    expect(signals).toHaveLength(1);
    expect(signals[0].direction).toBe('LONG');
    expect(signals[0].marketId).toBe('ETH');
    expect(signals[0].entryFundingApr).toBeCloseTo(-120, 0);
  });

  it('returns no signal when |APR| <= threshold (scanner dark)', async () => {
    mockGetAllCachedAssetCtxs.mockResolvedValue({
      BTC: { fundingRate: aprToHourly(50), markPrice: 70000, openInterest: 1000 },
    });
    const redis = makeRedis();
    const signals = await scanHlFunding(redis as never);
    expect(signals).toHaveLength(0);
  });

  it('throttle: persists the apr_below_threshold skip when HL_DECISION_LOG_SAMPLE_RATE=1', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_FUNDING_SCANNER_ENABLED: true,
      HL_DECISION_LOG_SAMPLE_RATE: 1,
    });
    mockGetAllCachedAssetCtxs.mockResolvedValue({
      BTC: { fundingRate: aprToHourly(50), markPrice: 70000, openInterest: 1000 }, // APR 50 < 100 → apr_below_threshold
    });
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    const redis = makeRedis();
    await scanHlFunding(redis as never);
    expect(enqueueWrite).toHaveBeenCalledWith(
      'signal_decisions',
      expect.objectContaining({ skipReason: 'apr_below_threshold' }),
    );
  });

  it('throttle: drops the apr_below_threshold skip when HL_DECISION_LOG_SAMPLE_RATE=0', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_FUNDING_SCANNER_ENABLED: true,
      HL_DECISION_LOG_SAMPLE_RATE: 0,
    });
    mockGetAllCachedAssetCtxs.mockResolvedValue({
      BTC: { fundingRate: aprToHourly(50), markPrice: 70000, openInterest: 1000 },
    });
    const { enqueueWrite } = await import('../../db/writeQueue.js');
    const redis = makeRedis();
    const signals = await scanHlFunding(redis as never);
    expect(signals).toHaveLength(0); // still skipped — only the LOG is suppressed
    expect(enqueueWrite).not.toHaveBeenCalledWith('signal_decisions', expect.anything());
  });

  it('returns no signal when enabled=false even if APR > threshold (scanner_dark gate)', async () => {
    mockGetAllCachedAssetCtxs.mockResolvedValue({
      BTC: { fundingRate: aprToHourly(200), markPrice: 70000, openInterest: 1000 },
    });
    const redis = makeRedis();
    const signals = await scanHlFunding(redis as never);
    expect(signals).toHaveLength(0);
  });

  it('skips symbol on same-side position open (any source)', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, HL_FUNDING_SCANNER_ENABLED: true });
    mockGetAllCachedAssetCtxs.mockResolvedValue({
      BTC: { fundingRate: aprToHourly(150), markPrice: 70000, openInterest: 1000 },
    });
    // APR > 0 → direction = SHORT; existing SHORT from hl-momentum
    mockHasOpenPosition.mockImplementation((_redis: unknown, _sym: string, dir: string) =>
      Promise.resolve(dir === 'SHORT'),
    );
    const redis = makeRedis();
    const signals = await scanHlFunding(redis as never);
    expect(signals).toHaveLength(0);
  });

  it('skips symbol when opposite-side position exists (executor blocks both sides to avoid fee-burn)', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, HL_FUNDING_SCANNER_ENABLED: true });
    mockGetAllCachedAssetCtxs.mockResolvedValue({
      BTC: { fundingRate: aprToHourly(150), markPrice: 70000, openInterest: 1000 },
    });
    // hl-momentum holds LONG; hl-funding wants SHORT — executor blocks opposite-side stacking
    mockHasOpenPosition.mockImplementation((_redis: unknown, _sym: string, dir: string) =>
      Promise.resolve(dir === 'LONG'),
    );
    const redis = makeRedis();
    const signals = await scanHlFunding(redis as never);
    expect(signals).toHaveLength(0);
  });

  it('skips symbol when denylist contains it', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_FUNDING_SCANNER_ENABLED: true,
      HL_FUNDING_SCANNER_SYMBOL_DENYLIST: 'BTC,ETH',
    });
    mockGetAllCachedAssetCtxs.mockResolvedValue({
      BTC: { fundingRate: aprToHourly(200), markPrice: 70000, openInterest: 1000 },
    });
    const redis = makeRedis();
    const signals = await scanHlFunding(redis as never);
    expect(signals).toHaveLength(0);
  });

  it('skips symbol when loss cooldown is active', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, HL_FUNDING_SCANNER_ENABLED: true });
    mockGetAllCachedAssetCtxs.mockResolvedValue({
      BTC: { fundingRate: aprToHourly(200), markPrice: 70000, openInterest: 1000 },
    });
    const redis = makeRedis({ 'futures:loss-cooldown:BTC': '1' });
    const signals = await scanHlFunding(redis as never);
    expect(signals).toHaveLength(0);
  });

  it('skips symbol when per-side funding cooldown is active', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, HL_FUNDING_SCANNER_ENABLED: true });
    mockGetAllCachedAssetCtxs.mockResolvedValue({
      BTC: { fundingRate: aprToHourly(200), markPrice: 70000, openInterest: 1000 },
    });
    // APR > 0 → direction = SHORT → cooldown key for SHORT
    const redis = makeRedis({ [fundingCooldownKey('BTC', 'SHORT')]: '1' });
    const signals = await scanHlFunding(redis as never);
    expect(signals).toHaveLength(0);
  });

  it('returns no signals and does not throw when bulk cache returns empty', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, HL_FUNDING_SCANNER_ENABLED: true });
    mockGetAllCachedAssetCtxs.mockResolvedValue({});
    const redis = makeRedis();
    const signals = await scanHlFunding(redis as never);
    expect(signals).toHaveLength(0);
  });

  it('caps stake to FUTURES_MAX_PER_TRADE_USD when STAKE_USD exceeds it', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      HL_FUNDING_SCANNER_ENABLED: true,
      HL_FUNDING_SCANNER_STAKE_USD: 50,
      FUTURES_MAX_PER_TRADE_USD: 15,
    });
    mockGetAllCachedAssetCtxs.mockResolvedValue({
      BTC: { fundingRate: aprToHourly(200), markPrice: 70000, openInterest: 1000 },
    });
    const redis = makeRedis();
    const signals = await scanHlFunding(redis as never);
    expect(signals[0].stakeUsd).toBe(15);
  });
});
