/**
 * Outcome recorder — Phase 8a.
 *
 * Records every closed position with full signal context for:
 *   1. Historical context injection into LLM consensus prompts
 *   2. Calibration tracking per category
 *
 * Storage: Redis hashes + sorted sets. Never throws — all errors are logged.
 */

import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import type { Redis } from 'ioredis';

export interface PositionOutcome {
  id: string;
  closedAt: string;
  executionId?: string;
  source: 'osint' | 'copytrade' | 'spot' | 'arb' | 'crypto-arb';
  category: string;
  question: string;
  direction: 'YES' | 'NO' | 'UP' | 'DOWN';
  urgencyScore?: number;
  consensusProbability: number;
  divergence: number;
  result: 'won' | 'lost' | 'pushed';
  returnPct: number;
  holdingHours: number;
  executionVenue: string;
  modeConfigured?: 'hybrid' | 'maker' | 'taker';
  entryExecutionPath?: string;
  entryOrderType?: 'maker' | 'taker' | 'none';
  fallbackReason?: string;
  decisionSpreadBps?: number;
  makerPriceImprovementBps?: number;
  makerPriceImprovementUsd?: number;
}

/**
 * Map a position's `sourcedFrom` field to the PositionOutcome source enum.
 */
export function inferSource(sourcedFrom: string): PositionOutcome['source'] {
  const s = sourcedFrom.toLowerCase();
  if (s.startsWith('copytrade:')) return 'copytrade';
  if (s.startsWith('crypto-arb:')) return 'crypto-arb';
  if (s.startsWith('spot:') || s.startsWith('spot ')) return 'spot';
  if (s.startsWith('arb:') || s.startsWith('market arb')) return 'arb';
  return 'osint'; // default: OSINT news pipeline
}

/**
 * Infer a category from a market question using keyword matching.
 */
export function inferCategory(question: string): string {
  const q = question.toLowerCase();

  // Short tokens (eth, sol, btc, etc.) are anchored with \b to prevent false matches
  // like "methane" → eth, "absolute" → sol, "protocol" → btc.
  if (
    /bitcoin|\bbtc\b|\beth\b|ethereum|crypto|\bsolana\b|\bsol\b|\bdoge\b|dogecoin|\bxrp\b|ripple|\bshib\b|shiba|\bpepe\b|binance|coinbase/.test(
      q,
    )
  ) {
    return 'crypto-regulatory';
  }
  if (/\bfed\b|\brate\b|\bgdp\b|inflation|\bbank\b|\bcpi\b|recession/.test(q)) {
    return 'macro';
  }
  if (/trump|biden|election|congress|senate|white house|democrat|republican/.test(q)) {
    return 'us-politics';
  }
  if (/\bai\b|openai|nvidia|anthropic|gemini|gpu|llm/.test(q)) {
    return 'ai-tech';
  }
  if (/\bnba\b|basketball|lakers|warriors|celtics/.test(q)) {
    return 'sports-nba';
  }
  if (/\bnfl\b|american football|super bowl|quarterback/.test(q)) {
    return 'sports-nfl';
  }
  if (/soccer|fifa|champions league|premier league|epl|la liga/.test(q)) {
    return 'sports-soccer';
  }
  if (/olympics|mlb|baseball|tennis|atp|wta|nhl|hockey|championship/.test(q)) {
    return 'sports';
  }
  if (/mention|say|tweet|post|transcript|phrase|word|quoted/.test(q)) {
    return 'mentions';
  }
  return 'geopolitical';
}

/**
 * Record a closed position outcome to Redis.
 * NEVER throws — all errors are caught and logged.
 */
