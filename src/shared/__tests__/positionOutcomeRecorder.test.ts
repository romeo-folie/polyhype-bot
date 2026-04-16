import { describe, it, expect, vi } from 'vitest';

vi.mock('../outcomeRecorder.js', () => ({
  recordOutcome: vi.fn().mockResolvedValue(undefined),
  inferCategory: vi.fn().mockReturnValue('geopolitical'),
  inferSource: vi.fn().mockReturnValue('osint'),
}));

const { recordOutcome } = await import('../outcomeRecorder.js');
const { recordPositionOutcome } = await import('../positionOutcomeRecorder.js');

describe('recordPositionOutcome', () => {
  it('maps execution attribution fields into the persisted outcome', async () => {
    const redis = {} as any;

    await recordPositionOutcome(
      redis,
      {
        executionId: 'exec-123',
        sourcedFrom: 'headline',
        question: 'Will X happen?',
        direction: 'YES',
        consensusProbability: 0.7,
        edgeMagnitude: 0.12,
        openedAt: '2026-04-02T12:00:00Z',
        executionVenue: 'clob',
        modeConfigured: 'hybrid',
        entryExecutionPath: 'maker_fill',
        entryOrderType: 'maker',
        fallbackReason: 'simmer_market_missing',
        decisionSpreadBps: 42,
        makerPriceImprovementBps: 18,
        makerPriceImprovementUsd: 0.33,
      },
      {
        result: 'won',
        returnPct: 15,
      },
    );

    expect(recordOutcome).toHaveBeenCalledWith(
      redis,
      expect.objectContaining({
        executionId: 'exec-123',
        executionVenue: 'clob',
        modeConfigured: 'hybrid',
        entryExecutionPath: 'maker_fill',
        entryOrderType: 'maker',
        fallbackReason: 'simmer_market_missing',
        decisionSpreadBps: 42,
        makerPriceImprovementBps: 18,
        makerPriceImprovementUsd: 0.33,
        result: 'won',
        returnPct: 15,
      }),
      { sourcedFrom: 'headline' },
    );
  });

  it('forwards copytrade sourcedFrom to the outcome recorder', async () => {
    const redis = {} as any;

    await recordPositionOutcome(
      redis,
      {
        executionId: 'exec-456',
        sourcedFrom: 'copytrade:0xabc',
        question: 'Whale mirror',
        direction: 'YES',
        consensusProbability: 0.6,
        edgeMagnitude: 0.05,
        openedAt: '2026-04-14T12:00:00Z',
        executionVenue: 'clob',
      },
      { result: 'lost', returnPct: -12 },
    );

    expect(recordOutcome).toHaveBeenLastCalledWith(
      redis,
      expect.any(Object),
      { sourcedFrom: 'copytrade:0xabc' },
    );
  });

  it('passes exitReason through to the outcome recorder (futures close path)', async () => {
    const redis = {} as any;

    await recordPositionOutcome(
      redis,
      {
        executionId: 'exec-hl-1',
        sourcedFrom: 'Spot: bittensor +0.8% in 10min',
        question: 'Futures TAO',
        direction: 'SHORT',
        consensusProbability: 0.5,
        edgeMagnitude: 0.08,
        openedAt: '2026-04-10T03:12:18Z',
        executionVenue: 'hyperliquid',
        marketId: 'TAO',
        entryPrice: 289.73,
        stakeUsd: 15.15,
      },
      {
        result: 'won',
        returnPct: 9.16,
        executionVenueOverride: 'hyperliquid',
        exitReason: 'Take-Profit triggered (6.00%)',
      },
    );

    expect(recordOutcome).toHaveBeenLastCalledWith(
      redis,
      expect.objectContaining({
        exitReason: 'Take-Profit triggered (6.00%)',
        executionVenue: 'hyperliquid',
        executionId: 'exec-hl-1',
      }),
      { sourcedFrom: 'Spot: bittensor +0.8% in 10min' },
    );
  });

  it('accepts result=pushed (rare zero-PnL futures close)', async () => {
    const redis = {} as any;

    // Zero-PnL case — result='pushed'. Should not throw and should flow
    // through to recordOutcome. UP/DOWN streak recorder is skipped (tested
    // implicitly — we'd hit a mock failure if it tried to load config).
    await expect(
      recordPositionOutcome(
        redis,
        {
          executionId: 'exec-push',
          sourcedFrom: 'futures-monitor',
          question: 'Futures BTC',
          direction: 'LONG',
          consensusProbability: 0.5,
          edgeMagnitude: 0.03,
          openedAt: '2026-04-16T00:00:00Z',
          executionVenue: 'hyperliquid',
        },
        {
          result: 'pushed',
          returnPct: 0,
          executionVenueOverride: 'hyperliquid',
          exitReason: 'flat_exit',
        },
      ),
    ).resolves.toBeUndefined();

    expect(recordOutcome).toHaveBeenLastCalledWith(
      redis,
      expect.objectContaining({ result: 'pushed', exitReason: 'flat_exit' }),
      expect.any(Object),
    );
  });
});
