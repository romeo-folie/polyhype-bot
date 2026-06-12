import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { z } from 'zod';
import type * as configModule from '../../shared/config.js';
import { runSpotMonitor } from '../index.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../db/writeQueue.js', () => ({ enqueueWrite: vi.fn().mockResolvedValue(undefined) }));

// Test config foundation from the REAL Zod schema defaults (see
// hlMomentumScanner.test.ts for rationale — mocks can never drift from config.ts).
const { envSchema } = await vi.importActual<typeof configModule>('../../shared/config.js');
function schemaDefaults(schema: z.AnyZodObject): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const parsed = field.safeParse(undefined);
    if (parsed.success && parsed.data !== undefined) defaults[key] = parsed.data;
  }
  return defaults;
}

const baseConfig = {
  ...schemaDefaults(envSchema),
  SPOT_MONITOR_ENABLED: true,
  FUTURES_ENABLED: true,
  // Keep the futures leg deterministic: no confluence/vol-sizing dependencies.
  FUTURES_CONFLUENCE_GATE_ENABLED: false,
  FUTURES_VOL_SIZING_ENABLED: false,
  FUTURES_MIN_SPOT_MOVE_PCT: 0.3,
  FUTURES_MAX_PER_TRADE_USD: 10,
  MAX_BET_FRACTION: 0.05,
};

const mockLoadConfig = vi.fn(() => ({ ...baseConfig }));
vi.mock('../../shared/config.js', () => ({ loadConfig: () => mockLoadConfig() }));

const mockRedis = { exists: vi.fn().mockResolvedValue(0) };
vi.mock('../../shared/redis.js', () => ({
  getRedis: () => mockRedis,
  closeRedis: vi.fn(),
  acquireLock: vi.fn().mockResolvedValue('token'),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../shared/bankroll.js', () => ({ getBankroll: vi.fn().mockResolvedValue(100) }));
vi.mock('../../shared/feedSingleton.js', () => ({
  getPriceFeed: () => ({ watch: vi.fn() }),
  destroyPriceFeed: vi.fn(),
}));
vi.mock('../../shared/priceCache.js', () => ({ resolveYesPrice: vi.fn().mockResolvedValue(null) }));
vi.mock('../poller.js', () => ({ pollSpotPrices: vi.fn().mockResolvedValue([{ assetId: 'bitcoin', price: 70_000 }]) }));

const mockDetectMoves = vi.fn();
vi.mock('../thresholdDetector.js', () => ({ detectMoves: (...args: unknown[]) => mockDetectMoves(...args) }));

const mockFindCorrelatedMarkets = vi.fn();
vi.mock('../marketCorrelator.js', () => ({
  findCorrelatedMarkets: (...args: unknown[]) => mockFindCorrelatedMarkets(...args),
}));

const mockEstimateFastConsensus = vi.fn();
vi.mock('../fastPathConsensus.js', () => ({
  estimateFastConsensus: (...args: unknown[]) => mockEstimateFastConsensus(...args),
}));

const mockComputeDivergence = vi.fn();
vi.mock('../../mapping/divergenceCalculator.js', () => ({
  computeDivergence: (...args: unknown[]) => mockComputeDivergence(...args),
}));

const mockExecuteSignals = vi.fn().mockResolvedValue([]);
vi.mock('../../execution/executor.js', () => ({
  executeSignals: (...args: unknown[]) => mockExecuteSignals(...args),
}));

vi.mock('../../execution/positionLedger.js', () => ({ hasOpenPosition: vi.fn().mockResolvedValue(false) }));
vi.mock('../../execution/telegram.js', () => ({ notifyTradeError: vi.fn() }));
vi.mock('../../arb/confluenceScorer.js', () => ({ scoreConfluence: vi.fn() }));
vi.mock('../../arb/indicators.js', () => ({ computeATR: vi.fn().mockResolvedValue(null) }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMove(changePercent = 2.0) {
  return {
    assetId: 'bitcoin',
    changePercent,
    currentPrice: 70_000,
    windowMinutes: 5,
    eventTs: Date.now(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue({ ...baseConfig });
  mockExecuteSignals.mockResolvedValue([]);
  mockRedis.exists.mockResolvedValue(0);
  mockFindCorrelatedMarkets.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// SPOT_FUTURES_ENABLED gate
// ---------------------------------------------------------------------------

describe('runSpotMonitor — SPOT_FUTURES_ENABLED gate', () => {
  it('executes the perp signal when SPOT_FUTURES_ENABLED=true (default)', async () => {
    mockDetectMoves.mockResolvedValue([makeMove()]);
    await runSpotMonitor();
    expect(mockExecuteSignals).toHaveBeenCalledTimes(1);
    const signals = mockExecuteSignals.mock.calls[0]![0] as Record<string, unknown>[];
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      marketId: 'BTC',
      direction: 'LONG',
      isFutures: true,
      source: 'spot',
    });
  });

  it('shadow-logs instead of executing when SPOT_FUTURES_ENABLED=false', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, SPOT_FUTURES_ENABLED: false });
    mockDetectMoves.mockResolvedValue([makeMove()]);
    const { enqueueWrite } = await import('../../db/writeQueue.js');

    await runSpotMonitor();

    expect(mockExecuteSignals).not.toHaveBeenCalled();
    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        kind: 'spot_futures_signal',
        source: 'spot',
        symbol: 'BTC',
        direction: 'LONG',
        wouldBlock: true,
        metricValue: 2.0,
        payload: expect.objectContaining({ movePct: 2.0, windowMinutes: 5 }),
      }),
    );
  });

  it('still emits correlated PM-market signals when SPOT_FUTURES_ENABLED=false', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, SPOT_FUTURES_ENABLED: false });
    mockDetectMoves.mockResolvedValue([makeMove()]);
    mockFindCorrelatedMarkets.mockResolvedValue([
      {
        marketId: '0xmarket1',
        conditionId: '0xcond1',
        clobTokenIds: ['0xyes', '0xno'],
        question: 'Will BTC be above $80k?',
        currentYesPrice: 0.5,
        correlationDirection: 'positive',
      },
    ]);
    mockEstimateFastConsensus.mockResolvedValue({ probability: 0.8, stddev: 0, reasoning: 'test' });
    mockComputeDivergence.mockReturnValue({
      hasTrade: true,
      decision: {
        direction: 'YES',
        stakeUsd: 5,
        edgeMagnitude: 0.3,
        consensusProbability: 0.8,
        outcomePrice: 0.5,
        halfKellyFraction: 0.1,
        priceZone: 3,
      },
    });

    await runSpotMonitor();

    // The perp leg is shadowed, but the correlated PM-market signal still executes.
    expect(mockExecuteSignals).toHaveBeenCalledTimes(1);
    const signals = mockExecuteSignals.mock.calls[0]![0] as Record<string, unknown>[];
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      marketId: '0xmarket1',
      direction: 'YES',
      source: 'spot',
    });
    expect(signals[0]!.isFutures).toBeUndefined();
  });

  it('shadow row carries the evaluated stake and SHORT direction for a down move', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, SPOT_FUTURES_ENABLED: false });
    mockDetectMoves.mockResolvedValue([makeMove(-1.8)]);
    const { enqueueWrite } = await import('../../db/writeQueue.js');

    await runSpotMonitor();

    expect(enqueueWrite).toHaveBeenCalledWith(
      'shadow_observations',
      expect.objectContaining({
        kind: 'spot_futures_signal',
        direction: 'SHORT',
        payload: expect.objectContaining({ stakeUsd: expect.any(Number) }),
      }),
    );
  });
});
