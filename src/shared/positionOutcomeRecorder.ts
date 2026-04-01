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
  position: Pick<Position, 'sourcedFrom' | 'question' | 'direction' | 'consensusProbability' | 'edgeMagnitude' | 'openedAt' | 'executionVenue'>,
  opts: {
    result: 'won' | 'lost';
    returnPct: number;
    executionVenueOverride?: string;
  },
): Promise<void> {
  await recordOutcome(redis, {
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
  });
}
