import type { Redis } from 'ioredis';
import type { Position } from '../execution/positionLedger.js';
import { recordOutcome, inferCategory, inferSource } from './outcomeRecorder.js';

/**
 * Record the outcome of a position exit. Centralises field mapping from Position
 * to the recordOutcome schema, reducing boilerplate across takeProfitExecutor and
 * resolutionRedeemer.
 */
export async function recordPositionOutcome(
  redis: Redis,
  position: Pick<
    Position,
    | 'executionId'
    | 'sourcedFrom'
    | 'question'
    | 'direction'
    | 'consensusProbability'
    | 'edgeMagnitude'
    | 'openedAt'
    | 'executionVenue'
    | 'modeConfigured'
    | 'entryExecutionPath'
    | 'entryOrderType'
    | 'fallbackReason'
    | 'decisionSpreadBps'
    | 'makerPriceImprovementBps'
    | 'makerPriceImprovementUsd'
  >,
  opts: {
    result: 'won' | 'lost';
    returnPct: number;
    executionVenueOverride?: string;
  },
): Promise<void> {
  const outcome = {
    source: inferSource(position.sourcedFrom ?? ''),
    category: inferCategory(position.question ?? ''),
    question: (position.question ?? '').slice(0, 200),
    direction: position.direction as 'YES' | 'NO',
    consensusProbability: position.consensusProbability ?? 0.5,
    divergence: position.edgeMagnitude ?? 0,
    result: opts.result,
    returnPct: opts.returnPct,
    holdingHours: position.openedAt
      ? (Date.now() - new Date(position.openedAt).getTime()) / 3600000
      : 0,
    executionVenue: opts.executionVenueOverride ?? position.executionVenue ?? 'simmer',
  } as const;

  await recordOutcome(redis, {
    ...outcome,
    ...(position.executionId ? { executionId: position.executionId } : {}),
    ...(position.modeConfigured ? { modeConfigured: position.modeConfigured } : {}),
    ...(position.entryExecutionPath ? { entryExecutionPath: position.entryExecutionPath } : {}),
    ...(position.entryOrderType ? { entryOrderType: position.entryOrderType } : {}),
    ...(position.fallbackReason ? { fallbackReason: position.fallbackReason } : {}),
    ...(position.decisionSpreadBps !== undefined ? { decisionSpreadBps: position.decisionSpreadBps } : {}),
    ...(position.makerPriceImprovementBps !== undefined ? { makerPriceImprovementBps: position.makerPriceImprovementBps } : {}),
    ...(position.makerPriceImprovementUsd !== undefined ? { makerPriceImprovementUsd: position.makerPriceImprovementUsd } : {}),
  });
}
