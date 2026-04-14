import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Position } from '../execution/positionLedger.js';
import { recordOutcome, inferCategory, inferSource } from './outcomeRecorder.js';
import { recordUpDownOutcome } from './updownThrottle.js';
import { loadConfig } from './config.js';
import { enqueueWrite } from '../db/writeQueue.js';

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
    | 'marketId'
    | 'conditionId'
    | 'entryPrice'
    | 'stakeUsd'
    | 'sharesHeld'
    | 'entryAtr'
    | 'entryAtrPct'
    | 'priceZone'
    | 'synthHedged'
    | 'pendingSettlement'
  >,
  opts: {
    result: 'won' | 'lost';
    returnPct: number;
    executionVenueOverride?: string;
  },
): Promise<void> {
  const outcome = {
    source: inferSource(position.sourcedFrom),
    category: inferCategory(position.question),
    question: position.question.slice(0, 200),
    direction: position.direction as 'YES' | 'NO' | 'UP' | 'DOWN',
    consensusProbability: position.consensusProbability ?? 0.5,
    divergence: position.edgeMagnitude,
    result: opts.result,
    returnPct: opts.returnPct,
    holdingHours: position.openedAt
      ? (Date.now() - new Date(position.openedAt).getTime()) / 3600000
      : 0,
    executionVenue: opts.executionVenueOverride ?? position.executionVenue ?? 'simmer',
  } as const;

  if (position.direction === 'UP' || position.direction === 'DOWN') {
    const cfg = loadConfig();
    await recordUpDownOutcome(
      redis,
      opts.result === 'won' ? 'W' : 'L',
      cfg.UPDOWN_PNL_WINDOW_SIZE,
    );
  }

  await recordOutcome(redis, {
    ...outcome,
    ...(position.executionId ? { executionId: position.executionId } : {}),
    ...(position.modeConfigured ? { modeConfigured: position.modeConfigured } : {}),
    ...(position.entryExecutionPath ? { entryExecutionPath: position.entryExecutionPath } : {}),
    ...(position.entryOrderType ? { entryOrderType: position.entryOrderType } : {}),
    ...(position.fallbackReason ? { fallbackReason: position.fallbackReason } : {}),
    ...(position.decisionSpreadBps !== undefined
      ? { decisionSpreadBps: position.decisionSpreadBps }
      : {}),
    ...(position.makerPriceImprovementBps !== undefined
      ? { makerPriceImprovementBps: position.makerPriceImprovementBps }
      : {}),
    ...(position.makerPriceImprovementUsd !== undefined
      ? { makerPriceImprovementUsd: position.makerPriceImprovementUsd }
      : {}),
  }, { sourcedFrom: position.sourcedFrom });

  const holdingHours = position.openedAt
    ? (Date.now() - new Date(position.openedAt).getTime()) / 3_600_000
    : 0;
  void enqueueWrite('outcomes', {
    outcomeId: randomUUID(),
    closedAt: new Date().toISOString(),
    openedAt: position.openedAt,
    executionId: position.executionId,
    source: inferSource(position.sourcedFrom),
    category: inferCategory(position.question),
    marketId: position.marketId,
    conditionId: position.conditionId,
    question: position.question,
    direction: position.direction,
    consensusProbability: position.consensusProbability ?? 0.5,
    divergence: position.edgeMagnitude,
    result: opts.result,
    returnPct: opts.returnPct,
    holdingHours,
    executionVenue: opts.executionVenueOverride ?? position.executionVenue ?? 'simmer',
    modeConfigured: position.modeConfigured,
    entryExecutionPath: position.entryExecutionPath,
    entryOrderType: position.entryOrderType,
    fallbackReason: position.fallbackReason,
    decisionSpreadBps: position.decisionSpreadBps,
    makerPriceImprovementBps: position.makerPriceImprovementBps,
    makerPriceImprovementUsd: position.makerPriceImprovementUsd,
    entryPrice: position.entryPrice,
    stakeUsd: position.stakeUsd,
    sharesHeld: position.sharesHeld,
    entryAtr: position.entryAtr,
    entryAtrPct: position.entryAtrPct,
    priceZone: position.priceZone,
    synthHedged: position.synthHedged ?? false,
    pendingSettlement: position.pendingSettlement ?? false,
  });
}
