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
    );
  });
});
