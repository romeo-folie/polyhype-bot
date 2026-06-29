import { describe, it, expect, vi } from 'vitest';

vi.mock('../outcomeRecorder.js', () => ({
  recordOutcome: vi.fn().mockResolvedValue(undefined),
  inferCategory: vi.fn().mockReturnValue('geopolitical'),
  inferSource: vi.fn().mockReturnValue('osint'),
}));

vi.mock('../../db/writeQueue.js', () => ({
  enqueueWrite: vi.fn().mockResolvedValue(undefined),
}));

const { recordOutcome } = await import('../outcomeRecorder.js');
const { enqueueWrite } = await import('../../db/writeQueue.js');
const { recordPositionOutcome, recordRedemptionOutcome } = await import(
  '../positionOutcomeRecorder.js'
);

describe('recordPositionOutcome', () => {
  it('maps execution attribution fields into the persisted outcome', async () => {
    const redis = {} as any;

    await recordPositionOutcome(
      redis,
      {
        executionId: 'exec-123',
        decisionId: '11111111-1111-4111-8111-111111111111',
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
        decisionId: '11111111-1111-4111-8111-111111111111',
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
    expect(enqueueWrite).toHaveBeenLastCalledWith(
      'outcomes',
      expect.objectContaining({
        executionId: 'exec-123',
        decisionId: '11111111-1111-4111-8111-111111111111',
      }),
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

describe('recordRedemptionOutcome', () => {
  it('merges ledger position + overrides for the resolution-redeemer path', async () => {
    const redis = {} as any;

    await recordRedemptionOutcome(
      redis,
      {
        executionId: 'exec-redeem-1',
        decisionId: '22222222-2222-4222-8222-222222222222',
        sourcedFrom: 'Breaking headline',
        question: 'ledger-original-question',
        direction: 'YES',
        consensusProbability: 0.72,
        edgeMagnitude: 0.14,
        openedAt: '2026-04-05T12:00:00Z',
        executionVenue: 'clob',
        marketId: 'mkt-123',
        entryPrice: 0.55,
        stakeUsd: 20,
      } as any,
      null,
      {
        marketId: 'mkt-123',
        direction: 'YES',
        // Caller wants to override question with resolved Gamma question
        question: 'Resolved: Will X happen? (full title)',
        result: 'won',
        returnPct: 80,
        executionVenue: 'clob',
        exitReason: 'clob_on_chain_redeemed',
      },
    );

    // Helper should land a DB-writing call with the merged position, overridden
    // question, and exitReason — so execution_events↔outcomes can join.
    expect(recordOutcome).toHaveBeenLastCalledWith(
      redis,
      expect.objectContaining({
        executionId: 'exec-redeem-1',
        decisionId: '22222222-2222-4222-8222-222222222222',
        exitReason: 'clob_on_chain_redeemed',
        result: 'won',
        returnPct: 80,
      }),
      { sourcedFrom: 'Breaking headline' },
    );
  });

  it('falls back to raw API response when ledger position is missing (Simmer recovery)', async () => {
    const redis = {} as any;

    // reconciliation.ts case: no ledger row, Simmer closedPos snake-case fields.
    // value_usdc is the PROCEEDS (what Simmer paid out), not the stake. The
    // stake comes from shares × average_price.
    await recordRedemptionOutcome(
      redis,
      null,
      {
        market_id: 'mkt-sim-1',
        side: 'yes',
        shares: 10,
        value_usdc: 8,
        average_price: 0.5,
        question: 'Resolved question',
        condition_id: 'cond-xyz',
      },
      {
        marketId: 'mkt-sim-1',
        direction: 'YES',
        question: 'Resolved question',
        result: 'won',
        returnPct: 60,
        executionVenue: 'simmer',
        exitReason: 'recovered_auto_redeemed',
        sourcedFromOverride: 'reconciled:simmer',
      },
    );

    // Snake-case raw mapping must land the derived attribution on the
    // Postgres write path — without it, DB rows would carry stake=0 /
    // entry=0 / no conditionId and the execution-events join would be
    // meaningless. Assert via the enqueueWrite mock (DB-writing side) since
    // recordOutcome (Redis side) doesn't carry stakeUsd/entryPrice/conditionId.
    expect(enqueueWrite).toHaveBeenCalledWith(
      'outcomes',
      expect.objectContaining({
        stakeUsd: 5, // derived: shares (10) × average_price (0.5)
        entryPrice: 0.5, // from average_price
        conditionId: 'cond-xyz', // from condition_id
        executionVenue: 'simmer',
        result: 'won',
        exitReason: 'recovered_auto_redeemed',
      }),
    );
  });

  it('does not fabricate openedAt when neither ledger nor raw provides it', async () => {
    const redis = {} as any;

    await recordRedemptionOutcome(
      redis,
      null,
      { market_id: 'mkt-noopen' },
      {
        marketId: 'mkt-noopen',
        direction: 'YES',
        question: 'No open time known',
        result: 'lost',
        returnPct: -100,
        exitReason: 'resolved_unknown_open',
      },
    );

    // The fabricated-openedAt default would have landed a synthetic ISO
    // timestamp, making holdingHours ≈ 0 but making "unknown hold time"
    // indistinguishable from a fast exit. Now: openedAt absent from the DB
    // write entirely so analytics can filter "unknown" rows out.
    expect(enqueueWrite).toHaveBeenCalledWith(
      'outcomes',
      expect.objectContaining({
        openedAt: undefined,
        holdingHours: 0,
      }),
    );
  });

  it('preserves full question text (does not truncate to 200 chars)', async () => {
    const redis = {} as any;
    const longQuestion = 'Q'.repeat(400); // > 200 chars

    await recordRedemptionOutcome(
      redis,
      null,
      null,
      {
        marketId: 'mkt-long',
        direction: 'YES',
        question: longQuestion,
        result: 'won',
        returnPct: 50,
        exitReason: 'resolved',
      },
    );

    // recordPositionOutcome truncates to 200 chars for Redis but passes full
    // text to the DB enqueueWrite. If the helper pre-truncates, the DB loses
    // the full resolved question/title — analytics regression.
    expect(enqueueWrite).toHaveBeenCalledWith(
      'outcomes',
      expect.objectContaining({ question: longQuestion }),
    );
    // Redis side still gets sliced inside recordPositionOutcome.
    const redisCall = (recordOutcome as any).mock.calls.at(-1)?.[1];
    expect(redisCall.question.length).toBe(200);
  });
});
