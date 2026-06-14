/**
 * Zod schema for the `positions` table — mirrors the Position interface from
 * src/execution/positionLedger.ts. Emit sites in Phase 3 will call
 * enqueueWrite('positions', position) where position is a Position object.
 *
 * Mutable fields (closed_at, reconciliation_status, pending_settlement,
 * synth_hedged, hedge_link, shares_held) are always optional so that partial
 * updates on open positions pass validation. The handler UPSERT writes all
 * provided values and updates updated_at.
 */
import { z } from 'zod';

const DIRECTION = ['YES', 'NO', 'UP', 'DOWN', 'LONG', 'SHORT'] as const;
const VENUE = ['simmer', 'clob', 'hyperliquid', 'none'] as const;

export const positionRowSchema = z.object({
  // Core identity — part of unique key (market_id, direction, opened_at)
  marketId:                         z.string(),
  direction:                        z.enum(DIRECTION),
  openedAt:                         z.string().datetime(),
  // Lifecycle (mutable)
  closedAt:                         z.string().datetime().optional(),
  reconciliationStatus:             z.string().optional(),
  pendingSettlement:                z.boolean().optional().default(false),
  synthHedged:                      z.boolean().optional().default(false),
  hedgeLink:                        z.number().int().optional(),   // hedge_events.id
  // Entry snapshot (immutable after write)
  entryPrice:                       z.number(),
  stakeUsd:                         z.number(),
  sharesHeld:                       z.number().optional(),
  executionVenue:                   z.enum(VENUE),
  executionId:                      z.string().optional(),
  decisionId:                       z.string().uuid().optional(),
  // Hybrid lifecycle
  modeConfigured:                   z.string().optional(),
  entryExecutionPath:               z.string().optional(),
  entryOrderType:                   z.string().optional(),
  fallbackReason:                   z.string().optional(),
  // Decision-time microstructure
  decisionBestBid:                  z.number().optional(),
  decisionBestAsk:                  z.number().optional(),
  decisionMidPrice:                 z.number().optional(),
  decisionSpreadBps:                z.number().optional(),
  counterfactualImmediateTakerPrice: z.number().optional(),
  counterfactualImmediateTakerShares: z.number().optional(),
  counterfactualImmediateTakerCostUsd: z.number().optional(),
  makerPriceImprovementBps:         z.number().optional(),
  makerPriceImprovementUsd:         z.number().optional(),
  // C6: mapping/edge taxonomy
  mappingConfidence:                z.number().optional(),
  relevanceClass:                   z.string().optional(),
  edgeClass:                        z.string().optional(),
  sizingReason:                     z.string().optional(),
  // Futures-specific
  isFutures:                        z.boolean().optional().default(false),
  symbol:                           z.string().optional(),
  leverage:                         z.number().optional(),
  entryAtr:                         z.number().optional(),
  entryAtrPct:                      z.number().optional(),
  memeAtrSlPct:                     z.number().optional(),
  memeAtrTpPct:                     z.number().optional(),
  priceZone:                        z.number().int().min(1).max(5).optional(),
  entryFundingApr:                  z.number().optional(),
  isContrarian:                     z.boolean().optional(),
  topUpCount:                       z.number().int().optional().default(0),
  rebateShare:                      z.number().optional(),
  // Consensus snapshot
  consensusProbability:             z.number().optional(),
  consensusStddev:                  z.number().optional(),
  // Metadata
  question:                         z.string(),
  sourcedFrom:                      z.string(),
  raw:                              z.record(z.unknown()).optional(),
});

export type PositionRow = z.infer<typeof positionRowSchema>;
