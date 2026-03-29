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
  source: 'osint' | 'copytrade' | 'spot' | 'arb' | 'crypto-arb';
  category: string;
  question: string;
  direction: 'YES' | 'NO';
  urgencyScore?: number;
  consensusProbability: number;
  divergence: number;
  result: 'won' | 'lost' | 'pushed';
  returnPct: number;
  holdingHours: number;
  executionVenue: string;
}

/**
 * Infer a category from a market question using keyword matching.
 */
export function inferCategory(question: string): string {
  const q = question.toLowerCase();

  if (/bitcoin|btc|eth|crypto|solana|doge|dogecoin|xrp|ripple|shib|shiba|pepe|binance|coinbase/.test(q)) {
    return 'crypto-regulatory';
  }
  if (/fed|rate|gdp|inflation|bank|cpi|recession/.test(q)) {
    return 'macro';
  }
  if (/trump|biden|election|congress|senate|white house|democrat|republican/.test(q)) {
    return 'us-politics';
  }
  if (/\bai\b|openai|nvidia|anthropic|gemini|gpu|llm/.test(q)) {
    return 'ai-tech';
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
): Promise<void> {
  try {
    const cfg = loadConfig();
    const id = randomUUID();
    const closedAt = new Date().toISOString();
    const ts = Date.now();

    const full: PositionOutcome = { ...outcome, id, closedAt };

    // Write hash
    const hashKey = `outcome:${id}`;
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(full)) {
      fields[k] = String(v ?? '');
    }
    await redis.hset(hashKey, fields);
    await redis.expire(hashKey, cfg.OUTCOME_HISTORY_DAYS * 86400);

    // Add to sorted sets
    await redis.zadd('outcomes:all', ts, id);
    await redis.zadd(`outcomes:${outcome.category}`, ts, id);
    await redis.zadd(`outcomes:source:${outcome.source}`, ts, id);

    // Prune if category exceeds max
    const count = await redis.zcard(`outcomes:${outcome.category}`);
    if (count > cfg.OUTCOME_MAX_PER_CATEGORY) {
      const excess = count - cfg.OUTCOME_MAX_PER_CATEGORY;
      await redis.zpopmin(`outcomes:${outcome.category}`, excess);
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
      if (!data || !data.id) continue;

      const parsed: PositionOutcome = {
        id: data.id,
        closedAt: data.closedAt ?? '',
        source: data.source as PositionOutcome['source'],
        category: data.category ?? '',
        question: data.question ?? '',
        direction: data.direction as 'YES' | 'NO',
        consensusProbability: Number(data.consensusProbability) || 0,
        divergence: Number(data.divergence) || 0,
        result: data.result as 'won' | 'lost' | 'pushed',
        returnPct: Number(data.returnPct) || 0,
        holdingHours: Number(data.holdingHours) || 0,
        executionVenue: data.executionVenue ?? '',
      };
      if (data.urgencyScore) parsed.urgencyScore = Number(data.urgencyScore);
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