export async function recordOutcome(
  redis: Redis,
  outcome: Omit<PositionOutcome, 'id' | 'closedAt'>,
  opts?: { sourcedFrom?: string | undefined },
): Promise<void> {
  try {
    const cfg = loadConfig();
    const id = randomUUID();
    const closedAt = new Date().toISOString();
    const ts = Date.now();

    const full: PositionOutcome = { ...outcome, id, closedAt };

    // Reconciliation-imported positions have default consensus values (0.5/0)
    // that would poison calibration. Store the hash for audit but skip calibration sets.
    const isReconciled = opts?.sourcedFrom?.startsWith('reconciled:') ?? false;

    // Write hash (always — audit trail)
    const hashKey = `outcome:${id}`;
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(full)) {
      fields[k] = String(v ?? '');
    }
    if (opts?.sourcedFrom) fields.sourcedFrom = opts.sourcedFrom;
    await redis.hset(hashKey, fields);
    await redis.expire(hashKey, cfg.OUTCOME_HISTORY_DAYS * 86400);

    // Add to sorted sets (skip category set for reconciled outcomes — keeps calibration clean)
    await redis.zadd('outcomes:all', ts, id);
    if (!isReconciled) {
      await redis.zadd(`outcomes:${outcome.category}`, ts, id);
    }
    await redis.zadd(`outcomes:source:${outcome.source}`, ts, id);

    // Prune if category exceeds max.
    // Remove pruned IDs from all index sets to avoid orphaned references.
    const count = await redis.zcard(`outcomes:${outcome.category}`);
    if (count > cfg.OUTCOME_MAX_PER_CATEGORY) {
      const excess = count - cfg.OUTCOME_MAX_PER_CATEGORY;
      // ioredis zpopmin returns a flat string[] alternating [member, score, member, score, ...]
      const pruned: string[] = await redis.zpopmin(`outcomes:${outcome.category}`, excess);
      const prunedIds = pruned.filter((_v, i) => i % 2 === 0);
      if (prunedIds.length > 0) {
        // Remove from the global index.
        await redis.zrem('outcomes:all', ...prunedIds);
        // Remove from each pruned outcome's actual source set (read from its hash),
        // not the current outcome's source — they may differ for cross-source prunes.
        for (const prunedId of prunedIds) {
          const src = await redis.hget(`outcome:${prunedId}`, 'source');
          if (src) await redis.zrem(`outcomes:source:${src}`, prunedId);
        }
        // Delete the hash entries to free memory.
        const hashKeys = prunedIds.map((id) => `outcome:${id}`);
        await redis.del(...hashKeys);
      }
    }

    logger.info('[outcome-recorder] recorded outcome', {
      id,
      category: outcome.category,
      result: outcome.result,
      returnPct: outcome.returnPct,
    });
  } catch (err) {
    logger.warn('[outcome-recorder] failed to record outcome (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Get recent outcomes for a category, reverse-chronologically.
 * Returns [] if Redis is unavailable or no outcomes exist.
 */
export async function getRecentOutcomes(
  redis: Redis,
  category: string,
  limit?: number,
): Promise<PositionOutcome[]> {
  try {
    const cfg = loadConfig();
    const cap = limit ?? cfg.CONTEXT_INJECTION_LIMIT;
    const ids: string[] = await redis.zrevrange(`outcomes:${category}`, 0, cap - 1);
    if (ids.length === 0) return [];

    const outcomes: PositionOutcome[] = [];
    for (const id of ids) {
      const data = await redis.hgetall(`outcome:${id}`);
      if (!data.id) continue;

      const parsed: PositionOutcome = {
        id: data.id,
        closedAt: data.closedAt ?? '',
        source: data.source as PositionOutcome['source'],
        category: data.category ?? '',
        question: data.question ?? '',
        direction: data.direction as PositionOutcome['direction'],
        consensusProbability: Number(data.consensusProbability) || 0,
        divergence: Number(data.divergence) || 0,
        result: data.result as 'won' | 'lost' | 'pushed',
        returnPct: Number(data.returnPct) || 0,
        holdingHours: Number(data.holdingHours) || 0,
        executionVenue: data.executionVenue ?? '',
      };
      if (data.executionId) parsed.executionId = data.executionId;
      if (data.urgencyScore !== undefined && data.urgencyScore !== null && data.urgencyScore !== '')
        parsed.urgencyScore = Number(data.urgencyScore);
      if (data.modeConfigured)
        parsed.modeConfigured = data.modeConfigured as NonNullable<
          PositionOutcome['modeConfigured']
        >;
      if (data.entryExecutionPath) parsed.entryExecutionPath = data.entryExecutionPath;
      if (data.entryOrderType)
        parsed.entryOrderType = data.entryOrderType as NonNullable<
          PositionOutcome['entryOrderType']
        >;
      if (data.fallbackReason) parsed.fallbackReason = data.fallbackReason;
      if (
        data.decisionSpreadBps !== undefined &&
        data.decisionSpreadBps !== null &&
        data.decisionSpreadBps !== ''
      )
        parsed.decisionSpreadBps = Number(data.decisionSpreadBps);
      if (
        data.makerPriceImprovementBps !== undefined &&
        data.makerPriceImprovementBps !== null &&
        data.makerPriceImprovementBps !== ''
      )
        parsed.makerPriceImprovementBps = Number(data.makerPriceImprovementBps);
      if (
        data.makerPriceImprovementUsd !== undefined &&
        data.makerPriceImprovementUsd !== null &&
        data.makerPriceImprovementUsd !== ''
      )
        parsed.makerPriceImprovementUsd = Number(data.makerPriceImprovementUsd);
      outcomes.push(parsed);
    }

    return outcomes;
  } catch (err) {
    logger.warn('[outcome-recorder] failed to get recent outcomes (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
